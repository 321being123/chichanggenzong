// ========== 收盘价漏记(P0-3) + 调度时区(P0-4) 回归测试 ==========
// 运行：node server/test/marketclose.test.js
// 说明：核心判定 pickMissingCodes 与时间zone 辅助函数均为纯函数，无需数据库/网络即可回归。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mc = require('../jobs/marketClose');
const { historicalKindFor } = require('../jobs/replayNav');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

// 与 MARKET_CLOSE_TIMES 一致的代码前缀判定（测试内镜像，避免耦合内部配置）
const isA = c => /^(00|30|60|68|[48])/.test(c);
const isBond = c => /^(11|12)/.test(c);
const isETF = c => /^(5|15|16|17|180|181|184)/.test(c) && c.length === 6;

const pos = (code, name) => ({ code, name: name || code });

console.log('A. pickMissingCodes —— P0-3 核心：按代码幂等，不因子账户任一条记录而整市场跳过');
check('仅 A 股账户：全部缺失代码被挑出', () => {
  const p = [pos('600000'), pos('000001'), pos('300750')];
  const got = mc.pickMissingCodes(p, new Set(), isA);
  assert.deepStrictEqual(got.sort(), ['000001', '300750', '600000']);
});
check('仅可转债账户：可转债代码被挑出', () => {
  const p = [pos('113000'), pos('123456')];
  const got = mc.pickMissingCodes(p, new Set(), isBond);
  assert.deepStrictEqual(got.sort(), ['113000', '123456']);
});
check('混合账户(A股+可转债+ETF)：A股已写不影响可转债/ETF', () => {
  // 已有 600000（A股）一条记录，身份键为「市场|代码」
  const existing = new Set(['CN|600000']);
  const p = [pos('600000'), pos('113000'), pos('510300')];
  // 可转债视角：113000 缺失 -> 必须被挑出（旧逻辑会因 600000 存在而整市场跳过）
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isBond), ['113000']);
  // ETF 视角：510300 缺失 -> 必须被挑出
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isETF), ['510300']);
  // A股视角：600000 已存在 -> 不挑
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isA), []);
});
check('部分代码缺失：只挑缺失项', () => {
  const p = [pos('600000'), pos('600001'), pos('600002')];
  const existing = new Set(['CN|600000', 'CN|600002']);
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isA), ['600001']);
});
check('同形证券按身份判定缺口：一只确认不影响另一只', () => {
  // A 股 000001 与港股 00001 是两只证券，同形不同市场
  const p = [
    { code: '000001', name: '平安银行', subtype: '深市' },
    { code: '00001', name: '长和', subtype: '港股' },
  ];
  const anyMatch = () => true;
  assert.deepStrictEqual(mc.pickMissingCodes(p, new Set(['CN|000001']), anyMatch), ['00001'],
    '港股 00001 未确认，不能被 A 股 000001 的确认记录当成已处理');
  assert.deepStrictEqual(mc.pickMissingCodes(p, new Set(['HK|00001']), anyMatch), ['000001'],
    'A 股 000001 未确认，也不能被港股 00001 的确认记录当成已处理');
  assert.deepStrictEqual(mc.pickMissingCodes(p, new Set(['CN|000001', 'HK|00001']), anyMatch), [],
    '两只都确认后才不再抓取');
  // 同一身份的多条持仓只取一次
  const dup = [{ code: '000001', subtype: '深市' }, { code: '000001', subtype: '深市' }];
  assert.deepStrictEqual(mc.pickMissingCodes(dup, new Set(), anyMatch), ['000001']);
});
check('日价行的市场身份：迁移标记的身份不明不得按代码长度猜', () => {
  assert.strictEqual(mc.dailyPriceRowMarket({ code: '000001', market: 'UNKNOWN' }), 'UNKNOWN',
    '迁移已判定身份不明的六位代码不能再被当作 A 股');
  assert.strictEqual(mc.dailyPriceRowMarket({ code: '000001', market: '' }), 'CN',
    '迁移前旧行（无 market）保持按代码形状兜底');
  assert.strictEqual(mc.dailyPriceRowMarket({ code: '00001', market: null }), 'HK');
  // 归因侧必须与收盘侧同一规则，否则身份不明的价格仍会进入历史资产重建
  const { priceRowMarket } = require('../services/navAttribution');
  assert.strictEqual(priceRowMarket({ code: '000001', market: 'UNKNOWN' }), 'UNKNOWN');
  assert.strictEqual(priceRowMarket({ code: '000001', market: '' }), 'CN');
  // UNKNOWN 的身份键永不等于任何持仓市场 -> 该价格只能保留为缺口
  assert.notStrictEqual(
    `${mc.dailyPriceRowMarket({ code: '000001', market: 'UNKNOWN' })}|000001`,
    mc.positionIdentityKey({ code: '000001', subtype: '深市' }),
    '身份不明的价格不得匹配任何持仓（否则会拿别的证券价格算资产）'
  );
  // 持仓身份：港股 5 位代码 / subtype 港股 都归 HK
  assert.strictEqual(mc.positionIdentityKey({ code: '00001', subtype: '' }), 'HK|00001');
  assert.strictEqual(mc.positionIdentityKey({ code: '00001', subtype: '港股' }), 'HK|00001');
  assert.strictEqual(mc.positionIdentityKey({ code: '000001', subtype: '深市' }), 'CN|000001');
  // 同一港股的五位与六位写法必须落到同一个身份，否则缺口判定会把它当成两只证券重复补写
  assert.strictEqual(mc.positionIdentityKey({ code: '000001', subtype: '港股' }), 'HK|00001',
    '六位补零的港股持仓必须与五位写法同身份');
  assert.strictEqual(mc.positionIdentityKey({ code: '00700', subtype: '港股' }), 'HK|00700');
  assert.strictEqual(mc.identityOf('UNKNOWN', '000001'), 'UNKNOWN|000001',
    '身份不明的行不做港股规范化，否则会被当成某只港股的证据');
  const sixDigitRow = mc.confirmedExistingCodes([{ code: '000001', market: 'HK', quality: 'confirmed', is_final: true }]);
  assert.ok(sixDigitRow.has('HK|00001'), '六位代码的已确认日价必须命中五位代码的持仓');
});
check('市场身份贯穿读取、回写与历史归因（源码守卫）', () => {
  const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  assert.ok(/SELECT code, market, quality, is_final FROM daily_prices/.test(read('repositories', 'marketCloseRepository.js')),
    '日价读取必须带 market，否则缺口判定与幂等跳过又退回按裸代码');
  assert.ok(/SELECT b\.close::float8 AS close, s\.source_code[\s\S]*market\.daily_bars/.test(read('repositories', 'marketCloseRepository.js')),
    '终盘核验必须先读已发布共享日线，避免多账户重复外采');
  assert.ok(/COALESCE\(d\.market, ''\) = \(CASE WHEN COALESCE\(p\.subtype/.test(read('db', 'accounts.js')),
    '持仓回写必须按市场匹配日价，否则同形 A 股/港股会串价');
  assert.ok(read('jobs', 'navSnapshot.js').includes("marketText ? 'UNKNOWN'"),
    '净值快照不得把身份不明（UNKNOWN）的价格按代码长度当成 A 股');
  assert.ok(read('services', 'navAttribution.js').includes("if (text) return 'UNKNOWN';"),
    '历史归因不得把身份不明的价格按代码长度当成 A 股');
});
check('某市场无任何持仓：返回空', () => {
  const p = [pos('600000')];
  assert.deepStrictEqual(mc.pickMissingCodes(p, new Set(), isBond), []);
});
check('已有代码集合为空且持仓为空：返回空', () => {
  assert.deepStrictEqual(mc.pickMissingCodes([], new Set(), isA), []);
});
check('共享行情缺失时支持按代码读取后续补取结果', () => {
  const quoteMap = new Map([['sz160719', { code: '160719', price: 1.9, quote_time: '2026-09-02T15:14:00+08:00' }]]);
  assert.strictEqual(mc.quoteForCode(quoteMap, '160719'), null, '腾讯映射键应使用统一代码或代码.市场，不应误认供应商 symbol');
  quoteMap.set('160719', { code: '160719', price: 1.9, quote_time: '2026-09-02T15:14:00+08:00' });
  assert.strictEqual(mc.isUsableQuote(mc.quoteForCode(quoteMap, '160719'), '2026-09-02'), true);
  assert.strictEqual(mc.isUsableQuote({ code: '160719', price: 1.9, quote_time: '2026-09-01T15:14:00+08:00' }, '2026-09-02'), false);
  mc.mergeQuoteMaps(quoteMap, new Map([['160719.SZ', { code: '160719', price: 1.91 }]]));
  assert.strictEqual(quoteMap.get('160719.SZ').price, 1.91);
});
check('收盘重试刷新盘前旧报价，合格报价不重复取', () => {
  const date = '2026-11-16';
  const closed = { status: 'open', isAfterMarketClose: true, closeTime: '16:10' };
  const before = { price: 3.95, quote_time: '2026-11-16T16:08:17+08:00' };
  const after = { price: 3.95, quote_time: '2026-11-16T16:11:00+08:00' };
  assert.strictEqual(mc.quoteNeedsCloseRefresh(before, closed, date), true);
  assert.strictEqual(mc.quoteNeedsCloseRefresh(after, closed, date), false);
  assert.strictEqual(mc.quoteNeedsCloseRefresh(null, closed, date), true);
  assert.strictEqual(mc.quoteNeedsCloseRefresh({ price: 1 }, closed, date), true);
  assert.strictEqual(mc.quoteNeedsCloseRefresh(before, { ...closed, isAfterMarketClose: false }, date), false);
});
check('批量行情缺失只允许一次有界补取，不能重复检查同一份空 Map', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketClose.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'repositories', 'marketCloseRepository.js'), 'utf8');
  assert.ok(source.includes('refreshMissingQuotes'), '收盘任务必须有缺失代码补取入口');
  assert.ok(source.includes('force: true'), '缺失代码补取必须强制刷新腾讯缓存');
  assert.ok(source.includes('const refreshAttempted = new Set()'), '补取必须按代码去重并限制在本次任务一次');
  assert.ok(source.includes('getExternalCallStats().total'), '任务外部调用数必须来自统一 Guard 实际计数');
});
check('非标准证券显式进入覆盖检查，不再静默漏掉', () => {
  assert.strictEqual(mc.isUncoveredPosition('404002', { name: '搜特退债', quantity: 1000 }), true);
  assert.strictEqual(mc.isUncoveredPosition('600000', { name: '浦发银行', quantity: 1000 }), false);
  assert.strictEqual(mc.isUncoveredPosition('404002', { name: '搜特退债', quantity: 0 }), false);
});
check('历史回补按证券类型路由，禁止统一走股票日线', () => {
  // 2026-10-31 数据层收口：改判业务类型（供应商接口名在数据层内决定）。
  assert.strictEqual(historicalKindFor('00762', { subtype: '港股' }), 'hk_stock');
  assert.strictEqual(historicalKindFor('113575', { subtype: '可转债' }), 'bond');
  assert.strictEqual(historicalKindFor('510900', { subtype: '基金/ETF' }), 'fund');
  assert.strictEqual(historicalKindFor('600000', { subtype: '沪市' }), 'stock');
});

