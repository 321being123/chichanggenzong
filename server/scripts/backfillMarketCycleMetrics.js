require('dotenv').config();
const { initSchema } = require('../db/migrations');
const { pool } = require('../db');
const { syncMarketCycleMetrics } = require('../jobs/marketVolatilitySync');
const { ensureIndexRecent } = require('../jobs/indexBaseline');

async function main() {
  await initSchema();
  const metrics = await syncMarketCycleMetrics(true);
  await ensureIndexRecent(30);
  console.log(JSON.stringify({ ok: true, metrics }));
}

main()
  .catch(error => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
