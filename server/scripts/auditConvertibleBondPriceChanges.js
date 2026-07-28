const { pool } = require('../db');
const { tushareQuery, tsRows } = require('../services/market');

async function main() {
  const { rows } = await pool.query(
    `SELECT i.canonical_code
     FROM core.instruments i
     JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
     WHERE i.status <> 'delisted' AND (p.maturity_date IS NULL OR p.maturity_date >= CURRENT_DATE)
     ORDER BY i.canonical_code`
  );
  const codes = rows.map(row => row.canonical_code);
  const anomalies = [];
  let cursor = 0;
  async function worker() {
    while (cursor < codes.length) {
      const code = codes[cursor++];
      const data = await tushareQuery('cb_price_chg', { ts_code: code },
        'ts_code,publish_date,change_date,convert_price_initial,convertprice_bef,convertprice_aft');
      const history = tsRows(data).slice().sort((a, b) => String(a.change_date).localeCompare(String(b.change_date)));
      for (let index = 1; index < history.length; index += 1) {
        const previous = history[index - 1];
        const current = history[index];
        const previousAfter = Number(previous.convertprice_aft);
        const currentBefore = Number(current.convertprice_bef);
        if (Number.isFinite(previousAfter) && Number.isFinite(currentBefore)
          && Math.abs(previousAfter - currentBefore) > 0.001) {
          anomalies.push({
            code,
            previous_date: previous.change_date,
            previous_after: previousAfter,
            current_date: current.change_date,
            current_before: currentBefore,
            current_after: Number(current.convertprice_aft),
          });
        }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  console.log(JSON.stringify({ checked: codes.length, anomalies }, null, 2));
}

main()
  .then(() => pool.end())
  .catch(async error => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
