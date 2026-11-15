// 收盘任务连续重跑回归（2026-11-15 第八轮三次复核 P1）
//
// 覆盖三类会让"重跑误报成功"的场景，全部在真实隔离库上跑，行情用替身：
//   A. 共享日线写库失败 → 缺口落库；重跑即使账户日价已确认也必须继续核验，补齐后才成功。
//   B. 缺口表本身异常（登记/读取/计数全失败）→ 不能把未知状态当成"没有缺口"，
//      两次运行都必须报未完成；缺口表恢复后要能从日价证据重建缺口，状态不丢。
//   C. 日线已落库但分区发布失败 → 重跑在"没有新增日线、没有待重试缺口"时也要补发布。
const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const DATE = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const PRICE = 12.5;
const USER = 'market_close_bar_gap';
const ACCOUNT = '收盘缺口重跑账户';
const JOB_LABEL = 'A股';

// 行情与市场状态替身必须在 require marketClose 之前替换（该模块在加载时解构这些函数）。
const marketState = require('../services/marketState');
marketState.getMarketState = async () => ({
  status: 'open', isAfterMarketClose: true, closeTime: '15:00', closeQuoteTime: '15:00',
});
marketState.isCnTradingDate = () => true;
marketState.prefetchMarketFacts = async () => {};
marketState.shanghaiDateTime = () => ({ time: '15:30' });

const datasets = require('../dataAccess/marketDatasets');
let seriesCalls = 0;
const seriesRequested = [];
datasets.readRealtimeQuotes = async ({ codes } = {}) => new Map((codes || []).map(code => [String(code), {
  code: String(code), name: '收盘重跑测试证券', price: PRICE, quote_time: `${DATE}T15:05:00+08:00`,
}]));
datasets.readHistoricalCloseSeries = async ({ tsCode, kind } = {}) => {
  seriesCalls += 1;
  seriesRequested.push({ tsCode: String(tsCode || ''), kind: String(kind || '') });
  return [{ trade_date: DATE.replace(/-/g, ''), close: PRICE, source_code: 'tushare', price_adjust: 'none' }];
};

// 分区发布替身：用开关注入"发布失败"，验证重跑是否补发布。
const datasetPartitions = require('../services/datasetPartitions');
const realPublishPartition = datasetPartitions.publishDatasetPartition;
let publishFailure = null;
datasetPartitions.publishDatasetPartition = async (...args) => {
  if (publishFailure) throw new Error(publishFailure);
  return realPublishPartition(...args);
};

const { pool } = require('../db/connection');
const repository = require('../repositories/marketCloseRepository');
const marketClose = require('../jobs/marketClose');

let ACCOUNT_ID = null;
const CODES = {
  gap: '689998', storeBroken: '689997', publishBroken: '689996', resolveBroken: '689995',
  crossStock: '689994', crossBond: '113994',
};
const tsCodeOf = code => `${code}.SH`;

// 缺口表替身：用开关模拟"权限异常/表不可用"，验证异常不能被降级成"没有缺口"。
// only 只让指定方法报错（例如只让"销账"失败，模拟日线已写好、发布成功但销账那一步撞上异常）。
const gapStoreFault = {
  active: false,
  only: null,
  methods: ['upsert_bar_gap', 'resolve_bar_gap', 'select_open_bar_gaps', 'count_open_bar_gaps', 'select_unsynced_bar_evidence'],
};
const gapStoreOriginals = {};
for (const method of gapStoreFault.methods) {
  gapStoreOriginals[method] = repository[method];
  repository[method] = async (...args) => {
    if (gapStoreFault.active && (!gapStoreFault.only || gapStoreFault.only.includes(method))) {
      throw new Error('injected gap store failure');
    }
    return gapStoreOriginals[method](...args);
  };
}