console.log('B. 时区辅助函数 —— P0-4：显式东八区，不受容器本地时区影响');
check('fmtCN 在 UTC 凌晨算北京时间日期（跨日正确）', () => {
  // 2026-07-16T16:00:00Z = 北京时间 2026-07-17 00:00
  assert.strictEqual(mc.fmtCN('2026-07-16T16:00:00Z'), '2026-07-17');
  // 2026-07-16T15:00:00Z = 北京时间 2026-07-16 23:00
  assert.strictEqual(mc.fmtCN('2026-07-16T15:00:00Z'), '2026-07-16');
});
check('cnWeekday 返回北京时间星期几', () => {
  // 2026-07-16 是周四(4)
  assert.strictEqual(mc.cnWeekday('2026-07-16T01:00:00Z'), 4);
  // 2026-07-19 是周日(0)
  assert.strictEqual(mc.cnWeekday('2026-07-19T01:00:00Z'), 0);
});
check('msUntil 落点固定为北京时间 h:m（不受主机时区影响）', () => {
  for (const [h, m] of [[15, 10], [16, 10]]) {
    const now = new Date();
    const ms = mc.msUntil(h, m, now);
    assert.ok(ms > 0 && ms < 48 * 3600 * 1000, `msUntil(${h},${m}) 区间异常: ${ms}`);
    const at = new Date(now.getTime() + ms);
    const beijing = new Date(at.getTime() + 8 * 3600 * 1000);
    assert.strictEqual(beijing.getUTCHours(), h, `落点小时应为 ${h}`);
    assert.strictEqual(beijing.getUTCMinutes(), m, `落点分钟应为 ${m}`);
  }
});

