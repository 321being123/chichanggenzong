// ========== 套利适配器层测试（纯函数，不联网不连库） ==========
const assert = require('assert');
const cninfo = require('../services/cninfoAnnouncement');
const hkex = require('../services/hkexAnnouncement');
const sync = require('../services/arbitrageAnnouncementSync');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('--- 套利适配器/同步纯函数测试 ---');

// ===== 巨潮：<em> 高亮标签清洗 + 交易所映射 =====
test('巨潮标题含 <em> 标签时被清洗，分类可识别', () => {
  const payload = JSON.stringify({
    totalAnnouncement: 1,
    announcements: [{
      announcementId: 'ABC',
      announcementTitle: '关于<em>要约</em><em>收购</em>公司股份的提示性公告',
      secCode: '600491',
      secName: 'ST龙元',
      pageColumn: 'SHZB',
      announcementTime: 1717000000000,
      adjunctUrl: '/finalpage/download?abc.pdf',
    }],
  });
  const { items } = cninfo.parseSearchResponse(payload);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, '关于要约收购公司股份的提示性公告');
  assert.strictEqual(items[0].exchange, 'SSE');
});

test('巨潮创业板 SZCY / 深圳主板 SZZB 均映射为 SZSE', () => {
  const payload = JSON.stringify({ totalAnnouncement: 2, announcements: [
    { announcementId: '1', announcementTitle: '换股吸收合并', secCode: '300433', pageColumn: 'SZCY', adjunctUrl: 'x' },
    { announcementId: '2', announcementTitle: '现金选择权', secCode: '000001', pageColumn: 'SZZB', adjunctUrl: 'y' },
  ]});
  const { items } = cninfo.parseSearchResponse(payload);
  assert.strictEqual(items[0].exchange, 'SZSE');
  assert.strictEqual(items[1].exchange, 'SZSE');
});

test('巨潮证券名称中的 em 高亮标签会被清除', () => {
  const payload = JSON.stringify({ announcements: [
    { announcementId: 'name-clean', announcementTitle: '换股吸收合并', secCode: '600095', secName: '湘财<em>股</em>份' },
  ]});
  const { items } = cninfo.parseSearchResponse(payload);
  assert.strictEqual(items[0].stockName, '湘财股份');
});

test('巨潮默认搜索关键词包含 UPDATE_KEYWORDS（终止/完成/换股实施）', () => {
  const all = [...cninfo.DISCOVERY_KEYWORDS, ...cninfo.UPDATE_KEYWORDS];
  assert.ok(all.includes('终止'), 'missing 终止');
  assert.ok(all.includes('完成'), 'missing 完成');
  assert.ok(all.includes('换股实施'), 'missing 换股实施');
  assert.ok(all.includes('要约收购报告书'), 'missing 发现关键词');
});

// ===== 港交所：result 为 JSON 字符串需解析 =====
test('港交所 result 为 JSON 字符串时正确解析数组', () => {
  const payload = JSON.stringify({
    result: JSON.stringify([
      { NEWS_ID: '100', TITLE: '建议私有化', STOCK_CODE: '00555', DATE_TIME: '09/08/2026', CATEGORY: '17600' },
      { NEWS_ID: '101', TITLE: '供股章程', STOCK_CODE: '00777', DATE_TIME: '08/08/2026', CATEGORY: '18500' },
    ]),
    hasNextRow: false,
    recordCnt: 2,
  });
  const { items, hasNextRow, recordCnt } = hkex.parseSearchResponse(payload);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, '建议私有化');
  assert.strictEqual(items[0].stockCode, '00555');
  assert.strictEqual(hasNextRow, false);
  assert.strictEqual(recordCnt, 2);
});

// ===== 港交所：buildSearchUrl 必须严格对齐官方请求契约 =====
test('buildSearchUrl：官方参数契约（lang=zh/searchType=1/sortDir=0/t2Gcode空/分页100）', () => {
  const url = hkex.buildSearchUrl('17600', '2026-07-01', '2026-08-01', 100);
  assert.ok(url.includes('lang=zh'), 'lang 必须为 zh');
  assert.ok(url.includes('searchType=1'), 'searchType 必须为 1');
  assert.ok(url.includes('sortDir=0'), 'sortDir 必须为 0');
  assert.ok(url.includes('t2Gcode='), 't2Gcode 必须为空');
  assert.ok(!url.includes('t2Gcode=-2'), 't2Gcode 不得为 -2');
  assert.ok(url.includes('rowRange=100'), '分页必须为 100');
  assert.ok(url.includes('market=SEHK'), 'market 必须为 SEHK');
  assert.ok(url.includes('t1code=10000'), 't1code 必须为 10000');
});

