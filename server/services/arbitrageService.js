// ========== 套利机会服务 ==========
// 查询、事件合并、审核、统一计算（3 类公式）
const { pool } = require('../db');
const { fetchTencentQuotes } = require('./tencentQuote');
const parser = require('./arbitrageParser');
const { cleanSecurityText, classifyRiskAnnouncement } = require('./arbitrageRules');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { enqueueManualJob } = require('./jobScheduleSlots');

const FORMULA_VERSION = 'v2.0';

// 公开页只展示具备核心计算条款的案件；同时兜底排除历史上被误建为“进行中”的终态公告。
// 后台审核页仍保留全部案件，便于检查和修正原始数据。
const PUBLIC_CASE_FILTER = `
  c.review_status = 'approved'
  AND (c.parser_version IS NULL OR c.parse_status = 'validated')
  AND c.event_status NOT IN ('completed','terminated','expired')
  AND (c.expected_completion_date IS NULL OR c.expected_completion_date >= CURRENT_DATE)
  AND (
    (c.strategy_type IN ('a_cash_offer','hk_privatisation') AND COALESCE(c.offer_price,c.cash_choice_price) > 0)
    OR (c.strategy_type = 'a_share_swap' AND (
        COALESCE(c.cash_choice_price,c.offer_price) > 0
        OR (c.swap_ratio > 0
          AND c.reference_instrument_id IS NOT NULL
          AND c.reference_instrument_id <> c.target_instrument_id
          AND EXISTS (
            SELECT 1 FROM core.instruments ref_valid
            WHERE ref_valid.instrument_id = c.reference_instrument_id
              AND COALESCE(ref_valid.name, '') <> ''
          ))))
    OR (c.strategy_type = 'hk_rights' AND c.subscription_price > 0
        AND c.rights_units_per_new_share > 0 AND c.rights_instrument_id IS NOT NULL)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM event.arbitrage_case_documents acd_terminal
    JOIN event.documents d_terminal ON d_terminal.document_id = acd_terminal.document_id
    WHERE acd_terminal.case_id = c.case_id
      AND COALESCE(d_terminal.title, '') ~* '(终止|終止|完成过户|完成過戶|过户完成|過戶完成|交割完成|交割完毕|交割完畢|实施结果|實施結果|申报结果|申報結果|供股.{0,12}结果|供股.{0,12}結果|私有化.{0,12}完成|privati[sz]ation.{0,20}completed|lapsed|terminated|withdrawn)'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM event.arbitrage_cases terminal_case
    JOIN event.arbitrage_case_documents terminal_link ON terminal_link.case_id=terminal_case.case_id
    JOIN event.documents terminal_doc ON terminal_doc.document_id=terminal_link.document_id
    WHERE terminal_case.target_instrument_id=c.target_instrument_id
      AND terminal_case.strategy_type=c.strategy_type
      AND terminal_case.case_id<>c.case_id
      AND terminal_case.event_status IN ('completed','terminated','expired')
      AND terminal_doc.announced_at>=c.announced_at
  )`;

// ========== 查询 ==========

