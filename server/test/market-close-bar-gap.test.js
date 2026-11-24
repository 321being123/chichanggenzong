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

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const DATE = '2026-11-18';
const PRICE = 12.5;
const USER = 'market_close_bar_gap';
const ACCOUNT = '收盘缺口重跑账户';
const JOB_LABEL = 'A股';

// 行情与市场状态替身必须在 require marketClose 之前替换（该模块在加载时解构这些函数）。
const marketState = require('../services/marketState');
marketState.getMarketState = async ({ market }) => ({
  status: 'open', isAfterMarketClose: true, closeTime: market === 'HK' ? '16:10' : '15:00',
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
// 收盘终盘走按品种原子合并的发布入口，两个入口都要能注入失败。
const datasetPartitions = require('../services/datasetPartitions');
const realPublishPartition = datasetPartitions.publishDatasetPartition;
const realPublishCoverage = datasetPartitions.publishCoveragePartition;
let publishFailure = null;
datasetPartitions.publishDatasetPartition = async (...args) => {
  if (publishFailure) throw new Error(publishFailure);
  return realPublishPartition(...args);
};
datasetPartitions.publishCoveragePartition = async (...args) => {
  if (publishFailure) throw new Error(publishFailure);
  return realPublishCoverage(...args);
};

const { pool } = require('../db/connection');
const repository = require('../repositories/marketCloseRepository');
const marketClose = require('../jobs/marketClose');
const { datasetDependencyState } = require('../services/jobScheduleSlots');
const historicalDependency = coverageKind => ({
  jobCode: coverageKind === 'bond' ? 'market_close:可转债' : 'market_close:LOF/ETF',
  readinessDatasetDependencies: [{ datasetCode: 'position_close_bars_cn', scopeKey: 'CN',
    partitionDatePolicy: 'business_date', requireQualityStatus: 'passed', coverageKind }],
});

let ACCOUNT_ID = null;
const CODES = {
  gap: '689998', storeBroken: '689997', publishBroken: '689996', resolveBroken: '689995',
  crossStock: '689994', crossBond: '113994',
  partialOne: '113991', partialTwo: '113992',
  heldOnly: '113993', fund: '510300',
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
  await pool.query('DELETE FROM nav_history WHERE username=$1', [USER]);
  await pool.query('DELETE FROM nav_position_snapshots WHERE username=$1', [USER]);
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

// 历史场景从已有账户确认价及上版未持久化的终盘证据开始。
async function resetScenarioWithPositions(entries, { historical = true } = {}) {
  await pool.query('DELETE FROM nav_history WHERE username=$1', [USER]);
  await pool.query('DELETE FROM nav_position_snapshots WHERE username=$1', [USER]);
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
    if (historical) await seedHistoricalPrice(entry.code);

  }
}

async function seedHistoricalPrice(code) {
  const kind = code.startsWith('11') ? 'bond' : code.startsWith('51') ? 'fund' : 'stock';
  const label = kind === 'bond' ? '可转债' : kind === 'fund' ? 'LOF/ETF' : JOB_LABEL;
  await require('../db').saveDailyPrices(USER, ACCOUNT, DATE, [{
    code, price: PRICE, market: 'CN', quality: 'confirmed', is_final: true,
    source: 'market_close_task:' + label, evidence: {
      terminalPersisted: false, terminalTsCode: tsCodeOf(code), terminalKind: kind,
    },
  }]);
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

async function accountPrice(code, date = DATE) {
  const { rows } = await pool.query(
    'SELECT quality, is_final, evidence, price, quote_at, market FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 AND code=$4',
    [USER, ACCOUNT, date, code],
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

  // 反例回归：共享 CN 分区已有 A 股终盘行时，不能把它当成可转债覆盖并唤醒转债槽。
  await ensureInstrument(CODES.crossStock);
  const stockComplete = await runCloseFor(JOB_LABEL, CODES.crossStock);
  assert.strictEqual(stockComplete.ok, true, '股票终盘证据准备必须成功');
  const wrongKindPublish = await marketClose.publishCloseBarPartition('CN', DATE, '可转债', [{ username: USER }]);
  assert.strictEqual(wrongKindPublish.rowCount, 0, '可转债发布只统计可转债终盘行');
  const { rows: partitionDiagnostics } = await pool.query(
    `SELECT diagnostics FROM ops.dataset_partitions WHERE dataset_code='position_close_bars_cn' AND scope_key='CN' AND partition_key=$1::date`,
    [DATE],
  );
  const coverageKinds = partitionDiagnostics[0] && partitionDiagnostics[0].diagnostics && partitionDiagnostics[0].diagnostics.coverage_kinds;
  assert.deepStrictEqual(coverageKinds, ['stock'], '股票分区不得写入 bond 覆盖标记');
}

// ---------- E. 部分覆盖不得把整类分区判成质量通过（2026-11-19 复验 P1） ----------
// 复现：两只可转债都有已确认账户日价，只有一只的终盘日线落库。
// 旧实现只拦 rowCount<=0，于是分区 quality_status=passed、调度重验直接判整类就绪。
async function scenarioPartialCoverage() {
  // 缺口按「任务标签 + 交易日」整批重试，上一个场景留下的证券缺口也会被拉进来，
  // 必须先清掉，否则本次运行会去补不属于本场景的证券。
  for (const code of [CODES.crossBond, CODES.crossStock]) await cleanupCode(code);
  await resetScenarioWithPositions([
    { code: CODES.partialOne, subtype: '沪市' },
    { code: CODES.partialTwo, subtype: '沪市' },
  ]);
  // 只给第一只建主档：第二只的终盘日线一定写不进去（instrument_or_source_not_found）。
  await ensureInstrument(CODES.partialOne);
  const quote = code => ({ code, price: PRICE, quote_time: `${DATE}T15:05:00+08:00` });
  const partialRun = await marketClose.runMarketCloseByLabel('可转债', DATE, {
    accounts: [{ username: USER, account_name: ACCOUNT }],
    quoteMap: new Map([[CODES.partialOne, quote(CODES.partialOne)], [CODES.partialTwo, quote(CODES.partialTwo)]]),
    });
  assert.strictEqual(partialRun.ok, false, '部分证券缺终盘日线时任务必须报未完成');
  const secondPrice = await accountPrice(CODES.partialTwo);
  assert.ok(secondPrice && secondPrice.quality === 'confirmed', '第二只账户日价应已确认，差值只能体现在共享日线覆盖上');
  const published = await marketClose.publishCloseBarPartition('CN', DATE, '可转债', [{ username: USER }]);
  assert.strictEqual(published.coverage.status, 'partial',
    '部分覆盖必须判成 partial：' + JSON.stringify(published.coverage));
  assert.strictEqual(published.coverage.expected, 2, '目标证券来自两只已确认账户日价的转债');
  assert.strictEqual(published.coverage.covered, 1, '只有一只有合格终盘日线');
  assert.strictEqual(published.qualityStatus, 'failed', '部分覆盖不得标成质量通过');
  const { rows } = await pool.query(
    `SELECT diagnostics FROM ops.dataset_partitions
      WHERE dataset_code='position_close_bars_cn' AND scope_key='CN' AND partition_key=$1::date`,
    [DATE],
  );
  const diagnostics = rows[0] && rows[0].diagnostics;
  assert.strictEqual(diagnostics.quality_status, 'failed', '分区质量必须反映覆盖缺口，调度重验才不会被误判为就绪');
  assert.strictEqual(diagnostics.coverage_status, 'partial');
  assert.strictEqual(Number(diagnostics.expected_count), 2);
  assert.strictEqual(Number(diagnostics.covered_count), 1);

  // 补齐第二只后再次发布：覆盖完整才允许 passed。
  await ensureInstrument(CODES.partialTwo);
  const completed = await marketClose.runMarketCloseByLabel('可转债', DATE, {
    accounts: [{ username: USER, account_name: ACCOUNT }],
    quoteMap: new Map([[CODES.partialOne, quote(CODES.partialOne)], [CODES.partialTwo, quote(CODES.partialTwo)]]),
    });
  assert.strictEqual(completed.ok, true, '补齐后任务必须成功：' + JSON.stringify(completed));
  const republished = await marketClose.publishCloseBarPartition('CN', DATE, '可转债', [{ username: USER }]);
  assert.strictEqual(republished.coverage.status, 'complete', '覆盖齐全后必须判 complete');
  assert.strictEqual(republished.qualityStatus, 'passed');
  assert.strictEqual((await partitionRow()).status, 'published');
}

// ---------- F. 共享 CN 分区的品种覆盖不得互相顶替（2026-11-19 复验 P1） ----------
// 复现：两只转债一只缺终盘 → 转债部分覆盖；同日基金任务完整发布后，
// 旧实现用最后一次发布的质量覆盖整行，转债在零新增记录下变成"已就绪"。
// 同时验证覆盖分母包含持仓：只有持仓、没有账户日价的证券也必须计入。
async function scenarioCrossKindCoverage() {
  for (const code of [CODES.heldOnly, CODES.fund]) await cleanupCode(code);
  await resetScenarioWithPositions([
    { code: CODES.partialOne, subtype: '沪市' },
    { code: CODES.partialTwo, subtype: '沪市' },
  ]);
  await ensureInstrument(CODES.partialOne);
  const quote = code => ({ code, price: PRICE, quote_time: `${DATE}T15:05:00+08:00` });
  const bondRun = await marketClose.runMarketCloseByLabel('可转债', DATE, {
    accounts: [{ username: USER, account_name: ACCOUNT }],
    quoteMap: new Map([[CODES.partialOne, quote(CODES.partialOne)], [CODES.partialTwo, quote(CODES.partialTwo)]]),
    });
  assert.strictEqual(bondRun.ok, false, '转债缺终盘时必须报未完成');

  // 只有持仓、既无账户日价也无终盘日线的转债：必须进入覆盖分母。
  await pool.query(
    `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype)
     VALUES ($1,$2,$3,$4,$5,$6,0,100,5,'股权','沪市')`,
    [crypto.randomUUID(), USER, ACCOUNT, ACCOUNT_ID, CODES.heldOnly, '仅持仓测试转债'],
  );
  const withHeld = await marketClose.publishCloseBarPartition('CN', DATE, '可转债', [{ username: USER }]);
  assert.strictEqual(withHeld.coverage.expected, 3, '覆盖分母必须包含持仓证券，不能只看已确认日价');
  assert.strictEqual(withHeld.coverage.covered, 1, '只有一只有合格终盘日线');
  assert.strictEqual(withHeld.qualityStatus, 'failed');

  // 同日基金任务完整发布：转债的未就绪结论不得被覆盖。
  await pool.query(
    `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype)
     VALUES ($1,$2,$3,$4,$5,$6,0,100,5,'基金','沪市')`,
    [crypto.randomUUID(), USER, ACCOUNT, ACCOUNT_ID, CODES.fund, '基金测试证券'],
  );
  await ensureInstrument(CODES.fund);
  await seedHistoricalPrice(CODES.fund);
  const fundRun = await marketClose.runMarketCloseByLabel('LOF/ETF', DATE, {
    accounts: [{ username: USER, account_name: ACCOUNT }],
    quoteMap: new Map([[CODES.fund, quote(CODES.fund)]]),
    });
  assert.strictEqual(fundRun.ok, true, '基金终盘完整时任务必须成功：' + JSON.stringify(fundRun));
  const fundPublish = await marketClose.publishCloseBarPartition('CN', DATE, 'LOF/ETF', [{ username: USER }]);
  assert.strictEqual(fundPublish.coverage.status, 'complete', '基金自身覆盖完整');
  assert.strictEqual(fundPublish.qualityStatus, 'failed', '整行质量取最差品种：基金补齐不得把转债的 partial 冲掉');

  const { rows } = await pool.query(
    `SELECT diagnostics FROM ops.dataset_partitions
      WHERE dataset_code='position_close_bars_cn' AND scope_key='CN' AND partition_key=$1::date`,
    [DATE],
  );
  const diagnostics = rows[0] && rows[0].diagnostics;
  const byKind = diagnostics.coverage_by_kind || {};
  assert.strictEqual(byKind.bond && byKind.bond.status, 'partial', '转债品种结论必须保留');
  assert.strictEqual(byKind.fund && byKind.fund.status, 'complete', '基金品种结论单独记录');
  assert.deepStrictEqual(diagnostics.coverage_kinds.slice().sort(), ['bond', 'fund']);
  assert.strictEqual(diagnostics.quality_status, 'failed', '任一品种未补齐时整行不得为 passed');

  // 调度重验：转债仍不 ready、基金 ready，两条结论互不顶替。
  const bondState = await datasetDependencyState(
    { slot_id: 1, job_code: 'market_close:可转债', business_date: DATE, request_payload: {} },
    historicalDependency('bond'), { readiness: true },
  );
  assert.strictEqual(bondState.ready, false, '同分区基金已就绪不得让转债判成就绪');
  assert.ok((bondState.observations || []).some(item => item && item.error === 'partition_coverage_partial'),
    '转债必须留下部分覆盖的未就绪观测');
  const fundState = await datasetDependencyState(
    { slot_id: 2, job_code: 'market_close:LOF/ETF', business_date: DATE, request_payload: {} },
    historicalDependency('fund'), { readiness: true },
  );
  assert.strictEqual(fundState.ready, true, '基金覆盖完整时必须判就绪');
}

// ---------- G. 并发发布必须原子合并品种结论（2026-11-19 第三轮复验 P1） ----------
// 复现：转债与基金同时读到旧分区，转债写 partial 后基金用读到的旧值整体写回，
// 转债结论被冲掉、调度重验误判 ready。合并必须发生在数据库端（单条 UPDATE 内）。
async function scenarioConcurrentCoverageMerge() {
  const { publishCoveragePartition } = require('../services/datasetPartitions');
  // 发布路径不得再"先读旧分区再整体写回"：读改写正是并发丢更新的来源。
  const source = require('fs').readFileSync(require('path').join(__dirname, '../jobs/marketClose.js'), 'utf8');
  assert.ok(!/select_position_close_partition/.test(source),
    '品种覆盖不得在任务侧读改写，必须交给数据库端原子合并');
  await pool.query(
    `DELETE FROM ops.dataset_partitions
      WHERE dataset_code='position_close_bars_cn' AND scope_key='CN' AND partition_key=$1::date`,
    [DATE],
  );
  for (let round = 0; round < 5; round += 1) {
    await Promise.all([
      publishCoveragePartition('position_close_bars_cn', 'CN', {
        partitionKey: DATE, rowCount: 1, coverageKind: 'bond',
        coverage: { expected: 2, covered: 1, status: 'partial' },
        diagnostics: { query_status: 'success', reason: 'test:concurrent' },
      }),
      publishCoveragePartition('position_close_bars_cn', 'CN', {
        partitionKey: DATE, rowCount: 1, coverageKind: 'fund',
        coverage: { expected: 1, covered: 1, status: 'complete' },
        diagnostics: { query_status: 'success', reason: 'test:concurrent' },
      }),
    ]);
    const { rows } = await pool.query(
      `SELECT diagnostics FROM ops.dataset_partitions
        WHERE dataset_code='position_close_bars_cn' AND scope_key='CN' AND partition_key=$1::date`,
      [DATE],
    );
    const diagnostics = rows[0] && rows[0].diagnostics;
    assert.strictEqual(diagnostics.coverage_by_kind.bond.status, 'partial',
      `第 ${round + 1} 轮并发后转债结论不得被基金覆盖`);
    assert.strictEqual(diagnostics.coverage_by_kind.fund.status, 'complete',
      `第 ${round + 1} 轮并发后基金结论不得丢失`);
    assert.strictEqual(diagnostics.quality_status, 'failed', '并发合并后整行仍取最差品种');
    assert.deepStrictEqual(diagnostics.coverage_kinds.slice().sort(), ['bond', 'fund']);
  }
  const bondState = await datasetDependencyState(
    { slot_id: 3, job_code: 'market_close:可转债', business_date: DATE, request_payload: {} },
    historicalDependency('bond'), { readiness: true },
  );
  assert.strictEqual(bondState.ready, false, '并发写入后转债仍必须判为未就绪');
}

async function scenarioLiveQuotes() {
  const positions = [
    { code: CODES.crossStock, name: '现行规则测试股票' },
    { code: CODES.crossBond, name: '现行规则测试转债' },
    { code: CODES.fund, name: '现行规则测试基金' },
  ];
  await resetScenarioWithPositions(positions, { historical: false });
  const before = seriesCalls;
  await pool.query('UPDATE accounts SET cash_base=1000 WHERE username=$1', [USER]);
  const accounts = [{ username: USER, account_name: ACCOUNT }];
  for (const [i, label] of ['A股', '可转债', 'LOF/ETF'].entries()) {
    const code = positions[i].code;
    const price = PRICE + i;
    const quote_time = TODAY + 'T15:30:00+08:00';
    const result = await marketClose.runMarketCloseByLabel(label, TODAY, {
      accounts, quoteMap: new Map([[code, { code, price, quote_time }]]),
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.deepStrictEqual(result.publishDatasetCodes, ['account_daily_prices']);
    const row = await accountPrice(code, TODAY);
    assert.strictEqual(row.quality, 'confirmed');
    assert.strictEqual(row.is_final, true);
    assert.strictEqual(Number(row.price), price);
    assert.strictEqual(row.quote_at.toISOString(), new Date(quote_time).toISOString());
    assert.strictEqual(row.evidence.priceBasis, 'tencent_post_close_quote');
  }
  const { loadAccountData, loadAccountSummary } = require('../db');
  const account = await loadAccountData(USER, ACCOUNT);
  const summary = await loadAccountSummary(USER, ACCOUNT);
  const marketValue = positions.reduce((value, _, index) => value + (PRICE + index) * 100, 0);
  assert.strictEqual(summary.totalAsset, 1000 + marketValue);
  for (const [index, { code }] of positions.entries()) {
    const position = account.positions.find(row => row.code === code);
    assert.strictEqual(position.price, PRICE + index);
    assert.strictEqual(position.priceQuality, 'confirmed');
  }
  const basis = await require('../services/accountPositionBasis').ensurePositionBasis(USER, ACCOUNT, { date: TODAY });
  assert.strictEqual(basis.covered, true, JSON.stringify(basis));
  const nav = await require('../jobs/navSnapshot').recordNavSnapshots(USER, ACCOUNT, null, TODAY, TODAY);
  assert.strictEqual(nav.ok, true, JSON.stringify(nav));
  const stored = await pool.query('SELECT total_asset::float8 AS total FROM nav_history WHERE username=$1 AND date=$2', [USER, TODAY]);
  assert.strictEqual(stored.rows[0].total, summary.totalAsset, '持仓、总资产、净值同读一份腾讯收盘价');
  assert.strictEqual(seriesCalls, before, '当日腾讯报价直接确认，不请求日线');
}

async function scenarioLiveHongKong() {
  const code = '00700';
  await resetScenarioWithPositions([{ code, subtype: '港股' }], { historical: false });
  const before = seriesCalls;
  const accounts = [{ username: USER, account_name: ACCOUNT }];
  const readRealtimeQuotes = datasets.readRealtimeQuotes;
  datasets.readRealtimeQuotes = async () => new Map();
  try {
    const stale = await marketClose.runMarketCloseByLabel('港股', TODAY, {
      accounts, quoteMap: new Map([[code + '.HK', { code, price: PRICE, quote_time: TODAY + 'T16:09:59+08:00' }]]),
    });
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.errorType, 'close_quote_not_ready');
    assert.strictEqual(stale.retryable, true, '港股收市前报价应重取腾讯');
    assert.strictEqual((await accountPrice(code, TODAY)).quality, 'candidate');
    const result = await marketClose.runMarketCloseByLabel('港股', TODAY, {
      accounts, quoteMap: new Map([[code + '.HK', { code, price: PRICE + 1, quote_time: TODAY + 'T16:10:01+08:00' }]]),
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const row = await accountPrice(code, TODAY);
    assert.strictEqual(row.market, 'HK');
    assert.strictEqual(row.is_final, true);
    assert.strictEqual(Number(row.price), PRICE + 1);
  } finally {
    datasets.readRealtimeQuotes = readRealtimeQuotes;
  }
  assert.strictEqual(seriesCalls, before, '港股收盘不等待日线');
}

async function main() {
  await cleanup();
  ACCOUNT_ID = crypto.createHash('sha256').update(USER + '\n' + ACCOUNT).digest('hex');

  await scenarioGapRecovery();
  await scenarioGapStoreUnavailable();
  await scenarioPublishRetry();
  await scenarioResolveFailureRecovery();
  await scenarioCrossKindIsolation();
  await scenarioPartialCoverage();
  await scenarioCrossKindCoverage();
  await scenarioConcurrentCoverageMerge();
  await scenarioLiveQuotes();
  await scenarioLiveHongKong();

  console.log('收盘任务连续重跑回归通过：缺口落库、缺口表异常不误报成功、重跑继续核验与补发布、已发布日线也销账、跨品种不串扰、部分覆盖不判整类通过、共享分区按品种保留覆盖结论、并发发布原子合并、当日报价直写与三处估值一致');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (_) { /* 清理失败不掩盖原结论 */ }
    await pool.end().catch(() => {});
  });