async function cleanupCode(code) {
  const tsCode = tsCodeOf(code);
  // 按证券销账：缺口可能挂在任意任务标签下，清理时不能只看当前标签。
  await pool.query('DELETE FROM ops.market_close_bar_gaps WHERE ts_code=$1', [tsCode]);
  await pool.query(
    `DELETE FROM market.daily_bars WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code=$1)`,
    [tsCode],
  );
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [tsCode]);
}

async function cleanup() {
  for (const code of Object.values(CODES)) await cleanupCode(code);
  await pool.query('DELETE FROM ops.dataset_partitions WHERE dataset_code=$1 AND partition_key=$2::date', ['position_close_bars_cn', DATE]);
  await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
  await pool.query('DELETE FROM account_data WHERE username=$1', [USER]);
  await pool.query('DELETE FROM positions WHERE username=$1', [USER]);
  await pool.query('DELETE FROM accounts WHERE username=$1', [USER]);
  await pool.query('DELETE FROM users WHERE username=$1', [USER]);
}

async function ensureInstrument(code) {
  await pool.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market) VALUES($1,'收盘重跑测试证券','stock','CN')
     ON CONFLICT (canonical_code) DO NOTHING`,
    [tsCodeOf(code)],
  );
}

// 每个场景重置成：一个账户 + 指定持仓，当天没有任何日价/日线/分区/缺口。
async function resetScenarioWithPositions(entries) {
  await pool.query('DELETE FROM daily_prices WHERE username=$1', [USER]);
  await pool.query('DELETE FROM positions WHERE username=$1', [USER]);
  await pool.query(
    "DELETE FROM ops.dataset_partitions WHERE dataset_code IN ('position_close_bars_cn','position_close_bars_hk') AND partition_key=$1::date",
    [DATE],
  );
  for (const entry of entries) await cleanupCode(entry.code);
  if (!(await pool.query('SELECT 1 FROM users WHERE username=$1', [USER])).rowCount) {
    await pool.query(
      `INSERT INTO users (username,password,accounts,role,status) VALUES ($1,'x',$2,'user','active')`,
      [USER, JSON.stringify([ACCOUNT])],
    );
  }
  if (!(await pool.query('SELECT 1 FROM accounts WHERE username=$1', [USER])).rowCount) {
    await pool.query(
      `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
       VALUES ($1,$2,$3,0,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))`,
      [ACCOUNT_ID, USER, ACCOUNT],
    );
  }
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype)
       VALUES ($1,$2,$3,$4,$5,$6,0,100,5,$7,$8)`,
      [crypto.randomUUID(), USER, ACCOUNT, ACCOUNT_ID, entry.code,
        entry.name || '收盘重跑测试证券', entry.type || '股权', entry.subtype || '沪市'],
    );
  }
}

async function resetScenario(code) {
  await resetScenarioWithPositions([{ code }]);
}

const runCloseFor = (label, code) => marketClose.runMarketCloseByLabel(label, DATE, {
  accounts: [{ username: USER, account_name: ACCOUNT }],
  quoteMap: new Map([[code, { code, price: PRICE, quote_time: `${DATE}T15:05:00+08:00` }]]),
});

const runClose = code => runCloseFor(JOB_LABEL, code);

async function barEvidenceRows(code) {
  const { rows } = await pool.query(
    `SELECT b.close::float8 AS close
       FROM market.daily_bars b JOIN core.instruments i ON i.instrument_id=b.instrument_id
      WHERE upper(i.canonical_code)=upper($1) AND b.trade_date=$2::date
        AND b.bar_status='terminal' AND b.price_adjust='none' AND b.quality_status='passed'`,
    [tsCodeOf(code), DATE],
  );
  return rows;
}

async function gapRowsFor(label, code) {
  const { rows } = await pool.query(
    'SELECT job_label, reason, attempts, resolved_at FROM ops.market_close_bar_gaps WHERE job_label=$1 AND ts_code=$2 AND trade_date=$3::date',
    [label, tsCodeOf(code), DATE],
  );
  return rows;
}

async function gapRows(code) {
  return gapRowsFor(JOB_LABEL, code);
}

