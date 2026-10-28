const { pool } = require('../db/connection');

// 自 server/jobs/indexBaseline.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const INDEX_BACKFILL_DEFS = [
  { name: '沪深300', ts: '000300.SH', src: 'tushare' },
  { name: '中证全指', ts: '000985.CSI', src: 'tushare' },
  { name: '上证指数', ts: '000001.SH', src: 'tushare' },
  { name: '中证500', ts: '000905.SH', src: 'tushare' },
  { name: '恒生指数', src: 'tencent' } // 恒生无 Tushare 权限，沿用腾讯策略
];

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

module.exports = {
  hasIndexBaselineGap,
  loadSettledBaselines,
  markSettledBaseline,
};
