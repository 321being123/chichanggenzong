// ========== 自动补齐指数基线（启动后自动拉取“基准日期”的数据） ==========
// 基准日期 = 该账户净值最早日期；确保四指数（A股走Tushare，恒生走腾讯）都覆盖到该日期。
// 幂等：已覆盖到基线的指数跳过，仅在缺失时联网补齐；可随 deploy 自动自愈指数缺口。
const { pool, upsertIndexPoints, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, tsDateStr, normDate } = require('../services/market');

const INDEX_BACKFILL_DEFS = [
  { name: '沪深300', ts: '000300.SH', src: 'tushare' },
  { name: '上证指数', ts: '000001.SH', src: 'tushare' },
  { name: '中证500', ts: '000905.SH', src: 'tushare' },
  { name: '恒生指数', src: 'tencent' } // 恒生无 Tushare 权限，沿用腾讯策略
];

// 记录“已确认数据源最早只能拉到这”的指数，避免每次启动重复联网拉取
const settledIndexBaselines = new Set();

// 恒生历史日K：腾讯 web.ifzq hkfqkline（日期范围，结束日期须<=今天，否则返回空）
async function fetchHsiHistory(fromDate, toDate) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,${fromDate},${toDate},4000,qfq`;
  try {
    const txt = await new Promise((resolve, reject) => {
      const https = require('https');
      https.get(url, { timeout: 10000 }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    });
    const json = JSON.parse(txt);
    const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
    if (!Array.isArray(dayArr)) return [];
    return dayArr
      .map(function (it) { return { date: normDate(it[0]), close: parseFloat(it[2]) }; })
      .filter(function (p) { return p.date && !isNaN(p.close) && p.close > 0; });
  } catch (e) { return []; }
}

async function ensureIndexBaseline() {
  try {
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
        if (settledIndexBaselines.has(key)) continue; // 已确认数据源最早只能拉到这，跳过
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
          if (minD == null || earliest >= minD) settledIndexBaselines.add(key);
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
  }
}

// 带幂等锁与执行记录的指数基线任务（跨实例单跑，失败留痕）
async function runIndexBaselineJob() {
  if (!(await tryClaimJob('index_baseline'))) return;
  const runId = await startJobRun('index_baseline');
  try {
    await ensureIndexBaseline();
    await finishJobRun(runId, true, '');
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
  } finally {
    await releaseJob('index_baseline');
  }
}

module.exports = { ensureIndexBaseline, runIndexBaselineJob };