// 公开列表（仅 approved 且未结束）
async function getArbitrageList(type, page = 1, pageSize = 50) {
  const offset = (page - 1) * pageSize;
  const typeMap = {
    a_stock: ['a_cash_offer', 'a_share_swap'],
    hk_privatisation: ['hk_privatisation'],
    hk_rights: ['hk_rights'],
  };
  const types = typeMap[type] || typeMap.a_stock;

  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, regexp_replace(i.name,'<[^>]+>','','g') AS name, i.currency_code as inst_currency,
           ri.canonical_code as ref_code, regexp_replace(ri.name,'<[^>]+>','','g') AS ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name,
           pd.url AS announcement_url
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    LEFT JOIN event.documents pd ON c.primary_document_id = pd.document_id
    WHERE c.strategy_type = ANY($1)
      AND ${PUBLIC_CASE_FILTER}
    ORDER BY c.terms_updated_at DESC NULLS LAST
    LIMIT $2 OFFSET $3
  `, [types, pageSize, offset]);

  const { rows: countRows } = await pool.query(`
    SELECT count(*) as total FROM event.arbitrage_cases c
    WHERE c.strategy_type = ANY($1)
      AND ${PUBLIC_CASE_FILTER}
  `, [types]);

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
  const quoteAsOf = quoteTimes.length ? quoteTimes[quoteTimes.length - 1] : new Date().toISOString();

  return {
    rows: enrichedRows,
    total: parseInt(countRows[0].total),
    page,
    pageSize,
    dataAsOf: new Date().toISOString(),
    quoteAsOf,
    stale: enrichedRows.some(r => r.stale),
    formulaVersion: FORMULA_VERSION,
  };
}

// 详情
async function getArbitrageDetail(caseId) {
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, regexp_replace(i.name,'<[^>]+>','','g') AS name, i.currency_code as inst_currency,
           ri.canonical_code as ref_code, regexp_replace(ri.name,'<[^>]+>','','g') AS ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name,
           pd.url AS announcement_url
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    LEFT JOIN event.documents pd ON c.primary_document_id = pd.document_id
    WHERE c.case_id = $1 AND c.review_status = 'approved'
  `, [caseId]);

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
  const { rows: docs } = await pool.query(`
    WITH linked AS (
      SELECT d.document_id, d.title, d.announced_at, d.url, acd.relation_type, acd.document_role
      FROM event.arbitrage_case_documents acd
      JOIN event.documents d ON acd.document_id = d.document_id
      WHERE acd.case_id = $1
    ), inferred_risk AS (
      SELECT d.document_id, d.title, d.announced_at, d.url,
             'risk_event'::text AS relation_type, 'risk'::text AS document_role
      FROM event.documents d
      WHERE d.document_type = 'arbitrage_announcement'
        AND d.title ~* '(立案告知书|立案调查|调查通知书|调查告知书|行政处罚决定书|处罚决定|行政监管措施|监管警示|监管措施|问询函|监管工作函|监管函)'
        AND COALESCE(d.raw_payload->>'secCode', d.raw_payload->>'stockCode', d.raw_payload->>'code') = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.document_id = d.document_id)
    )
    SELECT * FROM linked
    UNION ALL
    SELECT * FROM inferred_risk
    ORDER BY announced_at DESC NULLS LAST
  `, [caseId, riskCodes]);

  const successEstimate = c.strategy_type === 'a_share_swap'
    ? estimateSwapSuccess(c, docs)
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
    documents: docs,
    ...(successEstimate || {}),
    ...calc,
    cashExpectedReturn: calcCashArbitrage(c.cash_choice_price || c.offer_price, currentPrice).arbitrageSpace,
    cashChoicePremium: calcPricePremium(c.cash_choice_price || c.offer_price, currentPrice),
    fixedSwapPremium: calcPricePremium(c.target_swap_price, currentPrice),
    liveSwapReturn: swapEligible ? calc.arbitrageSpace : null,
    formulaVersion: FORMULA_VERSION,
    dataAsOf: new Date().toISOString(),
    quoteAsOf: targetQuote ? targetQuote.quote_time : new Date().toISOString(),
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

  for (const doc of docs) {
    const risk = classifyRiskAnnouncement(doc.title);
    if (!risk) continue;
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
async function getCandidates(page = 1, pageSize = 50, status = 'pending') {
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, i.name
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    WHERE c.review_status = $1
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [status, pageSize, offset]);

  const { rows: countRows } = await pool.query(
    'SELECT count(*) as total FROM event.arbitrage_cases WHERE review_status=$1', [status]
  );

  return { rows, total: parseInt(countRows[0].total), page, pageSize };
}

