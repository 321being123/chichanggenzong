// 可转债资料输入「纯判定」行为基线（S5 分层提取的前后等价证据）。
//
// 目的：这些函数要从 services 提取到 domain，本文件用固定输入钉住它们的当前输出。
// 提取后导出面不变（service 继续 re-export），本文件必须逐字通过——
// 通过 = 行为等价；任何一条变化都说明提取改变了判定结果，必须先解释再改基线。
//
// 只调用纯函数，不连库、不发 HTTP、不跑子进程。
const assert = require('assert');

const inputs = require('../services/convertibleBondAnalysisInputs');
const { analysisInputTools: tools } = require('../services/convertibleBondAnalysis');
const core = require('../services/convertibleBondAnalysisCore');

const bond = {
  ts_code: '127040.SZ',
  stock_code: '002091.SZ',
  instrument_id: 90001,
  bond_short_name: '国泰转债',
  bond_full_name: '江苏国泰国际集团股份有限公司公开发行可转换公司债券',
  value_date: '2021-07-07',
  list_date: '2021-08-10',
  maturity_date: '2027-07-07',
  first_conv_price: 9.32,
  raw_payload: { issue_size: 455740000, rating_comp: '联合资信' }
};

const cases = [];
function check(name, run) {
  cases.push({ name, run });
}

// ---------- 日期与报告期 ----------
check('isoDate 规范化（Date / 数字串 / 空值）', () => {
  assert.strictEqual(core.isoDate(new Date('2026-10-30T04:00:00Z')), '2026-10-30');
  assert.strictEqual(core.isoDate('20261030'), '2026-10-30');
  assert.strictEqual(core.isoDate('2026-10-30'), '2026-10-30');
  assert.strictEqual(core.isoDate(''), null);
  assert.strictEqual(core.isoDate(null), null);
  assert.strictEqual(core.isoDate(new Date('invalid')), null);
});

check('requiredReportPeriod 三期边界', () => {
  assert.strictEqual(inputs.requiredReportPeriod('2026-04-30'), '2025-06-30');
  assert.strictEqual(inputs.requiredReportPeriod('2026-05-01'), '2025-12-31');
  assert.strictEqual(inputs.requiredReportPeriod('2026-08-31'), '2025-12-31');
  assert.strictEqual(inputs.requiredReportPeriod('2026-09-01'), '2026-06-30');
});

check('reportPeriod / isFullReport 标题解析', () => {
  assert.strictEqual(tools.reportPeriod('长海股份：2026年半年度报告'), '2026-06-30');
  assert.strictEqual(tools.reportPeriod('公司2025年年度报告'), '2025-12-31');
  assert.strictEqual(tools.reportPeriod('关于2026年半年度报告的提示性公告'), '2026-06-30');
  assert.strictEqual(tools.reportPeriod('评级报告'), null);
  assert.strictEqual(tools.isFullReport({ url: 'u', title: '长海股份：2026年半年度报告' }), true);
  assert.strictEqual(tools.isFullReport({ url: 'u', title: '2026年半年度报告摘要' }), false);
  assert.strictEqual(tools.isFullReport({ url: '', title: '2026年半年度报告' }), false);
});

// ---------- 文档选择 ----------
check('latestProspectus 确定性择优与已核验绑定', () => {
  const events = [
    { url: 'p-old', title: '公司公开发行可转换公司债券募集说明书', event_date: '2021-07-03' },
    { url: 'p-rev', title: '公司公开发行可转换公司债券募集说明书（更正版）', event_date: '2021-07-03' },
    { url: 'p-later', title: '公司公开发行可转换公司债券募集说明书', event_date: '2021-07-04' }
  ];
  assert.strictEqual(tools.latestProspectus(events).url, 'p-later');
  assert.strictEqual(tools.latestProspectus(events.slice(0, 2)).url, 'p-rev');
  assert.strictEqual(tools.latestProspectus(events, { preferUrl: 'p-old' }).url, 'p-old');
  assert.strictEqual(tools.latestProspectus([{ url: 'x', title: '公司向特定对象发行股票募集说明书', event_date: '2021-07-03' }]), null);
});

