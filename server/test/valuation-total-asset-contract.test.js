// 估值输出口径合同回归（2026-11-15 第四轮验收）
// 覆盖：完整总资产与部分金额分离、缺价清空持仓价、导出不输出假市值/假比例、补漏未完成不得报成功。
// 全部在隔离库跑真实读取路径，不做网络采集。
const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { loadAccountData, loadAccountSummary, resolveHkRateEvidence } = require('../db');
const { buildPositionExport } = require('../services/positionExport');
const { summarizeBackfill, findMissingCloseDates } = require('../jobs/marketClose');
const priceRepository = require('../repositories/effectivePriceRepository');
const { isCnTradingDate, invalidateMarketStateCache } = require('../services/marketState');

const USER = 'valuation_total_contract';
const ACCOUNT = '估值口径账户';
let ACCOUNT_ID = null;

function cnDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
}

// 最近一个「应有收盘价」的 A 股交易日。
// 取价服务的 phase 口径是：盘前/非交易日回退上一交易日，盘中、午休和收盘后要求当日；
// 测试夹具必须与该口径一致，不能在盘中写入上一交易日再断言当日估值完整。
function expectedCloseDate() {
  const now = new Date();
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const [hour, minute] = clock.split(':').map(Number);
  const today = cnDate(now);
  const beforeOpen = hour * 60 + minute < 9 * 60 + 30;
  const startOffset = isCnTradingDate(today) && !beforeOpen ? 0 : 1;
  for (let offset = startOffset; offset <= 11; offset++) {
    const day = new Date(now.getTime() - offset * 86400000);
    const text = cnDate(day);
    if (isCnTradingDate(text)) return text;
  }
  throw new Error('未能定位最近 A 股交易日');
}

// 补漏扫描只覆盖最近一个已结束交易日（findMissingCloseDates 的同一口径），
// 因此这些夹具不能使用盘中仍在进行的当日。
function lastCompletedCloseDate() {
  const now = new Date();
  for (let offset = 1; offset <= 11; offset++) {
    const day = cnDate(new Date(now.getTime() - offset * 86400000));
    if (isCnTradingDate(day)) return day;
  }
  throw new Error('未能定位最近已结束 A 股交易日');
}

async function cleanup() {
  await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
  await pool.query('DELETE FROM account_data WHERE username=$1', [USER]);
  await pool.query('DELETE FROM positions WHERE username=$1', [USER]);
  await pool.query('DELETE FROM accounts WHERE username=$1', [USER]);
  await pool.query('DELETE FROM users WHERE username=$1', [USER]);
}

async function seed(positionPrice) {
  await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
  await pool.query('DELETE FROM positions WHERE username=$1', [USER]);
  await pool.query(
    `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype)
     VALUES ($1,$2,$3,$4,'600000','测试证券',$5,100,5,'股权','沪市')`,
    [crypto.randomUUID(), USER, ACCOUNT, ACCOUNT_ID, positionPrice]
  );
}

// 退市债夹具：持仓保留最后退市价，同时存在一条 legacy_unverified 旧日价（真实生产形态）。
async function seedDelisted(fixedPrice, legacyDailyPrice) {
  await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
  await pool.query('DELETE FROM positions WHERE username=$1', [USER]);
  await pool.query(
    `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype)
     VALUES ($1,$2,$3,$4,'404002','搜特退债',$5,1000,1,'股权','京市')`,
    [crypto.randomUUID(), USER, ACCOUNT, ACCOUNT_ID, fixedPrice]
  );
  if (legacyDailyPrice != null) {
    await pool.query(
      `INSERT INTO daily_prices (username, account_name, account_id, date, code, name, price, market, quality, is_final, source)
       VALUES ($1,$2,$3,$4,'404002','搜特退债',$5,'CN','legacy_unverified',null,'legacy_import')`,
      [USER, ACCOUNT, ACCOUNT_ID, expectedCloseDate(), legacyDailyPrice]
    );
  }
}