test('searchAnnouncements：首个真实请求使用 rowRange=100（非 0）', async () => {
  // 模拟 httpRequest，记录首个请求 URL 并返回单页结果（hasNextRow=false 即只发一次请求）
  let firstUrl = null;
  const mockHttp = async (url) => {
    if (firstUrl === null) firstUrl = url;
    return JSON.stringify({
      result: JSON.stringify([
        { NEWS_ID: '100', TITLE: '建议私有化', STOCK_CODE: '00555', DATE_TIME: '09/08/2026', CATEGORY: '17600' },
      ]),
      hasNextRow: false,
      recordCnt: 1,
    });
  };
  const items = await hkex.searchAnnouncements({ fromDate: '2026-07-01', toDate: '2026-08-01', categories: ['17600'], _httpRequest: mockHttp });
  assert.ok(firstUrl, 'searchAnnouncements 应发起首个请求');
  assert.ok(firstUrl.includes('rowRange=100'), '首个请求 rowRange 必须为 100，而非 0');
  assert.ok(!firstUrl.includes('rowRange=0'), '首个请求不得为 rowRange=0');
  assert.strictEqual(items.length, 1, '单页结果应解析出 1 条');
  assert.strictEqual(items[0].title, '建议私有化');
});

// ===== 同步：后续进程公告分类（detectUpdate 需同时命中套利语义 + 终态动作词） =====
test('detectUpdate：终止私有化 → terminated + hk_privatisation', () => {
  const r = sync.detectUpdate('关于终止公司私有化的公告');
  assert.deepStrictEqual(r, { status: 'terminated', strategyType: 'hk_privatisation' });
});
test('detectUpdate：完成私有化 → completed + hk_privatisation', () => {
  const r = sync.detectUpdate('XX集团私有化完成暨撤回上市地位的公告');
  assert.deepStrictEqual(r, { status: 'completed', strategyType: 'hk_privatisation' });
});

test('detectUpdate：私有化建议公告不能误标为已完成', () => {
  const title = '要约人透过计划安排方式将国泰君安国际私有化之附带先决条件之建议及建议撤销上市地位';
  assert.strictEqual(sync.detectUpdate(title), null);
});
test('detectUpdate：换股吸收合并实施结果 → completed + a_share_swap', () => {
  const r = sync.detectUpdate('关于换股吸收合并实施结果暨股票复牌的公告');
  assert.deepStrictEqual(r, { status: 'completed', strategyType: 'a_share_swap' });
});
test('detectUpdate：要约收购完成过户 → completed + a_cash_offer', () => {
  const r = sync.detectUpdate('关于要约收购完成过户的公告');
  assert.deepStrictEqual(r, { status: 'completed', strategyType: 'a_cash_offer' });
});
test('detectUpdate：现金选择权申报结果 → completed + a_cash_offer', () => {
  const r = sync.detectUpdate('关于现金选择权申报结果的公告');
  assert.deepStrictEqual(r, { status: 'completed', strategyType: 'a_cash_offer' });
});
test('detectUpdate：无关完成场景 → null（不误关套利事件）', () => {
  assert.strictEqual(sync.detectUpdate('完成工商变更登记的公告'), null);
  assert.strictEqual(sync.detectUpdate('股份回购实施完成'), null);
  assert.strictEqual(sync.detectUpdate('2025年年度报告'), null);
  assert.strictEqual(sync.detectUpdate(null), null);
});

// ===== 同步：标题分类保持正确（清洗后语义不变） =====
test('清洗后标题仍能被正确分类', () => {
  assert.strictEqual(sync.classifyTitle('关于<em>现金选择权</em>实施的公告', 'cninfo'), 'a_cash_offer');
  assert.strictEqual(sync.classifyTitle('<em>要约收购</em>报告书摘要', 'cninfo'), 'a_cash_offer');
});

console.log('\nPASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);
