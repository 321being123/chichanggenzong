// 历史净值权威导入真实回归：验证历史价格/汇率锚点、重复导入和导入后续算闭合。
const assert = require('assert');
const express = require('express');
const { pool, loadAccountData, saveAccountData, upsertNav } = require('../db');
const accountsRouter = require('../routes/accounts');
const { todayCN } = require('../services/market');

const U = 'nav_anchor_regression';
const A = '历史锚点回归账户';
const yesterday = (() => {
  const [y, m, d] = todayCN().split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d - 1));
  return x.toISOString().slice(0, 10);
})();

(async () => {
  let server;
  let fxBackup = [];
  try {
    await pool.query('SELECT 1');
    fxBackup = (await pool.query(
      `SELECT base_currency, quote_currency, rate_date, source_id, rate, fetched_at
         FROM market.fx_rates
        WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date = ANY($1::date[])`,
      [[yesterday, todayCN()]]
    )).rows;
    for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts']) {
      await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
    }
    await pool.query('DELETE FROM users WHERE username=$1', [U]);
    await pool.query(`INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')`, [U, JSON.stringify([A])]);
    const accountId = require('crypto').createHash('sha256').update(U + '\n' + A).digest('hex');
    await pool.query(
      `INSERT INTO accounts (id,username,account_name,cash_base,hk_rate,version,updated_at)
       VALUES ($1,$2,$3,0,0.85,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`, [accountId, U, A]
    );
    await saveAccountData(U, A, {
      positions: [{ id: 'hk1', code: '00700', name: '腾讯控股', price: 110, quantity: 10, cost: 100, type: '股权', subtype: '港股', note: '' }],
      trades: [], navHistory: [], cashFlows: [], cash: 0, cashBase: 0, hkRate: 0.85, feeSettings: {}
    }, 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
    const sourceRow = (await pool.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code='calculated' LIMIT 1`
    )).rows[0];
    assert.ok(sourceRow, '测试汇率必须使用已登记的数据源');
    await pool.query(
      `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
       VALUES ('HKD','CNY',$1,$3,0.90,now()),('HKD','CNY',$2,$3,0.85,now())
       ON CONFLICT (base_currency,quote_currency,rate_date) DO UPDATE SET rate=EXCLUDED.rate,fetched_at=EXCLUDED.fetched_at`, [yesterday, todayCN(), sourceRow.source_id]
    );
    await pool.query(
      `INSERT INTO daily_prices (username,account_name,date,code,name,price)
       VALUES ($1,$2,$3,'00700','腾讯控股',100)
       ON CONFLICT (username,account_name,date,code) DO UPDATE SET price=EXCLUDED.price`, [U, A, yesterday]
    );

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: U, authVersion: 1 }; next(); });
    app.use('/api', accountsRouter);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    const body = { account: A, records: [{ date: yesterday, nav: 1, totalAsset: 1400, invested: 1000, cash: 500 }], mode: 'merge' };
    const before = await loadAccountData(U, A);
    const preview = await fetch(base + '/nav/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const previewJson = await preview.json();
    assert.strictEqual(preview.status, 200, '导入预览应成功');
    assert.strictEqual(previewJson.calcStatus, 'ready', '预览应确认历史价格/汇率齐全');
    assert.strictEqual((await pool.query('SELECT count(*)::int AS c FROM nav_import_batches WHERE username=$1', [U])).rows[0].c, 0, '预览不得写批次');
    const first = await fetch(base + '/nav/import?version=' + before.version, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual(first.status, 200, '历史导入应成功');
    const firstJson = await first.json();
    const imported = (await loadAccountData(U, A)).navHistory.find(n => n.date === yesterday);
    assert.strictEqual(imported.systemMarketValueAtSnapshot, 900, '锚点必须使用导入日收盘价×导入日系统汇率');
    const after = await loadAccountData(U, A);
    assert.strictEqual(Math.round(after.authoritativeTotalAsset), 1435, '当前总资产必须=券商锚点+本系统价格/汇率增量');
    const repeat = await fetch(base + '/nav/import?version=' + after.version, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const repeatJson = await repeat.json();
    assert.strictEqual(repeat.status, 200, '同文件重复导入应成功幂等返回');
    assert.strictEqual(repeatJson.idempotent, true, '同文件必须按内容哈希幂等');
    const batchCount = await pool.query('SELECT count(*)::int AS c FROM nav_import_batches WHERE username=$1 AND account_name=$2', [U, A]);
    assert.strictEqual(batchCount.rows[0].c, 1, '同文件不得新增第二个导入批次');

    await upsertNav(U, A, { date: todayCN(), nav: 1.025, totalAsset: 1435, invested: 1000, hkRate: 0.85 });
    const closed = await loadAccountData(U, A);
    assert.ok(closed.navAttribution && closed.navAttribution.complete, '导入日到今天应能完整归因');
    assert.strictEqual(Math.round(closed.navAttribution.priceImpact), 90, '价格影响应为90');
    assert.strictEqual(Math.round(closed.navAttribution.fxImpact), -55, '汇率影响应为-55');
    assert.strictEqual(Math.round(closed.navAttribution.totalChange), 35, '总资产变化应为35');
    assert.strictEqual(Math.round(closed.navAttribution.priceImpact + closed.navAttribution.fxImpact + closed.navAttribution.ledgerChange), 35, '归因必须闭合，无现金端校准差额');

    const latest = await loadAccountData(U, A);
    const batchId = firstJson.data.navHistory.find(n => n.date === yesterday).importBatchId;
    const rollback = await fetch(base + '/nav/import/' + encodeURIComponent(batchId) + '/rollback?version=' + latest.version, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: A }) });
    assert.strictEqual(rollback.status, 200, '导入批次回滚应成功');
    const rolled = await loadAccountData(U, A);
    assert.strictEqual(rolled.navHistory.length, 0, '回滚应恢复导入前净值历史');

    // 导入历史日期之后已有买入时，锚点必须使用导入日数量，而不是当前数量。
    await pool.query(
      `INSERT INTO trades (id, username, account_name, date, trade_date, executed_at, code, name, direction, price, quantity, amount,
                           quote_currency, fx_rate_to_cny, amount_cny, currency_status, subtype, commission, stamp_tax, transfer_fee, other_fee)
       VALUES ('post_anchor_buy',$1,$2,$3,$3,$3,'00700','腾讯控股','buy',100,10,1000,'HKD',0.9,900,'complete','港股',0,0,0,0)`,
      [U, A, todayCN()]
    );
    await pool.query(`UPDATE positions SET quantity=20 WHERE username=$1 AND account_name=$2 AND code='00700'`, [U, A]);
    const beforePostTradeImport = await loadAccountData(U, A);
    const postTradeImport = await fetch(base + '/nav/import?version=' + beforePostTradeImport.version, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: A, importBatchId: 'post-trade-anchor-regression', records: [{ date: yesterday, nav: 1, totalAsset: 1401, invested: 1000, cash: 500 }] })
    });
    assert.strictEqual(postTradeImport.status, 200, '历史导入应支持导入日之后已有买入');
    const anchorPosition = (await pool.query(`SELECT quantity::float8 AS quantity FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 AND snapshot_id='post-trade-anchor-regression' AND instrument_code='00700'`, [U, A])).rows[0];
    assert.strictEqual(anchorPosition.quantity, 10, '历史锚点持仓数量必须按导入日回放，不得使用当前20股');

    // 旧港股记录缺少人民币结算额时必须阻断现金归因，不能把 NULL 当成 0。
    await pool.query(
      `INSERT INTO trades (id, username, account_name, date, trade_date, executed_at, code, name, direction, price, quantity, amount,
                           quote_currency, fx_rate_to_cny, amount_cny, currency_status, subtype, commission, stamp_tax, transfer_fee, other_fee)
       VALUES ('legacy_hkd_missing',$1,$2,$3,$3,$3,'00005','汇丰控股','buy',50,10,500,'HKD',NULL,NULL,'needs_review','港股',0,0,0,0)`,
      [U, A, todayCN()]
    );
    const incompleteCash = await loadAccountData(U, A);
    assert.strictEqual(incompleteCash.cashDataIncomplete, true, '港股人民币结算额为空时必须标记现金数据不完整');
    const incompletePreview = await fetch(base + '/nav/import/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: A, records: [{ date: yesterday, nav: 1, totalAsset: 1402, invested: 1000, cash: 500 }] })
    });
    const incompletePreviewJson = await incompletePreview.json();
    assert.strictEqual(incompletePreview.status, 200, '缺少历史结算额时预览仍应返回可解释结果');
    assert.strictEqual(incompletePreviewJson.calcStatus, 'data_incomplete', '缺少历史结算额时预览必须标记数据不完整');
    assert.ok(incompletePreviewJson.unresolvedTradeIds.length > 0, '预览必须返回未解决港股交易标识');
    console.log('nav-authority-regression: ALL PASS');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'nav_position_snapshots', 'nav_import_batches', 'account_data', 'accounts']) {
      try { await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]); } catch (e) {}
    }
    try { await pool.query('DELETE FROM users WHERE username=$1', [U]); } catch (e) {}
    // 测试使用真实历史日期，必须恢复共享汇率，禁止把测试值留在生产数据表。
    try {
      await pool.query(`DELETE FROM market.fx_rates WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date = ANY($1::date[])`, [[yesterday, todayCN()]]);
      for (const r of fxBackup) {
        await pool.query(
          `INSERT INTO market.fx_rates (base_currency, quote_currency, rate_date, source_id, rate, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (base_currency, quote_currency, rate_date, source_id) DO UPDATE SET rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`,
          [r.base_currency, r.quote_currency, r.rate_date, r.source_id, r.rate, r.fetched_at]
        );
      }
    } catch (e) { console.error('恢复测试汇率失败:', e.message); }
    await pool.end();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
