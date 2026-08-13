const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../services/arbitrageRules');

test('港交所多代码只保留首个普通股代码和名称', () => {
  assert.equal(rules.firstSecurityCode('01788<br/>05731<br/>05764<br/>40100', 'HK'), '01788');
  assert.equal(rules.firstSecurityName('國泰君安國際<br/>GUOTAI JA N2807', 'HK'), '國泰君安國際');
});

test('公告角色优先级：修订和正式方案高于摘要、顾问报告与终态公告', () => {
  assert.equal(rules.classifyDocumentRole('要约收购报告书'), 'terms');
  assert.equal(rules.classifyDocumentRole('交易报告书修订稿'), 'amendment');
  assert.equal(rules.classifyDocumentRole('财务顾问意见'), 'advice');
  assert.equal(rules.classifyDocumentRole('完成过户公告'), 'terminal');
  assert.ok(rules.documentRolePriority('amendment') > rules.documentRolePriority('terms'));
});

test('换股吸收合并报告书识别为正式条款文件，差异表不冒充正式报告', () => {
  assert.equal(rules.classifyDocumentRole('中国国际金融股份有限公司换股吸收合并东兴证券股份有限公司报告书（草案）'), 'terms');
  assert.equal(rules.classifyDocumentRole('换股吸收合并报告书（草案）与预案差异情况对比表'), 'proposal');
});

test('稳定事件键不受公告抓取顺序影响', () => {
  const args = { market: 'CN', strategyType: 'a_share_swap', canonicalCode: '601059', announcedAt: '2025-12-18' };
  assert.equal(rules.buildEventKey(args), 'CN:a_share_swap:601059:2025-12-18');
  assert.equal(rules.buildEventKey({ ...args, announcedAt: new Date('2025-12-18T08:00:00+08:00') }), 'CN:a_share_swap:601059:2025-12-18');
  assert.equal(rules.buildEventKey(args), rules.buildEventKey({ ...args }));
});

test('邀约人噪声宁可置空，不允许表头和残句入库', () => {
  assert.equal(rules.sanitizeOfferor('/合并方 标的资产/ 被合并方 评估基准日'), null);
  assert.equal(rules.sanitizeOfferor('资格及能力的核查........................'), null);
  assert.equal(rules.sanitizeOfferor('湖北文化旅游集团有限公司'), '湖北文化旅游集团有限公司');
});

test('字段校验区分固定换股价格和现金选择权', () => {
  const result = rules.validateParsedTerms('a_share_swap', {
    cash_offer_price: 17.79,
    target_swap_price: 19.15,
    reference_swap_price: 36.91,
    swap_ratio: 0.518829,
    reference_names: ['中金公司'],
    evidence: [{ field: 'cash_offer_price' }, { field: 'target_swap_price' }, { field: 'swap_ratio' }],
  });
  assert.equal(result.coreComplete, true);
  assert.equal(result.parseStatus, 'validated');
  assert.equal(result.parsed.cash_offer_price, 17.79);
  assert.equal(result.parsed.target_swap_price, 19.15);
});

test('公告正文证券代码与事件标的不一致时拒绝入库', () => {
  const result = rules.validateParsedTerms('a_cash_offer', {
    cash_offer_price: 33.21,
    target_code_match: false,
    observed_codes: ['300955'],
  });
  assert.equal(result.coreComplete, false);
  assert.equal(result.parseStatus, 'conflict');
  assert.ok(result.errors.includes('target_code:mismatch'));
});

test('年份不能被当成价格', () => {
  const result = rules.validateParsedTerms('a_cash_offer', { cash_offer_price: 2026 });
  assert.equal(result.parsed.cash_offer_price, null);
  assert.ok(result.errors.includes('cash_offer_price:looks_like_year'));
});

test('监管立案公告识别为风险节点，不是终止公告', () => {
  const risk = rules.classifyRiskAnnouncement('大智慧：关于收到中国证监会立案告知书的公告');
  assert.equal(risk.riskType, 'regulatory_investigation');
  assert.equal(risk.severity, 'high');
  assert.equal(rules.classifyDocumentRole('大智慧：关于收到中国证监会立案告知书的公告'), 'risk');
});