async function main() {
  await cleanup();
  ACCOUNT_ID = crypto.createHash('sha256').update(USER + '\n' + ACCOUNT).digest('hex');
  invalidateMarketStateCache();
  await pool.query(
    `INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')`,
    [USER, JSON.stringify([ACCOUNT])]
  );
  await pool.query(
    `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
     VALUES ($1,$2,$3,1000,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
    [ACCOUNT_ID, USER, ACCOUNT]
  );

  // 1. 完全没有价格证据：totalAsset 必须为空，部分金额单独给，旧持仓价字段被清空。
  await seed(0);
  const missing = await loadAccountData(USER, ACCOUNT);
  assert.strictEqual(missing.totalAssetComplete, false, '缺价时不得声称总资产完整');
  assert.strictEqual(missing.totalAsset, null, '缺价时完整总资产字段必须为空（不是部分金额）');
  assert.strictEqual(typeof missing.totalAssetPartial, 'number', '部分金额必须单独给出');
  assert.strictEqual(Math.round(missing.totalAssetPartial), 1000, '部分金额只含可估值部分（此处仅现金）');
  const missingPosition = missing.positions.find(position => position.code === '600000');
  assert.strictEqual(missingPosition.price, null, '缺价时不得继续返回旧持仓价');
  assert.strictEqual(missingPosition.priceKind, 'missing');
  assert.ok(missing.valuation && missing.valuation.complete === false);

  // 1b. 只有兼容持仓价（未确认参考价）：同样不算完整，导出不得据此输出市值/比例。
  await seed(12);
  const unverified = await loadAccountData(USER, ACCOUNT);
  assert.strictEqual(unverified.totalAssetComplete, false, '未确认参考价不得构成完整估值');
  assert.strictEqual(unverified.totalAsset, null, '不完整时完整总资产字段必须为空');
  const unverifiedPosition = unverified.positions.find(position => position.code === '600000');
  assert.strictEqual(unverifiedPosition.priceQuality, 'unverified_reference',
    '兼容持仓价必须标成未核实参考价，不能伪装成统一价格');
  const unverifiedExport = buildPositionExport(unverified);
  assert.strictEqual(unverifiedExport.complete, false);
  const unverifiedRow = unverifiedExport.rows.find(row => row[0] === '600000');
  assert.ok(String(unverifiedRow[3]).includes('未确认'), '未确认价格必须在导出里标注');
  assert.strictEqual(unverifiedRow[5], null, '未确认价格不得输出市值');
  assert.strictEqual(unverifiedRow[6], null, '未确认价格不得输出比例');

  // 1c. 明确退市债：本账户保留的 2.362 是当前有效估值，压过 legacy_unverified 旧日价；
  // 质量单独计数，导出允许输出市值与比例，且不回写 daily_prices。
  await seedDelisted(2.362, 2.31);
  const delisted = await loadAccountData(USER, ACCOUNT);
  assert.strictEqual(delisted.totalAssetComplete, true, '退市债固定价应构成该账户的完整当前估值');
  assert.strictEqual(Math.round(delisted.totalAsset), 3362, '完整总资产 = 1000 现金 + 1000×2.362');
  assert.strictEqual(delisted.valuation.complete, true);
  assert.strictEqual(delisted.valuation.manualDelisted, 1, '退市固定价必须单独计数');
  assert.strictEqual(delisted.valuation.confirmed, 0, '退市固定价不是市场收盘价，不能计入已确认收盘');
  const summary = await loadAccountSummary(USER, ACCOUNT);
  assert.strictEqual(summary.totalAsset, delisted.totalAsset, '总览摘要与完整账户必须使用同一批固定价');
  assert.strictEqual(summary.valuation.complete, true);
  assert.strictEqual(summary.valuation.prices['CN|404002'].price, 2.362);
  const delistedPosition = delisted.positions.find(position => position.code === '404002');
  assert.strictEqual(delistedPosition.price, 2.362, '持仓价必须是本账户退市固定价，不能取旧日价');
  assert.strictEqual(delistedPosition.priceQuality, 'manual_delisted');
  assert.strictEqual(delistedPosition.priceKind, 'manual_delisted');
  assert.strictEqual(delistedPosition.priceSource, 'positions.price');
  assert.strictEqual(delistedPosition.priceTradeDate, null, '退市固定价不得伪造交易日');
  const delistedExport = buildPositionExport(delisted);
  assert.strictEqual(delistedExport.complete, true, '导出必须认可该账户私有的有效估值');
  const delistedRow = delistedExport.rows.find(row => row[0] === '404002');
  assert.strictEqual(delistedRow[5], 2362, '退市固定价应输出人民币市值');
  assert.strictEqual(delistedRow[3], '2.362（退市固定价）', '导出保留退市固定价精度和来源类型');
  const delistedDaily = (await pool.query(
    'SELECT price::float8 AS price, quality FROM daily_prices WHERE username=$1 AND code=$2', [USER, '404002']
  )).rows[0];
  assert.strictEqual(delistedDaily.price, 2.31, '统一估值不得回写或覆盖 daily_prices');
  assert.strictEqual(delistedDaily.quality, 'legacy_unverified');

  // 回到“完全缺价”状态做导出断言。
  await seed(0);
  const missingAgain = await loadAccountData(USER, ACCOUNT);

  // 2. 导出：缺价行不得输出市值/比例，且不得按部分金额算比例。
  const incompleteExport = buildPositionExport(missingAgain);
  assert.strictEqual(incompleteExport.complete, false);
  assert.deepStrictEqual(incompleteExport.missingCodes, ['600000']);
  const incompleteRow = incompleteExport.rows.find(row => row[0] === '600000');
  assert.strictEqual(incompleteRow[3], '缺价', '缺价必须在导出里写明，而不是输出 0 或旧价');
  assert.strictEqual(incompleteRow[5], null, '缺价行不得输出市值');
  assert.strictEqual(incompleteRow[6], null, '缺价行不得输出比例');
  assert.ok(incompleteExport.rows.slice(1).every(row => row[6] == null), '不完整时任何比例都不能计算');
  const noteRow = incompleteExport.rows.at(-1);
  assert.ok(String(noteRow[2]).includes('估值不完整'), '导出必须显式标注不完整原因');

  // 3. 补齐已确认收盘价后：totalAsset 恢复数值，持仓价回到统一价格。
  const closeDate = expectedCloseDate();
  await pool.query(
    `INSERT INTO daily_prices (username, account_name, account_id, date, code, name, price, market, quality, is_final, source)
     VALUES ($1,$2,$3,$4,'600000','测试证券',10,'CN','confirmed',true,'test_close_task')`,
    [USER, ACCOUNT, ACCOUNT_ID, closeDate]
  );
  const complete = await loadAccountData(USER, ACCOUNT);
  assert.strictEqual(complete.totalAssetComplete, true, '全部证券有已确认收盘价时应判为完整');
  assert.strictEqual(Math.round(complete.totalAsset), 2000, '完整总资产 = 1000 现金 + 100×10 市值');
  assert.strictEqual(complete.totalAssetPartial, null, '完整时不再返回部分金额');
  const pricedPosition = complete.positions.find(position => position.code === '600000');
  assert.strictEqual(pricedPosition.price, 10, '持仓价必须是同批统一价格');
  assert.strictEqual(pricedPosition.priceQuality, 'confirmed');

  // 4. 导出：完整时按完整总资产算比例。
  const completeExport = buildPositionExport(complete);
  assert.strictEqual(completeExport.complete, true);
  const completeRow = completeExport.rows.find(row => row[0] === '600000');
  assert.strictEqual(completeRow[5], 1000);
  assert.strictEqual(completeRow[6], 0.5, '完整时比例按完整总资产计算');
  assert.ok(!String(completeExport.rows.at(-1)[2] || '').includes('估值不完整'), '完整时不得出现不完整提示');

  // 5. 补漏结果：失败/待授权/异常都必须判为未完成。
  const clean = summarizeBackfill({ accounts: 1, missingDates: 2, recorded: 3, failed: 0, blockedRevision: 0, errors: 0 });
  assert.strictEqual(clean.incomplete, false, '全部补齐时才算完成');
  const withFailure = summarizeBackfill({ accounts: 1, missingDates: 2, recorded: 1, failed: 1 });
  assert.strictEqual(withFailure.incomplete, true, '存在失败不得报成功');
  const withBlocked = summarizeBackfill({ accounts: 1, missingDates: 2, recorded: 0, blockedRevision: 2 });
  assert.strictEqual(withBlocked.incomplete, true, '存在待授权改写不得报成功');
  assert.ok(withBlocked.message.includes('待授权修订 2 条'));
  const withError = summarizeBackfill({ accounts: 1, missingDates: 1, recorded: 0, errors: 1 });
  assert.strictEqual(withError.incomplete, true, '被捕获的异常同样不得报成功');

  // 6. 汇率证据：只有市场汇率库的值才算已确认，账户默认值不算。
  {
    const noFx = resolveHkRateEvidence({ fx_rate: null, account_hk_rate: 0.868 });
    assert.strictEqual(noFx.hkRateConfirmed, false, '账户默认汇率不得被当作已确认汇率');
    assert.strictEqual(noFx.hkRateSource, 'account_default');
    assert.strictEqual(noFx.hkRate, 0.868, '默认值仍可作为显示兜底');
    const withFx = resolveHkRateEvidence({ fx_rate: 0.873, fx_rate_date: '2026-11-13', account_hk_rate: 0.868 });
    assert.strictEqual(withFx.hkRateConfirmed, true, '市场汇率库有值时才算已确认');
    assert.strictEqual(withFx.hkRateSource, 'market_fx');
    assert.strictEqual(withFx.hkRateDate, '2026-11-13', '汇率必须带日期证据');
    assert.strictEqual(withFx.hkRate, 0.873);
  }

  // 7. 导出：汇率未确认时港股不得输出确定的人民币市值。
  {
    const unconfirmed = buildPositionExport({
      hkRate: 0.868,
      hkRateConfirmed: false,
      valuation: { complete: false },
      positions: [
        { code: '00700', subtype: '港股', quantity: 100, price: 10, priceQuality: 'confirmed' },
        { code: '600000', subtype: '沪市', quantity: 10, price: 10, priceQuality: 'confirmed' },
      ],
    });
    const hkRow = unconfirmed.rows.find(row => row[0] === '00700');
    assert.ok(String(hkRow[3]).includes('汇率未确认'), '缺汇率必须在导出里标注：' + String(hkRow[3]));
    assert.strictEqual(hkRow[5], null, '缺汇率时不得输出人民币市值（不能拿 0.868 顶）');
    assert.strictEqual(hkRow[6], null, '缺汇率时不得输出比例');
    assert.deepStrictEqual(unconfirmed.fxMissingCodes, ['00700']);
    const cnRow = unconfirmed.rows.find(row => row[0] === '600000');
    assert.strictEqual(cnRow[5], 100, 'A 股不依赖港币汇率，市值照常给出');

    const confirmed = buildPositionExport({
      hkRate: 0.9, hkRateConfirmed: true,
      valuation: { complete: true }, totalAsset: 1000,
      positions: [{ code: '00700', subtype: '港股', quantity: 100, price: 10, priceQuality: 'confirmed' }],
    });
    assert.strictEqual(confirmed.rows.find(row => row[0] === '00700')[5], 900, '汇率确认后才算人民币市值');
    assert.deepStrictEqual(confirmed.fxMissingCodes, []);
  }

  // 8. 补漏：同一天部分证券缺价也必须算缺口（不能因“当天有任意一条确认价”就跳过）。
  {
    // 找最近一个 A 股交易日，在该日只给一只证券确认价，另一只缺失。
    const day = lastCompletedCloseDate();
    await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
    await pool.query('DELETE FROM positions WHERE username=$1', [USER]);
    await pool.query(
      `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype)
       VALUES ($1,$2,$3,$4,'600000','测试证券',10,100,5,'股权','沪市'),
              ($5,$2,$3,$4,'600519','测试证券二',10,100,5,'股权','沪市')`,
      [crypto.randomUUID(), USER, ACCOUNT, ACCOUNT_ID, crypto.randomUUID()]
    );
    await pool.query(
      `INSERT INTO daily_prices (username, account_name, account_id, date, code, name, price, market, quality, is_final, source)
       VALUES ($1,$2,$3,$4,'600000','测试证券',10,'CN','confirmed',true,'test_close_task')`,
      [USER, ACCOUNT, ACCOUNT_ID, day]
    );
    const gaps = await findMissingCloseDates(USER, ACCOUNT);
    assert.ok(gaps.includes(day), '同一天有一只证券缺确认价时该日必须仍算缺口：' + JSON.stringify(gaps));

    // 两只都补齐后该日不再是缺口。
    await pool.query(
      `INSERT INTO daily_prices (username, account_name, account_id, date, code, name, price, market, quality, is_final, source)
       VALUES ($1,$2,$3,$4,'600519','测试证券二',10,'CN','confirmed',true,'test_close_task')`,
      [USER, ACCOUNT, ACCOUNT_ID, day]
    );
    const filled = await findMissingCloseDates(USER, ACCOUNT);
    assert.ok(!filled.includes(day), '逐证券补齐后该日不应再列为缺口');
  }

  // 9. 新补录的日价必须自带市场依据，否则同形代码会被取价层判成身份不明。
  {
    await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
    const written = await priceRepository.upsertDailyPrice([{
      username: USER, accountName: ACCOUNT, accountId: ACCOUNT_ID,
      date: lastCompletedCloseDate(), code: '000001', name: '测试A股', price: 10,
      source: 'history_backfill:lixinger', quoteAt: null, isFinal: true, quality: 'confirmed',
      market: 'CN', evidence: { origin: 'daily_bar_history', provider: 'lixinger', price_adjust: 'none' },
    }]);
    assert.strictEqual(written.rowCount, 1, '补录写入应成功');
    const stored = (await pool.query(
      'SELECT market, evidence FROM daily_prices WHERE username=$1 AND code=$2', [USER, '000001']
    )).rows[0];
    assert.strictEqual(stored.market, 'CN');
    assert.strictEqual(stored.evidence.market_basis, 'writer_declared',
      '写入时必须留下市场依据，否则同形代码会被判身份不明：' + JSON.stringify(stored.evidence));
    assert.strictEqual(stored.evidence.provider, 'lixinger', '来源与口径必须随行保存');
    assert.strictEqual(stored.evidence.price_adjust, 'none');

    // 无法判定市场的代码：写 UNKNOWN 且不带可核实依据（失败关闭）。
    await priceRepository.upsertDailyPrice([{
      username: USER, accountName: ACCOUNT, accountId: ACCOUNT_ID,
      date: lastCompletedCloseDate(), code: '000777', name: '身份不明', price: 5,
      source: null, quoteAt: null, isFinal: null, quality: 'candidate', market: null, evidence: {},
    }]);
    const unknown = (await pool.query(
      'SELECT market, evidence FROM daily_prices WHERE username=$1 AND code=$2', [USER, '000777']
    )).rows[0];
    assert.strictEqual(unknown.market, 'UNKNOWN', '身份无法判定时必须写 UNKNOWN');
    assert.strictEqual(unknown.evidence.market_basis, 'unverified');
  }

  console.log('估值输出口径合同回归通过');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原结论 */ }
    await pool.end().catch(() => {});
  });
