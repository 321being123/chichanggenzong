// 估值输出口径合同回归（2026-11-15 第四轮验收）
// 覆盖：完整总资产与部分金额分离、缺价清空持仓价、导出不输出假市值/假比例、补漏未完成不得报成功。
// 全部在隔离库跑真实读取路径，不做网络采集。
const assert = require('assert');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { loadAccountData } = require('../db');
const { buildPositionExport } = require('../services/positionExport');
const { summarizeBackfill } = require('../jobs/marketClose');
const { isCnTradingDate, invalidateMarketStateCache } = require('../services/marketState');

const USER = 'valuation_total_contract';
const ACCOUNT = '估值口径账户';
let ACCOUNT_ID = null;

function cnDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
}

// 最近一个 A 股应有收盘日（今天若休市则回退）。
function expectedCloseDate() {
  const base = new Date();
  for (let offset = 0; offset <= 10; offset++) {
    const day = new Date(base.getTime() - offset * 86400000);
    const text = cnDate(day);
    if (isCnTradingDate(text)) return text;
  }
  throw new Error('未能定位最近 A 股交易日');
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

  console.log('估值输出口径合同回归通过');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原结论 */ }
    await pool.end().catch(() => {});
  });