async function accountPrice(code) {
  const { rows } = await pool.query(
    'SELECT quality, is_final, evidence FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 AND code=$4',
    [USER, ACCOUNT, DATE, code],
  );
  return rows[0] || null;
}

async function partitionRow() {
  const { rows } = await pool.query(
    `SELECT status FROM ops.dataset_partitions WHERE dataset_code=$1 AND scope_key='CN' AND partition_key=$2::date`,
    ['position_close_bars_cn', DATE],
  );
  return rows[0] || null;
}

// ---------- A. 共享日线写库失败 -> 缺口落库 -> 重跑继续核验 ----------
async function scenarioGapRecovery() {
  await resetScenario(CODES.gap);
  const first = await runClose(CODES.gap);
  assert.strictEqual(first.ok, false, '共享日线没写进去时第一次运行不得报成功：' + JSON.stringify(first));
  assert.strictEqual(first.status, 'partial');
  assert.strictEqual(first.errorType, 'shared_bar_incomplete');
  assert.strictEqual(first.pricesRecorded, true, '账户收盘价已记录，下游净值应能继续');
  assert.ok(Number(first.sharedBarPersist.gapsOpen) >= 1, '缺口必须落库，不能只留在内存');
  const gaps1 = await gapRows(CODES.gap);
  assert.strictEqual(gaps1.length, 1, '缺口表必须有一条未销账记录');
  assert.ok(!gaps1[0].resolved_at, '缺口未补齐前不得销账');
  assert.strictEqual(gaps1[0].reason, 'instrument_or_source_not_found');
  assert.deepStrictEqual(await barEvidenceRows(CODES.gap), [], '共享日线确实没有落库');
  const price1 = await accountPrice(CODES.gap);
  assert.ok(price1, '账户日价已确认（这正是第二次运行会跳过的原因）');
  assert.strictEqual(price1.quality, 'confirmed');

  const before = seriesCalls;
  const second = await runClose(CODES.gap);
  assert.ok(seriesCalls > before, '重跑必须继续核验共享日线缺口，不能因账户日价已确认就跳过');
  assert.strictEqual(second.ok, false, '缺口仍在时第二次运行也不能报成功：' + JSON.stringify(second));
  assert.strictEqual(second.status, 'partial');
  assert.ok(Number(second.sharedBarPersist.gapsRetried) >= 1, '必须重试上一次留下的缺口');
  assert.ok(Number(second.sharedBarPersist.gapsOpen) >= 1, '仍失败的缺口必须继续留着');
  assert.strictEqual(second.sharedBarPublication, 'incomplete', '不得再报 complete');
  assert.notStrictEqual(second.barPartitionStatus, 'not_needed', '缺口未清时不能说"无需发布"');
  const gaps2 = await gapRows(CODES.gap);
  assert.strictEqual(gaps2.length, 1, '同一证券同一天只保留一条缺口');
  assert.ok(Number(gaps2[0].attempts) >= 2, '重复失败必须累加尝试次数，便于判断是否卡住');
  assert.deepStrictEqual(await barEvidenceRows(CODES.gap), [], '第二次运行后共享日线仍不存在');

  await ensureInstrument(CODES.gap);
  const third = await runClose(CODES.gap);
  assert.strictEqual(third.ok, true, '缺口补齐后任务才允许成功：' + JSON.stringify(third));
  assert.strictEqual(third.status, 'succeeded');
  assert.strictEqual(third.sharedBarPublication, 'complete');
  assert.strictEqual(Number(third.sharedBarPersist.gapsOpen), 0, '缺口必须清零');
  const gaps3 = await gapRows(CODES.gap);
  assert.ok(gaps3[0].resolved_at, '补齐后必须销账');
  const bars = await barEvidenceRows(CODES.gap);
  assert.strictEqual(bars.length, 1, '共享日线必须真的落库');
  assert.strictEqual(Number(bars[0].close), PRICE);
  assert.strictEqual((await partitionRow()).status, 'published', '证据分区必须发布');

  const fourth = await runClose(CODES.gap);
  assert.strictEqual(fourth.ok, true, '已补完后重跑必须成功：' + JSON.stringify(fourth));
  assert.strictEqual(Number(fourth.sharedBarPersist.gapsOpen), 0);
}

