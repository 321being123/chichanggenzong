// 统一历史港币汇率并修复冲突日期的净值快照。
// 默认只审计；传入 --apply 才写库。执行前必须已有数据库备份。
const { types } = require('pg');
types.setTypeParser(1082, value => value);
const { pool } = require('../db/connection');
const { chainNav } = require('../../public/shared/nav-math.js');

const APPLY = process.argv.includes('--apply');
const SOURCE_ID = 7;
const EPS = 0.0000005;

function key(username, accountName) { return username + '\n' + accountName; }
function asDate(value) { return String(value || '').slice(0, 10); }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function uniqueRates(rows) {
  return [...new Set(rows.map(r => Number(r.hk_rate)).filter(r => r > 0))].sort((a, b) => a - b);
}

async function reconstruct(account, date, rate) {
  const params = [account.username, account.account_name, date];
  const [cashBase, flows, trades, prices] = await Promise.all([
    pool.query('SELECT cash_base::float8 AS cash_base FROM accounts WHERE username=$1 AND account_name=$2', params.slice(0, 2)),
    pool.query('SELECT COALESCE(SUM(amount::float8),0)::float8 AS net FROM cash_flows WHERE username=$1 AND account_name=$2 AND date <= $3', params),
    pool.query(`SELECT COALESCE(trade_date,left(date,10)) AS trade_date, code, direction,
                       subtype, quantity::float8 AS quantity, amount::float8 AS amount,
                       (COALESCE(commission::float8,0)+COALESCE(stamp_tax::float8,0)+COALESCE(transfer_fee::float8,0)+COALESCE(other_fee::float8,0))::float8 AS fee
                  FROM trades WHERE username=$1 AND account_name=$2
                    AND COALESCE(trade_date,left(date,10)) <= $3
                  ORDER BY COALESCE(trade_date,left(date,10)), created_at`, params),
    pool.query(`SELECT code, date, price::float8 AS price FROM daily_prices
                 WHERE username=$1 AND account_name=$2 AND date <= $3 ORDER BY date`, params),
  ]);

  let cash = asNumber(cashBase.rows[0] && cashBase.rows[0].cash_base) + asNumber(flows.rows[0] && flows.rows[0].net);
  const held = new Map();
  for (const trade of trades.rows) {
    const qty = asNumber(trade.quantity);
    if (trade.direction === 'open' || trade.direction === 'adjust') {
      held.set(trade.code, { qty: trade.direction === 'adjust' ? Math.max(0, qty) : qty, subtype: trade.subtype || '' });
      continue;
    }
    const current = held.get(trade.code) || { qty: 0, subtype: trade.subtype || '' };
    current.qty += trade.direction === 'sell' ? -qty : qty;
    current.subtype = trade.subtype || current.subtype;
    held.set(trade.code, current);
    cash += trade.direction === 'buy' ? -asNumber(trade.amount) - asNumber(trade.fee) : asNumber(trade.amount) - asNumber(trade.fee);
  }

  const latest = new Map();
  for (const row of prices.rows) latest.set(row.code, { date: asDate(row.date), price: asNumber(row.price) });
  let marketValue = 0;
  for (const [code, info] of held) {
    if (!(info.qty > 0)) continue;
    const quote = latest.get(code);
    if (!quote || !(quote.price > 0)) return null;
    if (info.subtype === '港股' && !(rate > 0)) return null;
    marketValue += quote.price * info.qty * (info.subtype === '港股' ? rate : 1);
  }
  return cash + marketValue;
}

