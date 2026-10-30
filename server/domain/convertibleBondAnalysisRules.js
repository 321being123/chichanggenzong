// 可转债详细分析「资料输入」纯判定域（S5 分层提取，2026-10-30 从 services 原样搬移）。
// 约束：本文件不得出现 SQL、连接池、HTTP、子进程、req/res、DOM 或调度器依赖；
// 上游取数在 server/repositories/convertibleBondAnalysisInputsRepository.js，
// 文档解析子进程与事务编排仍在 server/services/convertibleBondAnalysisInputs.js。
// 这里的函数只做「给定事实 → 判定结果」，不判断事实从哪个来源来。
const crypto = require('crypto');

// ---------- 日期与报告期 ----------
const CN_OFFSET_MS = 8 * 3600 * 1000;

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const cn = new Date(value.getTime() + CN_OFFSET_MS);
    return `${cn.getUTCFullYear()}-${String(cn.getUTCMonth() + 1).padStart(2, '0')}-${String(cn.getUTCDate()).padStart(2, '0')}`;
  }
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

// Securities Law reporting periods: annual reports within four months; half-year within two.
function requiredReportPeriod(targetDate) {
  const year = Number(targetDate.slice(0, 4)), month = Number(targetDate.slice(5, 7));
  return month >= 9 ? `${year}-06-30` : month >= 5 ? `${year - 1}-12-31` : `${year - 1}-06-30`;
}

function reportPeriod(title) {
  const match = String(title || '').match(/(20\d{2})\s*年\s*(半年度|年度)报告/);
  if (!match) return null;
  return `${match[1]}-${match[2] === '半年度' ? '06-30' : '12-31'}`;
}

function isFullReport(event) {
  return Boolean(reportPeriod(event.title) && event.url && !/摘要|英文|取消/.test(String(event.title || '')) &&
    /20\d{2}年(?:半年度|年度)报告(?:全文)?(?:[（(](?:修订|更新|更正)(?:版|稿|后)?[）)])?$/.test(String(event.title || '').replace(/\s+/g, '')));
}

function latestFullReport(events) {
  return (events || []).filter(isFullReport)
    .sort((a, b) => reportPeriod(b.title).localeCompare(reportPeriod(a.title)) ||
      String(isoDate(b.event_date || b.announced_at) || '').localeCompare(String(isoDate(a.event_date || a.announced_at) || '')))[0] || null;
}

function latestProspectus(events, { allowGeneric = false, preferUrl = null } = {}) {
  const correctionRank = event => (/更正版|修订版|更新版|更正后/.test(String(event.title || '')) ? 0 : 1);
  const candidates = (events || [])
    .filter(event => (/(?:可转换公司债(?:券)?|可转债).{0,20}募集说明书/.test(String(event.title || ''))
      || allowGeneric && /募集说明书/.test(String(event.title || '')) && !/发行.*股票|公司债券(?!.*可转换)/.test(event.title)) && event.url
      && !/摘要|申报稿|上会稿|反馈|补充法律意见|更正公告|提示(?:性)?公告/.test(event.title));
  // 同一发行常有旧版/更正版同名文件：已核验文件优先保留，未绑定时按 日期新→更正版→网址 确定性择优，禁止随机换绑。
  const preferred = preferUrl ? candidates.find(event => event.url === preferUrl) : null;
  return preferred || candidates.sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))
    || correctionRank(a) - correctionRank(b) || String(a.url).localeCompare(String(b.url)))[0] || null;
}

// ---------- 版本与终态常量 ----------
const INPUT_VERSION = 'analysis-input-v4';
const DOCUMENT_SELECTION_VERSION = 'bond-doc-selection-2026-10-24-v2';
const RATING_REQUIREMENT_VERSION = 'latest-complete-history-present-v1';
// 评级解析能力版本：只用于让历史 failed 文档在解析器/执行环境改进后重试一次，
// 不影响 complete 文档（它们仍按 INPUT_VERSION 跳过），避免全量重算。
const RATING_RETRY_CAPABILITY = 'rating-retry-2026-10-24e';

// 资料终态：来源确实未覆盖、原文明确未披露、或存在无法消解的证据冲突。
// 终态只用于停止每日重试并保留证据，不改变“已完整”事实；无证据不得写入。
const TERMINAL_GAP_STATUSES = Object.freeze(['source_unavailable', 'not_disclosed', 'conflict']);

