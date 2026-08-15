// ========== 自动补齐指数基线（启动后自动拉取“基准日期”的数据） ==========
// 基准日期 = 该账户净值最早日期；确保五指数（A股走Tushare，恒生走腾讯）都覆盖到该日期。
// 幂等：已覆盖到基线的指数跳过，仅在缺失时联网补齐；可随 deploy 自动自愈指数缺口。
const { pool, upsertIndexPoints, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, tsDateStr, normDate } = require('../services/market');
const { withExternalCallGuard } = require('../services/externalCallGuard');
const { isCnHoliday } = require('../config/holidays');

const INDEX_BACKFILL_DEFS = [
  { name: '沪深300', ts: '000300.SH', src: 'tushare' },
  { name: '中证全指', ts: '000985.CSI', src: 'tushare' },
  { name: '上证指数', ts: '000001.SH', src: 'tushare' },
  { name: '中证500', ts: '000905.SH', src: 'tushare' },
  { name: '恒生指数', src: 'tencent' } // 恒生无 Tushare 权限，沿用腾讯策略
];

function chinaDateText(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function isChinaTradingDay(value = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short'
  }).format(value);
  return weekday !== 'Sat' && weekday !== 'Sun' && !isCnHoliday(chinaDateText(value));
}

function triggerTypeForReason(reason) {
  if (reason === 'startup-catchup') return 'startup_catchup';
  if (reason === 'manual-retry') return 'manual_retry';
  if (reason === 'auto-retry') return 'auto_retry';
  return 'scheduled';
}

// 读取“已确认数据源最早只能拉到这”的记录（落库，进程重启不丢）
// key = username|account_name|指数名，value = 确认时的净值起点
async function loadSettledBaselines() {
  try {
    const { rows } = await pool.query('SELECT username, account_name, index_name, baseline_date FROM index_baseline_settled');
    const map = new Map();
    rows.forEach(function (r) {
      map.set(r.username + '|' + r.account_name + '|' + r.index_name, String(r.baseline_date || ''));
    });
    return map;
  } catch (_) { return new Map(); }
}

async function markSettledBaseline(username, accountName, indexName, baselineDate, earliestDate) {
  try {
    await pool.query(
      `INSERT INTO index_baseline_settled (username,account_name,index_name,baseline_date,earliest_date,settled_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (username,account_name,index_name) DO UPDATE SET
         baseline_date=EXCLUDED.baseline_date, earliest_date=EXCLUDED.earliest_date, settled_at=now()`,
      [username, accountName, indexName, baselineDate, earliestDate || null]
    );
  } catch (e) { console.error('指数基线状态落库失败:', e.message); }
}

// 只做本地数据库检查，不访问外部接口；没有基线缺口时，启动不产生运行记录。
async function hasIndexBaselineGap() {
  const settled = await loadSettledBaselines();
  const accs = await pool.query('SELECT DISTINCT username, account_name FROM nav_history');
  for (const acc of accs.rows) {
    const base = await pool.query('SELECT MIN(date) AS d FROM nav_history WHERE username=$1 AND account_name=$2', [acc.username, acc.account_name]);
    const baseline = base.rows[0] && base.rows[0].d ? String(base.rows[0].d) : null;
    if (!baseline) continue;
    const accountKey = acc.username + '|' + acc.account_name;
    for (const def of INDEX_BACKFILL_DEFS) {
      const settledBase = settled.get(accountKey + '|' + def.name);
      if (settledBase && settledBase <= baseline) continue;
      const minR = await pool.query('SELECT MIN(date) AS d FROM index_history WHERE username=$1 AND account_name=$2 AND name=$3', [acc.username, acc.account_name, def.name]);
      const minD = minR.rows[0] && minR.rows[0].d ? String(minR.rows[0].d) : null;
      if (!minD || minD > baseline) return true;
    }
  }
  return false;
}

