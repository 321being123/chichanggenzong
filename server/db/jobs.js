// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');
// 咨询锁必须占住一条专用连接，否则连接归还连接池即释放。用 Map 持有直到 releaseJob。
const _jobClients = {};

async function tryClaimJob(job) {
  const client = await pool.connect();
  const key = hashString(job);
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (rows[0] && rows[0].ok) {
      _jobClients[job] = client;
      return true;
    }
  } catch (e) {}
  client.release();
  return false;
}
async function releaseJob(job) {
  const client = _jobClients[job];
  if (!client) return;
  const key = hashString(job);
  await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
  client.release();
  delete _jobClients[job];
}
async function startJobRun(job) {
  const { rows } = await pool.query(
    "INSERT INTO job_runs (job, status, started_at, locked_until) VALUES ($1, 'running', now(), now() + interval '1 hour') RETURNING id",
    [job]
  );
  return rows[0] ? rows[0].id : null;
}
async function finishJobRun(id, ok, detail) {
  if (!id) return;
  await pool.query(
    "UPDATE job_runs SET status=$2, finished_at=now(), detail=COALESCE($3,'') WHERE id=$1",
    [id, ok ? 'done' : 'failed', detail || '']
  );
}

// ====== 管理后台：定时任务执行记录（监控用）======
// 返回最近若干条执行记录 + 每个任务的最近一次状态汇总
async function adminJobRuns(limit = 50) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const recent = await pool.query(
    'SELECT id, job, status, started_at, finished_at, detail FROM job_runs ORDER BY id DESC LIMIT $1',
    [lim]
  );
  const summary = await pool.query(
    'SELECT DISTINCT ON (job) job, status, started_at, finished_at FROM job_runs ORDER BY job, id DESC'
  );
  return { recent: recent.rows, summary: summary.rows };
}

// ====== 管理后台：平台概览聚合（供后台仪表盘）======
async function adminOverview() {
  const [u, admin, dis, acct, today, asset] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM users'),
    pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'"),
    pool.query("SELECT COUNT(*)::int AS c FROM users WHERE status<>'active'"),
    pool.query('SELECT COUNT(*)::int AS c FROM accounts'),
    pool.query('SELECT COUNT(*)::int AS c FROM users WHERE created_at::date = CURRENT_DATE'),
    pool.query(`SELECT COALESCE(SUM(total_asset),0)::float8 AS s FROM (
      SELECT total_asset, ROW_NUMBER() OVER (PARTITION BY username, account_name ORDER BY date DESC) rn
      FROM nav_history
    ) t WHERE rn=1`)
  ]);
  return {
    totalUsers: u.rows[0].c,
    adminUsers: admin.rows[0].c,
    disabledUsers: dis.rows[0].c,
    totalAccounts: acct.rows[0].c,
    todayNewUsers: today.rows[0].c,
    totalAsset: Number(asset.rows[0].s || 0)
  };
}

// ====== 后台：平台配置（key/value，DB 优先于 env）======
module.exports = {
  tryClaimJob,
  releaseJob,
  startJobRun,
  finishJobRun,
  adminJobRuns,
  adminOverview,
};
