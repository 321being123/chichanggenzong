const { pool } = require('../db');

async function main() {
  const { rows } = await pool.query(
    `SELECT i.canonical_code,c.publish_date,c.change_date,c.price_before,c.price_after,
            c.reason,s.source_code,c.raw_payload->>'price_change_parser_version' AS parser_version
     FROM core.instruments i
     JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
     LEFT JOIN fundamental.convertible_bond_price_changes c ON c.instrument_id=i.instrument_id
     LEFT JOIN ops.data_sources s ON s.source_id=c.source_id
     WHERE i.status <> 'delisted' AND (p.maturity_date IS NULL OR p.maturity_date >= CURRENT_DATE)
     ORDER BY i.canonical_code,c.change_date`
  );
  const histories = new Map();
  for (const row of rows) {
    if (!histories.has(row.canonical_code)) histories.set(row.canonical_code, []);
    if (row.change_date) histories.get(row.canonical_code).push(row);
  }
  const anomalies = [];
  for (const [code, history] of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const previousAfter = Number(previous.price_after);
      const currentBefore = Number(current.price_before);
      if (Number.isFinite(previousAfter) && Number.isFinite(currentBefore)
        && Math.abs(previousAfter - currentBefore) > 0.001) {
        anomalies.push({
          code,
          previous_date: previous.change_date,
          previous_after: previousAfter,
          current_date: current.change_date,
          current_before: currentBefore,
          current_after: Number(current.price_after),
          source: current.source_code || 'unknown',
        });
      }
    }
  }
  console.log(JSON.stringify({
    source: 'historical_announcement_parser',
    checked: histories.size,
    histories: [...histories.values()].filter(history => history.length).length,
    anomalies,
  }, null, 2));
}

main()
  .then(() => pool.end())
  .catch(async error => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