// 管理后台详情
async function getCaseDetail(caseId) {
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, i.name,
           ri.canonical_code as ref_code, ri.name as ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    WHERE c.case_id = $1
  `, [caseId]);

  if (!rows.length) return null;

  const { rows: docs } = await pool.query(`
    SELECT d.document_id, d.title, d.announced_at, d.url, acd.relation_type
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id = d.document_id
    WHERE acd.case_id = $1
    ORDER BY d.announced_at DESC NULLS LAST
  `, [caseId]);

  return { ...rows[0], documents: docs };
}

// 把管理员输入的证券代码解析为 instrument_id（解析不到则自动建证券）；空值返回 null 以清空关联
async function resolveCodeToId(code) {
  if (code == null || String(code).trim() === '') return null;
  return parser.resolveInstrumentByCode(String(code).trim());
}

// 更新事件（审核/修正）
async function updateCase(caseId, updates, reviewer) {
  const allowed = [
    'strategy_type', 'event_status', 'review_status',
    'currency_code', 'offer_price', 'cash_choice_price', 'cash_component', 'swap_ratio',
    'subscription_price', 'rights_units_per_new_share', 'rights_ratio_numerator', 'rights_ratio_denominator',
    'announced_at', 'expected_completion_date',
    'rights_trade_start', 'rights_trade_end', 'payment_deadline', 'listing_date',
    'offeror', 'offeror_holding_pct', 'registrar', 'transaction_method',
    'headcount_required', 'shortable', 'description',
    'target_instrument_id', 'reference_instrument_id', 'rights_instrument_id',
  ];

  const sets = [];
  const params = [];
  let pi = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${pi}`);
    params.push(val);
    pi++;
  }

  // 管理员可直接输入「参考证券 / 供股权」的代码，后端解析为 instrument_id（解析不到则自动建证券）
  if (updates.reference_instrument_code !== undefined) {
    const id = await resolveCodeToId(updates.reference_instrument_code);
    sets.push(`reference_instrument_id = $${pi}`); params.push(id); pi++;
  }
  if (updates.rights_instrument_code !== undefined) {
    const id = await resolveCodeToId(updates.rights_instrument_code);
    sets.push(`rights_instrument_id = $${pi}`); params.push(id); pi++;
  }

  // 审核状态变更时记录审核人
  if (updates.review_status === 'approved' || updates.review_status === 'rejected') {
    sets.push(`reviewed_by = $${pi}`); params.push(reviewer); pi++;
    sets.push(`reviewed_at = now()`);
  }

  sets.push(`updated_at = now()`);

  const { rows } = await pool.query(
    `UPDATE event.arbitrage_cases SET ${sets.join(', ')} WHERE case_id = $${pi} RETURNING *`,
    [...params, caseId]
  );

  return rows.length ? rows[0] : null;
}

// 重新解析：调用 Python 解析器提取正文条款并回写事件
async function reparseCase(caseId) {
  const { rows } = await pool.query(`
    SELECT c.*,i.canonical_code
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
    WHERE c.case_id = $1
  `, [caseId]);
  if (!rows.length) return null;
  const row = rows[0];
  const { rows: docRows } = await pool.query(`
    SELECT d.document_id,d.url,d.title,acd.document_role
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id=d.document_id
    WHERE acd.case_id=$1 AND d.url ~* '\\.pdf$'
    ORDER BY d.announced_at ASC NULLS LAST
  `, [caseId]);
  if (!docRows.length) {
    return { caseId, status: 'skipped', message: '该事件没有可解析的 PDF 公告链接', extracted: null };
  }
  let parsedCount = 0;
  let failedCount = 0;
  let eligibleCount = 0;
  for (const doc of docRows) {
    const role = parserRole(doc.title, doc.document_role);
    if (role === 'terminal' || role === 'risk') continue;
    eligibleCount++;
    try {
      const payload = await parser.parseAndStoreDocument(caseId, doc.document_id, doc.url, row.canonical_code, role, true, true);
      if (payload) parsedCount++;
      else failedCount++;
    } catch (err) {
      failedCount++;
      console.error(`[arbitrage] case ${caseId} document ${doc.document_id} parse failed:`, sanitizeJobError(err.message || err, 500));
    }
  }
  if (!eligibleCount) return { caseId, status: 'skipped', message: '该事件没有需要重新解析的条款类 PDF 公告', extracted: null };
  if (!parsedCount) return { caseId, status: 'failed', message: `${failedCount}份公告均解析失败`, extracted: null };
  const rebuilt = await parser.rebuildCaseTerms(caseId);
  if (failedCount) {
    return {
      caseId,
      ...rebuilt,
      status: 'failed',
      message: `已解析${parsedCount}份公告，但仍有${failedCount}份失败，任务将进入统一重试`,
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
  const { rows } = await pool.query('SELECT case_id FROM event.arbitrage_cases WHERE case_id=$1', [caseId]);
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

module.exports = {
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