function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ---------- 评级与文档标题判定 ----------
function shouldRetryRatingFailure(kind, prior) {
  return kind === 'rating' && prior?.status === 'failed' && prior?.ratingCapability !== RATING_RETRY_CAPABILITY;
}

// 评级结果公告是否需要处理：报告缺失、报告解析不完整，或最新评级本身仍不完整（缺展望/实际日等）。
function needRatingResultNotices({ reportCount, latestComplete, hasIncompleteReport }) {
  if (!reportCount) return true;
  if (hasIncompleteReport) return true;
  return latestComplete === false;
}

function validateRatingGrade(result) {
  if (result.rating_conflicts?.length) throw new Error(`目标债项本次评级结论冲突，保留原事实：${JSON.stringify(result.rating_conflicts)}`);
}

function validateTrackingRatingYear(event, output) {
  const years = [...new Set([...String(event.title || '').normalize('NFKC').replace(/\s+/g, '').matchAll(/(20\d{2})年(?:度)?(?:定期)?跟踪(?:信用)?评级(?:报告|结果)/g)].map(match => match[1]))];
  if (years.length === 1 && output.rating_date_source === 'official_document' && output.rating_date?.slice(0, 4) !== years[0] &&
    !['current_explicit_label', 'current_summary_table', 'current_report_issuance'].includes(output.rating_date_context)) {
    throw new Error('跟踪报告年度与未限定本次的评级日期不一致，疑似历史日期，保留待核验');
  }
}

// 发行人全称：交易所公告里“股份有限公司/有限责任公司/股份公司”三种写法都存在。
function issuerNameOf(fullName) {
  return String(fullName || '').match(/^(.+?(?:股份有限公司|有限责任公司|股份公司))/)?.[1];
}

function isRatingPublicationDelay(event) {
  const title = String(event.title || '').trim();
  return /(?:延迟|延期)披露.*评级报告(?:的)?公告$/.test(title) && !/评级调整|信用等级.*调整|调整.*信用等级/.test(title);
}

function isRatingResultNotice(event) {
  return /评级结果(?:的)?公告$/.test(String(event.title || '')) && !isRatingPublicationDelay(event);
}

// 主体（发行人）信用评级报告不含本债债项结论，不能当债项评级来源；
// 债项报告标题必须提到可转债/可转换公司债券/转债，或本身就是评级结果公告。
function isBondRatingDocument(event) {
  const title = String(event?.title || '');
  if (isRatingResultNotice(event) || /评级调整|信用等级.*调整|调整.*信用等级/.test(title)) return true;
  if (/可转债|可转换公司债券|转债/.test(title)) return true;
  return !/主体|发行人|公司信用评级报告|年度.{0,12}信用评级报告/.test(title);
}

function terminalGap(state, field) {
  const item = state && state.terminal_gaps && state.terminal_gaps[field];
  return item && TERMINAL_GAP_STATUSES.includes(String(item.status || '')) ? item : null;
}

function validateHolderExemption(result, bond) {
  const exemption = result.holder_exemption, period = isoDate(result.report_date), listed = isoDate(bond.list_date);
  if (result.parse_status !== 'not_applicable' || !period || !listed || listed <= period || exemption?.reason !== 'not_listed_by_report_period'
    || exemption.listing_date !== listed || exemption.bond_name !== bond.bond_short_name || result.holder_table_bond !== bond.bond_short_name
    || !exemption.evidence?.includes('未上市')) throw new Error('持有人不适用缺少目标债券、报告期和实际上市日一致证据');
}

