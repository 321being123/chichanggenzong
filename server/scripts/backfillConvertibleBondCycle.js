// 可转债周期：历史回填脚本（断点续跑 + 空洞扫描 + 失败即停）
// 用法：node server/scripts/backfillConvertibleBondCycle.js
// 规则（整改方案 §3.1/§3.2）：
//   - 请求字段使用与每日同步同一份 DAILY_FIELDS（含 cb_value / cb_over_rate）；
//   - 游标只推进到「连续成功」的最后一个交易日：任一日请求失败、字段缺失或数据异常时立即停止，
//     该日及之后的游标不推进，下次执行自动从该日重试；
//   - 每次启动先扫描游标之前的「空洞日」（无事实数据、或样本达标但溢价率全空的坏数据日），一并补齐；
//   - 补过空洞后按时间顺序重算全部滚动分位；
//   - 同一日期重复回填按主键 UPSERT，不产生重复记录；
//   - 单日网络类错误自动重试 3 次；权限/配置错误立即退出。
const { pool } = require('../db');
const { tushareQuery, tsRows, tsDateStr } = require('../services/market');
const { DAILY_FIELDS } = require('../services/convertibleBondAnalysis');
const svc = require('../services/convertibleBondCycleService');

const START = '20170101';
const DELAY_MS = 250;
const RETRY_PER_DAY = 3;
const PERMISSION_RE = /TUSHARE|token|权限|permission|unauthorized|401|403|积分/i;
const REQUIRED_FIELDS = ['ts_code', 'trade_date', 'close', 'cb_value', 'cb_over_rate'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getOpenDays() {
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: START, end_date: tsDateStr(new Date()), is_open: '1' }, 'cal_date,is_open');
  return tsRows(data).filter((r) => String(r.is_open) === '1').map((r) => r.cal_date).sort();
}

// 请求字段完整性校验：返回行中真实存在的字段（Tushare 忽略不识别的 fields 参数，需事后验证）
function missingFields(rows) {
  if (!rows.length) return [];
  const sample = rows[0];
  return REQUIRED_FIELDS.filter((f) => !(f in sample));
}

async function fetchDayWithRetry(day) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_PER_DAY; attempt++) {
    try {
      const data = await tushareQuery('cb_daily', { trade_date: day }, DAILY_FIELDS);
      return tsRows(data);
    } catch (e) {
      lastErr = e;
      if (PERMISSION_RE.test(e.message)) throw e; // 权限/配置错误不重试
      if (attempt < RETRY_PER_DAY) await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

(async () => {
  const sourceId = await svc.getTushareSourceId();
  if (sourceId == null) {
    console.error('[回填] 未取得 tushare 数据源，请检查 ops.data_sources；本次跳过');
    process.exit(2);
  }
  const openDays = await getOpenDays();
  if (!openDays.length) {
    console.error('[回填] 未取得交易日历（可能未配置 Tushare 或无网络）；本次跳过');
    process.exit(3);
  }

  const cursor = await svc.getSyncCursor(); // 'YYYYMMDD' 或 null
  // 待处理 = 游标之前的空洞日 + 游标之后的全部开市日
  const before = cursor ? openDays.filter((d) => d <= cursor) : [];
  const after = cursor ? openDays.filter((d) => d > cursor) : openDays;
  const gaps = before.length ? await svc.findGapDays(before) : [];
  const pending = [...gaps, ...after].sort();
  if (!pending.length) {
    console.log('[回填] 已处理至最新交易日，且无历史空洞');
    process.exit(0);
  }
  if (gaps.length) console.log(`[回填] 检测到 ${gaps.length} 个历史空洞日：${gaps.slice(0, 10).join(',')}${gaps.length > 10 ? '...' : ''}`);
  console.log(`[回填] 待处理 ${pending.length} 个交易日，从 ${pending[0]} 开始`);

  let done = 0, stored = 0, unpublished = 0, gapFilled = 0;
  let failedDay = null, failedReason = null;
  const client = await pool.connect();
  try {
    for (const day of pending) {
      const isGap = gaps.includes(day);
      try {
        const rows = await fetchDayWithRetry(day);
        const miss = missingFields(rows);
        if (miss.length) { failedDay = day; failedReason = `缺少必要字段：${miss.join(',')}`; break; }
        await client.query('BEGIN');
        const res = await svc.processCycleDay(day, rows, { sourceId, client });
        if (res.failed) {
          await client.query('ROLLBACK');
          failedDay = day; failedReason = res.reason;
          break;
        }
        await client.query('COMMIT');
        if (res.stored) stored++;
        else { unpublished++; console.log(`  ${day} 未发布指标（${res.reason}）`); }
        if (isGap) gapFilled++;
        done++;
        if (done % 50 === 0) console.log(`[回填] 进度 ${done}/${pending.length} 已发布 ${stored}`);
        await sleep(DELAY_MS);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        failedDay = day; failedReason = e.message;
        if (PERMISSION_RE.test(e.message)) {
          console.error(`[回填] ${day} 权限/配置错误，停止：${e.message}`);
          await svc.recordCycleFailure(pool, day, e.message).catch(() => {});
          process.exit(4);
        }
        break;
      }
    }

    if (gapFilled > 0) {
      console.log(`[回填] 已补 ${gapFilled} 个空洞日，按时间顺序重算滚动分位...`);
      const n = await svc.recomputePercentiles();
      console.log(`[回填] 分位重算完成（${n} 天）`);
    }
  } finally {
    client.release();
  }

  if (failedDay) {
    await svc.recordCycleFailure(pool, failedDay, failedReason).catch(() => {});
    console.error(`[回填] ${failedDay} 失败（${failedReason}），已停止；游标不越过该日，下次执行将从此日重试`);
    console.log(`[回填] 本次完成：处理 ${done}，发布 ${stored}，未发布 ${unpublished}`);
    process.exit(1);
  }
  console.log(`[回填] 全部完成：处理 ${done}，发布 ${stored}，未发布 ${unpublished}，补空洞 ${gapFilled}`);
  process.exit(0);
})();