// ---------- B. 缺口表异常 -> 不能把未知状态当成"没有缺口" ----------
async function scenarioGapStoreUnavailable() {
  await resetScenario(CODES.storeBroken);
  gapStoreFault.active = true;
  try {
    const first = await runClose(CODES.storeBroken);
    assert.strictEqual(first.ok, false, '缺口登记失败时第一次运行必须报未完成：' + JSON.stringify(first));
    assert.strictEqual(first.status, 'partial');
    assert.ok(first.sharedBarPersist.storeError, '缺口表异常必须出现在任务结果里');
    assert.ok(String(first.sharedBarPersist.storeError.reason).includes('injected gap store failure'));

    // 关键反例：第二次运行时账户日价已确认、缺口表仍不可用。
    // 不能因为"查不到缺口"就当成没有缺口，必须继续报未完成。
    const before = seriesCalls;
    const second = await runClose(CODES.storeBroken);
    assert.strictEqual(second.ok, false, '缺口表不可用时第二次运行绝不能报成功：' + JSON.stringify(second));
    assert.strictEqual(second.status, 'partial');
    assert.notStrictEqual(second.barPartitionStatus, 'not_needed', '未知状态不能说"无需发布"');
    assert.ok(second.sharedBarPersist.storeError, '第二次仍要如实报出缺口表异常');
    assert.strictEqual(seriesCalls, before, '缺口读不出来时不会重复外采（但也不能声称完成）');
  } finally {
    gapStoreFault.active = false;
  }

  // 缺口表恢复后：仍没有缺口行，必须能从账户日价证据重建缺口，状态不能丢。
  const rebuilt = await runClose(CODES.storeBroken);
  assert.strictEqual(rebuilt.ok, false, '缺口重建后仍未补齐，必须报未完成：' + JSON.stringify(rebuilt));
  const gaps = await gapRows(CODES.storeBroken);
  assert.strictEqual(gaps.length, 1, '缺口表恢复后必须能从日价证据重建缺口');
  assert.ok(!gaps[0].resolved_at);

  // 证据里必须能看出"这条终盘证据没写回共享日线"，否则重建就无从下手。
  const price = await accountPrice(CODES.storeBroken);
  assert.strictEqual(price.evidence.terminalPersisted, false, '日价证据必须标记未写回共享日线');
  assert.strictEqual(price.evidence.terminalTsCode, tsCodeOf(CODES.storeBroken), '证据必须带上日线代码');
  assert.strictEqual(price.evidence.terminalKind, 'stock', '证据必须带上品种');

  await ensureInstrument(CODES.storeBroken);
  const healed = await runClose(CODES.storeBroken);
  assert.strictEqual(healed.ok, true, '补齐后必须成功：' + JSON.stringify(healed));
  assert.strictEqual(Number(healed.sharedBarPersist.gapsOpen), 0);
}