function validateRatingResultNotice(event, result, bond) {
  if (!isRatingResultNotice(event)) return;
  const notice = result.rating_result_notice;
  if (!['sse', 'szse'].includes(event.source) || notice?.version !== 'named-result-v1' || notice.bond_code !== bond.ts_code ||
    notice.bond_name !== bond.bond_short_name || !notice.issuer_name || !String(bond.bond_full_name || '').startsWith(notice.issuer_name) ||
    !result.rating_com_name || notice.rating_company !== result.rating_com_name ||
    result.source_url !== event.url || !/^[a-f0-9]{64}$/i.test(result.document_hash || '') || !result.rating || !result.rating_outlook || result.rating_conflicts?.length ||
    result.rating_date_source !== 'official_document' || !result.rating_date || result.rating_date > isoDate(event.event_date) ||
    notice.report_reference?.issued_at !== result.rating_date || !String(notice.report_reference.title || '').includes(notice.issuer_name)) {
    throw new Error('评级结果公告缺目标代码、发行人或本次原文证据，禁止替代报告');
  }
  for (const prior of result.rating_requirement_version === RATING_REQUIREMENT_VERSION ? [] : notice.previous_ratings || []) if (!prior.rating || !prior.rating_outlook || !prior.date_evidence || !prior.rating_evidence ||
    prior.rating_com_name !== result.rating_com_name ||
    prior.rating_date_source !== 'official_document' || prior.rating_date_context !== 'explicit_previous_named_bond' || !prior.rating_date || prior.rating_date >= result.rating_date) {
    throw new Error('结果公告前次评级缺独立债项、实际日与展望证据');
  }
}

function readValidatedRatingNotice(event, documents, bond) {
  const saved = documents[`rating:${event.url}`];
  if (saved?.status !== 'complete' || saved.parserVersion !== INPUT_VERSION || !saved.ratingResult || saved.documentHash !== saved.ratingResult.document_hash) return null;
  try { validateRatingResultNotice(event, saved.ratingResult, bond); return saved.ratingResult; } catch { return null; }
}

function ratingCoverageForReport(event, notices, documents, bond, reports = []) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
  const title = normalize(event.title), issued = isoDate(bond.value_date), listed = isoDate(bond.list_date) || issued;
  const candidates = [];
  for (const noticeEvent of notices) {
    const result = readValidatedRatingNotice(noticeEvent, documents, bond);
    if (!result) continue;
    if (noticeEvent.source !== event.source) continue;
    const notice = result.rating_result_notice, reference = notice.report_reference;
    let date = null, method = null;
    const samePublication = isoDate(noticeEvent.event_date) === isoDate(event.event_date);
    const datedTracking = new RegExp(`${reference.issued_at.slice(0, 4)}年(?:度)?(?:定期)?(?:信用)?跟踪`).test(title) &&
      isoDate(event.event_date) >= reference.issued_at;
    if (normalize(reference.title) === title && (samePublication || datedTracking)) {
      const urls = new Set(reports.filter(item => item.event.source === event.source && normalize(item.event.title) === title).map(item => item.event.url));
      if (urls.size > 1 || (!samePublication && urls.size !== 1)) continue;
      date = reference.issued_at; method = 'exact_report_reference';
    } else if (issued && listed && isoDate(event.event_date) <= listed && isoDate(event.event_date) <= isoDate(noticeEvent.event_date)) {
      const prefix = normalize(notice.issuer_name);
      const suffix = title.startsWith(prefix) ? title.slice(prefix.length) : '';
      if (/^(?:公开发行(?:A股)?|向不特定对象发行)可转换公司债券(?:信用)?评级报告(?:[（(]修订稿[）)])?$/.test(suffix)) {
        for (const prior of notice.previous_ratings || []) if (prior.rating_date <= issued) {
          candidates.push({ notice_url: noticeEvent.url, document_hash: result.document_hash, rating_date: prior.rating_date,
            rating: prior.rating, method: 'explicit_named_bond_previous_rating', evidence: prior.rating_evidence });
        }
      }
    }
    if (method) candidates.push({ notice_url: noticeEvent.url, document_hash: result.document_hash, rating_date: date,
      report_announced_at: isoDate(event.event_date), notice_announced_at: isoDate(noticeEvent.event_date),
      match_scope: samePublication ? 'same_publication_date' : 'unique_annual_report_reference',
      rating: result.rating, method, evidence: reference });
  }
  if (new Set(candidates.map(row => `${row.rating_date}:${row.rating}`)).size !== 1) return null;
  return candidates.length ? { status: 'covered_by_official_result_notice', ...candidates[0] } : null;
}

