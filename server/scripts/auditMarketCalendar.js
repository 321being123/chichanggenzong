// 只读日历对账：不发外部请求、不写数据库。
const { pool } = require('../db/connection');
const { getMarketState, prefetchMarketFacts, isCnTradingDate, validDate } = require('../services/marketState');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function addDays(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const year = Number(option('year', new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date())));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('--year 必须是有效年份');
  const time = option('time', '12:00');
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  if (dates.some(date => !validDate(date))) throw new Error('生成了无效业务日');

  const { rows } = await pool.query(
    `SELECT trade_date::text AS trade_date, is_open, source_code, raw_payload
       FROM market.trade_calendar
      WHERE exchange='HKEX' AND trade_date BETWEEN $1::date AND $2::date`,
    [start, end]
  );
  await prefetchMarketFacts('HK', dates);
  const rowsByDate = new Map(rows.map(row => [String(row.trade_date).slice(0, 10), row]));
  let covered = 0;
  let conflicts = 0;
  for (const date of dates) {
    const cn = isCnTradingDate(date) ? 'open' : 'closed';
    const hk = await getMarketState({ market: 'HK', businessDate: date, time });
    const raw = rowsByDate.get(date);
    if (raw) covered++;
    if (hk.qualityStatus === 'conflict') conflicts++;
    process.stdout.write(JSON.stringify({
      date,
      CN: cn,
      HK: hk.status,
      hkSession: hk.sessionType,
      hkCloseTime: hk.closeTime,
      source: hk.source,
      coverage: raw ? 'present' : 'missing',
      quality: hk.qualityStatus,
      conflict: hk.conflict,
    }) + '\n');
  }
  process.stderr.write(JSON.stringify({ year, days: dates.length, covered, missing: dates.length - covered, conflicts, readOnly: true }) + '\n');
}

main().catch(error => {
  process.stderr.write(`日历对账失败：${error.message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end().catch(() => {});
});