// ---------- C. 日线已落库但分区发布失败 -> 重跑必须补发布 ----------
async function scenarioPublishRetry() {
  await resetScenario(CODES.publishBroken);
  await ensureInstrument(CODES.publishBroken);
  publishFailure = 'injected publish failure';
  try {
    const first = await runClose(CODES.publishBroken);
    assert.strictEqual(first.ok, false, '分区发布失败时第一次必须报未完成：' + JSON.stringify(first));
    assert.strictEqual(first.barPartitionStatus, 'publish_failed');
    assert.ok(Number(first.persistedBars) >= 1, '日线本身已经落库');
    assert.strictEqual(await partitionRow(), null, '分区确实没发布');
    assert.strictEqual((await barEvidenceRows(CODES.publishBroken)).length, 1, '日线证据行存在');

    // 第二次：账户日价已确认、没有新增日线、也没有待重试缺口 —— 仍然必须补发布并失败。
    const beforeSeries = seriesCalls;
    const second = await runClose(CODES.publishBroken);
    assert.strictEqual(second.ok, false, '发布仍失败时第二次不能报成功：' + JSON.stringify(second));
    assert.strictEqual(second.barPartitionStatus, 'publish_failed');
    assert.strictEqual(seriesCalls, beforeSeries, '这一轮没有新增日线（差异只在发布）');
  } finally {
    publishFailure = null;
  }

  // 发布恢复后重跑：没有新增日线也要把已有合格日线重新发布出去。
  const third = await runClose(CODES.publishBroken);
  assert.strictEqual(third.ok, true, '发布恢复后重跑必须成功：' + JSON.stringify(third));
  assert.strictEqual(Number(third.persistedBars), 0, '这一轮确实没有新增日线');
  assert.strictEqual((await partitionRow()).status, 'published', '已有合格日线必须被补发布');
}

// ---------- D. 销账失败 -> 日线已发布 -> 故障恢复 -> 重跑必须销账成功 ----------
async function scenarioResolveFailureRecovery() {
  await resetScenario(CODES.resolveBroken);
  // 第 1 次：主档缺失 -> 日线写不进去 -> 缺口落库。
  const first = await runClose(CODES.resolveBroken);
  assert.strictEqual(first.ok, false);
  assert.strictEqual((await gapRows(CODES.resolveBroken)).length, 1, '缺口已登记');

  // 第 2 次：主档补齐、日线与分区都成功，但"销账"这一步撞上缺口表异常。
  await ensureInstrument(CODES.resolveBroken);
  gapStoreFault.active = true;
  gapStoreFault.only = ['resolve_bar_gap'];
  try {
    const second = await runClose(CODES.resolveBroken);
    assert.strictEqual(second.ok, false, '销账失败时不能报成功：' + JSON.stringify(second));
    assert.ok(second.sharedBarPersist.storeError, '销账异常必须出现在任务结果里');
    assert.ok(String(second.sharedBarPersist.storeError.action).includes('销账'));
  } finally {
    gapStoreFault.active = false;
    gapStoreFault.only = null;
  }
  // 数据层面其实已经补齐：日线在、分区也发布了，只是缺口没销账。
  assert.strictEqual((await barEvidenceRows(CODES.resolveBroken)).length, 1, '日线已落库');
  assert.strictEqual((await partitionRow()).status, 'published', '分区已发布');
  const stuck = await gapRows(CODES.resolveBroken);
  assert.strictEqual(stuck.length, 1);
  assert.ok(!stuck[0].resolved_at, '销账失败后缺口仍开着（这正是会卡住的原因）');

  // 第 3 次：故障恢复后重跑会命中已发布日线（published_bar），必须照样销账。
  const beforeSeries = seriesCalls;
  const third = await runClose(CODES.resolveBroken);
  assert.strictEqual(seriesCalls, beforeSeries, '命中已发布日线时不应再外采');
  assert.strictEqual(third.ok, true, '已发布日线命中后必须销账并成功：' + JSON.stringify(third));
  assert.strictEqual(third.status, 'succeeded');
  assert.strictEqual(Number(third.sharedBarPersist.gapsOpen), 0, '缺口必须销账');
  const healed = await gapRows(CODES.resolveBroken);
  assert.ok(healed[0].resolved_at, '命中已发布日线也必须销账，否则任务会一直 partial');

  // 第 4 次：确认不会再重复产生缺口。
  const fourth = await runClose(CODES.resolveBroken);
  assert.strictEqual(fourth.ok, true);
  assert.strictEqual(Number(fourth.sharedBarPersist.gapsOpen), 0);
}