check('inputDocuments 全量选择结果', () => {
  const events = [
    { url: 'p1', title: '公司公开发行可转换公司债券募集说明书', event_date: '2021-07-03' },
    { url: 'i1', title: '公司向不特定对象发行可转换公司债券发行公告', event_date: '2021-07-05' },
    { url: 'i-correction', title: '公司向不特定对象发行可转换公司债券发行公告更正公告', event_date: '2021-07-05' },
    { url: 'r1', title: '长海股份：2026年半年度报告', event_date: '2026-08-22' },
    { url: 'r-old', title: '长海股份：2025年年度报告', event_date: '2026-04-20' },
    { url: 'rt1', title: '公司2026年评级报告', event_date: '2026-06-25' },
    { url: 'rt-notice', title: '公司2026年评级结果公告', event_date: '2026-06-25' },
    { url: 'rt-delay', title: '关于延迟披露2026年评级报告的公告', event_date: '2026-06-20' },
    { url: 'rt-issuer', title: '江苏国泰国际集团股份有限公司主体信用评级报告', event_date: '2026-06-25' }
  ];
  const selected = inputs.inputDocuments(events, bond);
  assert.deepStrictEqual(
    selected.map(item => [item.kind, item.event.url]),
    [
      ['rating', 'rt-notice'],
      ['prospectus', 'p1'],
      ['issuance_terms', 'i1'],
      ['holders', 'r1'],
      ['price_history', 'r1'],
      ['rating', 'rt1']
    ],
    '评级结果公告先排，其余按 募集说明书→发行条款→持有人/价格→评级报告'
  );
});

check('inputDocuments 已核验文件不被重跑换绑', () => {
  const events = [
    { url: 'p-a', title: '公司公开发行可转换公司债券募集说明书', event_date: '2021-07-03' },
    { url: 'p-b', title: '公司公开发行可转换公司债券募集说明书（修订版）', event_date: '2021-07-03' }
  ];
  const withBinding = inputs.inputDocuments(events, bond, {
    documents: { 'prospectus:p-a': { status: 'complete', announcedAt: '2021-07-03' } }
  });
  assert.strictEqual(withBinding.find(d => d.kind === 'prospectus').event.url, 'p-a');
});

// ---------- 评级标题与身份判定 ----------
check('isRatingPublicationDelay / isRatingResultNotice', () => {
  assert.strictEqual(inputs.isRatingPublicationDelay({ title: '关于延迟披露2026年评级报告的公告' }), true);
  assert.strictEqual(inputs.isRatingPublicationDelay({ title: '关于信用等级调整的公告' }), false);
  assert.strictEqual(inputs.isRatingResultNotice({ title: '公司2026年评级结果公告' }), true);
  assert.strictEqual(inputs.isRatingResultNotice({ title: '关于延迟披露评级报告的公告' }), false);
  assert.strictEqual(inputs.isRatingResultNotice({ title: '公司2026年评级报告' }), false);
});

check('isBondRatingDocument 主体报告不当作债项来源', () => {
  assert.strictEqual(inputs.isBondRatingDocument({ title: '公司可转换公司债券2026年跟踪评级报告' }), true);
  assert.strictEqual(inputs.isBondRatingDocument({ title: '公司2026年评级结果公告' }), true);
  assert.strictEqual(inputs.isBondRatingDocument({ title: '江苏国泰国际集团股份有限公司主体信用评级报告' }), false);
});

check('issuerNameOf 三种公司写法', () => {
  assert.strictEqual(inputs.issuerNameOf('江苏国泰国际集团股份有限公司公开发行可转换公司债券'), '江苏国泰国际集团股份有限公司');
  assert.strictEqual(inputs.issuerNameOf('某有限责任公司债券'), '某有限责任公司');
  assert.strictEqual(inputs.issuerNameOf('某股份公司债'), '某股份公司');
  assert.strictEqual(inputs.issuerNameOf('没有后缀的公司'), undefined);
});