console.log('C. 收盘确认准入 —— 报价必须是当日且不早于收市时刻');
const closedCN = { status: 'open', isAfterMarketClose: true, closeTime: '15:00' };
const quoteAt = (date, time) => `${date}T${time}:00+08:00`;
check('已收盘 + 收盘后报价 -> 已确认终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, quoteAt('2026-09-24', '15:00'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'confirmed');
  assert.strictEqual(q.isFinal, true);
  assert.strictEqual(q.reason, null);
});
check('已收盘但拿到当天上午报价 -> 只能候选，不得写成终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, quoteAt('2026-09-24', '10:05'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate', '上午报价在收盘任务里仍可能被拿到，不能当终盘');
  assert.strictEqual(q.isFinal, null);
  assert.strictEqual(q.reason, 'quote_before_close');
});
check('缺少报价时刻 -> 不能确认为终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, null, '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate');
  assert.strictEqual(q.reason, 'quote_time_missing');
});
check('报价不属于目标交易日 -> 不能确认为终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, quoteAt('2026-09-23', '15:00'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate');
  assert.strictEqual(q.reason, 'quote_not_same_day');
});
check('市场未过收市时刻 -> 不能确认为终盘', () => {
  const q = mc.qualifyCloseQuote({ status: 'open', isAfterMarketClose: false, closeTime: '15:00' },
    quoteAt('2026-09-24', '15:00'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate');
  assert.strictEqual(q.reason, 'market_not_closed');
});
check('补漏缺口按身份判定：同形证券不得互相顶替', () => {
  // 与 MARKET_CLOSE_TIMES 一致的规则形状：A 股要求 6 位及以上，港股按 5 位
  const aRule = { label: 'A股', match: code => String(code).length >= 6 && isA(code) };
  const hkRule = { label: '港股', match: code => String(code).length === 5 };
  const held = [{ code: '000001', subtype: '深市' }, { code: '00001', subtype: '港股' }];
  const onlyCn = new Set(['CN|000001']);
  assert.strictEqual(mc.hasConfirmedGap(aRule, held, onlyCn), false, 'A 股已确认 -> A 股无缺口');
  assert.strictEqual(mc.hasConfirmedGap(hkRule, held, onlyCn), true, '港股未确认 -> 港股仍是缺口');
  const onlyHk = new Set(['HK|00001']);
  assert.strictEqual(mc.hasConfirmedGap(aRule, held, onlyHk), true, 'A 股未确认 -> A 股仍是缺口');
  assert.strictEqual(mc.hasConfirmedGap(hkRule, held, onlyHk), false, '港股已确认 -> 港股无缺口');
  const both = new Set(['CN|000001', 'HK|00001']);
  assert.strictEqual(mc.hasConfirmedGap(aRule, held, both), false);
  assert.strictEqual(mc.hasConfirmedGap(hkRule, held, both), false);
});
check('已有候选价不阻止收盘升级：只有已确认记录才算已处理', () => {
  const codes = mc.confirmedExistingCodes([
    { code: '600000', market: 'CN', quality: 'candidate', is_final: null },
    { code: '600519', market: 'CN', quality: 'legacy_unverified', is_final: null },
    { code: '000001', market: 'CN', quality: 'confirmed', is_final: true },
  ]);
  assert.deepStrictEqual([...codes], ['CN|000001'], '候选与遗留价必须留在待升级集合里');
  // 身份不明（UNKNOWN）的已确认记录不能当成“该证券已处理”，必须重新取价确认
  const unknown = mc.confirmedExistingCodes([{ code: '000001', market: 'UNKNOWN', quality: 'confirmed', is_final: true }]);
  assert.ok(!unknown.has('CN|000001'), '身份不明的记录不得顶替 A 股持仓的确认状态');
});

console.log('D. 历史补漏授权门禁 —— 缺行补齐可直接写，改写存量历史日价必须显式授权');
check('没有既有记录 -> 直接补齐', () => {
  const plan = mc.splitHistoricalBackfill(['CN|600000', 'CN|000001'], new Set(), false);
  assert.deepStrictEqual(plan.writable, ['CN|600000', 'CN|000001']);
  assert.deepStrictEqual(plan.blocked, []);
});
check('已有未核验存量行 -> 默认不改写，计入待授权', () => {
  const plan = mc.splitHistoricalBackfill(['CN|600000', 'CN|000001'], new Set(['CN|600000']), false);
  assert.deepStrictEqual(plan.writable, ['CN|000001'], '只有缺行的那只可以补写');
  assert.deepStrictEqual(plan.blocked, ['CN|600000'], '存量历史日价必须留待授权');
});
check('显式授权后允许修订存量历史日价', () => {
  const plan = mc.splitHistoricalBackfill(['CN|600000'], new Set(['CN|600000']), true);
  assert.deepStrictEqual(plan.writable, ['CN|600000']);
  assert.deepStrictEqual(plan.blocked, []);
});
check('另一市场的同形代码不得阻断缺行补齐', () => {
  // 同一天只有 A 股 000001 的存量行时，港股 000001 只是缺行，不是"改写已有历史"
  const hk = mc.splitHistoricalBackfill(['HK|000001'], new Set(['CN|000001']), false);
  assert.deepStrictEqual(hk.blocked, [], '同形代码属于另一只证券，不能判成需要授权修订');
  assert.deepStrictEqual(hk.writable, ['HK|000001']);
  const cn = mc.splitHistoricalBackfill(['CN|00001'], new Set(['HK|00001']), false);
  assert.deepStrictEqual(cn.blocked, [], '反过来也一样：港股的存量行不阻断 A 股缺行补齐');
  // 同一身份才算改写历史
  const same = mc.splitHistoricalBackfill(['HK|000001'], new Set(['HK|000001']), false);
  assert.deepStrictEqual(same.blocked, ['HK|000001']);
  // 源码守卫：调用方必须真的传证券身份，而不是退回裸代码
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketClose.js'), 'utf8');
  assert.ok(source.includes('splitHistoricalBackfill(missing.map(pos => positionIdentityKey(pos))'),
    '历史补漏授权判定必须按「市场+代码」身份，不能按裸代码');
  assert.ok(source.includes('identityOf(dailyPriceRowMarket(row), row.code)'),
    '既有记录的身份集合也必须带市场前缀并经同一套代码规范化');
  assert.ok(!source.includes('`${dailyPriceRowMarket(row)}|${String(row.code)}`'),
    '不得再用原始代码拼身份：港股 000001 与 00001 是同一只证券');
});

console.log('E. 任务结果契约 —— 共享日线没写完时不得报成功');
check('共享日线全部没写回 -> partial 且不是成功', () => {
  const outcome = mc.resolveCloseJobOutcome({
    label: 'A股', dateStr: '2026-11-14',
    result: {
      recorded: 3, failed: 0, persistedBars: 0,
      sharedBarPublication: 'incomplete',
      sharedBarPersist: { persisted: 0, failed: 2, reasons: { instrument_or_source_not_found: 2 }, samples: [{ identity: 'CN|600000', reason: 'instrument_or_source_not_found' }] },
      barPartitionStatus: 'persist_failed',
    },
  });
  assert.strictEqual(outcome.ok, false, '共享日线未完成不得返回 ok=true');
  assert.strictEqual(outcome.status, 'partial', '按任务契约返回 partial，便于调度/监控区分');
  assert.strictEqual(outcome.errorType, 'shared_bar_incomplete');
  assert.strictEqual(outcome.retryable, true, '必须可续跑，否则缺口不会被自动补齐');
  assert.ok(outcome.error.includes('instrument_or_source_not_found×2'), '失败原因必须进任务结果');
  assert.deepStrictEqual(outcome.failures, [{ identity: 'CN|600000', reason: 'instrument_or_source_not_found' }],
    '失败对象必须保留，不能只留一个计数');
  assert.strictEqual(outcome.pricesRecorded, true, '收盘价已记录，下游净值仍应继续');
});
check('证据分区发布失败 -> 同样 partial', () => {
  const outcome = mc.resolveCloseJobOutcome({
    label: '港股', dateStr: '2026-11-14',
    result: { recorded: 1, failed: 0, persistedBars: 2, sharedBarPublication: 'complete', barPartitionStatus: 'publish_failed' },
  });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.status, 'partial');
  assert.strictEqual(outcome.errorType, 'shared_bar_incomplete');
  assert.strictEqual(outcome.pricesRecorded, true);
});
check('共享日线写完 -> 成功', () => {
  const outcome = mc.resolveCloseJobOutcome({
    label: 'A股', dateStr: '2026-11-14',
    result: { recorded: 3, failed: 0, persistedBars: 3, sharedBarPublication: 'complete', barPartitionStatus: 'published' },
  });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 'succeeded');
  assert.strictEqual(outcome.errorType, null);
});
check('候选未确认/历史待授权 -> 不给净值续跑', () => {
  const pending = mc.resolveCloseJobOutcome({
    label: 'A股', dateStr: '2026-11-14',
    result: { recorded: 2, pendingConfirmation: 1, sharedBarPublication: 'complete', barPartitionStatus: 'published' },
  });
  assert.strictEqual(pending.ok, false);
  assert.strictEqual(pending.errorType, 'pending_confirmation');
  assert.strictEqual(pending.pricesRecorded, false, '价格尚未确认时不能让净值按候选价继续');
  const blocked = mc.resolveCloseJobOutcome({
    label: 'A股', dateStr: '2026-11-14',
    result: { recorded: 0, blockedRevision: 2, sharedBarPublication: 'complete', barPartitionStatus: 'not_needed' },
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.errorType, 'historical_revision_blocked');
  assert.strictEqual(blocked.pricesRecorded, false);
});
check('任务结果契约贯穿执行记录与下游净值门禁（源码守卫）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketClose.js'), 'utf8');
  assert.ok(/finishJobRun\(runId, outcome\.ok,/.test(source), '执行记录必须按契约写成功/失败，partial 不能记成功');
  assert.ok(!/finishJobRun\(runId, true, `写入/.test(source), '不得再无条件以成功结束收盘任务');
  assert.ok(source.includes('result.pricesRecorded !== true'), '下游净值只能按"收盘价是否记录"判断续跑');
  // 任务实际发布的数据集必须在自己任务契约里声明（不能只在代码里隐式发布）。
  const definitions = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobDefinitions.js'), 'utf8');
  assert.ok(/'market_close:A股':[^\n]*producesDatasets: \['account_daily_prices', 'position_close_bars_cn'\]/.test(definitions),
    'A股收盘任务必须声明共享日线证据分区');
  assert.ok(/'market_close:港股':[^\n]*producesDatasets: \['account_daily_prices', 'position_close_bars_hk'\]/.test(definitions),
    '港股收盘任务必须声明自己的共享日线证据分区（不得借用 A 股分区）');
});

check('上次留下的缺口未销账 -> 即使本次没新增失败也必须 partial', () => {
  // 重跑时账户日价已确认、本次一条都没重采，但缺口表里还有未销账记录：
  // 以缺口表为准，不能因为"本次内存里没有失败"就报 complete。
  const outcome = mc.resolveCloseJobOutcome({
    label: 'A股', dateStr: '2026-11-14',
    result: {
      recorded: 0, failed: 0, persistedBars: 0,
      sharedBarPublication: 'incomplete',
      barPartitionStatus: 'gaps_open',
      sharedBarPersist: { persisted: 0, failed: 0, reasons: {}, samples: [], gapsRetried: 1, gapsOpen: 1 },
    },
  });
  assert.strictEqual(outcome.ok, false, '缺口未销账不得报成功');
  assert.strictEqual(outcome.status, 'partial');
  assert.ok(outcome.error.includes('仍有 1 条共享日线缺口'), '任务结果必须说明还有几条缺口：' + outcome.error);
});
check('缺口表异常 -> 不能当成没有缺口，必须 partial', () => {
  // 缺口登记/读取/计数失败时"有没有缺口"根本没有答案，按没有缺口处理就会误报成功。
  const outcome = mc.resolveCloseJobOutcome({
    label: 'A股', dateStr: '2026-11-14',
    result: {
      recorded: 1, failed: 0, persistedBars: 0,
      sharedBarPublication: 'incomplete',
      barPartitionStatus: 'gaps_open',
      sharedBarPersist: {
        persisted: 0, failed: 0, reasons: {}, samples: [], gapsRetried: 0, gapsOpen: null,
        storeError: { action: '计数', reason: 'permission denied for table market_close_bar_gaps' },
      },
    },
  });
  assert.strictEqual(outcome.ok, false, '缺口表不可用时不得报成功');
  assert.strictEqual(outcome.status, 'partial');
  assert.ok(outcome.error.includes('缺口表不可用'), '任务结果必须点明缺口表异常：' + outcome.error);
  assert.ok(outcome.error.includes('计数失败'));
  assert.strictEqual(outcome.retryable, true);
});
check('缺口必须独立落库并在重跑时继续处理（源码守卫）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketClose.js'), 'utf8');
  const gapRetryIndex = source.indexOf('select_open_bar_gaps');
  const accountLoopIndex = source.indexOf('for (const account of accounts)');
  assert.ok(gapRetryIndex > 0 && accountLoopIndex > 0 && gapRetryIndex < accountLoopIndex,
    '缺口重试必须发生在遍历账户之前，否则账户日价已确认就再也没机会补共享日线');
  assert.ok(source.includes('upsert_bar_gap'), '失败必须登记为独立缺口');
  assert.ok(source.includes('resolve_bar_gap'), '补齐后必须销账');
  assert.ok(source.includes('count_open_bar_gaps'), '是否完成必须以缺口表为准，不能只看本次内存');
  assert.ok(!/select_open_bar_gaps\(\[label, cnDate\]\)\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/.test(source),
    '缺口读取失败不得降级为空结果');
  assert.ok(!/count_open_bar_gaps\(\[label, cnDate\]\)\.catch\(\(\) =>/.test(source),
    '缺口计数失败不得降级为空结果');
  assert.ok(source.includes('noteGapStoreError'), '缺口表异常必须被记录并阻断成功');
  // 命中已发布日线说明这只证券这一天其实已经补齐，必须照样销账：
  // 否则"日线写完、发布成功、只有销账失败"的场景会让缺口永久留着、任务一直 partial。
  assert.ok(source.includes("result.via === 'published_bar' && result.tsCode"), '命中已发布日线也必须销账');
  // 分区发布必须每次都核对，不能只在"本次有新增日线"时才发布（否则重跑补不上发布失败）。
  assert.ok(source.includes('const barPartition = await publishCloseBarPartition(market.market, cnDate);'),
    '每次运行都要核对并补发布已有合格日线');
  // 缺口表登记的是证券 + 日线代码 + 交易日，与账户无关。
  const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', 'era15MarketCloseBarGaps.js'), 'utf8');
  assert.ok(migration.includes('UNIQUE(job_label, ts_code, trade_date)'),
    '同一任务同一天同一证券只能有一条缺口，避免多账户重复登记');
  const migrations = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');
  assert.ok(migrations.includes('203_market_close_bar_gaps'), '迁移 203 必须注册到执行顺序');
});

check('缺口重建按任务品种筛选，跨品种不串扰（源码守卫）', () => {
  // CN 下 A股/可转债/LOF-ETF 共用同一市场：不按品种筛选，A 股任务会把可转债/基金的缺口
  // 登记到自己名下，去要转债日线并把自己弄成 partial。
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketClose.js'), 'utf8');
  assert.ok(source.includes('LABEL_TERMINAL_KINDS'), '每个任务的品种范围必须显式登记');
  assert.ok(source.includes('if (!labelOwnsKind(label, kind)) continue;'), '重建缺口必须按品种过滤');
  assert.deepStrictEqual(mc.LABEL_TERMINAL_KINDS['A股'], ['stock']);
  assert.deepStrictEqual(mc.LABEL_TERMINAL_KINDS['可转债'], ['bond']);
  assert.deepStrictEqual(mc.LABEL_TERMINAL_KINDS['LOF/ETF'], ['fund']);
  assert.deepStrictEqual(mc.LABEL_TERMINAL_KINDS['港股'], ['hk_stock']);
  assert.strictEqual(mc.labelOwnsKind('A股', 'bond'), false, 'A 股任务不拥有可转债品种');
  assert.strictEqual(mc.labelOwnsKind('A股', 'fund'), false, 'A 股任务不拥有基金品种');
  assert.strictEqual(mc.labelOwnsKind('可转债', 'stock'), false);
  assert.strictEqual(mc.labelOwnsKind('非标准证券', 'stock'), false, '未登记品种范围的任务不重建缺口');
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n========================================');
console.log(`P0-3/P0-4 回归：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：'); failed.forEach(f => console.log('  - ' + f[1]));
  process.exit(1);
}
console.log('全部通过 ✅');
