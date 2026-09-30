const { syncConvertibleBondSuspensions } = require('../services/convertibleBondSuspensionSync');
const { pool } = require('../db/connection');

const startDate = process.argv[2] || '20260701';
const endDate = process.argv[3] || '20260824';
const targetCodes = (process.argv[4] || '').split(',').filter(Boolean);

(async () => {
  try {
    const result = await syncConvertibleBondSuspensions({ startDate, endDate, targetCodes });
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