// ---------- 文档选择 ----------
function inputDocuments(events, bond = {}, state = null) {
  const selected = [];
  const issueDate = isoDate(bond.value_date);
  // 已解析完成的文件优先锁定：同一发行的旧版/更正版同名文件不得在重跑中被无声换绑。
  const boundUrl = kind => {
    const rows = Object.entries(state?.documents || {})
      .filter(([key, value]) => key.startsWith(`${kind}:`) && value?.status === 'complete')
      .map(([key, value]) => ({ url: key.slice(kind.length + 1), announcedAt: String(value?.announcedAt || '') }))
      .sort((a, b) => b.announcedAt.localeCompare(a.announcedAt) || a.url.localeCompare(b.url));
    return rows.length ? rows[0].url : null;
  };
  const prospectus = latestProspectus(events.filter(e => !issueDate || isoDate(e.event_date) <= issueDate && isoDate(e.event_date) >= `${Number(issueDate.slice(0, 4)) - 1}${issueDate.slice(4)}`), { allowGeneric: true, preferUrl: boundUrl('prospectus') }),
    report = latestFullReport(events.filter(e => !issueDate || reportPeriod(e.title) >= issueDate));
  if (prospectus) selected.push({ kind: 'prospectus', event: prospectus });
  if (issueDate) {
    // 更正公告/提示公告只是"通知"，不含条款正文，不能与真正的发行公告/上市公告书并列择优。
    const issuanceCandidates = events.filter(e => /发行公告|上市公告书/.test(e.title)
      && !/更正公告|提示(?:性)?公告|摘要|申报稿|上会稿|反馈|补充法律意见/.test(e.title)
      && isoDate(e.event_date) >= `${Number(issueDate.slice(0, 4)) - 1}${issueDate.slice(4)}`);
    const boundIssuance = boundUrl('issuance_terms');
    const issuance = (boundIssuance && issuanceCandidates.find(e => e.url === boundIssuance)) || issuanceCandidates
      .sort((a, b) => {
        const dist = e => Math.abs(new Date(isoDate(e.event_date)) - new Date(issueDate));
        const correction = e => /更正版|修订版|更新版|更正后/.test(e.title) ? 0 : 1;
        return dist(a) - dist(b) || correction(a) - correction(b) || String(a.url).localeCompare(String(b.url));
      })[0];
    if (issuance) selected.push({ kind: 'issuance_terms', event: issuance });
  }
  if (report) selected.push({ kind: 'holders', event: report }, { kind: 'price_history', event: report });
  for (const event of events.filter(e => !isRatingPublicationDelay(e) && isBondRatingDocument(e) && (/评级报告|评级调整/.test(e.title) ||
    isRatingResultNotice(e) && bond.bond_short_name) && (!issueDate ||
    isoDate(e.event_date) >= issueDate || isoDate(e.event_date) >= `${Number(issueDate.slice(0, 4)) - 1}${issueDate.slice(4)}` && /可转债|可转换公司债券/.test(e.title)))) selected.push({ kind: 'rating', event });
  return [...selected.filter(d => d.kind === 'rating' && isRatingResultNotice(d.event)).sort((a, b) => String(a.event.event_date).localeCompare(String(b.event.event_date))),
    ...selected.filter(d => d.kind !== 'rating' || !isRatingResultNotice(d.event))];
}

