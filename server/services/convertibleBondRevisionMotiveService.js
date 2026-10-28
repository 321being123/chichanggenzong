// 可转债下修动机评分：只读取已入库事实，评分结果按交易日和模型版本留痕。
// 评分是研究工具，不把“动机高”解释成一定会下修，也不把安全性风险抵消掉。
const crypto = require('crypto');
const { pool } = require('../db');
const { tushareQuery, tsRows } = require('./market');
const txControl = require('../repositories/transactionControl');
const { saveRevisionCycles, saveSyncCursor, saveSyncRawPayload } = require('../repositories/convertibleBondRevisionMotiveServiceRepository.js');
const repository = require('../repositories/convertibleBondRevisionMotiveServiceRepository.js');

// 评分规则移除无效的“剩余规模低于发行规模”和跨债种市场热度加分，必须升级模型版本，避免旧快照混入新规则。
const MOTIVE_MODEL_VERSION = 'motive-v1.1';
// 历史公告前样本外回测尚未通过前，禁止把研究分转换为预测等级；完成回测后需升级模型版本并显式打开。
const MOTIVE_MODEL_CALIBRATED = false;
const CYCLE_VERSION = 'cycle-v1';
const BOND_CODE_RE = /^(110|111|113|118|123|127|128)\d{3}\.(SH|SZ)$/i;
// Tushare 官方文档规定 top10cbholders 单次最多返回 3000 行；这是响应完整性边界，
// 不是本系统自设的调用次数或业务处理上限。
const TOP10_CB_HOLDERS_ROW_LIMIT = 3000;
const TOP10_CB_HOLDERS_FIELDS = 'ts_code,end_date,holder_rank,holder_name,hold_amount,hold_ratio';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateText(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // node-postgres 会把 DATE 按本地时区解析成前一日 16:00Z；先还原上海日历日，不能直接 toISOString().slice。
    const shanghai = new Date(value.getTime() + 8 * 60 * 60 * 1000);
    return shanghai.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const text = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function dateMinusDays(value, days) {
  const date = dateText(value);
  if (!date) return null;
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() - Number(days || 0));
  return result.toISOString().slice(0, 10);
}

function ymd(value) {
  const date = dateText(value);
  return date ? date.replace(/-/g, '') : null;
}

