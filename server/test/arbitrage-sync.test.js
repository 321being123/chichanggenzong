// ========== 套利同步逻辑测试 ==========
// 测试月窗口生成、标题分类、调度注册
const assert = require('assert');
const sync = require('../services/arbitrageAnnouncementSync');
const { SCHEDULER_REGISTRY } = require('../scheduler');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('--- 套利同步逻辑测试 ---');

// ===== 月窗口生成 =====
test('1 年区间生成 12 个月窗口', () => {
  const windows = sync.generateMonthWindows('2025-08-09', '2026-08-09');
  assert.strictEqual(windows.length, 13); // 2025-08 到 2026-08 跨 13 个月
});

test('每个窗口不超过 1 个月', () => {
  const windows = sync.generateMonthWindows('2025-01-01', '2025-12-31');
  for (const w of windows) {
    const from = new Date(w.from);
    const to = new Date(w.to);
    const diffDays = (to - from) / (24 * 3600 * 1000);
    assert.ok(diffDays <= 31, 'window ' + w.from + '~' + w.to + ' exceeds 31 days');
  }
});

test('首日和末日窗口正确', () => {
  const windows = sync.generateMonthWindows('2026-01-01', '2026-03-31');
  assert.strictEqual(windows[0].from, '2026-01-01');
  assert.strictEqual(windows[0].to, '2026-01-31');
  assert.strictEqual(windows[2].from, '2026-03-01');
  assert.strictEqual(windows[2].to, '2026-03-31');
});

test('跨年窗口正确', () => {
  const windows = sync.generateMonthWindows('2025-12-01', '2026-01-31');
  assert.strictEqual(windows.length, 2);
  assert.strictEqual(windows[0].from, '2025-12-01');
  assert.strictEqual(windows[0].to, '2025-12-31');
  assert.strictEqual(windows[1].from, '2026-01-01');
  assert.strictEqual(windows[1].to, '2026-01-31');
});

test('单月窗口', () => {
  const windows = sync.generateMonthWindows('2026-06-01', '2026-06-30');
  assert.strictEqual(windows.length, 1);
  assert.strictEqual(windows[0].from, '2026-06-01');
  assert.strictEqual(windows[0].to, '2026-06-30');
});

// ===== 标题分类 =====
test('标题分类：A股换股吸收合并', () => {
  assert.strictEqual(sync.classifyTitle('中国南车中国北车换股吸收合并公告', 'cninfo'), 'a_share_swap');
});

test('标题分类：A股现金选择权', () => {
  assert.strictEqual(sync.classifyTitle('关于现金选择权实施的公告', 'cninfo'), 'a_cash_offer');
});

test('标题分类：A股要约收购', () => {
  assert.strictEqual(sync.classifyTitle('要约收购报告书摘要', 'cninfo'), 'a_cash_offer');
});

test('标题分类：免于发出要约不属于套利机会', () => {
  assert.strictEqual(sync.classifyTitle('收购报告书暨免于发出要约收购申请之财务顾问报告', 'cninfo'), null);
});

test('标题分类：完成公告不能新建进行中案件', () => {
  assert.strictEqual(sync.classifyTitle('关于要约收购公司股份完成过户的公告', 'cninfo'), null);
  assert.strictEqual(sync.classifyTitle('关于现金选择权申报结果的公告', 'cninfo'), null);
});

test('标题分类：港股私有化', () => {
  assert.strictEqual(sync.classifyTitle('建议私有化公告', 'hkex'), 'hk_privatisation');
});

test('标题分类：B股转H现金选择权', () => {
  assert.strictEqual(sync.classifyTitle('境内上市外资股转换上市地以介绍方式在香港上市的预案', 'cninfo'), 'a_cash_offer');
});

test('标题分类：港交所分类元数据中的私有化', () => {
  const text = '建议以计划安排方式进行股份回购及撤销上市 私有化/撤销或取消证券上市';
  assert.strictEqual(sync.classifyTitle(text, 'hkex'), 'hk_privatisation');
});

test('标题分类：港股供股', () => {
  assert.strictEqual(sync.classifyTitle('供股章程', 'hkex'), 'hk_rights');
});

test('标题分类：无关公告返回null', () => {
  assert.strictEqual(sync.classifyTitle('2025年年度报告', 'cninfo'), null);
  assert.strictEqual(sync.classifyTitle('盈利预警公告', 'hkex'), null);
});

test('标题分类：空标题返回null', () => {
  assert.strictEqual(sync.classifyTitle(null, 'hkex'), null);
  assert.strictEqual(sync.classifyTitle('', 'cninfo'), null);
});

test('监管立案公告不新建套利案件', () => {
  assert.equal(sync.classifyTitle('关于公司收到中国证监会立案告知书的公告', 'cninfo'), null);
  assert.equal(sync.classifyRiskAnnouncement('关于公司收到中国证监会立案告知书的公告').severity, 'high');
});

test('终止公告：控制权变更/协议转让终止可识别为终态', () => {
  assert.strictEqual(sync.isGenericControlChangeTermination(
    '关于控股股东及相关方终止协议转让暨公司控制权变更事项终止的公告'
  ), true);
  assert.strictEqual(sync.isGenericControlChangeTermination('关于工商变更登记的公告'), false);
});

// ===== 调度注册 =====
test('调度任务已注册 arbitrageSync', () => {
  assert.ok(SCHEDULER_REGISTRY.scheduled.includes('arbitrageSync'),
    'arbitrageSync not in scheduler registry: ' + JSON.stringify(SCHEDULER_REGISTRY.scheduled));
});

// ===== 数据源配置 =====
test('SCOPES 包含 hkex 和 cninfo 两个数据源', () => {
  assert.ok(sync.SCOPES.hkex, 'missing hkex scope');
  assert.ok(sync.SCOPES.cninfo, 'missing cninfo scope');
  assert.strictEqual(sync.SCOPES.hkex.dataset, 'hkex_announcements');
  assert.strictEqual(sync.SCOPES.cninfo.dataset, 'cninfo_announcements');
  assert.strictEqual(typeof sync.retryPendingDocuments, 'function');
});

console.log('\nPASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);