function missingReportRepairStart(bond, state, targetDate, selected) {
  const period = requiredReportPeriod(targetDate);
  if (!isoDate(bond.value_date) || isoDate(bond.value_date) > period || selected.some(d => d.kind === 'holders' && reportPeriod(d.event.title) >= period)) return null;
  const prior = state.reportRepair;
  const covered = prior?.version === DOCUMENT_SELECTION_VERSION && prior.reportPeriod === period ? isoDate(prior.checkedThrough) : null;
  if (covered && covered >= targetDate) return null;
  const start = new Date(`${covered || period}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() + 1);
  return isoDate(start);
}

// ---------- 评级要求 ----------
function ratingRequirement(bond, records, documents, targetDate, suspectUrls = new Set()) {
  const available = records.filter(row => row.rating && isoDate(row.rating_date) && isoDate(row.rating_date) <= targetDate &&
    (!row.announced_at || isoDate(row.announced_at) <= targetDate));
  available.sort((a, b) => String(isoDate(b.rating_date)).localeCompare(String(isoDate(a.rating_date))) ||
    String(isoDate(b.announced_at) || '').localeCompare(String(isoDate(a.announced_at) || '')));
  const latest = available[0], raw = latest?.raw_payload || {}, date = isoDate(latest?.rating_date), announced = isoDate(latest?.announced_at);
  // 只有“评级结果公告”才可能携带比既有事实更新的评级；后面发布的评级报告只是复盘同一结论，
  // 不能因为它日期更晚就把接口/既有的最新评级判成不完整。
  const newestDocumentDate = documents.filter(item => isRatingResultNotice(item.event || {})).map(item => isoDate(item.event.event_date)).filter(Boolean).sort().at(-1);
  const requiredDocumentDate = newestDocumentDate || documents.map(item => isoDate(item.event.event_date)).filter(Boolean).sort().at(-1);
  const documentIdentity = /^[a-f0-9]{64}$/i.test(raw.document_hash || '') &&
    (raw.rating_result_notice ? raw.rating_result_notice.bond_code === bond.ts_code &&
      raw.rating_result_notice.bond_name === bond.bond_short_name && raw.rating_result_notice.rating_company === latest.rating_company :
      raw.identity_binding ? raw.identity_binding.validated === true && String(raw.identity_binding.instrument_id) === String(bond.instrument_id) :
        raw.bond_name === bond.bond_short_name && raw.security_code === bond.stock_code);
  const identity = raw.document_hash ? documentIdentity : raw.ts_code === bond.ts_code;
  const actualDate = ['official_document', 'existing_standard_fact'].includes(raw.rating_date_source) ||
    !raw.rating_date_source && raw.ts_code === bond.ts_code;
  const sameLatest = available.filter(row => isoDate(row.rating_date) === date && isoDate(row.announced_at) === announced);
  const conflict = new Set(sameLatest.map(row => row.rating)).size > 1 || raw.rating_conflicts?.length > 0;
  // 接口来源（cb_rating）多数不提供展望：展望留空但已标注 api_unavailable 时，不得当作缺项否决，
  // 也不得默认成“稳定”；原文来源仍必须给出展望。
  const outlookApiMissing = raw.outlook_status === 'api_unavailable';
  const complete = Boolean(latest && identity && actualDate && !conflict && !suspectUrls.has(raw.source_url) && latest.rating_company && (latest.rating_outlook || outlookApiMissing) &&
    raw.rating === latest.rating && raw.rating_com_name === latest.rating_company && (outlookApiMissing || raw.rating_outlook === latest.rating_outlook) &&
    isoDate(raw.rating_date) === date && announced && date <= announced &&
    !/主体|发行人/.test(String(raw.rating_type || '')) && (!newestDocumentDate || announced >= newestDocumentDate));
  return { version: RATING_REQUIREMENT_VERSION, target_date: targetDate, history_available: available.length > 0, history_count: available.length,
    latest_complete: complete, latest_rating_date: date || null, latest_announced_at: announced || null,
    latest_rating: latest?.rating || null, latest_agency: latest?.rating_company || null,
    latest_outlook: complete ? latest.rating_outlook : null, outlook_status: outlookApiMissing ? 'api_unavailable' : 'original',
    required_document_urls: complete ? [] : documents.filter(item => isoDate(item.event.event_date) === requiredDocumentDate).map(item => item.event.url) };
}

module.exports = {
  CN_OFFSET_MS,
  isoDate,
  requiredReportPeriod,
  reportPeriod,
  isFullReport,
  latestFullReport,
  latestProspectus,
  INPUT_VERSION,
  DOCUMENT_SELECTION_VERSION,
  RATING_REQUIREMENT_VERSION,
  RATING_RETRY_CAPABILITY,
  TERMINAL_GAP_STATUSES,
  sha,
  shouldRetryRatingFailure,
  needRatingResultNotices,
  validateRatingGrade,
  validateTrackingRatingYear,
  issuerNameOf,
  isRatingPublicationDelay,
  isRatingResultNotice,
  isBondRatingDocument,
  terminalGap,
  validateHolderExemption,
  validateRatingResultNotice,
  readValidatedRatingNotice,
  ratingCoverageForReport,
  inputDocuments,
  missingReportRepairStart,
  ratingRequirement
};
