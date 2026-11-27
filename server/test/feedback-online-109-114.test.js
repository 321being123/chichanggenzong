// 2026-11-27 线上反馈 #109–#114（财报三表格式与层级）及 #86 表头对齐遗留的定向回归。
// 覆盖：通用表头包装/折行根因、双行名称合并、全零行过滤、层级视觉契约与虚线科目说明。
// 边界：只验证可离线复现的 DOM/静态 CSS 与领域展示结构；真实浏览器、真机与生产数据不在本文件范围。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const statementsScript = read('public/js/stock-analysis-statements.js');
const businessTableScript = read('public/shared/business-table.js');
const analysisCss = read('public/css/stock-analysis.css');
const sharedCss = read('public/shared/style.css');

const dict = require('../dataAccess/lixingerReportMetrics');
const pres = require('../domain/statementPresentation');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + ' —— ' + (err && err.message ? err.message : err));
  }
}

const BASE_HTML = '<select id="stock-analysis-statement-period"></select>'
  + '<select id="stock-analysis-statement-scope"></select>'
  + '<div id="stock-analysis-statements-title"></div>'
  + '<div id="stock-analysis-statements-meta"></div>'
  + '<div id="stock-analysis-statements-message"></div>'
  + '<div id="stock-analysis-statements-wrap"></div>';

function mountView() {
  const dom = new JSDOM(BASE_HTML, { pretendToBeVisual: true, runScripts: 'outside-only' });
  const window = dom.window;
  window.escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  window.stockAnalysisNumber = (value) => String(value);
  window.stockAnalysisPercent = (value) => String(value);
  window.stockAnalysisStatementFilters = () => ({ periodType: 'quarter', scope: 'consolidated' });
  window.eval(businessTableScript);
  window.eval(statementsScript);
  return dom;
}

function render(dom, payload) {
  dom.window.stockAnalysisRenderStatements(payload);
  return dom.window.document.getElementById('stock-analysis-statements-wrap');
}

function attachTable(dom) {
  const wrap = dom.window.document.getElementById('stock-analysis-statements-wrap');
  dom.window.BusinessTable.attach(wrap, { page: '#main-stock-analysis', sticky: false });
  return wrap;
}

function buildModel(statement, type = 'non_financial', periods = null, value = 1) {
  const context = `CN|${type}`;
  const metrics = dict.metricsOfType('CN', type).filter((metric) => metric.statement === statement).map((metric) => ({
    ...metric,
    relation_contexts: [context],
    context_rules: [{ context, rule: metric.hierarchy_rule }],
  }));
  const list = periods || [{ end_date: '2025-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', fs_table_type: type, currency: 'CNY' }];
  const fields = pres.presentationOf(metrics, statement, 'CNY').map((field) => ({
    ...field,
    values: list.map(() => ({ value, status: 'available' })),
  }));
  const model = pres.buildStatementPresentation(fields, { metrics, statement });
  return { fields, model, periods: list };
}

function specificity(selector) {
  let text = selector;
  let ids = 0;
  let classes = 0;
  let elements = 0;
  text = text.replace(/:not\(([^)]*)\)/g, (all, inner) => {
    const sub = specificity(inner);
    ids += sub[0]; classes += sub[1]; elements += sub[2];
    return ' ';
  });
  ids += (text.match(/#[\w-]+/g) || []).length;
  classes += (text.match(/\.[\w-]+/g) || []).length;
  classes += (text.match(/\[[^\]]+\]/g) || []).length;
  classes += (text.match(/:{1}[\w-]+(?:\([^)]*\))?/g) || []).length;
  const cleaned = text.replace(/#[\w-]+/g, ' ').replace(/\.[\w-]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ').replace(/::?[\w-]+(?:\([^)]*\))?/g, ' ');
  elements += (cleaned.match(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g) || []).length;
  return [ids, classes, elements];
}