check('shouldRetryRatingFailure / needRatingResultNotices', () => {
  assert.strictEqual(inputs.shouldRetryRatingFailure('rating', { status: 'failed', ratingCapability: 'old' }), true);
  assert.strictEqual(
    inputs.shouldRetryRatingFailure('rating', { status: 'failed', ratingCapability: inputs.RATING_RETRY_CAPABILITY }),
    false
  );
  assert.strictEqual(inputs.shouldRetryRatingFailure('holders', { status: 'failed' }), false);
  assert.strictEqual(inputs.needRatingResultNotices({ reportCount: 0, latestComplete: true, hasIncompleteReport: false }), true);
  assert.strictEqual(inputs.needRatingResultNotices({ reportCount: 2, latestComplete: true, hasIncompleteReport: true }), true);
  assert.strictEqual(inputs.needRatingResultNotices({ reportCount: 2, latestComplete: false, hasIncompleteReport: false }), true);
  assert.strictEqual(inputs.needRatingResultNotices({ reportCount: 2, latestComplete: true, hasIncompleteReport: false }), false);
});

check('terminalGap 只认三种终态', () => {
  assert.deepStrictEqual(
    inputs.terminalGap({ terminal_gaps: { holders: { status: 'not_disclosed', reason: 'x' } } }, 'holders'),
    { status: 'not_disclosed', reason: 'x' }
  );
  assert.strictEqual(inputs.terminalGap({ terminal_gaps: { holders: { status: 'unknown' } } }, 'holders'), null);
  assert.strictEqual(inputs.terminalGap(null, 'holders'), null);
  assert.deepStrictEqual([...inputs.TERMINAL_GAP_STATUSES], ['source_unavailable', 'not_disclosed', 'conflict']);
});

check('validateHolderExemption 证据不全必须抛错', () => {
  assert.throws(
    () => inputs.validateHolderExemption({ parse_status: 'not_applicable' }, bond),
    /持有人不适用缺少目标债券、报告期和实际上市日一致证据/
  );
  assert.doesNotThrow(() => inputs.validateHolderExemption({
    parse_status: 'not_applicable',
    report_date: '2020-12-31',
    holder_table_bond: '国泰转债',
    holder_exemption: {
      reason: 'not_listed_by_report_period',
      listing_date: '2021-08-10',
      bond_name: '国泰转债',
      evidence: '债券于报告期末尚未上市'
    }
  }, bond), '报告期早于上市日且证据含「未上市」时才允许豁免');
});

// ---------- 评级要求与覆盖 ----------
const completeRecord = {
  rating: 'AA',
  rating_date: '2026-06-25',
  announced_at: '2026-06-25',
  rating_company: '联合资信',
  rating_outlook: '稳定',
  raw_payload: {
    document_hash: 'a'.repeat(64),
    rating_result_notice: { bond_code: '127040.SZ', bond_name: '国泰转债', rating_company: '联合资信' },
    rating_date_source: 'official_document',
    rating_date: '2026-06-25',
    rating: 'AA',
    rating_com_name: '联合资信',
    rating_outlook: '稳定',
    rating_type: '债项评级',
    rating_conflicts: []
  }
};
const ratingDocuments = [{ kind: 'rating', event: { url: 'rt-notice', title: '公司2026年评级结果公告', event_date: '2026-06-25', source: 'szse' } }];

check('ratingRequirement 完整评级', () => {
  const result = inputs.ratingRequirement(bond, [completeRecord], ratingDocuments, '2026-10-30');
  assert.deepStrictEqual(result, {
    version: inputs.RATING_REQUIREMENT_VERSION,
    target_date: '2026-10-30',
    history_available: true,
    history_count: 1,
    latest_complete: true,
    latest_rating_date: '2026-06-25',
    latest_announced_at: '2026-06-25',
    latest_rating: 'AA',
    latest_agency: '联合资信',
    latest_outlook: '稳定',
    outlook_status: 'original',
    required_document_urls: []
  });
});

check('ratingRequirement 接口来源缺展望不作否决', () => {
  const apiRecord = {
    rating: 'AA+',
    rating_date: '2026-07-01',
    announced_at: '2026-07-01',
    rating_company: '中诚信',
    rating_outlook: null,
    raw_payload: {
      ts_code: '127040.SZ',
      rating: 'AA+',
      rating_com_name: '中诚信',
      rating_outlook: null,
      outlook_status: 'api_unavailable',
      rating_date: '2026-07-01',
      rating_type: '债项评级'
    }
  };
  const result = inputs.ratingRequirement(bond, [apiRecord], [], '2026-10-30');
  assert.strictEqual(result.latest_complete, true);
  assert.strictEqual(result.outlook_status, 'api_unavailable');
  assert.strictEqual(result.latest_outlook, null);
});

