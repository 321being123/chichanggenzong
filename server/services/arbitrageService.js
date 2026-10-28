// ========== 套利机会服务 ==========
// 查询、事件合并、审核、统一计算（3 类公式）
const { pool } = require('../db');
const { fetchTencentQuotes } = require('./tencentQuote');
const parser = require('./arbitrageParser');
const repository = require('../repositories/arbitrageServiceRepository.js');
const {
  cleanSecurityText,
  classifyRiskAnnouncement,
  classifyProgressAnnouncement,
  BUYER_OFFER_TITLE_PATTERN,
} = require('./arbitrageRules');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { enqueueManualJob } = require('./jobScheduleSlots');
const { getCandidates, getCaseDetail } = require('../repositories/arbitrageServiceRepository.js');

const FORMULA_VERSION = 'v2.0';

function deduplicateArbitrageDocuments(documents) {
  const seen = new Set();
  return documents.filter((doc) => {
    const url = String(doc.url || '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
    const title = cleanSecurityText(doc.title).normalize('NFKC').toLowerCase().replace(/[\s\u3000]/g, '');
    const date = doc.announced_at ? String(doc.announced_at).slice(0, 10) : '';
    const key = url ? `url:${url}` : `title:${date}:${title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 公开页只展示具备核心计算条款的案件；兜底条件由数据层构造，后台审核页仍保留全部案件。
const { buildCaseFilter } = repository;
const PUBLIC_CASE_FILTER = buildCaseFilter(BUYER_OFFER_TITLE_PATTERN);

// ========== 查询 ==========

// 公开列表（仅 approved 且未结束）
async function getArbitrageList(type, page = 1, pageSize = 50, username = null) {
  const offset = (page - 1) * pageSize;
  const typeMap = {
    a_stock: ['a_cash_offer', 'a_share_swap'],
    hk_privatisation: ['hk_privatisation'],
    hk_rights: ['hk_rights'],
  };
  const types = typeMap[type] || typeMap.a_stock;

  const { rows } = await repository.listArbitrageCases({ types, pageSize, offset, username, buyerOfferPattern: BUYER_OFFER_TITLE_PATTERN });

  const { rows: countRows } = await repository.countArbitrageCases({ types, buyerOfferPattern: BUYER_OFFER_TITLE_PATTERN });

  // 收集所有需取行情的代码（正股 / 换股参考股 / 供股权）
  const codeSet = new Set();
  rows.forEach(r => {
    [r.canonical_code, r.ref_code, r.rights_code].forEach(c => { if (c) codeSet.add(c); });
  });
  const quoteMap = codeSet.size ? await fetchTencentQuotes([...codeSet]) : new Map();

  // 计算套利空间
  const enrichedRows = rows.map(r => {
    const tQuote = r.canonical_code ? quoteMap.get(r.canonical_code) : null;
    const refQuote = r.ref_code ? quoteMap.get(r.ref_code) : null;
    const rightsQuote = r.rights_code ? quoteMap.get(r.rights_code) : null;
    const currentPrice = tQuote ? Number(tQuote.price) : null;
    const refPrice = refQuote ? Number(refQuote.price) : null;
    const rightsPrice = rightsQuote ? Number(rightsQuote.price) : null;
    const changePct = tQuote ? Number(tQuote.change) : null;
    const quoteTime = tQuote ? tQuote.quote_time : null;

    const swapEligible = isSwapEligible(r);
    const calc = swapEligible || r.strategy_type !== 'a_share_swap'
      ? calcArbitrage(r, currentPrice, refPrice, rightsPrice)
      : calcCashArbitrage(r.cash_choice_price || r.offer_price, currentPrice);
    const cashCalc = r.strategy_type === 'a_share_swap'
      ? calcCashArbitrage(r.cash_choice_price, currentPrice)
      : calc;

    return {
      ...r,
      name: cleanSecurityText(r.name),
      ref_name: cleanSecurityText(r.ref_name),
      rights_name: cleanSecurityText(r.rights_name),
      currentPrice,
      changePct,
      quoteTime,
      refPrice,
      rightsPrice,
      rights_code: r.rights_code,
      ref_code: r.ref_code,
      stale: !tQuote,
      swapEligible,
      ...calc,
      cashArbitrageSpace: cashCalc.arbitrageSpace,
      cashExpectedReturn: cashCalc.arbitrageSpace,
      cashChoicePremium: calcPricePremium(r.cash_choice_price || r.offer_price, currentPrice),
      fixedSwapPremium: calcPricePremium(r.target_swap_price, currentPrice),
      swapArbitrageSpace: swapEligible ? calc.arbitrageSpace : null,
      liveSwapReturn: swapEligible ? calc.arbitrageSpace : null,
    };
  });

  const quoteTimes = enrichedRows.map(r => r.quoteTime).filter(Boolean).sort();
  const quoteAsOf = quoteTimes.length ? quoteTimes[quoteTimes.length - 1] : null;
  const termsTimes = enrichedRows.map(r => r.terms_updated_at).filter(Boolean).map(String).sort();

  return {
    rows: enrichedRows,
    total: parseInt(countRows[0].total),
    page,
    pageSize,
    dataAsOf: termsTimes.length ? termsTimes[termsTimes.length - 1] : null,
    quoteAsOf,
    stale: enrichedRows.some(r => r.stale),
    formulaVersion: FORMULA_VERSION,
    canMarkSeen: Boolean(username),
    unreadCount: await getArbitrageUnreadCount(username),
  };
}

// 详情
async function getArbitrageDetail(caseId, username = null) {
  const { rows } = await repository.selectArbitrageDetail({ caseId, username, buyerOfferPattern: BUYER_OFFER_TITLE_PATTERN });

  if (!rows.length) return null;
  const c = rows[0];

  // 批量查行情
  const codes = [c.canonical_code, c.ref_code, c.rights_code].filter(Boolean);
  const quoteMap = codes.length ? await fetchTencentQuotes(codes) : new Map();

  const targetQuote = c.canonical_code ? quoteMap.get(c.canonical_code) : null;
  const refQuote = c.ref_code ? quoteMap.get(c.ref_code) : null;
  const rightsQuote = c.rights_code ? quoteMap.get(c.rights_code) : null;

  const currentPrice = targetQuote ? Number(targetQuote.price) : null;
  const swapEligible = isSwapEligible(c);
  const calc = swapEligible || c.strategy_type !== 'a_share_swap'
    ? calcArbitrage(c, currentPrice, refQuote ? Number(refQuote.price) : null, rightsQuote ? Number(rightsQuote.price) : null)
    : calcCashArbitrage(c.cash_choice_price || c.offer_price, currentPrice);

  // 获取公告链
  const riskCodes = [c.canonical_code, c.ref_code].filter(Boolean);
  const { rows: docs } = await repository.with_event_arbitrage_case_documents([caseId, riskCodes]);

  // 历史上已经被误归为 risk_event 的“问询函回复”不应继续出现在风险区。
  const normalizedDocs = deduplicateArbitrageDocuments(docs.map((doc) => {
    const progress = classifyProgressAnnouncement(doc.title);
    if (progress && doc.relation_type === 'risk_event') {
      return { ...doc, relation_type: 'progress_event', document_role: 'progress' };
    }
    return doc;
  }));
  const latestProgress = normalizedDocs.map((doc) => ({ doc, progress: classifyProgressAnnouncement(doc.title) }))
    .filter(item => item.progress)
    .sort((a, b) => String(b.doc.announced_at || '').localeCompare(String(a.doc.announced_at || '')))[0];
  const successEstimate = c.strategy_type === 'a_share_swap'
    ? estimateSwapSuccess(c, normalizedDocs)
    : null;

  return {
    ...c,
    name: cleanSecurityText(c.name),
    ref_name: cleanSecurityText(c.ref_name),
    rights_name: cleanSecurityText(c.rights_name),
    currentPrice,
    changePct: targetQuote ? Number(targetQuote.change) : null,
    refPrice: refQuote ? Number(refQuote.price) : null,
    rightsPrice: rightsQuote ? Number(rightsQuote.price) : null,
    quoteTime: targetQuote ? targetQuote.quote_time : null,
    swapEligible,
    documents: normalizedDocs,
    display_status: latestProgress ? latestProgress.progress.label : null,
    ...(successEstimate || {}),
    ...calc,
    cashExpectedReturn: calcCashArbitrage(c.cash_choice_price || c.offer_price, currentPrice).arbitrageSpace,
    cashChoicePremium: calcPricePremium(c.cash_choice_price || c.offer_price, currentPrice),
    fixedSwapPremium: calcPricePremium(c.target_swap_price, currentPrice),
    liveSwapReturn: swapEligible ? calc.arbitrageSpace : null,
    formulaVersion: FORMULA_VERSION,
    dataAsOf: c.terms_updated_at || null,
    quoteAsOf: targetQuote ? targetQuote.quote_time : null,
  };
}

// 换股合并成功概率：这是“公开进展 + 风险公告”的规则估计，不是历史样本训练出的统计概率。
// 目的在于把影响判断的因素明白列出来，避免只看套利空间而忽略事件风险。
function estimateSwapSuccess(caseRow, documents) {
  const docs = Array.isArray(documents) ? documents : [];
  const titles = docs.map(d => cleanSecurityText(d.title)).filter(Boolean);
  let score = 50;
  const factors = [];
  const riskEvents = [];

  if (caseRow.review_status === 'approved') {
    score += 8;
    factors.push({ type: 'positive', label: '事件已审核通过', points: 8 });
  }
  if (caseRow.event_status === 'in_progress') {
    score += 8;
    factors.push({ type: 'positive', label: '当前仍处于进行中', points: 8 });
  }
  if (caseRow.parse_status === 'validated') {
    score += 8;
    factors.push({ type: 'positive', label: '换股核心条款已验证', points: 8 });
  } else if (caseRow.parse_status === 'conflict') {
    score -= 8;
    factors.push({ type: 'negative', label: '公告条款存在解析冲突', points: -8 });
  }
  if (Number(caseRow.terms_confidence) >= 0.85) {
    score += 4;
    factors.push({ type: 'positive', label: '条款证据置信度较高', points: 4 });
  }
  if (titles.some(t => /恢复审核|恢复审查|同意恢复审核|审核通过/.test(t))) {
    score += 8;
    factors.push({ type: 'positive', label: '已出现恢复审核或审核通过进展', points: 8 });
  }
  if (titles.some(t => /股东大会|股东会/.test(t) && /通过|审议通过|决议/.test(t))) {
    score += 8;
    factors.push({ type: 'positive', label: '已出现股东会审议通过进展', points: 8 });
  }
  if (titles.some(t => /中止审核|中止审查|暂停审核/.test(t))) {
    score -= 15;
    factors.push({ type: 'negative', label: '曾出现审核中止或暂停', points: -15 });
  }

  const progressTypes = new Set();
  for (const doc of docs) {
    const progress = classifyProgressAnnouncement(doc.title);
    if (!progress || progressTypes.has(progress.progressType)) continue;
    progressTypes.add(progress.progressType);
    score += progress.points;
    factors.push({ type: 'positive', label: progress.label, points: progress.points });
  }

  const responseDocs = docs.filter((doc) =>
    classifyProgressAnnouncement(doc.title)?.progressType === 'regulatory_query_response'
  );

  for (const doc of docs) {
    const risk = classifyRiskAnnouncement(doc.title);
    if (!risk) continue;
    // 同一轮问询已有同日或更晚回复时，原“收到问询”只保留为历史节点，
    // 不再作为当前未解决风险扣分。
    if (risk.riskType === 'regulatory_query' && responseDocs.some((response) =>
      !response.announced_at || !doc.announced_at
        || new Date(response.announced_at).getTime() >= new Date(doc.announced_at).getTime()
    )) continue;
    riskEvents.push({
      document_id: doc.document_id,
      title: doc.title,
      announced_at: doc.announced_at,
      url: doc.url,
      riskType: risk.riskType,
      severity: risk.severity,
      label: risk.label,
    });
    score -= risk.penalty;
    factors.push({ type: 'negative', label: `${risk.label}：${cleanSecurityText(doc.title)}`, points: -risk.penalty });
  }

  score = Math.max(5, Math.min(95, Math.round(score)));
  return {
    successProbability: score,
    successProbabilityLabel: score >= 70 ? '较高' : (score >= 45 ? '中等' : '偏低'),
    successProbabilityFactors: factors,
    riskEvents,
    successProbabilityNote: '规则估计值，仅用于比较风险；立案调查尚无最终结论时，不代表交易必然终止。',
    successProbabilityAsOf: new Date().toISOString(),
  };
}

// ========== 管理后台 ==========

// 待审核候选列表
/* getCandidates 已迁入 server/repositories/arbitrageServiceRepository.js */

// 管理后台详情
/* getCaseDetail 已迁入 server/repositories/arbitrageServiceRepository.js */

// 把管理员输入的证券代码解析为 instrument_id（解析不到则自动建证券）；空值返回 null 以清空关联
async function resolveCodeToId(code) {
  if (code == null || String(code).trim() === '') return null;
  return parser.resolveInstrumentByCode(String(code).trim());
}

// 更新事件（审核/修正）
async function updateCase(caseId, updates, reviewer) {
  // 管理员可直接输入「参考证券 / 供股权」的代码，后端解析为 instrument_id（解析不到则自动建证券）
  const referenceInstrumentId = updates.reference_instrument_code !== undefined
    ? await resolveCodeToId(updates.reference_instrument_code) : undefined;
  const rightsInstrumentId = updates.rights_instrument_code !== undefined
    ? await resolveCodeToId(updates.rights_instrument_code) : undefined;
  const { rows } = await repository.updateArbitrageCase({
    caseId, updates, reviewer, referenceInstrumentId, rightsInstrumentId,
  });
  return rows.length ? rows[0] : null;
}

// 重新解析：调用 Python 解析器提取正文条款并回写事件
async function reparseCase(caseId) {
  const { rows } = await repository.select_event_arbitrage_cases([caseId]);
  if (!rows.length) return null;
  const row = rows[0];
  const { rows: docRows } = await repository.select_event_arbitrage_case_documents([caseId]);
  if (!docRows.length) {
    return { caseId, status: 'skipped', message: '该事件没有可解析的 PDF 公告链接', extracted: null };
  }
  let parsedCount = 0;
  let failedCount = 0;
  let eligibleCount = 0;
  let retrySignal = null;
  for (const doc of docRows) {
    const role = parserRole(doc.title, doc.document_role);
    if (role === 'terminal' || role === 'risk') continue;
    eligibleCount++;
    try {
      // 首次版本升级会强制解析旧版本文档；同一案件因来源限速进入重试时，已成功文档走缓存，只补未完成文档。
      const forceDocument = doc.parser_version !== parser.PARSER_VERSION || doc.parse_status !== 'validated';
      const payload = await parser.parseAndStoreDocument(caseId, doc.document_id, doc.url, row.canonical_code, role, forceDocument, true);
      if (payload) parsedCount++;
      else failedCount++;
    } catch (err) {
      failedCount++;
      if (!retrySignal && ['BUDGET_WAIT', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN'].includes(String(err.code || '').toUpperCase())) {
        retrySignal = {
          errorCode: String(err.code).toUpperCase(),
          errorType: err.errorType,
          source: err.source,
          apiName: err.apiName,
          recoverAt: err.recoverAt,
        };
      }
      console.error(`[arbitrage] case ${caseId} document ${doc.document_id} parse failed:`, sanitizeJobError(err.message || err, 500));
    }
  }
  if (!eligibleCount) return { caseId, status: 'skipped', message: '该事件没有需要重新解析的条款类 PDF 公告', extracted: null };
  if (!parsedCount) {
    return { caseId, status: 'failed', message: `${failedCount}份公告均解析失败`, extracted: null, ...(retrySignal || {}) };
  }
  const rebuilt = await parser.rebuildCaseTerms(caseId);
  if (failedCount) {
    return {
      caseId,
      ...rebuilt,
      status: 'failed',
      message: `已解析${parsedCount}份公告，但仍有${failedCount}份失败，任务将进入统一重试`,
      ...(retrySignal || {}),
    };
  }
  return {
    caseId,
    status: rebuilt.status,
    message: `已解析${parsedCount}份公告并按证据优先级重建条款`,
    ...rebuilt,
  };
}

async function queueReparseCase(caseId) {
  if (!Number.isSafeInteger(caseId) || caseId <= 0) return null;
  const { rows } = await repository.select_event_arbitrage_cases_1([caseId]);
  if (!rows.length) return null;
  const slot = await enqueueManualJob('arbitrage_reparse', { caseId });
  if (!slot) return { ok: false, error: '公告重新解析任务未注册' };
  return {
    ok: true,
    queued: true,
    slotId: slot.slot_id,
    status: slot.status || 'pending',
    caseId,
    message: '公告重新解析已进入后台任务队列',
  };
}

function parserRole(title, existingRole) {
  if (existingRole && existingRole !== 'other') return existingRole;
  return require('./arbitrageRules').classifyDocumentRole(title);
}

// 触发同步（后台执行）
async function triggerSync() {
  const slot = await enqueueManualJob('arbitrage_sync');
  if (!slot) return { ok: false, error: '套利同步任务未注册' };
  return { ok: true, queued: true, slotId: slot.slot_id, status: 'pending', message: '增量同步已进入后台任务队列' };
}

// ========== 统一计算 ==========

// 现金选择权/现金要约/私有化
function calcCashArbitrage(offerPrice, currentPrice) {
  if (!offerPrice || !currentPrice || offerPrice <= 0 || currentPrice <= 0) {
    return { arbitrageValue: null, arbitrageSpace: null };
  }
  const value = offerPrice - currentPrice;
  const space = (offerPrice / currentPrice - 1) * 100;
  return { arbitrageValue: round(value), arbitrageSpace: round(space) };
}

// 现价相对固定条款价格的溢折价；与“潜在收益率”分开，避免正负号和分母混用。
function calcPricePremium(termPrice, currentPrice) {
  if (!termPrice || !currentPrice || termPrice <= 0 || currentPrice <= 0) return null;
  return round((currentPrice / termPrice - 1) * 100);
}

// 换股吸收合并
function calcSwapArbitgage(refPrice, swapRatio, cashComponent, targetPrice) {
  if (!refPrice || !swapRatio || !targetPrice || refPrice <= 0 || swapRatio <= 0 || targetPrice <= 0) {
    return { arbitrageValue: null, arbitrageSpace: null, theoreticalPrice: null };
  }
  const cc = cashComponent || 0;
  const theoreticalPrice = refPrice * swapRatio + cc;
  const value = theoreticalPrice - targetPrice;
  const space = (theoreticalPrice / targetPrice - 1) * 100;
  return {
    theoreticalPrice: round(theoreticalPrice),
    arbitrageValue: round(value),
    arbitrageSpace: round(space),
  };
}

function isSwapEligible(caseRow) {
  return Boolean(caseRow && caseRow.strategy_type === 'a_share_swap'
    && Number(caseRow.swap_ratio) > 0
    && caseRow.reference_instrument_id != null
    && caseRow.target_instrument_id != null
    && String(caseRow.reference_instrument_id) !== String(caseRow.target_instrument_id));
}

// 港股供股权：每股新股总成本 = 供股价(subscriptionPrice) + 供股权现价(rightsPrice) × rights_units_per_new_share
function calcRightsArbitrage(targetPrice, subscriptionPrice, rightsPrice, unitsPerNewShare) {
  if (!targetPrice || !subscriptionPrice || !rightsPrice || !unitsPerNewShare ||
      targetPrice <= 0 || subscriptionPrice <= 0 || rightsPrice <= 0 || unitsPerNewShare <= 0) {
    return { arbitrageValue: null, arbitrageSpace: null, totalCost: null };
  }
  const totalCost = subscriptionPrice + rightsPrice * unitsPerNewShare;
  const value = targetPrice - totalCost;
  const space = totalCost > 0 ? (value / totalCost) * 100 : null;
  return { totalCost: round(totalCost), arbitrageValue: round(value), arbitrageSpace: round(space) };
}

// 统一计算入口
function calcArbitrage(caseRow, targetPrice, refPrice, rightsPrice) {
  const st = caseRow.strategy_type;

  if (st === 'a_cash_offer' || st === 'hk_privatisation') {
    const offerPrice = caseRow.offer_price || caseRow.cash_choice_price;
    return calcCashArbitrage(offerPrice, targetPrice);
  }

  if (st === 'a_share_swap') {
    return calcSwapArbitgage(refPrice, caseRow.swap_ratio, caseRow.cash_component, targetPrice);
  }

  if (st === 'hk_rights') {
    if (!targetPrice || !rightsPrice || !caseRow.subscription_price || !caseRow.rights_units_per_new_share) {
      return { arbitrageValue: null, arbitrageSpace: null, totalCost: null };
    }
    // 每股新股总成本 = 供股价 + 供股权现价 × rights_units_per_new_share
    const totalCost = caseRow.subscription_price + rightsPrice * caseRow.rights_units_per_new_share;
    const value = targetPrice - totalCost;
    const space = totalCost > 0 ? (value / totalCost) * 100 : null;
    return {
      totalCost: round(totalCost),
      arbitrageValue: round(value),
      arbitrageSpace: round(space),
    };
  }

  return { arbitrageValue: null, arbitrageSpace: null };
}

function round(n) {
  if (n == null || !isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

async function getArbitrageUnreadCount(username) {
  if (!username) return 0;
  const { rows } = await repository.countUnreadArbitrages({ username, buyerOfferPattern: BUYER_OFFER_TITLE_PATTERN });
  return rows[0].count;
}

async function markArbitrageSeen(username, caseId) {
  const { rowCount } = await repository.markArbitrageSeenCase({ username, caseId, buyerOfferPattern: BUYER_OFFER_TITLE_PATTERN });
  return rowCount > 0;
}

module.exports = {
  PUBLIC_CASE_FILTER,
  getArbitrageUnreadCount,
  markArbitrageSeen,
  getArbitrageList,
  getArbitrageDetail,
  getCandidates,
  getCaseDetail,
  updateCase,
  reparseCase,
  queueReparseCase,
  triggerSync,
  calcCashArbitrage,
  calcPricePremium,
  calcSwapArbitgage,
  calcRightsArbitrage,
  calcArbitrage,
  isSwapEligible,
  estimateSwapSuccess,
  FORMULA_VERSION,
};
