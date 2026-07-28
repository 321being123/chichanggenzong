const { pool } = require('../db');
const { backfillUnderlyingStockMarket } = require('../services/convertibleBondAnalysis');

backfillUnderlyingStockMarket({ windowDays: 500 })
  .then(result => {
    console.log(JSON.stringify(result));
    return pool.end();
  })
  .catch(async error => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