function winner(css, element, property) {
  const rules = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((match = ruleRe.exec(source))) {
    const selectors = match[1].split(',').map((s) => s.trim()).filter(Boolean);
    const body = match[2];
    const propMatch = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)').exec(body);
    if (!propMatch) continue;
    selectors.forEach((sel) => {
      if (sel.startsWith('@')) return;
      let hit = false;
      try { hit = element.matches(sel); } catch (e) { hit = false; }
      if (hit) rules.push({ sel, value: propMatch[1].trim(), spec: specificity(sel), order: rules.length });
    });
  }
  const rank = (r) => r.spec[0] * 1e6 + r.spec[1] * 1e3 + r.spec[2];
  rules.sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order));
  return rules.length ? rules[rules.length - 1].value : null;
}

(async () => {
  console.log('--- 线上反馈 #109–#114 / #86 表头对齐 ---');

  await test('#109-1 左上角「默认单位：亿元」不被通用表头插入换行', () => {
    const dom = mountView();
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'none', unit_label: '默认单位：亿元', period_type: 'annual',
      periods: [{ end_date: '2025-12-31', period_type: 'annual', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
      fields: [{ code: 'ps.op', label: '营业利润', measure_type: 'currency', values: [{ value: 10, status: 'available' }] }],
    });
    attachTable(dom);
    const corner = wrap.querySelector('th.statement-col-corner');
    assert.ok(corner, '缺少左上角单位单元格');
    assert.strictEqual(corner.textContent.trim(), '默认单位：亿元', '单位标题不得被拆成「默认单位/：亿元」');
    assert.ok(!corner.querySelector('br'), '单位标题不得含 <br>');
    assert.ok(!corner.querySelector('.biz-table-head-label'), '单位标题不得被通用表头包装器处理');
    assert.match(analysisCss, /thead th\.statement-col-corner\{[^}]*white-space:nowrap/, '单位标题必须显式禁止折行');
    dom.window.close();
  });

  await test('#109-2 换行后的科目名称保持左对齐，且不被通用表头居中', () => {
    const dom = mountView();
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'none', unit_label: '默认单位：亿元', period_type: 'annual',
      periods: [{ end_date: '2025-12-31', period_type: 'annual', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
      fields: [{ code: 'ps.iifaajv', label: '(其中)对联营企业及合营企业的投资收益', measure_type: 'currency', values: [{ value: 10, status: 'available' }] }],
    });
    attachTable(dom);
    const nameCell = wrap.querySelector('tr[data-statement-code="ps.iifaajv"] th.statement-col-name');
    const summary = nameCell && nameCell.querySelector('.statement-label');
    assert.ok(nameCell, '缺少长科目名称单元格');
    assert.ok(summary, '缺少科目名称标签');
    assert.strictEqual(summary.textContent.trim(), '(其中)对联营企业及合营企业的投资收益', '科目名称必须完整保留');
    assert.ok(!nameCell.querySelector('br'), '科目名称不得由通用表头强制插入 <br>');
    assert.ok(!nameCell.querySelector('.biz-table-head-label'), '科目名称不得被居中包装器处理');
    assert.match(analysisCss, /tbody th\.statement-col-name[^{]*\{[^}]*text-align:left/, '科目名称列必须左对齐');
    assert.match(analysisCss, /statement-label-tip summary\{[^}]*text-align:left/, '换行后的提示摘要必须左对齐');
    dom.window.close();
  });

  await test('#109-3 当期/单季（半年）名称单元格垂直合并 rowspan=2，不再留空单元格', () => {
    const dom = mountView();
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'none', unit_label: '原值', period_type: 'quarter',
      periods: [{ end_date: '2025-09-30', period_type: 'q3', report_type_label: 'third_quarterly_report', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
      fields: [
        { code: 'ps.oi', label: '营业收入', measure_type: 'currency', values: [{ value: 100, status: 'available', single_value: 30 }] },
        { code: 'ps.beps', label: '基本每股收益', measure_type: 'per_share', unit: '元/股', values: [{ value: 1, status: 'available', single_value: 0.3 }] },
        { code: 'ps.gp_m', label: '毛利率', measure_type: 'percent', unit: '%', values: [{ value: 30, status: 'available' }] },
      ],
    });
    const primary = wrap.querySelector('tr[data-statement-code="ps.oi"]');
    const sub = wrap.querySelector('tr[data-statement-code="ps.oi"].statement-subperiod-row');
    assert.ok(primary && sub, '金额科目应生成当期/单季两行');
    const nameCell = primary.querySelector('th.statement-col-name');
    assert.strictEqual(nameCell.getAttribute('rowspan'), '2', '名称单元格必须垂直合并两行');
    assert.strictEqual(sub.querySelectorAll('th.statement-col-name').length, 0, '单季行不得再保留空的名称单元格');
    assert.strictEqual(sub.firstElementChild.className, 'statement-col-basis', '单季行首格应为口径列');
    assert.strictEqual(sub.firstElementChild.textContent.trim(), '单季', '子行口径必须为单季');
    assert.strictEqual(wrap.querySelectorAll('tr[data-statement-code="ps.beps"] th.statement-col-name[rowspan="2"]').length, 1, '每股收益同样合并');
    assert.strictEqual(wrap.querySelector('tr[data-statement-code="ps.gp_m"] th.statement-col-name').getAttribute('rowspan'), null, '比率类只有单行，不应合并');
    dom.window.close();
  });

  await test('#110 营业利润/营业外收支/营业外收入/支出/利润总额的层级与角色可区分', () => {
    const dom = mountView();
    const built = buildModel('income', 'non_financial', [{ end_date: '2025-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }]);
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'none', unit_label: '原值', period_type: 'annual',
      periods: built.periods, fields: built.fields, presentation: built.model,
    });
    const op = wrap.querySelector('tr[data-statement-code="ps.op"]');
    const section = [...wrap.querySelectorAll('tr.statement-section')].find((tr) => tr.textContent.trim() === '营业外收支');
    const noi = wrap.querySelector('tr[data-statement-code="ps.noi"]');
    const noe = wrap.querySelector('tr[data-statement-code="ps.noe"]');
    const tp = wrap.querySelector('tr[data-statement-code="ps.tp"]');
    assert.ok(op && section && noi && noe && tp, '关键行必须存在');
    assert.strictEqual(op.getAttribute('data-statement-level'), '0', '营业利润为 0 层结构小计');
    assert.ok(op.classList.contains('statement-role-subtotal') && !op.classList.contains('statement-has-children'), '营业利润是结构小计且没有子项');
    assert.ok(section.classList.contains('statement-level-0') && section.querySelector('th.statement-section-title'), '营业外收支是 0 层小节标题');
    assert.strictEqual(noi.getAttribute('data-statement-level'), '1', '加：营业外收入缩进 1 层');
    assert.strictEqual(noe.getAttribute('data-statement-level'), '1', '减：营业外支出缩进 1 层');
    assert.ok(noi.classList.contains('statement-has-children') && noe.classList.contains('statement-has-children'), '营业外收入/支出有其中项，应使用中性父级样式');
    assert.strictEqual(tp.getAttribute('data-statement-level'), '0', '利润总额回到 0 层结构小计');
    assert.match(analysisCss, /statement-role-subtotal\.statement-has-children>th\.statement-col-name/, '普通父项必须有中性样式，不与结构小计同色');
    dom.window.close();
  });

  await test('#111 现金流量表一级分组不折行，二级流入/流出有独立层级样式', () => {
    const dom = mountView();
    const built = buildModel('cashflow', 'non_financial', [{ end_date: '2025-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }]);
    const wrap = render(dom, {
      name: '现金流量表', type: 'cashflow', compare: 'none', unit_label: '原值', period_type: 'annual',
      periods: built.periods, fields: built.fields, presentation: built.model,
    });
    attachTable(dom);
    const sections = [...wrap.querySelectorAll('tr.statement-section')];
    const primary = sections.find((tr) => tr.textContent.trim() === '经营活动现金流');
    const inflow = sections.find((tr) => tr.textContent.trim() === '现金流入');
    assert.ok(primary && inflow, '一级活动与二级流入分组必须存在');
    assert.ok(primary.classList.contains('statement-level-0'), '经营活动现金流为一级分组');
    assert.ok(inflow.classList.contains('statement-level-1'), '现金流入为二级分组');
    for (const tr of sections) {
      assert.ok(!tr.querySelector('br'), '分组标题不得出现 <br> 折行：' + tr.textContent.trim());
      assert.ok(!tr.querySelector('.biz-table-head-label'), '分组标题不得被通用表头包装器处理');
      assert.ok(tr.querySelector('.statement-section-text'), '分组标题必须使用三表专用文本容器');
    }
    assert.match(analysisCss, /statement-section-text\{[^}]*white-space:nowrap/, '分组标题文本必须禁止折行');
    assert.match(analysisCss, /tr\.statement-section\.statement-level-1 th\{[^}]*padding-left:22px/, '二级分组必须有缩进和独立背景');
    dom.window.close();
  });

  await test('#112 全零行（含 0 同比/0 环比）必须隐藏，全 null 汇总行与异常状态保留', () => {
    const dom = mountView();
    const periods = [
      { end_date: '2025-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' },
      { end_date: '2024-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' },
    ];
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'yoy', unit_label: '原值', period_type: 'annual', periods,
      fields: [
        { code: 'ps.core_zero', label: '普通全零项(带0同比)', measure_type: 'currency', values: [
          { value: 0, status: 'available', yoy: 0, yoy_status: 'available' },
          { value: 0, status: 'available', yoy: 0, yoy_status: 'available' },
        ] },
        { code: 'ps.core_zero_single', label: '普通全零项(带0单季同比)', measure_type: 'currency', values: [
          { value: 0, status: 'available', yoy: 0, yoy_status: 'available', single_value: 0, single_yoy: 0 },
          { value: 0, status: 'available', yoy: 0, yoy_status: 'available', single_value: 0, single_yoy: 0 },
        ] },
        { code: 'ps.zero_uncomparable', label: '全零但比较不可比项', measure_type: 'currency', values: [
          { value: 0, status: 'available', yoy: null, yoy_status: 'unavailable', yoy_reason: 'comparison_basis_uncomparable' },
          { value: 0, status: 'available', yoy: null, yoy_status: 'unavailable', yoy_reason: 'comparison_basis_uncomparable' },
        ] },
        { code: 'ps.zero_then_yoy', label: '仅同比有值项', measure_type: 'currency', values: [
          { value: 0, status: 'available', yoy: 0.05, yoy_status: 'available' },
          { value: 0, status: 'available', yoy: 0.05, yoy_status: 'available' },
        ] },
        { code: 'ps.incomplete', label: '采集不完整项', measure_type: 'currency', values: [
          { value: null, status: 'collection_incomplete', reason: 'source_batch_incomplete' },
          { value: null, status: 'collection_incomplete', reason: 'source_batch_incomplete' },
        ] },
        { code: 'ps.total_zero', label: '核心汇总零值', measure_type: 'currency', row_role: 'total', values: [
          { value: 0, status: 'available', yoy: 0, yoy_status: 'available' },
          { value: 0, status: 'available', yoy: 0, yoy_status: 'available' },
        ] },
      ],
      presentation: {
        version: '2026-11-23.1',
        rows: [
          { kind: 'section', row_role: 'section', group_id: 'group:空分组', label: '空分组', depth: 0 },
          { kind: 'field', code: 'ps.core_zero', row_role: 'line', group_id: 'group:空分组', parent_code: null, depth: 1, relation_status: 'group_only' },
          { kind: 'section', row_role: 'section', group_id: 'group:保留分组', label: '保留分组', depth: 0 },
          { kind: 'field', code: 'ps.core_zero_single', row_role: 'line', group_id: 'group:保留分组', parent_code: null, depth: 1, relation_status: 'group_only' },
          { kind: 'field', code: 'ps.zero_uncomparable', row_role: 'line', group_id: 'group:保留分组', parent_code: null, depth: 1, relation_status: 'group_only' },
          { kind: 'field', code: 'ps.zero_then_yoy', row_role: 'line', group_id: 'group:保留分组', parent_code: null, depth: 1, relation_status: 'group_only' },
          { kind: 'field', code: 'ps.incomplete', row_role: 'line', group_id: 'group:保留分组', parent_code: null, depth: 1, relation_status: 'group_only' },
          { kind: 'field', code: 'ps.total_zero', row_role: 'total', group_id: 'group:保留分组', parent_code: null, depth: 0, relation_status: 'group_only' },
        ],
      },
    });
    const text = wrap.textContent;
    assert.ok(!text.includes('普通全零项(带0同比)'), '全 0 且同比 0 的普通行必须隐藏');
    assert.ok(!text.includes('普通全零项(带0单季同比)'), '全 0 且单季同比 0 的普通行必须隐藏');
    assert.ok(!text.includes('全零但比较不可比项'), '全 0 行不因比较状态异常而重新出现');
    assert.ok(!text.includes('空分组'), '没有保留子项的空分组必须隐藏');
    assert.ok(text.includes('仅同比有值项'), '同比非零的行必须保留');
    assert.ok(text.includes('采集不完整项'), '全 null 但采集不完整的行必须保留并说明原因');
    assert.ok(text.includes('核心汇总零值'), '核心汇总/总计零值行必须保留，不能误删');
    dom.window.close();
  });

  await test('#113 财务费用/投资收益及其「其中」项缩进、父项与引导线可区分', () => {
    const dom = mountView();
    const built = buildModel('income', 'non_financial', [{ end_date: '2025-12-31', period_type: 'annual', report_type_label: 'annual_report', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }]);
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'none', unit_label: '原值', period_type: 'annual',
      periods: built.periods, fields: built.fields, presentation: built.model,
    });
    const fe = wrap.querySelector('tr[data-statement-code="ps.fe"]');
    const ieife = wrap.querySelector('tr[data-statement-code="ps.ieife"]');
    const iiife = wrap.querySelector('tr[data-statement-code="ps.iiife"]');
    const ivi = wrap.querySelector('tr[data-statement-code="ps.ivi"]');
    const iifaajv = wrap.querySelector('tr[data-statement-code="ps.iifaajv"]');
    assert.ok(fe && ieife && iiife && ivi && iifaajv, '财务费用/投资收益及其中项必须存在');
    assert.ok(fe.classList.contains('statement-has-children'), '财务费用作为父项应有子项标识');
    assert.strictEqual(Number(ieife.getAttribute('data-statement-level')), Number(fe.getAttribute('data-statement-level')) + 1, '利息费用必须比财务费用深一层');
    assert.strictEqual(iiife.getAttribute('data-parent-code'), 'ps.fe', '利息收入必须挂财务费用');
    assert.strictEqual(iifaajv.getAttribute('data-parent-code'), 'ps.ivi', '联营合营投资收益必须挂投资收益');
    assert.ok(ieife.classList.contains('statement-role-detail') && ieife.querySelector('.statement-branch'), '其中项必须有 detail 角色与连接符');
    assert.match(analysisCss, /statement-role-detail\.statement-level-1>th\.statement-col-name\{[^}]*padding-left:32px/, '其中项必须有额外缩进');
    assert.match(analysisCss, /statement-role-detail>th\.statement-col-name \.statement-label\{[^}]*color:var\(--text-secondary\)/, '其中项必须使用次级文字色');
    dom.window.close();
  });

  await test('#114 虚线科目在悬停/聚焦/点按均可读到完整说明', () => {
    const dom = mountView();
    const wrap = render(dom, {
      name: '利润表', type: 'income', compare: 'none', unit_label: '原值', period_type: 'annual',
      periods: [{ end_date: '2025-12-31', period_type: 'annual', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
      fields: [
        { code: 'ps.ie', label: '利息支出', measure_type: 'currency', values: [{ value: null, status: 'source_unavailable', reason: 'metric_not_requested' }] },
        { code: 'ps.face', label: '手续费及佣金支出', measure_type: 'currency', values: [{ value: 12, status: 'available' }] },
        { code: 'ps.iiicr', label: '提取保险责任准备金净额', measure_type: 'currency', values: [{ value: 8, status: 'available' }] },
        { code: 'ps.phdrfpip', label: '保单红利支出', measure_type: 'currency', values: [{ value: null, status: 'source_unavailable', reason: 'metric_not_requested' }] },
      ],
    });
    for (const [code, keyword] of [
      ['ps.ie', '利息支出：企业为筹资及经营业务发生的利息支出'],
      ['ps.face', '手续费及佣金支出：金融、保险等业务发生的手续费及佣金支出'],
      ['ps.iiicr', '提取保险责任准备金净额：保险公司按规定提取的保险责任准备金'],
      ['ps.phdrfpip', '保单红利支出：保险公司按合同约定向保单持有人分配的保单红利支出'],
    ]) {
      const row = wrap.querySelector('tr[data-statement-code="' + code + '"]');
      assert.ok(row, '缺少科目行：' + code);
      const tip = row.querySelector('details.statement-label-tip');
      assert.ok(tip && tip.querySelector('summary.statement-label-has-tip'), '虚线科目必须渲染可交互说明：' + code);
      assert.ok(tip.textContent.includes(keyword), '说明文案必须包含科目含义：' + code);
      assert.ok(tip.querySelector('.statement-label-tip-body'), '说明正文必须存在：' + code);
    }
    assert.match(analysisCss, /statement-label-tip:not\(\[open\]\):hover>\.statement-label-tip-body/, '桌面悬停必须展开说明');
    assert.match(analysisCss, /statement-label-tip:not\(\[open\]\):focus-within>\.statement-label-tip-body/, '键盘聚焦必须展开说明');
    assert.match(analysisCss, /statement-label-has-tip\{[^}]*border-bottom:1px dashed/, '说明入口必须保留虚线下划线');
    dom.window.close();
  });

  await test('#86 表头首格左对齐/单行、口径列居中，并保留其他业务表通用表头包装', () => {
    const dom = mountView();
    const wrap = render(dom, {
      name: '资产负债表', type: 'balance', compare: 'none', unit_label: '默认单位：亿元', period_type: 'annual',
      periods: [{ end_date: '2025-12-31', period_type: 'annual', scope: 'consolidated', fs_table_type: 'non_financial', currency: 'CNY' }],
      fields: [{ code: 'bs.ta', label: '资产总计', measure_type: 'currency', values: [{ value: 1, status: 'available' }] }],
    });
    attachTable(dom);
    const corner = wrap.querySelector('th.statement-col-corner');
    const basis = wrap.querySelector('th.statement-col-basis');
    assert.strictEqual(winner(analysisCss + '\n' + sharedCss, corner, 'text-align'), 'left', '表头首格最终必须左对齐');
    assert.strictEqual(winner(analysisCss + '\n' + sharedCss, corner, 'white-space'), 'nowrap', '表头首格最终必须单行');
    if (basis) assert.strictEqual(winner(analysisCss + '\n' + sharedCss, basis, 'text-align'), 'center', '第二列口径必须居中');

    const normal = dom.window.document.createElement('div');
    normal.innerHTML = '<table class="biz-table"><thead><tr><th>很长很长的普通表头名称</th></tr></thead></table>';
    dom.window.document.body.appendChild(normal);
    dom.window.BusinessTable.attach(normal, { sticky: false });
    assert.ok(normal.querySelector('thead th .biz-table-head-label'), '非三表业务表仍应保留通用表头包装，避免影响其他页面');
    dom.window.close();
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