// 恒生历史日K：腾讯 web.ifzq hkfqkline（日期范围，结束日期须<=今天，否则返回空）
async function fetchHsiHistory(fromDate, toDate) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,${fromDate},${toDate},4000,qfq`;
  try {
    const txt = await withExternalCallGuard('tencent', `hsi-history:${fromDate}:${toDate}`, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
      const https = require('https');
      https.get(url, { timeout: 10000 }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode === 429) {
            const error = new Error('腾讯恒指接口 HTTP 429');
            error.code = 'RATE_LIMIT'; error.errorType = 'rate_limit'; error.source = 'tencent';
            return reject(error);
          }
          if (resp.statusCode >= 500) {
            const error = new Error(`腾讯恒指接口 HTTP ${resp.statusCode}`);
            error.code = 'UPSTREAM_5XX'; error.errorType = 'network'; error.source = 'tencent';
            return reject(error);
          }
          resolve(data);
        });
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    }));
    const json = JSON.parse(txt);
    const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
    if (!Array.isArray(dayArr)) return [];
    return dayArr
      .map(function (it) { return { date: normDate(it[0]), close: parseFloat(it[2]) }; })
      .filter(function (p) { return p.date && !isNaN(p.close) && p.close > 0; });
  } catch (e) {
    if (e && e.code) throw e;
    return [];
  }
}

// options.force = true 时忽略"已确认"记录，强制重查（供用户主动补历史使用）
async function ensureIndexBaseline(options) {
  const force = !!(options && options.force);
  try {
    const settled = force ? new Map() : await loadSettledBaselines();
    const accs = await pool.query('SELECT DISTINCT username, account_name FROM nav_history');
    for (const acc of accs.rows) {
      const base = await pool.query('SELECT MIN(date) AS d FROM nav_history WHERE username=$1 AND account_name=$2', [acc.username, acc.account_name]);
      const baseline = base.rows[0] && base.rows[0].d ? String(base.rows[0].d) : null;
      if (!baseline) continue; // 无净值记录则无需补齐
      const startTs = baseline.replace(/-/g, '');
      const endTs = tsDateStr(new Date());
      const endDash = normDate(endTs);
      const accountKey = acc.username + '|' + acc.account_name;
      const points = [];
      for (const def of INDEX_BACKFILL_DEFS) {
        const key = accountKey + '|' + def.name;
        // 已确认数据源最早只能拉到这，且净值起点没有变得更早 → 跳过，不再联网
        const settledBase = settled.get(key);
        if (settledBase && settledBase <= baseline) continue;
        // 已覆盖到基线（指数最早日期 <= 净值起点）则跳过，避免重复联网
        const minR = await pool.query('SELECT MIN(date) AS d FROM index_history WHERE username=$1 AND account_name=$2 AND name=$3', [acc.username, acc.account_name, def.name]);
        const minD = minR.rows[0] && minR.rows[0].d ? String(minR.rows[0].d) : null;
        if (minD && minD <= baseline) continue;
        let series = [];
        if (def.src === 'tushare') {
          const rows = await tushareQuery('index_daily', { ts_code: def.ts, start_date: startTs, end_date: endTs }, 'trade_date,close');
          if (rows) series = tsRows(rows).map(function (r) { return { date: normDate(r.trade_date), close: parseFloat(r.close) }; }).filter(function (p) { return p.date && !isNaN(p.close) && p.close > 0; });
        } else {
          series = await fetchHsiHistory(baseline, endDash);
        }
        // 取到了数据但最早日并未早于已有最早日 → 说明数据源最早只能拉到这，记录以避免重复拉取
        if (series.length) {
          const earliest = series.reduce(function (a, b) { return a.date < b.date ? a : b; }).date;
          if (minD == null || earliest >= minD) {
            await markSettledBaseline(acc.username, acc.account_name, def.name, baseline, earliest);
          }
        }
        series.forEach(function (p) { points.push({ date: p.date, name: def.name, close: p.close }); });
      }
      if (points.length) {
        await upsertIndexPoints(acc.username, acc.account_name, points);
        console.log(`指数基线补齐: ${acc.username}/${acc.account_name} 新增 ${points.length} 点 (基准 ${baseline})`);
      }
    }
    console.log('指数基线检查完成');
  } catch (e) {
    console.error('指数基线补齐失败:', e.message);
    throw e;
  }
}

// 带幂等锁与执行记录的指数基线任务（跨实例单跑，失败留痕）
async function runIndexBaselineJob(reason = 'startup-catchup') {
  // 启动补跑属于自动任务，休息日不执行；人工补跑仍允许按需执行。
  if (reason !== 'manual-retry' && !isChinaTradingDay()) {
    return { ok: true, skipped: true, reason: 'not_trading_day' };
  }
  if (!(await tryClaimJob('index_baseline'))) {
    return { ok: true, skipped: true, reason: 'already_running' };
  }
  let runId = null;
  try {
    if (!(await hasIndexBaselineGap())) {
      return { ok: true, skipped: true, reason: 'no_missing_data' };
    }
    runId = await startJobRun('index_baseline', triggerTypeForReason(reason));
    await ensureIndexBaseline();
    await finishJobRun(runId, true, '');
  } catch (e) {
    // 预检查失败时没有运行记录；已创建记录的正常执行仍需留痕。
    if (runId) await finishJobRun(runId, false, e.message || String(e));
    else console.error('指数基线补齐预检查失败:', e.message || String(e));
    return { ok: false, error: e.message || String(e) };
  } finally {
    await releaseJob('index_baseline');
  }
}

// 每日增量补齐：只拉最近 days 天的五指数点位（默认 10），增量 upsert。
// 与 ensureIndexBaseline（启动补齐基线→今天全段）互补：本函数负责“持续每日新增”，
// 解决进程长期运行期间若不开网页、每日指数点位不落库导致对比曲线断档的问题。
async function ensureIndexRecent(days) {
  try {
    const n = Math.max(5, Math.min(days || 10, 30));
    const accs = await pool.query('SELECT DISTINCT username, account_name FROM nav_history');
    const endTs = tsDateStr(new Date());
    const endDash = normDate(endTs);
    const startD = new Date();
    startD.setDate(startD.getDate() - n);
    const startTs = tsDateStr(startD);
    const startDash = normDate(startTs);
    let total = 0;
    for (const acc of accs.rows) {
      const points = [];
      for (const def of INDEX_BACKFILL_DEFS) {
        let series = [];
        if (def.src === 'tushare') {
          const rows = await tushareQuery('index_daily', { ts_code: def.ts, start_date: startTs, end_date: endTs }, 'trade_date,close');
          if (rows) series = tsRows(rows).map(function (r) { return { date: normDate(r.trade_date), close: parseFloat(r.close) }; }).filter(function (p) { return p.date && !isNaN(p.close) && p.close > 0; });
        } else {
          series = await fetchHsiHistory(startDash, endDash);
        }
        series.forEach(function (p) { points.push({ date: p.date, name: def.name, close: p.close }); });
      }
      if (points.length) {
        await upsertIndexPoints(acc.username, acc.account_name, points);
        total += points.length;
      }
    }
    console.log('指数每日补齐完成，新增 ' + total + ' 点');
  } catch (e) {
    console.error('指数每日补齐失败:', e.message);
    throw e;
  }
}

// 带幂等锁与执行记录的每日指数任务
async function runIndexRecentJob() {
  if (!(await tryClaimJob('index_recent'))) return;
  const runId = await startJobRun('index_recent');
  try {
    await ensureIndexRecent(10);
    await finishJobRun(runId, true, '');
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
  } finally {
    await releaseJob('index_recent');
  }
}

module.exports = { ensureIndexBaseline, runIndexBaselineJob, ensureIndexRecent, runIndexRecentJob };