function shiftYmd(value, days) {
  const text = ymd(value);
  if (!text) return null;
  const date = new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function minYmd(values) {
  return values.map(ymd).filter(Boolean).sort()[0] || null;
}

function midpointYmd(start, end) {
  const startText = ymd(start), endText = ymd(end);
  if (!startText || !endText || startText >= endText) return null;
  const startDate = new Date(`${startText.slice(0, 4)}-${startText.slice(4, 6)}-${startText.slice(6, 8)}T00:00:00Z`);
  const endDate = new Date(`${endText.slice(0, 4)}-${endText.slice(4, 6)}-${endText.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) return null;
  const midpoint = new Date(startDate.getTime() + Math.floor((endDate.getTime() - startDate.getTime()) / 2));
  const result = midpoint.toISOString().slice(0, 10).replace(/-/g, '');
  return result > startText && result < endText ? result : null;
}

// 批量读取 top10_cb_holders：同一请求支持多个 ts_code，达到官方行数上限时递归拆分。
// 对首次全量数据，优先按代码拆分；单只债券仍达到上限时再按日期拆分，不能静默接受截断结果。
async function fetchTop10CbHolderRowsBatched({
  bonds = [], businessDate, query, rowLimit = TOP10_CB_HOLDERS_ROW_LIMIT,
  stopOnError = () => false, isBudgetBoundary = () => false,
} = {}) {
  if (typeof query !== 'function') throw new Error('缺少 top10_cb_holders 批量查询函数');
  const rowsByCode = new Map();
  const errorsByCode = new Map();
  const attemptedCodes = new Set();
  const deferredCodes = new Set();
  const targetEnd = ymd(businessDate);
  let calls = 0;
  let stopError = null;

  function codesOf(batch) {
    return [...new Set(batch.map(row => String(row.ts_code || '').trim().toUpperCase()).filter(Boolean))];
  }

  function markFailure(batch, error, { deferred = false, stop = false } = {}) {
    for (const code of codesOf(batch)) {
      if (deferred) deferredCodes.add(code);
      else {
        attemptedCodes.add(code);
        errorsByCode.set(code, error);
      }
    }
    if (stop && !stopError) stopError = error;
  }

  async function fetchBatch(batch, window = {}) {
    if (!batch.length) return;
    if (stopError) {
      markFailure(batch, stopError, { deferred: true });
      return;
    }
    const requestedCodes = codesOf(batch);
    const hasExplicitStart = Object.prototype.hasOwnProperty.call(window, 'startDate');
    const startDate = hasExplicitStart
      ? ymd(window.startDate)
      : minYmd(batch.map(row => dateMinusDays(row.holder_report_date, 30)));
    const endDate = ymd(window.endDate) || targetEnd;
    const params = { ts_code: requestedCodes.join(','), end_date: endDate };
    if (startDate) params.start_date = startDate;

    let rows;
    try {
      rows = await query(params);
      calls += 1;
      if (!Array.isArray(rows)) throw new Error('top10_cb_holders 返回结构无效');
    } catch (error) {
      if (isBudgetBoundary(error)) {
        markFailure(batch, error, { deferred: true, stop: true });
      } else {
        markFailure(batch, error, { stop: stopOnError(error) });
      }
      return;
    }

    if (rows.length >= rowLimit) {
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        const childWindow = hasExplicitStart ? window : { endDate: window.endDate || targetEnd };
        await fetchBatch(batch.slice(0, middle), childWindow);
        await fetchBatch(batch.slice(middle), childWindow);
        return;
      }

      // list_date 缺失时只用一个远早于现有可转债历史的技术下界做二分计算，
      // 该值不是业务筛选条件，也不作为接口额度或完成边界。
      const lowerBound = startDate || ymd(batch[0].list_date) || '19000101';
      const middle = midpointYmd(lowerBound, endDate);
      if (!middle) {
        const error = Object.assign(new Error(`top10_cb_holders 单只债券仍返回 ${rowLimit} 行，无法安全拆分日期`), {
          code: 'TOP10_CB_HOLDERS_ROW_LIMIT_EXCEEDED',
        });
        markFailure(batch, error, { stop: true });
        return;
      }
      await fetchBatch(batch, { startDate: lowerBound, endDate: middle });
      await fetchBatch(batch, { startDate: shiftYmd(middle, 1), endDate });
      return;
    }

    const allowed = new Set(requestedCodes);
    const grouped = new Map();
    for (const row of rows) {
      const code = String(row.ts_code || row.tscode || '').trim().toUpperCase();
      if (!allowed.has(code)) continue;
      if (!grouped.has(code)) grouped.set(code, []);
      grouped.get(code).push(row);
    }
    for (const code of requestedCodes) {
      attemptedCodes.add(code);
      rowsByCode.set(code, [...(rowsByCode.get(code) || []), ...(grouped.get(code) || [])]);
    }
  }

  await fetchBatch(bonds, { endDate: targetEnd });
  return { rowsByCode, errorsByCode, attemptedCodes, deferredCodes, stopError, calls };
}

// top10_cb_holders 不提供公告日。历史评分使用法定最晚披露日作为保守可见日，
// 宁可晚用，也不能把报告期结束日当成市场已经可见而产生未来数据泄漏。
function holderAvailableDate(row) {
  const announcedAt = dateText(row && row.announced_at);
  if (announcedAt) return announcedAt;
  const reportDate = dateText(row && row.report_date);
  if (!reportDate) return null;
  const year = Number(reportDate.slice(0, 4));
  const monthDay = reportDate.slice(5);
  if (monthDay === '12-31') return `${year + 1}-04-30`;
  if (monthDay === '06-30') return `${year}-08-31`;
  if (monthDay === '03-31') return `${year}-04-30`;
  if (monthDay === '09-30') return `${year}-10-31`;
  return null;
}

function researchLevel(percentile, score) {
  if (finite(score) == null || finite(percentile) == null) return 'unavailable';
  if (Number(percentile) >= 0.8) return 'relative_high';
  if (Number(percentile) >= 0.4) return 'relative_medium';
  return 'relative_low';
}

function normalizeBondCode(value) {
  const text = String(value || '').trim().toUpperCase();
  return BOND_CODE_RE.test(text) ? text : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, finite(value) == null ? 0 : Number(value)));
}

function percentileRank(values, value) {
  const numbers = (values || []).map(finite).filter(v => v != null).sort((a, b) => a - b);
  const current = finite(value);
  if (!numbers.length || current == null) return null;
  return numbers.filter(item => item <= current).length / numbers.length;
}

function pickNumber(source, names) {
  for (const name of names) {
    const value = finite(source && source[name]);
    if (value != null) return value;
  }
  return null;
}

function normalizeHolderName(value) {
  return String(value || '').replace(/[\s　（）()【】\[\]“”"'‘’]/g, '').replace(/有限责任公司|股份有限公司|有限公司$/g, '').toUpperCase();
}

function holderType(value) {
  const text = String(value || '');
  if (/基金|养老金|年金|社保|资产管理|集合资产管理|信托/.test(text)) return 'fund';
  if (/银行|保险|证券|信托/.test(text)) return 'financial';
  if (/公司|集团|合伙|投资/.test(text)) return 'company';
  if (/自然人|个人/.test(text)) return 'individual';
  return 'other';
}

function saveHolderRow(row, instrumentId, sourceId, relatedNames = []) {
  const reportDate = dateText(row.end_date || row.report_date);
  if (!reportDate || !instrumentId || !sourceId) return null;
  const rank = finite(row.holder_rank);
  const rawAmount = pickNumber(row, ['hold_amount', 'holding_quantity']);
  const holderName = String(row.holder_name || row.holder || '').trim();
  const normalized = normalizeHolderName(holderName);
  const related = (relatedNames || []).map(normalizeHolderName).filter(Boolean).some(name => normalized.includes(name));
  return {
    instrumentId, reportDate, announcedAt: dateText(row.ann_date || row.announced_at), rank,
    name: holderName, normalized,
    type: holderType(holderName), isControllerRelated: related,
    // Tushare top10_cb_holders 的 hold_amount 单位是万张，库内统一保存为张。
    amount: rawAmount == null ? null : rawAmount * 10000,
    ratio: finite(row.hold_ratio),
    sourceKey: `top10_cb_holders:${instrumentId}:${reportDate}:${rank == null ? normalizeHolderName(row.holder_name || row.holder || '') : rank}`,
    raw: row,
  };
}

function diffHolderSnapshots(latestRows = [], previousRows = [], latestDate = null) {
  const latest = new Map(latestRows.filter(row => row.holder_name_normalized).map(row => [row.holder_name_normalized, row]));
  const previous = new Map(previousRows.filter(row => row.holder_name_normalized).map(row => [row.holder_name_normalized, row]));
  const changes = [];
  for (const name of new Set([...latest.keys(), ...previous.keys()])) {
    const now = latest.get(name) || {}, before = previous.get(name) || {};
    const hasNow = latest.has(name), hasBefore = previous.has(name);
    const nowAmount = finite(now.hold_amount), beforeAmount = finite(before.hold_amount);
    const nowRatio = finite(now.hold_ratio), beforeRatio = finite(before.hold_ratio);
    const amount = hasNow && hasBefore
      ? nowAmount == null || beforeAmount == null ? null : nowAmount - beforeAmount
      : hasNow ? nowAmount : beforeAmount == null ? null : -beforeAmount;
    const ratio = hasNow && hasBefore
      ? nowRatio == null || beforeRatio == null ? null : nowRatio - beforeRatio
      : hasNow ? nowRatio : beforeRatio == null ? null : -beforeRatio;
    if ((amount == null || amount === 0) && (ratio == null || ratio === 0)) continue;
    changes.push({
      name, now, before, amount, ratio,
      changeType: !hasBefore ? 'new' : !hasNow ? 'cleared' : amount != null && amount > 0 ? 'increase' : amount != null && amount < 0 ? 'decrease' : ratio > 0 ? 'increase' : 'decrease',
      isCleared: !hasNow,
      changeStartDate: dateText(before.report_date),
      changeEndDate: dateText(now.report_date) || dateText(latestDate),
    });
  }
  return changes;
}

async function saveConvertibleBondHolderPositions(client, instrumentId, rows, sourceId, relatedNames = []) {
  const prepared = (rows || []).map(row => saveHolderRow(row, instrumentId, sourceId, relatedNames)).filter(Boolean);
  if (!prepared.length) return 0;
  for (const row of prepared) {
    await repository.insert_fundamental_convertible_bond_holder_positions([row.instrumentId, row.reportDate, row.announcedAt, row.rank, row.name, row.normalized, row.type, row.isControllerRelated,
        row.amount, row.ratio, sourceId, row.sourceKey, JSON.stringify(row.raw)], client);
  }
  const { rows: reportDates } = await repository.select_fundamental_convertible_bond_holder_positions([instrumentId], client);
  if (reportDates.length === 2) {
    const { rows: history } = await repository.select_fundamental_convertible_bond_holder_positions_1([instrumentId, reportDates[0].report_date, reportDates[1].report_date], client);
    const latestDate = dateText(reportDates[0].report_date), previousDate = dateText(reportDates[1].report_date);
    const latest = new Map(history.filter(row => dateText(row.report_date) === latestDate).map(row => [row.holder_name_normalized, row]));
    const previous = new Map(history.filter(row => dateText(row.report_date) === previousDate).map(row => [row.holder_name_normalized, row]));
    const changes = diffHolderSnapshots(
      history.filter(row => dateText(row.report_date) === latestDate),
      history.filter(row => dateText(row.report_date) === previousDate), latestDate
    );
    for (const change of changes) {
      const { name, now, before, amount, ratio, changeType, isCleared, changeStartDate, changeEndDate } = change;
      await repository.insert_event_convertible_bond_holder_change_events([instrumentId, dateText(now.announced_at) || latestDate, now.holder_name || before.holder_name || name, name,
          changeType, amount, ratio, finite(before.hold_amount), finite(now.hold_amount), finite(before.hold_ratio), finite(now.hold_ratio),
          isCleared, changeStartDate, changeEndDate, sourceId,
          `holder-change:${instrumentId}:${latestDate}:${name}`, JSON.stringify({ latest: now, previous: before })], client);
    }
  }
  return prepared.length;
}

async function saveCompanyPledgeSnapshots(client, companyId, rows, sourceId) {
  if (!companyId || !sourceId) return 0;
  const prepared = (rows || []).map(row => {
    const asOfDate = dateText(row.end_date || row.as_of_date);
    if (!asOfDate) return null;
    return {
      asOfDate, announcedAt: dateText(row.ann_date || row.announced_at),
      ratio: finite(row.pledge_ratio), pledgeCount: finite(row.pledge_count),
      // Tushare pledge_stat 的股份数量单位是万股，库内统一保存为股。
      pledged: pickNumber(row, ['rest_pledge', 'pledged_shares']) == null ? null : pickNumber(row, ['rest_pledge', 'pledged_shares']) * 10000,
      unpledged: pickNumber(row, ['unrest_pledge', 'unpledged_shares']) == null ? null : pickNumber(row, ['unrest_pledge', 'unpledged_shares']) * 10000,
      totalShares: pickNumber(row, ['total_share', 'total_shares']) == null ? null : pickNumber(row, ['total_share', 'total_shares']) * 10000, raw: row,
      key: `pledge_stat:${companyId}:${asOfDate}`,
    };
  }).filter(Boolean);
  for (const row of prepared) {
    await repository.insert_fundamental_company_pledge_snapshots([companyId, row.asOfDate, row.announcedAt, row.pledgeCount, row.ratio, row.pledged, row.unpledged, row.totalShares, sourceId, row.key, JSON.stringify(row.raw)], client);
  }
  return prepared.length;
}

function buildRevisionCycles(events, noRevisionRows = [], triggerRows = []) {
  const rows = [
    ...(events || []).map(row => ({ ...row, date: dateText(row.announced_at), kind: String(row.event_type || '') })),
    ...(noRevisionRows || []).map(row => ({ ...row, date: dateText(row.announced_at), kind: 'no_revision' })),
    ...(triggerRows || []).map(row => ({ ...row, date: dateText(row.trade_date), kind: 'trigger_observation' })),
  ].filter(row => row.date).sort((a, b) => a.date.localeCompare(b.date));
  const cycles = [];
  let current = null;
  for (const row of rows) {
    const gapDays = current && current.last_observation_date ?
      (new Date(`${row.date}T00:00:00Z`) - new Date(`${current.last_observation_date}T00:00:00Z`)) / 86400000 : 0;
    const newCycle = !current
      || (current.cycle_end_date && row.date > current.cycle_end_date)
      || (row.kind !== 'trigger_observation' && gapDays > 240);
    if (newCycle) {
      current = { cycle_start_date: row.date, first_match_date: null, trigger_date: null, proposal_date: null, decision_date: null,
        cycle_end_date: null, implementation_date: null, outcome: 'open', short_label: 'unknown', proposal_type: '', no_revision: false, lock_until: null, evidence: [] };
      cycles.push(current);
    }
    current.last_observation_date = row.date;
    current.evidence.push({ event_type: row.kind, date: row.date, title: row.title || row.summary || '' });
    if (row.kind === 'trigger_observation') {
      if (finite(row.matched_days) > 0) current.first_match_date = current.first_match_date || row.date;
      if (String(row.status || row.calculated_status || '') === 'met' || (finite(row.required_days) > 0 && finite(row.matched_days) >= finite(row.required_days))) current.trigger_date = current.trigger_date || row.date;
    }
    if (row.kind === 'trigger_notice') { current.trigger_date = current.trigger_date || row.date; current.short_label = current.short_label === 'unknown' ? 'unknown' : current.short_label; }
    if (row.kind === 'proposal') { current.proposal_date = current.proposal_date || row.date; current.proposal_type = 'proposal'; current.short_label = 'proposed'; }
    if (row.kind === 'meeting_notice') current.decision_date = current.decision_date || row.meeting_date || row.date;
    if (row.kind === 'meeting_approved') { current.decision_date = row.meeting_date || row.date; current.outcome = 'approved'; current.cycle_end_date = current.cycle_end_date || current.decision_date; }
    if (row.kind === 'meeting_rejected' || row.kind === 'terminated') { current.decision_date = row.meeting_date || row.date; current.outcome = 'rejected'; current.short_label = 'explicit_no_revision'; current.cycle_end_date = current.cycle_end_date || current.decision_date; }
    if (row.kind === 'implemented') { current.implementation_date = row.effective_date || row.date; current.outcome = 'implemented'; current.cycle_end_date = current.cycle_end_date || current.implementation_date; }
    if (row.kind === 'no_revision') { current.no_revision = true; current.outcome = 'no_revision'; current.short_label = 'explicit_no_revision'; current.decision_date = current.decision_date || row.date; current.cycle_end_date = current.cycle_end_date || row.date; current.lock_until = row.next_eligible_date || row.valid_until || null; }
  }
  return cycles.map((row, index) => { const { last_observation_date, ...clean } = row; return { ...clean, cycle_no: index + 1 }; });
}

/* saveRevisionCycles 已迁入 server/repositories/convertibleBondRevisionMotiveServiceRepository.js */

function scoreHistory(input) {
  const cutoff = input.tradeDate ? new Date(`${input.tradeDate}T00:00:00Z`).getTime() - 730 * 86400000 : null;
  const cycles = (input.cycles || []).filter(row => !cutoff || !row.cycle_start_date || new Date(`${row.cycle_start_date}T00:00:00Z`).getTime() >= cutoff);
  let score = 0;
  const items = [];
  const implemented = cycles.filter(row => row.outcome === 'implemented');
  if (implemented.length) { score += 12; items.push(`近两年已有${implemented.length}次成功实施`); }
  if (implemented.length >= 2) { score += 4; items.push('存在重复实施记录'); }
  const last = cycles[cycles.length - 1];
  if (last && last.proposal_date && !last.implementation_date) { score += 5; items.push('最近周期已提出但尚未实施'); }
  const noRevisionCount = cycles.filter(row => row.no_revision).length;
  if (noRevisionCount) { score -= Math.min(12, noRevisionCount * 4); items.push(`历史有${noRevisionCount}次明确不下修或锁定`); }
  const rejected = cycles.filter(row => row.outcome === 'rejected').length;
  if (rejected) { score -= Math.min(12, rejected * 6); items.push(`历史有${rejected}次否决/终止`); }
  return { score: clamp(score, 0, 25), items };
}

function scorePressure(input) {
  const p = input.profile || {}, f = input.financial || {};
  const remainYears = p.maturityDate && input.tradeDate ? (new Date(`${p.maturityDate}T00:00:00Z`) - new Date(`${input.tradeDate}T00:00:00Z`)) / 86400000 / 365 : null;
  const cash = pickNumber(f, ['cash', 'cash_equivalents']);
  const trading = pickNumber(f, ['trading_assets']);
  const debt = pickNumber(f, ['total_liabilities']);
  const revenue = pickNumber(f, ['revenue']);
  const interest = pickNumber(f, ['interest_expense']);
  const ebitda = pickNumber(f, ['ebitda']);
  const assets = pickNumber(f, ['total_assets']);
  const currentRatio = pickNumber(f, ['current_ratio', 'current_ratio_value']);
  const items = [], values = [];
  if (remainYears != null && remainYears <= 2) { values.push(6); items.push('距离到期不超过两年'); }
  if (remainYears != null && remainYears <= 1) { values.push(3); items.push('距离到期不超过一年'); }
  if (input.putProgress != null && input.putProgress > 0) { values.push(clamp(input.putProgress, 0, 6)); items.push('回售压力已有触发迹象'); }
  if (p.remainSize != null && cash != null && trading != null && cash + trading > 0 && p.remainSize > cash + trading) {
    values.push(p.remainSize > (cash + trading) * 2 ? 8 : 6); items.push('剩余债务高于现金及交易性资产');
  }
  if (debt != null && ebitda != null && debt > 0 && ebitda / debt < 0.05) { values.push(3); items.push('EBITDA覆盖负债能力偏弱'); }
  if (currentRatio != null && currentRatio < 1) { values.push(3); items.push('流动比率低于1'); }
  if (revenue != null && interest != null && revenue > 0 && interest / revenue > 0.1) { values.push(2); items.push('利息费用率偏高'); }
  if (assets != null && debt != null && assets > 0 && debt / assets > 0.6) { values.push(2); items.push('资产负债率偏高'); }
  return { score: clamp(values.reduce((a, b) => a + b, 0), 0, 30), items };
}

function scoreConversion(input) {
  const p = input.profile || {}, items = [], values = [];
  if (p.remainSize != null && p.issueSize != null && p.issueSize > 0) {
    const ratio = p.remainSize / p.issueSize;
    if (ratio >= 0.9) { values.push(8); items.push('剩余规模接近原发行规模'); }
    else if (ratio >= 0.7) { values.push(5); items.push('剩余规模仍较大'); }
  }
  if (p.remainSize != null && input.marketCap != null && input.marketCap > 0) {
    const ratio = p.remainSize / input.marketCap;
    if (ratio >= 0.2) { values.push(7); items.push('剩余债务相对正股市值较大'); }
    else if (ratio >= 0.1) { values.push(5); items.push('剩余债务相对正股市值偏高'); }
  }
  if (input.conversionValue != null && input.conversionValue < 70) { values.push(5); items.push('当前转股价值明显偏低'); }
  else if (input.conversionValue != null && input.conversionValue < 80) { values.push(3); items.push('当前转股价值偏低'); }
  return { score: clamp(values.reduce((a, b) => a + b, 0), 0, 20), items };
}

function scoreGovernance(input) {
  const controller = input.controller || {}, holders = input.holders || [], pledge = finite(input.pledgeRatio);
  const items = [], values = [];
  if (/自然人|民营|个人/.test(String(controller.controller_type || controller.type || '') + String(controller.controller_name || controller.name || ''))) { values.push(4); items.push('控制人更可能关注股权融资约束'); }
  const latestHolders = holders.filter(row => row.reportKind === 'latest');
  const initialHolders = holders.filter(row => row.reportKind === 'initial');
  const relatedRatio = latestHolders.filter(row => row.related).reduce((sum, row) => sum + (finite(row.hold_ratio) || 0), 0);
  if (relatedRatio >= 25) { values.push(4); items.push('关联方持有转债比例较高'); }
  const topRatio = latestHolders.filter(row => row.related).reduce((sum, row) => sum + (finite(row.hold_ratio) || 0), 0);
  const initialRatio = initialHolders.filter(row => row.related).reduce((sum, row) => sum + (finite(row.hold_ratio) || 0), 0);
  if (initialRatio >= 40 && topRatio < initialRatio * 0.75) { values.push(6); items.push('初始大额持有后出现明显退出'); }
  else if (initialRatio >= 25) { values.push(4); items.push('初始大额持有'); }
  if (pledge != null && pledge >= 40) { values.push(3); items.push('控制人股权质押比例较高'); }
  else if (pledge != null && pledge >= 20) { values.push(2); items.push('控制人存在一定股权质押'); }
  if (finite(controller.ratio) != null && controller.ratio >= 20) { values.push(2); items.push('控制人持股比例较高'); }
  return { score: clamp(values.reduce((a, b) => a + b, 0), 0, 15), items };
}

function scoreMarket(input) {
  const items = [], contextItems = [], values = [], bondClose = finite(input.bondClose);
  if (bondClose != null && bondClose < 100) { values.push(4); items.push('转债价格低于面值'); }
  else if (bondClose != null && bondClose < 110) { values.push(2); items.push('转债价格接近面值'); }
  const bondRank = percentileRank(input.bondPriceHistory, bondClose);
  if (bondRank != null && bondRank <= 0.2) { values.push(2); items.push('转债价格处于自身历史低位'); }
  const proposalRank = percentileRank(input.proposalHistory, input.proposalCount || 0);
  // 其他转债的下修只能作为市场背景，不能直接证明本债发行人有下修动机，因此不计入单债评分。
  if (proposalRank != null && proposalRank >= 0.6) contextItems.push('近期全市场下修提议偏多（仅作市场背景，不计入本债动机分）');
  if (input.industryProposalPressure) contextItems.push('同行近期下修提议偏多（仅作市场背景，不计入本债动机分）');
  return { score: clamp(values.reduce((a, b) => a + b, 0), 0, 10), items, contextItems };
}

function calculateExecutability(input) {
  const p = input.profile || {};
  const currentConv = finite(p.currentConvPrice), stockClose = finite(input.stockClose);
  const vwap = finite(input.stockVwap), pb = finite(input.stockPb), netAsset = pb && pb > 0 && stockClose != null ? stockClose / pb : null;
  const clauseFloor = input.netAssetFloorApplicable ? netAsset : null;
  // 面值是债券面值（通常100元），不是每股转股价底线，不能直接拿来限制下修。
  // 没有净资产条款时，仍需使用转股价格下修规则要求的近期均价作为估算底价。
  const floorPrice = [vwap, clauseFloor, finite(input.explicitFloorPrice)].filter(v => v != null && v > 0).sort((a, b) => b - a)[0] || null;
  const conversionValue = currentConv != null && currentConv > 0 && stockClose != null ? stockClose / currentConv * 100 : null;
  const postValue = floorPrice != null && stockClose != null ? stockClose / floorPrice * 100 : null;
  const space = currentConv != null && floorPrice != null && currentConv > 0 ? currentConv / floorPrice - 1 : null;
  const uplift = postValue != null && conversionValue != null ? postValue - conversionValue : null;
  const blockers = [];
  if (input.locked) blockers.push('当前处于不下修锁定期');
  if (currentConv == null || stockClose == null) blockers.push('缺少当前转股价或正股收盘价');
  if (input.netAssetFloorApplicable && netAsset == null) blockers.push('缺少可计算的每股净资产');
  if (floorPrice == null) blockers.push('缺少估算底价');
  if (space != null && space < 0.1) blockers.push('估算下修空间不足10%');
  if (uplift != null && uplift < 8) blockers.push('估算下修后转股价值提升不足8点');
  let status = 'incomplete';
  if (input.locked) status = 'locked';
  else if (currentConv == null || stockClose == null) status = 'incomplete';
  else if (floorPrice == null || (input.netAssetFloorApplicable && netAsset == null)) status = 'floor_blocked';
  else if (space < 0.1 || uplift < 8) status = 'insufficient_space';
  else status = 'pass';
  return { status, floorPrice, space, postValue, uplift, conversionValue, blockers };
}

function calculateMaturity(input) {
  if (input.revisionStatus === 'met') return 100;
  if (input.revisionStatus === 'tracking' && finite(input.remainingDays) != null) {
    if (input.remainingDays <= 3) return 85;
    if (input.remainingDays <= 5) return 70;
    if (input.remainingDays <= 10) return 50;
  }
  if (input.matchedDays > 0) return 30;
  return input.qualityStatus === 'incomplete' ? 0 : 10;
}

function buildDimensionCalculations(input) {
  const p = input.profile || {}, f = input.financial || {}, controller = input.controller || {};
  const cycles = input.cycles || [], recentCycles = cycles.filter(row => !input.tradeDate || !row.cycle_start_date ||
    new Date(`${dateText(row.cycle_start_date)}T00:00:00Z`) >= new Date(`${input.tradeDate}T00:00:00Z`) - 730 * 86400000);
  const implemented = recentCycles.filter(row => row.outcome === 'implemented').length;
  const rejected = recentCycles.filter(row => row.outcome === 'rejected').length;
  const remainYears = p.maturityDate && input.tradeDate ? (new Date(`${p.maturityDate}T00:00:00Z`) - new Date(`${input.tradeDate}T00:00:00Z`)) / 86400000 / 365 : null;
  const cash = pickNumber(f, ['cash', 'cash_equivalents']), trading = pickNumber(f, ['trading_assets']);
  const debt = pickNumber(f, ['total_liabilities']), ebitda = pickNumber(f, ['ebitda']);
  const revenue = pickNumber(f, ['revenue']), interest = pickNumber(f, ['interest_expense']), currentRatio = pickNumber(f, ['current_ratio', 'current_ratio_value']);
  const assets = pickNumber(f, ['total_assets']);
  const item = (metric, label, raw, unit, rule, delta = null) => ({ metric, label, raw_value: raw == null ? null : raw, unit, rule, delta });
  return {
    history: [
      item('implemented_count', '近两年成功实施次数', implemented, '次', '≥1次加12分，≥2次再加4分'),
      item('rejected_count', '近两年否决/终止次数', rejected, '次', '每次扣6分，最多扣12分', rejected ? -Math.min(12, rejected * 6) : 0),
      item('last_cycle_status', '最近周期状态', cycles[cycles.length - 1] && cycles[cycles.length - 1].outcome, '状态', '未实施提议加5分；明确不下修扣4分'),
    ],
    pressure: [
      item('remaining_years', '距离到期年数', remainYears, '年', '≤2年加6分，≤1年再加3分'),
      item('put_progress', '回售触发进度', input.putProgress, '分', '按触发进度最高加6分'),
      item('remain_size_vs_liquid_assets', '剩余规模/现金及交易资产', p.remainSize != null && cash != null && trading != null ? `${p.remainSize}/${cash + trading}` : null, '元', '剩余规模高于现金及交易资产时加6/8分'),
      item('leverage', '资产负债率', assets != null && debt != null && assets > 0 ? debt / assets : null, '倍', '>60%加2分'),
      item('ebitda_coverage', 'EBITDA/负债', debt != null && ebitda != null && debt > 0 ? ebitda / debt : null, '倍', '<5%加3分'),
      item('current_ratio', '流动比率', currentRatio, '倍', '<1加3分'),
      item('interest_rate', '利息费用/收入', revenue != null && interest != null && revenue > 0 ? interest / revenue : null, '倍', '>10%加2分'),
    ],
    conversion: [
      item('remain_issue_ratio', '剩余规模/发行规模', p.remainSize != null && p.issueSize > 0 ? p.remainSize / p.issueSize : null, '百分比', '≥90%加8分，≥70%加5分'),
      item('remain_market_cap_ratio', '剩余规模/正股市值', p.remainSize != null && input.marketCap > 0 ? p.remainSize / input.marketCap : null, '百分比', '≥20%加7分，≥10%加5分'),
      item('conversion_value', '转股价值', input.conversionValue, '元', '<70加5分，<80加3分'),
    ],
    governance: [
      item('controller_type', '控制人类型', controller.controller_type || controller.type, '类型', '自然人/民营/个人加4分'),
      item('related_holder_ratio', '最新关联持有人比例', (input.holders || []).filter(row => row.reportKind === 'latest' && row.related).reduce((sum, row) => sum + (finite(row.hold_ratio) || 0), 0), '%', '≥25%加4分'),
      item('pledge_ratio', '股权质押比例', input.pledgeRatio, '%', '≥40%加3分，≥20%加2分'),
      item('controller_ratio', '控制人持股比例', finite(controller.control_ratio || controller.ratio), '%', '≥20%加2分'),
    ],
    market: [
      item('bond_close', '转债价格', input.bondClose, '元', '<100加4分，<110加2分'),
      item('bond_price_percentile', '转债历史价格分位', percentileRank(input.bondPriceHistory, input.bondClose), '百分位', '≤20%加2分'),
      item('industry_proposal_pressure', '同行近期提议压力', input.industryProposalPressure, '状态', '仅作市场背景参考，不计入本债动机分'),
    ],
  };
}

function buildMotiveScore(input = {}) {
  const qualityStatus = input.qualityStatus || 'incomplete';
  const history = scoreHistory(input), pressure = scorePressure(input), conversion = scoreConversion(input);
  const governance = scoreGovernance(input), market = scoreMarket(input);
  const executable = calculateExecutability(input);
  const motiveScore = clamp(history.score + pressure.score + conversion.score + governance.score + market.score, 0, 100);
  const maturityScore = calculateMaturity({ ...input, qualityStatus });
  const coreMotives = [...new Set([...pressure.items, ...conversion.items, ...governance.items, ...market.items])].slice(0, 6);
  const governanceHolders = (input.holders || []).filter(row => row.reportKind === 'latest' && row.related).reduce((sum, row) => sum + (finite(row.hold_ratio) || 0), 0);
  const blockers = [...new Set([
    ...executable.blockers,
    ...(governanceHolders >= 25 ? ['大股东仍持债，相关股东可能需要回避表决'] : []),
    ...(input.profile && input.profile.issueSize > 0 && input.profile.remainSize != null && input.profile.remainSize / input.profile.issueSize < 0.2 ? ['剩余规模较小，促转股必要性偏弱'] : []),
    ...(input.safetyLevel && /高风险|high/i.test(String(input.safetyLevel)) ? ['安全性评级偏高风险，动机不等于安全'] : []),
    ...(qualityStatus !== 'complete' ? ['核心输入未完整，暂不输出预测等级'] : []),
    ...(!MOTIVE_MODEL_CALIBRATED && input.modelCalibrated !== true ? ['历史样本外回测未通过，暂不输出预测等级'] : []),
    ...(qualityStatus === 'incomplete' ? ['关键输入不完整'] : []),
  ])];
  // 部分输入缺失或模型尚未完成样本外校准时，不能把研究分数转换成预测等级。
  const hasUsableInput = qualityStatus === 'complete' && (MOTIVE_MODEL_CALIBRATED || input.modelCalibrated === true);
  const motiveLevel = !hasUsableInput ? 'unavailable' : motiveScore >= 70 ? 'research_high' : motiveScore >= 50 ? 'has_motive' : 'weak';
  const unavailableReason = qualityStatus !== 'complete' ? '数据不完整，暂不判断' : '研究评分未完成历史校准，暂不判断';
  return {
    motiveScore, maturityScore, motiveLevel,
    classification: motiveLevel === 'research_high' ? '研究评分≥70（待历史校准）' : motiveLevel === 'has_motive' ? '存在下修动机（研究评分）' : motiveLevel === 'weak' ? '动机偏弱（研究评分）' : unavailableReason,
    dimensions: { history: history.score, pressure: pressure.score, conversion: conversion.score, governance: governance.score, market: market.score },
    dimensionItems: { history: history.items, pressure: pressure.items, conversion: conversion.items, governance: governance.items, market: market.items },
    dimensionCalculations: buildDimensionCalculations({ ...input, qualityStatus }),
    marketContext: market.contextItems || [], executability: executable, coreMotives, blockers,
  };
}

function snapshotRow(field, label, value, unit, dataDate, source, rule = '', delta = null, businessKey = '', apiName = '', ingestedAt = null, statusOverride = '') {
  const present = value !== null && value !== undefined && value !== '';
  return {
    field, metric: field, label, value: present ? value : null, raw_value: present ? value : null, unit,
    rule, delta, data_date: dateText(dataDate), source, business_key: businessKey, api_name: apiName,
    ingested_at: ingestedAt || null, status: statusOverride || (present ? 'present' : 'missing'),
  };
}

function inputSnapshot(input) {
  const p = input.profile || {}, f = input.financial || {}, meta = input.sourceMeta || {};
  const structured = value => value == null ? null : JSON.stringify(value);
  const holderSummary = (input.holders || []).filter(row => row.reportKind === 'latest' || row.reportKind === 'initial').map(row => ({ report_date: dateText(row.report_date), holder_name: row.holder_name,
    holder_type: row.holder_type, hold_amount: finite(row.hold_amount), hold_ratio: finite(row.hold_ratio), related: Boolean(row.related), report_kind: row.reportKind }));
  const cycleSummary = (input.cycles || []).map(row => ({ cycle_no: row.cycle_no, cycle_start_date: dateText(row.cycle_start_date),
    trigger_date: dateText(row.trigger_date), proposal_date: dateText(row.proposal_date), decision_date: dateText(row.decision_date),
    implementation_date: dateText(row.implementation_date), outcome: row.outcome, no_revision: Boolean(row.no_revision), lock_until: dateText(row.lock_until) }));
  const refs = [
    snapshotRow('bond_close', '转债收盘价', input.bondClose, '元', input.marketTradeDate || input.tradeDate, 'market.convertible_bond_daily_metrics', '用于面值/历史低位判断', null, input.tsCode, 'cb_daily', meta.market_ingested_at),
    snapshotRow('stock_close', '正股收盘价', input.stockClose, '元', input.stockTradeDate, 'market.daily_bars', '用于净资产和转股价值估算', null, input.stockCode, 'daily', meta.stock_ingested_at),
    snapshotRow('stock_vwap', '正股20日成交额加权均价', input.stockVwap, '元', input.stockTradeDate, 'market.daily_bars', '估算下修底价', null, input.stockCode, 'daily', meta.stock_ingested_at),
    snapshotRow('conversion_value', '转股价值', input.conversionValue, '元', input.marketTradeDate || input.tradeDate, 'market.convertible_bond_daily_metrics', '低于70/80分段加分', null, input.tsCode, 'cb_daily', meta.market_ingested_at),
    snapshotRow('current_conv_price', '当前转股价', p.currentConvPrice, '元/股', input.tradeDate, 'fundamental.convertible_bond_profiles', '计算下修空间', null, input.tsCode, 'cb_basic+本地条款', meta.profile_ingested_at),
    snapshotRow('stock_pb', '正股PB', input.stockPb, '倍', input.valuationTradeDate, 'market.daily_valuations', '净资产条款存在时参与底价估算', null, input.stockCode, 'daily_basic', meta.valuation_ingested_at),
    snapshotRow('market_cap', '正股总市值', input.marketCap, '元', input.valuationTradeDate, 'market.daily_valuations', '计算剩余债务/市值压力', null, input.stockCode, 'daily_basic', meta.valuation_ingested_at),
    snapshotRow('remain_size', '剩余规模', p.remainSize, '元', input.tradeDate, 'fundamental.convertible_bond_profiles', '与现金、正股市值比较', null, input.tsCode, 'cb_basic', meta.profile_ingested_at),
    snapshotRow('issue_size', '发行规模', p.issueSize, '元', input.tradeDate, 'fundamental.convertible_bond_profiles', '计算余额占发行规模比例', null, input.tsCode, 'cb_basic', meta.profile_ingested_at),
    snapshotRow('maturity_date', '到期日', p.maturityDate, '日期', input.tradeDate, 'fundamental.convertible_bond_profiles', '剩余期限压力', null, input.tsCode, 'cb_basic', meta.profile_ingested_at),
    snapshotRow('trigger_status', '下修触发状态', input.revisionStatus, '状态', input.tradeDate, 'analytics.convertible_bond_trigger_daily', '触发状态/成熟度', null, input.tsCode, '本地计算', meta.trigger_calculated_at),
    snapshotRow('matched_days', '已满足天数', input.matchedDays, '天', input.tradeDate, 'analytics.convertible_bond_trigger_daily', '与必要天数比较', null, input.tsCode, '本地计算', meta.trigger_calculated_at),
    snapshotRow('required_days', '必要天数', input.requiredDays, '天', input.tradeDate, 'analytics.convertible_bond_trigger_daily', '与已满足天数比较', null, input.tsCode, '本地计算', meta.trigger_calculated_at),
    snapshotRow('remaining_days', '剩余观察天数', input.remainingDays, '天', input.tradeDate, 'analytics.convertible_bond_trigger_daily', '成熟度评分', null, input.tsCode, '本地计算', meta.trigger_calculated_at),
    snapshotRow('pledge_ratio', '股权质押比例', input.pledgeRatio, '%', input.pledgeDate, 'fundamental.company_pledge_snapshots', '20%/40%分段加分；正常空结果表示该截止日未返回质押统计，不按未知错误处理', null, input.companyId || '', 'pledge_stat', meta.pledge_ingested_at, input.pledgeObservationStatus),
    snapshotRow('safety_level', '安全性结果', input.safetyLevel, '等级', input.tradeDate, 'bond_safety_snapshots', '仅展示，不抵消动机分', null, input.tsCode, '本地计算', meta.safety_refreshed_at),
    snapshotRow('financial_metrics', '财务指标说明', structured(f), '说明', f.report_period, f.source_table || 'fundamental.financial_reports', '同一报告期内取数', null, input.companyId || input.stockCode || '', f.source_api || 'financial_reports', meta.financial_ingested_at),
    snapshotRow('controller', '控制人快照', structured(input.controller), '说明', input.controllerDate || input.tradeDate, 'core.company_controllers', '控制人类型/持股比例', null, input.companyId || '', 'company_controllers', meta.controller_announced_at),
    snapshotRow('holder_positions', '前十大持有人快照', structured(holderSummary), '说明', input.holderDate, 'fundamental.convertible_bond_holder_positions', '最新报告期与初始报告期对比', null, input.tsCode, 'top10_cb_holders', meta.holder_ingested_at),
    snapshotRow('revision_cycles', '历史下修情况', structured(cycleSummary), '说明', input.tradeDate, 'analytics.convertible_bond_revision_cycles', '按时间说明过去的下修过程', null, input.tsCode, '本地计算', meta.cycle_calculated_at),
    snapshotRow('put_progress', '回售触发进度', input.putProgress, '分', input.tradeDate, 'analytics.analysis_snapshots', '回售触发迹象最高加6分', null, input.tsCode, '本地快照', meta.analysis_as_of_date),
    snapshotRow('quality_status', '输入质量状态', input.qualityStatus, '状态', input.tradeDate, '本地评分质量门槛', 'complete/partial/incomplete', null, input.tsCode, '本地计算'),
  ];
  return refs;
}

function sourceReferences(input) {
  const meta = input.sourceMeta || {};
  const refs = [
    { group: '评分主链', table: 'market.convertible_bond_daily_metrics', data_date: dateText(input.marketTradeDate || input.tradeDate), source: '已入库行情事实', business_key: input.tsCode, api_name: 'cb_daily', ingested_at: meta.market_ingested_at },
    { group: '评分主链', table: 'market.daily_bars', data_date: dateText(input.stockTradeDate), source: '已入库行情事实', business_key: input.stockCode, api_name: 'daily', ingested_at: meta.stock_ingested_at },
    { group: '评分主链', table: 'market.daily_valuations', data_date: dateText(input.valuationTradeDate), source: '已入库行情事实', business_key: input.stockCode, api_name: 'daily_basic', ingested_at: meta.valuation_ingested_at },
    { group: '触发成熟度', table: 'analytics.convertible_bond_trigger_daily', data_date: dateText(input.tradeDate), source: '本地计算事实', business_key: input.tsCode, api_name: 'reset-v2', ingested_at: meta.trigger_calculated_at },
    { group: '历史周期', table: 'event.convertible_bond_revision_events', data_date: dateText(meta.event_latest_at), source: '本地公告事件库', business_key: input.tsCode, api_name: 'revision-events', ingested_at: meta.event_latest_ingested_at },
    { group: '历史周期', table: 'analytics.convertible_bond_revision_cycles', data_date: dateText(input.tradeDate), source: '本地评分计算', business_key: `${input.tsCode}:${CYCLE_VERSION}`, api_name: 'cycle-v1', ingested_at: meta.cycle_calculated_at },
    { group: '治理压力', table: 'fundamental.convertible_bond_holder_positions', data_date: dateText(input.holderDate), source: 'Tushare结果入库', business_key: input.tsCode, api_name: 'top10_cb_holders', ingested_at: meta.holder_ingested_at },
    { group: '治理压力', table: 'fundamental.company_pledge_snapshots', data_date: dateText(input.pledgeDate), source: 'Tushare结果入库', business_key: input.companyId || '', api_name: 'pledge_stat', ingested_at: meta.pledge_ingested_at },
    { group: '治理压力', table: 'core.company_controllers', data_date: dateText(input.controllerDate), source: '本地公司事实库', business_key: input.companyId || '', api_name: 'company_controllers', ingested_at: meta.controller_announced_at },
    { group: '财务压力', table: input.financial && input.financial.source_table || 'fundamental.financial_reports', data_date: dateText(input.financialDate), source: input.financial && input.financial.source_table === 'bond_safety_financial_cache' ? '已入库正股财务缓存' : '已入库财报事实', business_key: input.companyId || input.stockCode || '', api_name: input.financial && input.financial.source_api || 'financial_reports', ingested_at: meta.financial_ingested_at },
    { group: '安全性', table: 'bond_safety_snapshots', data_date: dateText(meta.safety_refreshed_at), source: '本地安全性快照', business_key: input.tsCode, api_name: 'bond_safety_snapshots', ingested_at: meta.safety_refreshed_at },
  ];
  (input.events || []).filter(row => row.source_url).forEach(row => refs.push({
    group: '历史周期', table: 'event.convertible_bond_revision_events', data_date: dateText(row.announced_at), source: '正式公告',
    business_key: row.source_number || input.tsCode, api_name: 'official_announcement', announcement_url: row.source_url, ingested_at: row.updated_at,
  }));
  return refs;
}

function inputHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot || [])).digest('hex');
}

function qualityRate(input) {
  const checks = [input.bondClose, input.stockClose, input.profile && input.profile.currentConvPrice, input.profile && input.profile.maturityDate,
    input.profile && input.profile.issueSize, input.profile && input.profile.remainSize, input.financialDate, input.holderDate, input.pledgeDate];
  const rate = checks.filter(v => v !== null && v !== undefined && v !== '').length / checks.length;
  return { rate, status: rate >= 0.85 ? 'complete' : rate >= 0.55 ? 'partial' : 'incomplete' };
}

function rawReportValue(reports, names) {
  for (const report of reports || []) {
    const value = pickNumber(report.raw_payload || report, names);
    if (value != null) return value;
  }
  return null;
}

function buildFinancial(reports, cache) {
  const orderedReports = (reports || []).filter(row => row && row.period_end).slice().sort((a, b) => {
    const period = dateText(b.period_end).localeCompare(dateText(a.period_end));
    return period || String(b.announced_at || '').localeCompare(String(a.announced_at || ''));
  });
  // 财务指标必须来自同一报告期；只有完全没有标准财报时才回退到已按公告日筛选过的缓存。
  const period = orderedReports[0] && dateText(orderedReports[0].period_end)
    || dateText(cache && (cache.report_end_date || cache.period_end || cache.end_date));
  const periodReports = period ? orderedReports.filter(row => dateText(row.period_end) === period) : [];
  const rows = periodReports.length ? periodReports.map(row => row.raw_payload || row) : cache && cache.data ? [cache.data] : [];
  const cash = rawReportValue(rows, ['money_cap', 'monetary_cap', 'cash_cash_equivalents', 'cash_equivalents', 'cash']);
  const trading = rawReportValue(rows, ['tradable_fin_assets', 'trading_fin_assets', 'trading_assets']);
  const liabilities = rawReportValue(rows, ['total_liab', 'total_liabilities', 'total_liability']);
  const assets = rawReportValue(rows, ['total_assets']);
  const revenue = rawReportValue(rows, ['total_revenue', 'revenue', 'operating_revenue']);
  const interest = rawReportValue(rows, ['fin_exp_int_exp', 'interest_expense', 'finan_exp']);
  const currentRatio = rawReportValue(rows, ['current_ratio', 'current_ratio_value']);
  const ebit = rawReportValue(rows, ['ebit', 'operating_profit']);
  const depreciation = rawReportValue(rows, ['depr_fa_coga_dpba', 'depreciation']);
  const amortization = rawReportValue(rows, ['amort_intang_assets', 'amortization']);
  const fromStandardReports = periodReports.length > 0;
  return { cash, trading_assets: trading, total_liabilities: liabilities, total_assets: assets, current_ratio: currentRatio, revenue, interest_expense: interest,
    ebitda: ebit == null ? null : ebit + (depreciation || 0) + (amortization || 0), report_period: period,
    announced_at: periodReports[0] && dateText(periodReports[0].announced_at) || dateText(cache && cache.announced_at),
    source_table: fromStandardReports ? 'fundamental.financial_reports' : cache && cache.data ? 'bond_safety_financial_cache' : 'fundamental.financial_reports',
    source_api: fromStandardReports ? 'financial_reports' : cache && cache.data ? 'bond_safety_financial_cache' : 'financial_reports' };
}

async function loadMotiveInput(tsCode, tradeDate, db = pool) {
  const { rows } = await repository.select_fundamental_convertible_bond_issuance([tsCode, tradeDate]);
  if (!rows.length) return null;
  const base = rows[0];
  const [events, noRevision, holders, pledge, pledgeCursor, controllers, financial, cache, safety, analysisSnapshot, stockBars, bondBars, history, proposal, industry, triggerHistory] = await Promise.all([
    repository.select_event_convertible_bond_revision_events([base.instrument_id, tradeDate]),
    repository.select_analytics_convertible_bond_announcement_history([base.instrument_id, tradeDate]),
    repository.select_fundamental_convertible_bond_holder_positions_2([base.instrument_id, tradeDate]),
    base.company_id ? repository.select_fundamental_company_pledge_snapshots([base.company_id, tradeDate]) : Promise.resolve({ rows: [] }),
    base.company_id ? repository.select_ops_sync_cursors([base.company_id, tradeDate]) : Promise.resolve({ rows: [] }),
    base.company_id ? repository.select_core_company_controllers([base.company_id, tradeDate]) : Promise.resolve({ rows: [] }),
    base.company_id ? repository.select_fundamental_financial_reports([base.company_id, tradeDate]) : Promise.resolve({ rows: [] }),
    base.stock_code ? repository.select_bond_safety_financial_cache([base.stock_code, tradeDate]) : Promise.resolve({ rows: [] }),
    repository.select_bond_safety_snapshots([tradeDate]),
    base.instrument_id ? repository.select_analytics_analysis_snapshots([base.instrument_id, tradeDate]) : Promise.resolve({ rows: [] }),
    base.stock_instrument_id ? repository.select_market_daily_bars([base.stock_instrument_id, tradeDate]) : Promise.resolve({ rows: [] }),
    repository.select_market_convertible_bond_daily_metrics([base.instrument_id, tradeDate]),
    repository.select_event_convertible_bond_revision_events_1([tradeDate]),
    repository.select_event_convertible_bond_revision_events_2([base.instrument_id, tradeDate]),
    base.company_id ? repository.select_event_convertible_bond_revision_events_3([base.company_id, tradeDate]) : Promise.resolve({ rows: [{ recent_count: 0, year_count: 0 }] }),
    repository.select_analytics_convertible_bond_trigger_daily([base.instrument_id, tradeDate]),
  ]);
  const holderRows = holders.rows.filter(row => {
    const availableAt = holderAvailableDate(row);
    return availableAt && availableAt <= tradeDate;
  });
  const latestDate = holderRows[0] && dateText(holderRows[0].report_date);
  const initialDate = holderRows.length ? holderRows.map(row => dateText(row.report_date)).filter(Boolean).sort()[0] : null;
  const controller = controllers.rows[0] || {};
  const relatedNames = [base.legal_name, base.bond_name, base.stock_name, controller.controller_name].filter(Boolean).map(normalizeHolderName);
  const holderData = holderRows.map(row => ({ ...row, related: relatedNames.some(name => name && normalizeHolderName(row.holder_name).includes(name)), reportKind: dateText(row.report_date) === latestDate ? 'latest' : dateText(row.report_date) === initialDate ? 'initial' : 'other' }));
  const latestNoRevision = noRevision.rows.slice().sort((a, b) => String(b.announced_at).localeCompare(String(a.announced_at)))[0] || {};
  const locked = (dateText(latestNoRevision.next_eligible_date) && tradeDate < dateText(latestNoRevision.next_eligible_date))
    || (dateText(latestNoRevision.valid_until) && tradeDate <= dateText(latestNoRevision.valid_until));
  const safetyList = safety.rows[0] && Array.isArray(safety.rows[0].data) ? safety.rows[0].data : [];
  const safetyItem = safetyList.find(row => String(row.bond_code || row.ts_code || '').split('.')[0] === String(tsCode).split('.')[0]) || {};
  const stockRows = stockBars.rows;
  const vwapRows = stockRows.filter(row => finite(row.volume) > 0 && finite(row.amount) != null);
  const stockVwap = vwapRows.length ? vwapRows.slice(0, 20).reduce((sum, row) => sum + Number(row.amount) * 10, 0) / vwapRows.slice(0, 20).reduce((sum, row) => sum + Number(row.volume), 0) : null;
  const financialData = buildFinancial(financial.rows, cache.rows[0]);
  const industryRecent = Number(industry.rows[0] && industry.rows[0].recent_count || 0);
  const industryYear = Number(industry.rows[0] && industry.rows[0].year_count || 0);
  const pledgeRow = pledge.rows[0] || null;
  const pledgeObservedAt = pledgeRow && dateText(pledgeRow.as_of_date)
    || pledgeCursor.rows[0] && dateText(pledgeCursor.rows[0].last_success_date);
  const quality = qualityRate({ bondClose: base.bond_close, stockClose: base.stock_close, profile: {
    currentConvPrice: base.current_conv_price, maturityDate: dateText(base.maturity_date), issueSize: finite(base.issue_size), remainSize: finite(base.remain_size)
  }, financialDate: financialData.report_period, holderDate: latestDate, pledgeDate: pledgeObservedAt });
  const cycles = buildRevisionCycles(events.rows, noRevision.rows, triggerHistory.rows);
  return {
    instrumentId: base.instrument_id, tsCode, tradeDate, bondName: base.bond_name || base.bond_short_name, stockCode: base.stock_code, stockName: base.stock_name,
    companyId: base.company_id,
    profile: { parValue: finite(base.par_value), issueSize: finite(base.issue_size), remainSize: finite(base.remain_size), maturityDate: dateText(base.maturity_date), currentConvPrice: finite(base.current_conv_price) },
    bondClose: finite(base.bond_close), conversionValue: finite(base.conversion_value), marketTradeDate: dateText(base.market_trade_date), stockClose: finite(base.stock_close), stockTradeDate: dateText(base.stock_trade_date),
    stockPb: base.stock_trade_date && base.valuation_trade_date && dateText(base.stock_trade_date) === dateText(base.valuation_trade_date) ? finite(base.stock_pb) : null,
    marketCap: base.stock_trade_date && base.valuation_trade_date && dateText(base.stock_trade_date) === dateText(base.valuation_trade_date) ? finite(base.total_market_cap) : null,
    valuationTradeDate: dateText(base.valuation_trade_date),
    stockVwap, revisionStatus: base.revision_status, matchedDays: finite(base.matched_days),
    requiredDays: finite(base.required_days),
    remainingDays: finite(base.required_days) != null && finite(base.matched_days) != null ? Math.max(0, finite(base.required_days) - finite(base.matched_days)) : null,
    rollingRemainingDays: finite(base.rolling_remaining_days), netAssetFloorApplicable: Boolean(base.net_asset_floor_applicable),
    locked, financial: financialData, financialDate: financialData.report_period, safetyLevel: safetyItem.safety || safetyItem.safety_level || '',
    holders: holderData, holderDate: latestDate, pledgeRatio: pledgeRow && finite(pledgeRow.pledge_ratio), pledgeDate: pledgeObservedAt,
    pledgeObservationStatus: pledgeRow ? 'present' : pledgeObservedAt ? 'observed_empty' : 'missing',
    controller: { ...controller, name: controller.controller_name, type: controller.controller_type, ratio: finite(controller.control_ratio) }, controllerDate: controller.announced_at && dateText(controller.announced_at),
    cycles, events: events.rows, noRevision: noRevision.rows, bondPriceHistory: bondBars.rows.map(row => finite(row.close)),
    proposalCount: Number(proposal.rows[0] && proposal.rows[0].count || 0), proposalHistory: history.rows.map(row => finite(row.count)),
    industryProposalPressure: industryRecent > 0 && (industryRecent >= 2 || industryRecent * 4 >= Math.max(industryYear, 1)),
    putProgress: (() => { const basic = analysisSnapshot.rows[0] && analysisSnapshot.rows[0].payload && analysisSnapshot.rows[0].payload.basic || {}; const required = finite(basic.put_required_days); const matched = finite(basic.put_day_count); return basic.put_met ? 6 : required && matched != null ? Math.min(6, matched / required * 6) : 0; })(),
    qualityStatus: quality.status, qualityRate: quality.rate, termId: base.term_id,
    sourceMeta: { market_ingested_at: base.market_ingested_at, stock_ingested_at: base.stock_ingested_at, valuation_ingested_at: base.valuation_ingested_at,
      trigger_calculated_at: base.trigger_calculated_at, profile_ingested_at: null, holder_ingested_at: holderRows[0] && holderRows[0].ingested_at,
      pledge_ingested_at: pledge.rows[0] && pledge.rows[0].ingested_at, financial_ingested_at: financial.rows[0] && financial.rows[0].ingested_at || cache.rows[0] && cache.rows[0].fetched_at,
      controller_announced_at: controller.announced_at, cycle_calculated_at: null, event_latest_at: events.rows.length ? events.rows[events.rows.length - 1].announced_at : null,
      event_latest_ingested_at: null, safety_refreshed_at: safety.rows[0] && (safety.rows[0].source_updated_at || safety.rows[0].refreshed_at), analysis_as_of_date: analysisSnapshot.rows[0] && analysisSnapshot.rows[0].as_of_date },
  };
}

async function calculateBondRevisionMotive(tsCode, tradeDate, client = pool, options = {}) {
  // 读取阶段有多条并行查询，使用连接池避免在同一个 PostgreSQL client 上并发 query；结果写入仍由调用方事务负责。
  const input = await loadMotiveInput(tsCode, tradeDate, pool);
  if (!input) return null;
  const score = buildMotiveScore(input);
  const snapshot = inputSnapshot(input);
  const refs = sourceReferences(input);
  const result = { ...score, input, inputSnapshot: snapshot, sourceReferences: refs, inputHash: inputHash(snapshot) };
  // 历史回填只补评分快照，不重建周期表；否则按历史日期逐条回填会把未来周期删掉。
  if (options.persistCycles !== false) await saveRevisionCycles(client, input.instrumentId, input.cycles, input.termId);
  await repository.insert_analytics_convertible_bond_revision_motive_daily([input.instrumentId, tradeDate, MOTIVE_MODEL_VERSION, score.motiveScore, score.dimensions.history, score.dimensions.pressure, score.dimensions.conversion,
      score.dimensions.governance, score.dimensions.market, score.maturityScore, score.executability.status, score.executability.floorPrice, score.executability.space,
      score.executability.postValue, score.executability.uplift, input.safetyLevel || '', score.motiveLevel, score.classification, JSON.stringify(score.coreMotives), JSON.stringify(score.blockers),
      JSON.stringify({ dimensions: score.dimensions, dimension_items: score.dimensionItems, dimension_calculations: score.dimensionCalculations, market_context: score.marketContext, maturity_score: score.maturityScore, executability: score.executability }),
      JSON.stringify(snapshot), JSON.stringify(refs), input.tradeDate, result.inputHash, input.qualityRate, input.qualityStatus], client);
  return result;
}

async function calculateConvertibleBondRevisionMotiveScores(tradeDate) {
  let targetDate = dateText(tradeDate);
  if (!targetDate) {
    const { rows: dateRows } = await repository.select_market_convertible_bond_daily_metrics_1();
    targetDate = dateText(dateRows[0] && dateRows[0].trade_date);
  }
  if (!targetDate) return { ok: false, status: 'no_data', tradeDate: null, count: 0, complete: 0, incomplete: 0, failures: [] };
  const { rows } = await repository.select_market_convertible_bond_daily_metrics_2([targetDate]);
  const results = [], failures = [];
  const client = await pool.connect();
  for (const row of rows) {
    try {
      await txControl.begin(client);
      const result = await calculateBondRevisionMotive(row.ts_code, targetDate, client);
      await txControl.commit(client);
      if (result) results.push(result);
    } catch (error) {
      try { await txControl.rollback(client); } catch (_) {}
      failures.push({ tsCode: row.ts_code, error: String(error.message || error).slice(0, 300) });
    }
  }
  client.release();
  return { ok: failures.length === 0, tradeDate: targetDate, count: results.length, complete: results.filter(row => row.input.qualityStatus === 'complete').length, incomplete: results.filter(row => row.input.qualityStatus !== 'complete').length, failures };
}

async function getBondRevisionMotiveDetail({ tsCode, tradeDate = null }) {
  const code = normalizeBondCode(tsCode);
  if (!code) throw Object.assign(new Error('可转债代码不合法'), { statusCode: 400 });
  const { rows } = await repository.selectRevisionMotiveDetail({ code, modelVersion: MOTIVE_MODEL_VERSION, tradeDate: tradeDate ? dateText(tradeDate) : null });
  if (!rows.length) {
    const { rows: bonds } = await repository.select_core_instruments([code]);
    if (!bonds.length) return null;
    return {
      bond: bonds[0], score_summary: { motive_score: null, maturity_score: null, motive_level: 'unavailable',
        research_level: 'unavailable', research_percentile: null, classification: '尚未生成评分快照', safety_level: '',
        quality_status: 'incomplete', completeness_rate: 0, trade_date: tradeDate || null },
      dimension_calculations: [], market_context: [], executability_calculation: {}, input_snapshot: [], source_references: [],
      core_motives: [], blockers: ['尚未生成评分快照，请等待下一次下修动机计算任务'], model_version: MOTIVE_MODEL_VERSION,
      calculated_at: null, input_hash: null,
    };
  }
  const row = rows[0];
  const percentile = finite(row.research_percentile);
  return {
    bond: { ts_code: row.ts_code, bond_name: row.bond_name, stock_code: row.stock_code, stock_name: row.stock_name },
    score_summary: { motive_score: finite(row.motive_score), maturity_score: finite(row.maturity_score), motive_level: row.motive_level,
      research_level: researchLevel(percentile, row.motive_score), research_percentile: percentile,
      classification: row.classification, safety_level: row.safety_level, quality_status: row.quality_status,
      completeness_rate: finite(row.completeness_rate), trade_date: dateText(row.trade_date) },
    dimension_calculations: Object.entries((row.components && row.components.dimensions) || {}).map(([key, value]) => ({ dimension: key, score: value, items: (row.components.dimension_items && row.components.dimension_items[key]) || [], calculations: (row.components.dimension_calculations && row.components.dimension_calculations[key]) || [] })),
    market_context: row.components && row.components.market_context || [],
    executability_calculation: { status: row.executability_status, floor_price: finite(row.estimated_floor_price), space: finite(row.estimated_space), post_conversion_value: finite(row.estimated_post_conversion_value), value_uplift: finite(row.estimated_value_uplift), blockers: row.blockers || [] },
    input_snapshot: row.input_snapshot || [], source_references: row.source_refs || [], core_motives: row.core_motives || [], blockers: row.blockers || [],
    model_version: row.model_version, calculated_at: row.calculated_at, input_hash: row.input_hash,
  };
}

/* saveSyncRawPayload 已迁入 server/repositories/convertibleBondRevisionMotiveServiceRepository.js */

/* saveSyncCursor 已迁入 server/repositories/convertibleBondRevisionMotiveServiceRepository.js */

async function syncRevisionMotiveInputs({ businessDate = null, limit = null } = {}) {
  const date = dateText(businessDate) || dateText(new Date());
  const configuredLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const { rows: bonds } = await repository.selectRevisionMotiveInputTargets({ date, limit: configuredLimit });
  const { rows: sourceRows } = await repository.select_ops_data_sources();
  const sourceMap = Object.fromEntries(sourceRows.map(row => [row.source_code, row.source_id]));
  let holderCount = 0, pledgeCount = 0, externalCalls = 0;
  let holderDeferredCount = 0, pledgeDeferredCount = 0;
  const failures = [];
  const pledgeByCompany = new Map();
  const controllerNamesByCompany = new Map();
  let holderStopError = null;
  let pledgeStopError = null;
  const errorText = error => String(error && error.message || error).slice(0, 300);
  const isEndpointStopError = error => Boolean(error && ['AUTH_ERROR', 'PERMISSION_DENIED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN'].includes(error.code));
  const isRunBudgetBoundaryError = error => Boolean(error && error.code === 'JOB_BUDGET_EXCEEDED');
  const holderRowsByCode = new Map();
  const holderErrorsByCode = new Map();
  const holderAttemptedCodes = new Set();
  const holderDeferredCodes = new Set();
  // 首次无水位数据与已有水位数据分开批量，避免一个新债券的全历史查询拖慢所有增量查询。
  const holderGroups = [
    bonds.filter(bond => !bond.holder_report_date),
    bonds.filter(bond => Boolean(bond.holder_report_date)),
  ];
  for (const holderGroup of holderGroups) {
    if (!holderGroup.length) continue;
    if (holderStopError) {
      holderGroup.forEach(bond => holderDeferredCodes.add(String(bond.ts_code).toUpperCase()));
      continue;
    }
    const batchResult = await fetchTop10CbHolderRowsBatched({
      bonds: holderGroup,
      businessDate: date,
      query: async params => tsRows(await tushareQuery('top10_cb_holders', params, TOP10_CB_HOLDERS_FIELDS, { allowEmpty: true })),
      rowLimit: TOP10_CB_HOLDERS_ROW_LIMIT,
      stopOnError: isEndpointStopError,
      isBudgetBoundary: isRunBudgetBoundaryError,
    });
    externalCalls += batchResult.calls;
    for (const [code, rows] of batchResult.rowsByCode) holderRowsByCode.set(code, rows);
    for (const [code, error] of batchResult.errorsByCode) {
      holderErrorsByCode.set(code, error);
      failures.push({ tsCode: code, dataset: 'top10_cb_holders', error: errorText(error) });
    }
    for (const code of batchResult.attemptedCodes) holderAttemptedCodes.add(code);
    for (const code of batchResult.deferredCodes) holderDeferredCodes.add(code);
    if (batchResult.stopError) holderStopError = batchResult.stopError;
  }
  for (const bond of bonds) {
    const code = String(bond.ts_code).toUpperCase();
    if (!holderAttemptedCodes.has(code) && !holderErrorsByCode.has(code)) holderDeferredCodes.add(code);
  }

  for (const bond of bonds) {
    const code = String(bond.ts_code).toUpperCase();
    const holderRows = holderRowsByCode.get(code) || [];
    const holderError = holderErrorsByCode.get(code) || null;
    const holderAttempted = holderAttemptedCodes.has(code);
    if (holderDeferredCodes.has(code)) holderDeferredCount += 1;

    let pledgeRows = [];
    let pledgeError = null;
    let pledgeAttempted = false;
    if (bond.company_id && bond.stock_code) {
      const cached = pledgeByCompany.get(bond.company_id);
      if (cached && cached.rows) {
        pledgeAttempted = true;
        pledgeRows = cached.rows;
      }
      else if (!cached && !pledgeStopError) {
        pledgeAttempted = true;
        try {
          const pledgeParams = { ts_code: bond.stock_code, end_date: date.replace(/-/g, '') };
          pledgeRows = tsRows(await tushareQuery('pledge_stat', pledgeParams, 'ts_code,end_date,pledge_count,unrest_pledge,rest_pledge,total_share,pledge_ratio', { allowEmpty: true }));
          externalCalls += 1;
          pledgeByCompany.set(bond.company_id, { rows: pledgeRows });
        } catch (error) {
          pledgeError = error;
          if (isRunBudgetBoundaryError(error)) {
            pledgeAttempted = false;
            pledgeStopError = error;
            pledgeByCompany.set(bond.company_id, { deferred: true });
          } else {
            if (isEndpointStopError(error)) pledgeStopError = error;
            pledgeByCompany.set(bond.company_id, { error });
            failures.push({ tsCode: bond.ts_code, dataset: 'pledge_stat', error: errorText(error) });
          }
        }
      }
      if (!pledgeRows.length && cached && cached.error) {
        pledgeAttempted = true;
        pledgeError = cached.error;
      }
    }
    if (bond.company_id && !pledgeAttempted) pledgeDeferredCount += 1;

    let relatedNames = [];
    if (holderRows.length && bond.company_id) {
      try {
        if (!controllerNamesByCompany.has(bond.company_id)) {
          const { rows: controllerRows } = await repository.select_core_company_controllers_1([bond.company_id, date]);
          controllerNamesByCompany.set(bond.company_id, controllerRows.map(row => row.controller_name).filter(Boolean));
        }
        relatedNames = controllerNamesByCompany.get(bond.company_id) || [];
      } catch (error) {
        failures.push({ tsCode: bond.ts_code, dataset: 'company_controllers', error: errorText(error) });
      }
    }

    const client = await pool.connect();
    try {
      await txControl.begin(client);
      if (holderRows.length) {
        await saveSyncRawPayload(client, sourceMap.tushare, 'top10_cb_holders', `${bond.ts_code}:${date}`, date, holderRows);
        holderCount += await saveConvertibleBondHolderPositions(client, bond.instrument_id, holderRows, sourceMap.tushare, relatedNames);
        const reportDate = holderRows.map(row => dateText(row.end_date)).filter(Boolean).sort().pop() || date;
        await saveSyncCursor(client, { instrumentId: bond.instrument_id, scopeKey: `convertible_bond:${bond.instrument_id}`, datasetCode: 'top10_cb_holders', successDate: reportDate });
      } else if (holderAttempted && !holderError) {
        // 正常空结果也推进业务日水位，避免每批反复请求同一对象；空结果不生成持有人事实。
        await saveSyncCursor(client, { instrumentId: bond.instrument_id, scopeKey: `convertible_bond:${bond.instrument_id}`, datasetCode: 'top10_cb_holders', successDate: date });
      } else if (holderAttempted && holderError) {
        await saveSyncCursor(client, { instrumentId: bond.instrument_id, scopeKey: `convertible_bond:${bond.instrument_id}`, datasetCode: 'top10_cb_holders', error: errorText(holderError) });
      }
      if (bond.company_id && pledgeRows.length) {
        await saveSyncRawPayload(client, sourceMap.tushare, 'pledge_stat', `${bond.company_id}:${bond.stock_code}:${date}`, date, pledgeRows);
        pledgeCount += await saveCompanyPledgeSnapshots(client, bond.company_id, pledgeRows, sourceMap.tushare);
        const pledgeDate = pledgeRows.map(row => dateText(row.end_date)).filter(Boolean).sort().pop() || date;
        await saveSyncCursor(client, { companyId: bond.company_id, scopeKey: `company:${bond.company_id}`, datasetCode: 'pledge_stat', successDate: pledgeDate });
      } else if (bond.company_id && pledgeAttempted && !pledgeError) {
        // 记录“已尝试且为空”，后续补偿仍可按 last_attempt_at 复查，但不会覆盖已有快照。
        await saveSyncCursor(client, { companyId: bond.company_id, scopeKey: `company:${bond.company_id}`, datasetCode: 'pledge_stat', successDate: date });
      } else if (bond.company_id && pledgeAttempted && pledgeError) {
        await saveSyncCursor(client, { companyId: bond.company_id, scopeKey: `company:${bond.company_id}`, datasetCode: 'pledge_stat', error: errorText(pledgeError) });
      }
      await txControl.commit(client);
    } catch (error) {
      try { await txControl.rollback(client); } catch (_) {}
      failures.push({ tsCode: bond.ts_code, dataset: 'persistence', error: errorText(error) });
    } finally { client.release(); }
  }
  const deferred = holderDeferredCount + pledgeDeferredCount;
  const limited = configuredLimit !== null;
  return { ok: failures.length === 0 && !limited, status: failures.length ? 'degraded' : (deferred || limited) ? 'partial' : 'succeeded', businessDate: date, bonds: bonds.length,
    holderCount, pledgeCount, externalCalls, deferred, holderDeferredCount, pledgeDeferredCount, failures,
    limit: configuredLimit, continuationRequired: Boolean(deferred || limited) };
}

module.exports = {
  MOTIVE_MODEL_VERSION, MOTIVE_MODEL_CALIBRATED, CYCLE_VERSION, TOP10_CB_HOLDERS_ROW_LIMIT, TOP10_CB_HOLDERS_FIELDS,
  dateText, dateMinusDays, fetchTop10CbHolderRowsBatched, holderAvailableDate, researchLevel, normalizeBondCode, normalizeHolderName, holderType, saveHolderRow, diffHolderSnapshots, buildRevisionCycles,
  scoreHistory, scorePressure, scoreConversion, scoreGovernance, scoreMarket, calculateExecutability, calculateMaturity, buildFinancial, buildMotiveScore,
  saveConvertibleBondHolderPositions, saveCompanyPledgeSnapshots, loadMotiveInput, calculateBondRevisionMotive,
  calculateConvertibleBondRevisionMotiveScores, getBondRevisionMotiveDetail, syncRevisionMotiveInputs,
};