async function main() {
  const { rows: navRows } = await pool.query(`
    SELECT username, account_name, date, total_asset::float8 AS total_asset,
           nav::float8 AS nav, hk_rate::float8 AS hk_rate, snapshot_at
      FROM nav_history ORDER BY username, account_name, date`);
  const { rows: accounts } = await pool.query('SELECT DISTINCT username, account_name FROM accounts ORDER BY username, account_name');
  const byDate = new Map();
  const byAccount = new Map();
  for (const row of navRows) {
    row.date = asDate(row.date);
    const dateRows = byDate.get(row.date) || [];
    dateRows.push(row); byDate.set(row.date, dateRows);
    const accountRows = byAccount.get(key(row.username, row.account_name)) || [];
    accountRows.push(row); byAccount.set(key(row.username, row.account_name), accountRows);
  }

  const rates = new Map();
  const conflicts = [];
  for (const [date, rows] of byDate) {
    let candidates = uniqueRates(rows);
    if (candidates.length > 1) {
      const nonDefault = candidates.filter(rate => Math.abs(rate - 0.868) > EPS);
      if (nonDefault.length) candidates = nonDefault;
    }
    if (!candidates.length) continue;
    if (candidates.length === 1) { rates.set(date, candidates[0]); continue; }
    let best = null;
    for (const candidate of candidates) {
      let error = 0; let usable = 0; const reconstructed = [];
      for (const row of rows) {
        const total = await reconstruct(row, date, candidate);
        reconstructed.push({ row, total });
        if (total != null && Number.isFinite(total)) { error += Math.abs(asNumber(row.total_asset) - total); usable++; }
      }
      if (usable === rows.length && (!best || error < best.error - EPS)) best = { rate: candidate, error, reconstructed };
    }
    if (!best) continue;
    rates.set(date, best.rate);
    conflicts.push({ date, candidates, chosenRate: best.rate, error: best.error, reconstructed: best.reconstructed });
  }

  const changes = [];
  for (const conflict of conflicts) {
    for (const item of conflict.reconstructed) {
      if (item.total == null) continue;
      const oldTotal = asNumber(item.row.total_asset);
      const rateChanged = Math.abs(asNumber(item.row.hk_rate) - conflict.chosenRate) >= EPS;
      if (rateChanged) {
        changes.push({ username: item.row.username, accountName: item.row.account_name, date: conflict.date,
          oldRate: asNumber(item.row.hk_rate), newRate: conflict.chosenRate, oldTotal,
          newTotal: Number(item.total.toFixed(2)), delta: Number((item.total - oldTotal).toFixed(2)) });
      }
    }
  }

  const repairedTotals = new Map(changes.map(change => [key(change.username, change.accountName) + '\n' + change.date, change.newTotal]));

  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', globalDates: rates.size,
    conflicts: conflicts.map(c => ({ date: c.date, candidates: c.candidates, chosenRate: c.chosenRate, error: Number(c.error.toFixed(2)) })), changes }, null, 2));
  if (!APPLY || !rates.size) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [date, rate] of rates) {
      await client.query(`INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
        VALUES ('HKD','CNY',$1,$2,$3,now())
        ON CONFLICT (base_currency,quote_currency,rate_date)
        DO UPDATE SET source_id=EXCLUDED.source_id, rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`, [date, SOURCE_ID, rate]);
    }
    for (const change of changes) {
      await client.query(`UPDATE nav_history SET total_asset=$1, hk_rate=$2
        WHERE username=$3 AND account_name=$4 AND date=$5`, [change.newTotal, change.newRate, change.username, change.accountName, change.date]);
    }
    // 冲突日期之后的净值链按修复后的前一日总资产重新计算，保持实际现金流边界不变。
    for (const conflict of conflicts) {
      const grouped = new Map();
      for (const row of navRows) {
        if (row.date < conflict.date) continue;
        const rows = grouped.get(key(row.username, row.account_name)) || [];
        rows.push(row); grouped.set(key(row.username, row.account_name), rows);
      }
      for (const [accountKey, rows] of grouped) {
        rows.sort((a, b) => a.date.localeCompare(b.date));
        const [username, accountName] = accountKey.split('\n');
        const prior = (byAccount.get(accountKey) || []).filter(r => r.date < conflict.date).sort((a, b) => b.date.localeCompare(a.date))[0];
        let previous = prior ? { date: prior.date, nav: asNumber(prior.nav), total: asNumber(prior.total_asset) } : null;
        const { rows: cashFlows } = await client.query('SELECT date, amount::float8 AS amount FROM cash_flows WHERE username=$1 AND account_name=$2', [username, accountName]);
        for (const row of rows) {
          const rate = rates.get(row.date);
          if (rate) await client.query('UPDATE nav_history SET hk_rate=$1 WHERE username=$2 AND account_name=$3 AND date=$4', [rate, username, accountName, row.date]);
          if (!previous) { previous = { date: row.date, nav: asNumber(row.nav), total: asNumber(row.total_asset) }; continue; }
          let pcf = 0;
          for (const flow of cashFlows) if (asDate(flow.date) > previous.date && asDate(flow.date) <= row.date) pcf += asNumber(flow.amount);
          const total = repairedTotals.has(key(username, accountName) + '\n' + row.date)
            ? repairedTotals.get(key(username, accountName) + '\n' + row.date)
            : asNumber(row.total_asset);
          const nav = chainNav(previous.nav, previous.total, total, pcf);
          await client.query('UPDATE nav_history SET nav=$1 WHERE username=$2 AND account_name=$3 AND date=$4', [Number(nav.toFixed(6)), username, accountName, row.date]);
          previous = { date: row.date, nav, total };
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => pool.end());