check('ratingRequirement 主体评级与日期倒挂判不完整', () => {
  const issuerRecord = {
    ...completeRecord,
    rating_date: '2026-06-26',
    announced_at: '2026-06-25',
    raw_payload: { ...completeRecord.raw_payload, rating_type: '主体评级', rating_date: '2026-06-26' }
  };
  const result = inputs.ratingRequirement(bond, [issuerRecord], ratingDocuments, '2026-10-30');
  assert.strictEqual(result.latest_complete, false);
  assert.deepStrictEqual(result.required_document_urls, ['rt-notice']);
});

check('ratingRequirement 结果公告早于最新文档时判不完整', () => {
  const older = { ...completeRecord, rating_date: '2026-06-20', announced_at: '2026-06-20', raw_payload: { ...completeRecord.raw_payload, rating_date: '2026-06-20' } };
  const result = inputs.ratingRequirement(bond, [older], ratingDocuments, '2026-10-30');
  assert.strictEqual(result.latest_complete, false, 'announced 早于最新评级结果公告日，视为缺本期原文');
});

check('ratingCoverageForReport 无匹配时返回 null', () => {
  const report = { url: 'rt-report', title: '公司2026年跟踪评级报告', event_date: '2026-06-25', source: 'szse' };
  const result = inputs.ratingCoverageForReport(report, [], {}, bond, []);
  assert.strictEqual(result, null);
});

check('validateRatingResultNotice 非结果公告直接放行', () => {
  assert.doesNotThrow(() => inputs.validateRatingResultNotice({ title: '公司2026年评级报告' }, {}, bond));
});

check('validateRatingResultNotice 缺原文证据必须抛错', () => {
  const noticeEvent = { title: '公司2026年评级结果公告', url: 'u', event_date: '2026-06-25', source: 'szse' };
  assert.throws(
    () => inputs.validateRatingResultNotice(noticeEvent, { rating: 'AA' }, bond),
    /评级结果公告缺目标代码、发行人或本次原文证据/
  );
});

check('validateRatingGrade 冲突结论必须抛错', () => {
  assert.doesNotThrow(() => inputs.validateRatingGrade({ rating: 'AA' }));
  assert.throws(() => inputs.validateRatingGrade({ rating_conflicts: ['AA', 'AA+'] }), /目标债项本次评级结论冲突/);
});

check('missingReportRepairStart 断点续补', () => {
  assert.strictEqual(inputs.missingReportRepairStart(bond, {}, '2026-10-24', []), '2026-07-01');
  assert.strictEqual(inputs.missingReportRepairStart({ ...bond, value_date: '2026-07-01' }, {}, '2026-10-24', []), null);
  assert.strictEqual(
    inputs.missingReportRepairStart(bond, {
      reportRepair: { version: 'bond-doc-selection-2026-10-24-v2', reportPeriod: '2026-06-30', checkedThrough: '2026-10-24' }
    }, '2026-10-24', []),
    null
  );
});

check('validateTrackingRatingYear 年度不一致必须抛错', () => {
  assert.throws(
    () => inputs.validateTrackingRatingYear(
      { title: '公司2026年跟踪评级报告' },
      { rating_date: '2025-06-25', rating_date_source: 'official_document', rating_date_context: 'other_context' }
    ),
    /跟踪报告年度与未限定本次的评级日期不一致/
  );
  assert.doesNotThrow(() => inputs.validateTrackingRatingYear(
    { title: '公司2026年跟踪评级报告' },
    { rating_date: '2025-06-25', rating_date_source: 'official_document', rating_date_context: 'current_explicit_label' }
  ));
});

// ---------- 执行 ----------
let failed = 0;
for (const item of cases) {
  try {
    item.run();
    console.log('  ✓ ' + item.name);
  } catch (error) {
    failed += 1;
    console.log('  ✗ ' + item.name + ' —— ' + (error && error.message));
  }
}
console.log('convertible-bond-analysis-rules-golden: ' + cases.length + ' 项基线，失败 ' + failed);
process.exit(failed ? 1 : 0);
