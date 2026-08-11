const PARSER_VERSION = '2.0.3';

function cleanSecurityText(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSecurityCode(value, market) {
  const clean = cleanSecurityText(value);
  const re = market === 'HK' ? /(?:^|\D)(\d{3,5})(?=\D|$)/ : /(?:^|\D)(\d{6})(?=\D|$)/;
  const match = re.exec(clean);
  if (!match) return '';
  return market === 'HK' ? match[1].padStart(5, '0') : match[1];
}

function firstSecurityName(value) {
  const first = String(value || '').split(/<br\s*\/?\s*>|\|/i)[0];
  return cleanSecurityText(first);
}

function classifyDocumentRole(title) {
  const text = cleanSecurityText(title);
  if (/(完成过户|完成過戶|实施结果|實施結果|申报结果|申報結果|终止|終止|失效|撤回)/.test(text)) return 'terminal';
  if (/(董事会报告|董事會報告|财务顾问|財務顧問|法律意见|法律意見|估值报告|估值報告|核查意见|核查意見)/.test(text)) return 'advice';
  if (/(修订|修訂|补充|補充|更新)/.test(text)) return 'amendment';
  if (/(要约收购报告书|要約收購報告書|交易报告书|交易報告書|换股吸收合并.*报告书|換股吸收合併.*報告書|联合公告|聯合公告|计划安排|計劃安排)/.test(text)
    && !/(摘要|差异情况|差異情況|估值报告|估值報告|核查意见|核查意見|法律意见|法律意見)/.test(text)) return 'terms';
  if (/摘要/.test(text)) return 'summary';
  if (/(预案|預案|提示性公告|进展公告|進展公告)/.test(text)) return 'proposal';
  return 'other';
}

function documentRolePriority(role) {
  return ({ amendment: 110, terms: 100, summary: 80, proposal: 60, advice: 30, other: 20, terminal: 0 })[role] || 0;
}

function eventDateAnchor(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const raw = String(value);
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(raw);
  if (iso) return iso[0];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function buildEventKey({ market, strategyType, canonicalCode, announcedAt, sourceKey }) {
  const code = cleanSecurityText(canonicalCode).toUpperCase();
  const anchor = eventDateAnchor(announcedAt || sourceKey);
  if (!market || !strategyType || !code || !anchor) return null;
  return [market, strategyType, code, anchor].join(':');
}

const OFFEROR_NOISE = /(目录|目錄|核查|资格|能力|诚信|評估|评估|估值|交易标的|合并方|被合并方|以下简称|以下簡稱|提供|出具|名称|股份回购报告|\.{4,}|\/)/;

function sanitizeOfferor(value) {
  const text = cleanSecurityText(value).replace(/^[”’'）)\s]+|[（(“‘'\s]+$/g, '').trim();
  if (!text || text.length < 4 || text.length > 80 || OFFEROR_NOISE.test(text)) return null;
  if (!/(有限公司|有限合伙|集团|控股|投资|基金|公司|先生|女士|Limited|Holdings|Group|Capital|Investment)$/i.test(text)) return null;
  return text;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

function validateParsedTerms(strategyType, parsed) {
  const p = { ...(parsed || {}) };
  const errors = [];
  if (p.target_code_match === false) errors.push('target_code:mismatch');
  for (const key of ['cash_offer_price', 'cash_choice_price', 'target_swap_price', 'reference_swap_price', 'swap_ratio', 'subscription_price']) {
    if (p[key] != null) {
      const value = positiveNumber(p[key]);
      if (value == null) {
        errors.push(`${key}:invalid`);
        p[key] = null;
      } else if (key !== 'swap_ratio' && Number.isInteger(value) && value >= 1900 && value <= 2100) {
        errors.push(`${key}:looks_like_year`);
        p[key] = null;
      } else {
        p[key] = value;
      }
    }
  }
  if (p.offeror) p.offeror = sanitizeOfferor(p.offeror);

  if (p.target_swap_price && p.reference_swap_price && p.swap_ratio) {
    const implied = p.target_swap_price / p.reference_swap_price;
    if (Math.abs(implied / p.swap_ratio - 1) > 0.02) errors.push('swap_ratio:mismatch');
  }

  let coreComplete = false;
  if (strategyType === 'a_cash_offer' || strategyType === 'hk_privatisation') {
    coreComplete = Boolean(p.cash_choice_price || p.cash_offer_price);
  } else if (strategyType === 'a_share_swap') {
    coreComplete = Boolean(p.cash_choice_price || (p.swap_ratio && (p.reference_codes?.length || p.reference_names?.length)));
  } else if (strategyType === 'hk_rights') {
    coreComplete = Boolean(p.subscription_price && p.rights_units_per_new_share && p.rights_codes?.length);
  }
  if (p.target_code_match === false) coreComplete = false;

  const evidenceFields = new Set((p.evidence || []).map((item) => item && item.field).filter(Boolean));
  const confidence = coreComplete && errors.length === 0
    ? Math.min(1, 0.7 + Math.min(0.3, evidenceFields.size * 0.05))
    : Math.max(0, Math.min(0.69, Number(p.confidence || 0)));
  return {
    parsed: p,
    errors,
    coreComplete,
    confidence: Math.round(confidence * 100) / 100,
    parseStatus: coreComplete && errors.length === 0 ? 'validated' : (errors.length ? 'conflict' : 'incomplete'),
  };
}

module.exports = {
  PARSER_VERSION,
  cleanSecurityText,
  firstSecurityCode,
  firstSecurityName,
  classifyDocumentRole,
  documentRolePriority,
  buildEventKey,
  sanitizeOfferor,
  validateParsedTerms,
};