// ---------- E. 跨品种隔离：A 股任务不得接手可转债/基金缺口 ----------
async function scenarioCrossKindIsolation() {
  await resetScenarioWithPositions([
    { code: CODES.crossStock, name: '跨品种测试股票', type: '股权', subtype: '沪市' },
    { code: CODES.crossBond, name: '跨品种测试转债', type: '债权', subtype: '可转债' },
  ]);

  // 先跑可转债任务：只给自己的品种登记缺口。
  const bondRun = await runCloseFor('可转债', CODES.crossBond);
  assert.strictEqual(bondRun.ok, false, '可转债任务自己也有缺口，必须报未完成');
  assert.strictEqual((await gapRowsFor('可转债', CODES.crossBond)).length, 1, '可转债缺口必须挂在可转债任务下');
  assert.strictEqual((await gapRowsFor('可转债', CODES.crossStock)).length, 0, '可转债任务不得登记股票缺口');

  // 再跑 A 股任务：此时账户里可转债的日价证据已经存在（terminalPersisted=false），
  // 若重建缺口不按品种筛选，就会把可转债登记到 A 股任务名下并去取转债日线。
  seriesRequested.length = 0;
  const stockRun = await runClose(CODES.crossStock);
  assert.strictEqual(stockRun.ok, false, '股票自己的缺口仍在，必须报未完成');
  assert.strictEqual(seriesRequested.filter(item => item.tsCode === tsCodeOf(CODES.crossBond)).length, 0,
    'A 股任务不得去取可转债日线');
  assert.strictEqual((await gapRowsFor(JOB_LABEL, CODES.crossBond)).length, 0,
    'A 股任务不得把可转债登记成自己的缺口');
  assert.strictEqual((await gapRowsFor(JOB_LABEL, CODES.crossStock)).length, 1, '股票缺口挂在自己的任务下');
  const samples = (stockRun.sharedBarPersist && stockRun.sharedBarPersist.samples) || [];
  assert.ok(!samples.some(item => String(item.identity).includes(CODES.crossBond)),
    'A 股任务的失败对象里不得出现可转债');

  // 反向：可转债任务重跑也不得接手股票缺口、不得取股票日线。
  seriesRequested.length = 0;
  const bondAgain = await runCloseFor('可转债', CODES.crossBond);
  assert.strictEqual(bondAgain.ok, false);
  assert.strictEqual(seriesRequested.filter(item => item.tsCode === tsCodeOf(CODES.crossStock)).length, 0,
    '可转债任务不得去取股票日线');
  assert.strictEqual((await gapRowsFor('可转债', CODES.crossStock)).length, 0);
  assert.strictEqual((await gapRowsFor(JOB_LABEL, CODES.crossStock)).length, 1, '股票缺口不受可转债任务影响');

  // 品种范围是显式登记的：未登记品种的任务不参与缺口重建。
  assert.deepStrictEqual(marketClose.LABEL_TERMINAL_KINDS['A股'], ['stock']);
  assert.deepStrictEqual(marketClose.LABEL_TERMINAL_KINDS['可转债'], ['bond']);
  assert.strictEqual(marketClose.labelOwnsKind('A股', 'bond'), false, 'A 股任务不拥有可转债品种');
  assert.strictEqual(marketClose.labelOwnsKind('可转债', 'stock'), false);
  assert.strictEqual(marketClose.labelOwnsKind('非标准证券', 'stock'), false, '未登记品种范围的任务不重建缺口');
}

async function main() {
  await cleanup();
  ACCOUNT_ID = crypto.createHash('sha256').update(USER + '\n' + ACCOUNT).digest('hex');

  await scenarioGapRecovery();
  await scenarioGapStoreUnavailable();
  await scenarioPublishRetry();
  await scenarioResolveFailureRecovery();
  await scenarioCrossKindIsolation();

  console.log('收盘任务连续重跑回归通过：缺口落库、缺口表异常不误报成功、重跑继续核验与补发布、已发布日线也销账、跨品种不串扰');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原结论 */ }
    await pool.end().catch(() => {});
  });
