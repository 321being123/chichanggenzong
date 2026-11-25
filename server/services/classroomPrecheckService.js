'use strict';

const crypto = require('crypto');
const repo = require('../repositories/classroomRepository');
const stockProjection = require('../repositories/stockProjectionRepository');
const suspensionRepo = require('../repositories/convertibleBondSuspensionSyncRepository');
const marketDatasets = require('../dataAccess/marketDatasets');
const referenceDatasets = require('../dataAccess/referenceDatasets');
const { marketMultiple } = require('../domain/stockFacts');

const PRECHECK_RULE_VERSION = 'v2_sw2021_level1';
const SURVIVOR_BIAS_NOTICE = '按建场时 SW2021 一级行业归属筛选并要求覆盖完整 15 个历史年度，存在幸存者偏差，仅作教学样本使用。';
const BOND_CODE_PRIORITY = ['CBA00601', 'CN10Y_WEALTH', 'CHINABOND_7_10Y_WEALTH'];
const MIN_SSE_OPEN_DAYS_PER_YEAR = 200;
const MAX_CALENDAR_GAP_DAYS = 20;

function validateYearTradeCalendar(year, yearTradeDates, calSummaryRow = null) {
  if (!Array.isArray(yearTradeDates) || yearTradeDates.length < MIN_SSE_OPEN_DAYS_PER_YEAR) {
    return {
      ok: false,
      reason: `${year} 年交易日历不完整（仅 ${yearTradeDates ? yearTradeDates.length : 0} 个开放日，须不少于 ${MIN_SSE_OPEN_DAYS_PER_YEAR} 个）`,
    };
  }
  if (calSummaryRow) {
    if (Number(calSummaryRow.missing_head_weekdays || 0) > 0) {
      return {
        ok: false,
        reason: `${year} 年交易日历缺少年初开市日前的工作日记录（首日 ${yearTradeDates[0]}）`,
      };
    }
    if (Number(calSummaryRow.missing_tail_weekdays || 0) > 0) {
      return {
        ok: false,
        reason: `${year} 年交易日历缺少年末收市日后的工作日记录（末日 ${yearTradeDates[yearTradeDates.length - 1]}）`,
      };
    }
    if (Number(calSummaryRow.closed_rows || 0) > 0 && Number(calSummaryRow.total_rows || 0) < 365) {
      return {
        ok: false,
        reason: `${year} 年交易日历存在缺失自然日（仅 ${calSummaryRow.total_rows} 条）`,
      };
    }
  }
  const first = yearTradeDates[0];
  const last = yearTradeDates[yearTradeDates.length - 1];
  const firstMonthDay = first.slice(5);
  const lastMonthDay = last.slice(5);
  if (firstMonthDay > '01-15') {
    return { ok: false, reason: `${year} 年交易日历缺少年初开市日（首日 ${first}）` };
  }
  if (lastMonthDay < '12-20') {
    return { ok: false, reason: `${year} 年交易日历缺少年末收市日（末日 ${last}）` };
  }
  for (let i = 1; i < yearTradeDates.length; i++) {
    const prevMs = Date.parse(`${yearTradeDates[i - 1]}T00:00:00Z`);
    const curMs = Date.parse(`${yearTradeDates[i]}T00:00:00Z`);
    const gapDays = Math.round((curMs - prevMs) / 86400000);
    if (gapDays > MAX_CALENDAR_GAP_DAYS) {
      return {
        ok: false,
        reason: `${year} 年交易日历存在异常断档（${yearTradeDates[i - 1]} 至 ${yearTradeDates[i]} 间隔 ${gapDays} 天）`,
      };
    }
  }
  return { ok: true };
}

// 按 (startYear, totalRounds, taxonomy, ruleVersion, dataVersion) 缓存已核验的行业与个股覆盖状态
const windowPoolCache = new Map();

function getShanghaiCurrentYear(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).formatToParts(now);
  const yearPart = parts.find((p) => p.type === 'year');
  return Number(yearPart ? yearPart.value : now.getUTCFullYear());
}

function validateWindowBounds(startYear, totalRounds = 15, now = new Date()) {
  if (!Number.isInteger(startYear) || startYear < 1990) {
    return { valid: false, reason: '起始年份须为合法整数（不早于 1990 年）' };
  }
  const endYear = startYear + totalRounds - 1;
  const maxCompletedYear = getShanghaiCurrentYear(now) - 1;
  if (endYear > maxCompletedYear) {
    return {
      valid: false,
      reason: `历史窗口 ${startYear}–${endYear} 包含尚未结束的上海业务自然年（当前仅支持截至 ${maxCompletedYear} 年）`,
    };
  }
  return { valid: true, startYear, endYear };
}

function createRng(seed = null) {
  if (seed == null || String(seed).trim() === '') {
    return () => crypto.randomInt(0, 0x100000000) / 0x100000000;
  }
  const hash = crypto.createHash('sha256').update(String(seed)).digest();
  let state = hash.readUInt32LE(0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleUniformWithoutReplacement(items, count, rng = createRng()) {
  const copy = items.slice();
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

/**
 * 将 SW2021 行业节点沿 parent_id 归并到一级行业节点。
 */
function resolveSw2021Level1Map(nodes) {
  const byId = new Map();
  for (const n of (nodes || [])) {
    byId.set(String(n.industry_node_id), n);
  }
  const level1ById = new Map();
  for (const [nodeId] of byId.entries()) {
    let cur = byId.get(nodeId);
    const visited = new Set();
    let valid = true;
    while (cur && cur.parent_id != null && Number(cur.level) !== 1) {
      const curId = String(cur.industry_node_id);
      if (visited.has(curId)) {
        valid = false;
        break;
      }
      visited.add(curId);
      const parent = byId.get(String(cur.parent_id));
      if (!parent) {
        valid = false;
        break;
      }
      cur = parent;
    }
    if (valid && cur) {
      level1ById.set(nodeId, {
        level1NodeId: String(cur.industry_node_id),
        level1Code: cur.industry_code || '',
        level1Name: cur.industry_name || '',
      });
    }
  }
  return level1ById;
}

/**
 * 按 SW2021 一级行业节点 ID 分组、证券 ID 去重；缺失或冲突记录排除并留存原因。
 */
function groupCandidatesByLevel1Industry(candidateRows, level1Map) {
  const byInstrument = new Map();
  for (const row of (candidateRows || [])) {
    const instId = String(row.instrument_id);
    if (!byInstrument.has(instId)) {
      byInstrument.set(instId, {
        instrumentId: instId,
        canonicalCode: row.canonical_code,
        stockName: row.name,
        listDate: row.list_date,
        delistDate: row.delist_date,
        rawNodeIds: new Set(),
        level1Nodes: new Map(),
      });
    }
    const entry = byInstrument.get(instId);
    if (row.industry_node_id != null) {
      const nid = String(row.industry_node_id);
      entry.rawNodeIds.add(nid);
      const l1 = level1Map.get(nid);
      if (l1) {
        entry.level1Nodes.set(l1.level1NodeId, l1);
      }
    }
  }

  const industryMap = new Map();
  const excluded = [];

  for (const entry of byInstrument.values()) {
    if (entry.level1Nodes.size === 0) {
      excluded.push({
        instrumentId: entry.instrumentId,
        canonicalCode: entry.canonicalCode,
        stockName: entry.stockName,
        reason: entry.rawNodeIds.size > 0
          ? 'SW2021 行业节点父链断链或存在环路，无法归并到一级行业'
          : '缺少 SW2021 当前行业归属',
      });
      continue;
    }
    if (entry.level1Nodes.size > 1) {
      const names = Array.from(entry.level1Nodes.values()).map((x) => x.level1Name).join(' / ');
      excluded.push({
        instrumentId: entry.instrumentId,
        canonicalCode: entry.canonicalCode,
        stockName: entry.stockName,
        reason: `存在多个冲突的 SW2021 一级行业归属（${names}），已排除`,
      });
      continue;
    }
    const [l1] = Array.from(entry.level1Nodes.values());
    if (!industryMap.has(l1.level1NodeId)) {
      industryMap.set(l1.level1NodeId, {
        industryNodeId: l1.level1NodeId,
        industryCode: l1.level1Code,
        industryName: l1.level1Name,
        candidates: [],
      });
    }
    industryMap.get(l1.level1NodeId).candidates.push({
      instrumentId: entry.instrumentId,
      canonicalCode: entry.canonicalCode,
      stockName: entry.stockName,
      listDate: entry.listDate,
      delistDate: entry.delistDate,
      industryNodeId: l1.level1NodeId,
      industryName: l1.level1Name,
    });
  }

  return {
    industries: Array.from(industryMap.values()).sort((a, b) => a.industryName.localeCompare(b.industryName, 'zh-CN')),
    excluded,
  };
}

const PRECHECK_RULE_VERSION = 'v2_sw2021_level1';
const SURVIVOR_BIAS_NOTICE = '按建场时 SW2021 一级行业归属筛选并要求覆盖完整 15 个历史年度，存在幸存者偏差，仅作教学样本使用。';
const BOND_CODE_PRIORITY = ['CBA00601', 'CN10Y_WEALTH', 'CHINABOND_7_10Y_WEALTH'];
const MIN_SSE_OPEN_DAYS_PER_YEAR = 200;
const MAX_CALENDAR_GAP_DAYS = 20;

function validateYearTradeCalendar(year, yearTradeDates, calSummaryRow = null) {
  if (!Array.isArray(yearTradeDates) || yearTradeDates.length < MIN_SSE_OPEN_DAYS_PER_YEAR) {
    return {
      ok: false,
      reason: `${year} 年交易日历不完整（仅 ${yearTradeDates ? yearTradeDates.length : 0} 个开放日，须不少于 ${MIN_SSE_OPEN_DAYS_PER_YEAR} 个）`,
    };
  }
  if (calSummaryRow) {
    if (Number(calSummaryRow.missing_head_weekdays || 0) > 0) {
      return {
        ok: false,
        reason: `${year} 年交易日历缺少年初开市日前的工作日记录（首日 ${yearTradeDates[0]}）`,
      };
    }
    if (Number(calSummaryRow.missing_tail_weekdays || 0) > 0) {
      return {
        ok: false,
        reason: `${year} 年交易日历缺少年末收市日后的工作日记录（末日 ${yearTradeDates[yearTradeDates.length - 1]}）`,
      };
    }
    if (Number(calSummaryRow.closed_rows || 0) > 0 && Number(calSummaryRow.total_rows || 0) < 365) {
      return {
        ok: false,
        reason: `${year} 年交易日历存在缺失自然日（仅 ${calSummaryRow.total_rows} 条）`,
      };
    }
  }
  const first = yearTradeDates[0];
  const last = yearTradeDates[yearTradeDates.length - 1];
  const firstMonthDay = first.slice(5);
  const lastMonthDay = last.slice(5);
  if (firstMonthDay > '01-15') {
    return { ok: false, reason: `${year} 年交易日历缺少年初开市日（首日 ${first}）` };
  }
  if (lastMonthDay < '12-20') {
    return { ok: false, reason: `${year} 年交易日历缺少年末收市日（末日 ${last}）` };
  }
  for (let i = 1; i < yearTradeDates.length; i++) {
    const prevMs = Date.parse(`${yearTradeDates[i - 1]}T00:00:00Z`);
    const curMs = Date.parse(`${yearTradeDates[i]}T00:00:00Z`);
    const gapDays = Math.round((curMs - prevMs) / 86400000);
    if (gapDays > MAX_CALENDAR_GAP_DAYS) {
      return {
        ok: false,
        reason: `${year} 年交易日历存在异常断档（${yearTradeDates[i - 1]} 至 ${yearTradeDates[i]} 间隔 ${gapDays} 天）`,
      };
    }
  }
  return { ok: true };
}

// 按 (startYear, totalRounds, taxonomy, ruleVersion, dataVersion) 缓存已核验的行业与个股覆盖状态
const windowPoolCache = new Map();

function getShanghaiCurrentYear(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).formatToParts(now);
  const yearPart = parts.find((p) => p.type === 'year');
  return Number(yearPart ? yearPart.value : now.getUTCFullYear());
}

function validateWindowBounds(startYear, totalRounds = 15, now = new Date()) {
  if (!Number.isInteger(startYear) || startYear < 1990) {
    return { valid: false, reason: '起始年份须为合法整数（不早于 1990 年）' };
  }
  const endYear = startYear + totalRounds - 1;
  const maxCompletedYear = getShanghaiCurrentYear(now) - 1;
  if (endYear > maxCompletedYear) {
    return {
      valid: false,
      reason: `历史窗口 ${startYear}–${endYear} 包含尚未结束的上海业务自然年（当前仅支持截至 ${maxCompletedYear} 年）`,
    };
  }
  return { valid: true, startYear, endYear };
}

function createRng(seed = null) {
  if (seed == null || String(seed).trim() === '') {
    return () => crypto.randomInt(0, 0x100000000) / 0x100000000;
  }
  const hash = crypto.createHash('sha256').update(String(seed)).digest();
  let state = hash.readUInt32LE(0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleUniformWithoutReplacement(items, count, rng = createRng()) {
  const copy = items.slice();
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

/**
 * 将 SW2021 行业节点沿 parent_id 归并到一级行业节点。
 */
function resolveSw2021Level1Map(nodes) {
  const byId = new Map();
  for (const n of (nodes || [])) {
    byId.set(String(n.industry_node_id), n);
  }
  const level1ById = new Map();
  for (const [nodeId] of byId.entries()) {
    let cur = byId.get(nodeId);
    const visited = new Set();
    let valid = true;
    while (cur && cur.parent_id != null && Number(cur.level) !== 1) {
      const curId = String(cur.industry_node_id);
      if (visited.has(curId)) {
        valid = false;
        break;
      }
      visited.add(curId);
      const parent = byId.get(String(cur.parent_id));
      if (!parent) {
        valid = false;
        break;
      }
      cur = parent;
    }
    if (valid && cur) {
      level1ById.set(nodeId, {
        level1NodeId: String(cur.industry_node_id),
        level1Code: cur.industry_code || '',
        level1Name: cur.industry_name || '',
      });
    }
  }
  return level1ById;
}

/**
 * 按 SW2021 一级行业节点 ID 分组、证券 ID 去重；缺失或冲突记录排除并留存原因。
 */
function groupCandidatesByLevel1Industry(candidateRows, level1Map) {
  const byInstrument = new Map();
  for (const row of (candidateRows || [])) {
    const instId = String(row.instrument_id);
    if (!byInstrument.has(instId)) {
      byInstrument.set(instId, {
        instrumentId: instId,
        canonicalCode: row.canonical_code,
        stockName: row.name,
        listDate: row.list_date,
        delistDate: row.delist_date,
        rawNodeIds: new Set(),
        level1Nodes: new Map(),
      });
    }
    const entry = byInstrument.get(instId);
    if (row.industry_node_id != null) {
      const nid = String(row.industry_node_id);
      entry.rawNodeIds.add(nid);
      const l1 = level1Map.get(nid);
      if (l1) {
        entry.level1Nodes.set(l1.level1NodeId, l1);
      }
    }
  }

  const industryMap = new Map();
  const excluded = [];

  for (const entry of byInstrument.values()) {
    if (entry.level1Nodes.size === 0) {
      excluded.push({
        instrumentId: entry.instrumentId,
        canonicalCode: entry.canonicalCode,
        stockName: entry.stockName,
        reason: entry.rawNodeIds.size > 0
          ? 'SW2021 行业节点父链断链或存在环路，无法归并到一级行业'
          : '缺少 SW2021 当前行业归属',
      });
      continue;
    }
    if (entry.level1Nodes.size > 1) {
      const names = Array.from(entry.level1Nodes.values()).map((x) => x.level1Name).join(' / ');
      excluded.push({
        instrumentId: entry.instrumentId,
        canonicalCode: entry.canonicalCode,
        stockName: entry.stockName,
        reason: `存在多个冲突的 SW2021 一级行业归属（${names}），已排除`,
      });
      continue;
    }
    const [l1] = Array.from(entry.level1Nodes.values());
    if (!industryMap.has(l1.level1NodeId)) {
      industryMap.set(l1.level1NodeId, {
        industryNodeId: l1.level1NodeId,
        industryCode: l1.level1Code,
        industryName: l1.level1Name,
        candidates: [],
      });
    }
    industryMap.get(l1.level1NodeId).candidates.push({
      instrumentId: entry.instrumentId,
      canonicalCode: entry.canonicalCode,
      stockName: entry.stockName,
      listDate: entry.listDate,
      delistDate: entry.delistDate,
      industryNodeId: l1.level1NodeId,
      industryName: l1.level1Name,
    });
  }

  return {
    industries: Array.from(industryMap.values()).sort((a, b) => a.industryName.localeCompare(b.industryName, 'zh-CN')),
    excluded,
  };
}

/**
 * 纯函数：在单个自然年的交易日列表内，按停牌规则解析取价日与估值日。
 * - 年初目标日：该年首个交易日；若当日有连续停牌证据，向后最多顺延 5 个市场交易日。
 * - 年末目标日：该年最后一个交易日；若当日有连续停牌证据，向前最多回退 5 个市场交易日。
 * - 期初估值与权重仍按原年初目标日；若原年初目标日证实停牌，可在原目标日前 5 个市场交易日内取最近有效估值快照。
 */
function resolveYearStockCoverage({
  year,
  yearTradeDates,
  prevYearTailTradeDates = [],
  barByDate,
  valByDate,
  suspendDates,
}) {
  if (!yearTradeDates || yearTradeDates.length < 2) {
    return { status: 'red', reason: `${year} 年交易日历缺失` };
  }
  const startTarget = yearTradeDates[0];
  const endTarget = yearTradeDates[yearTradeDates.length - 1];

  // 1. 解析年初取价日
  let startAdopted = null;
  let startOffset = 0;
  let startStatus = 'green';
  let startNote = '';

  const startBar = barByDate.get(startTarget);
  if (startBar && startBar.close != null && startBar.adj_factor != null) {
    startAdopted = startTarget;
  } else if (suspendDates.has(startTarget)) {
    for (let offset = 1; offset <= 5 && offset < yearTradeDates.length; offset++) {
      const cand = yearTradeDates[offset];
      const b = barByDate.get(cand);
      if (b && b.close != null && b.adj_factor != null) {
        startAdopted = cand;
        startOffset = offset;
        startStatus = 'yellow';
        startNote = `年初目标日 ${startTarget} 停牌，顺延 ${offset} 个交易日至 ${cand}`;
        break;
      }
      if (!suspendDates.has(cand)) break; // 非连续停牌，禁止继续顺延
    }
    if (!startAdopted) {
      return { status: 'red', reason: `${year} 年初停牌顺延超过 5 个交易日或缺少复权因子` };
    }
  } else {
    return { status: 'red', reason: `${year} 年初目标日 ${startTarget} 缺行情或无停牌证据` };
  }

  // 2. 解析年末取价日
  let endAdopted = null;
  let endOffset = 0;
  let endStatus = 'green';
  let endNote = '';

  const endBar = barByDate.get(endTarget);
  if (endBar && endBar.close != null && endBar.adj_factor != null) {
    endAdopted = endTarget;
  } else if (suspendDates.has(endTarget)) {
    for (let offset = 1; offset <= 5 && offset < yearTradeDates.length; offset++) {
      const cand = yearTradeDates[yearTradeDates.length - 1 - offset];
      const b = barByDate.get(cand);
      if (b && b.close != null && b.adj_factor != null) {
        endAdopted = cand;
        endOffset = offset;
        endStatus = 'yellow';
        endNote = `年末目标日 ${endTarget} 停牌，前移 ${offset} 个交易日至 ${cand}`;
        break;
      }
      if (!suspendDates.has(cand)) break;
    }
    if (!endAdopted) {
      return { status: 'red', reason: `${year} 年末停牌前移超过 5 个交易日或缺少复权因子` };
    }
  } else {
    return { status: 'red', reason: `${year} 年末目标日 ${endTarget} 缺行情或无停牌证据` };
  }

  if (startAdopted >= endAdopted) {
    return { status: 'red', reason: `${year} 年首尾取价日顺序异常 (${startAdopted} >= ${endAdopted})` };
  }

  // 3. 解析期初估值（仍按原年初目标日；若证实停牌，可在原目标日前 5 个市场交易日内取快照）
  let valAdopted = null;
  let valLagDays = 0;
  let valStatus = 'green';
  let valNote = '';

  const exactVal = valByDate.get(startTarget);
  if (exactVal && exactVal.total_market_cap != null && Number(exactVal.total_market_cap) > 0) {
    valAdopted = startTarget;
  } else if (suspendDates.has(startTarget)) {
    for (let lag = 1; lag <= 5 && lag <= prevYearTailTradeDates.length; lag++) {
      const cand = prevYearTailTradeDates[prevYearTailTradeDates.length - lag];
      const v = valByDate.get(cand);
      if (v && v.total_market_cap != null && Number(v.total_market_cap) > 0) {
        valAdopted = cand;
        valLagDays = lag;
        valStatus = 'yellow';
        valNote = `年初停牌采用前 ${lag} 个交易日 ${cand} 估值快照`;
        break;
      }
    }
    if (!valAdopted) {
      return { status: 'red', reason: `${year} 年初停牌且前 5 个交易日无可靠估值/市值快照` };
    }
  } else {
    return { status: 'red', reason: `${year} 年初目标日 ${startTarget} 缺少估值或市值快照` };
  }

  const sBar = barByDate.get(startAdopted);
  const eBar = barByDate.get(endAdopted);
  const valRow = valByDate.get(valAdopted);
  const adjStartClose = Number(sBar.close) * Number(sBar.adj_factor);
  const adjEndClose = Number(eBar.close) * Number(eBar.adj_factor);
  if (!(adjStartClose > 0) || !(adjEndClose > 0)) {
    return { status: 'red', reason: `${year} 年复权收盘价非正` };
  }

  const returnRate = Number(((adjEndClose / adjStartClose) - 1).toFixed(8));
  const status = (startStatus === 'yellow' || endStatus === 'yellow' || valStatus === 'yellow')
    ? 'yellow'
    : 'green';

  return {
    status,
    year,
    startTarget,
    startAdopted,
    startOffset,
    endTarget,
    endAdopted,
    endOffset,
    valAdopted,
    valLagDays,
    notes: [startNote, endNote, valNote].filter(Boolean),
    returnRate,
    peTtm: valRow.pe_ttm == null ? null : Number(valRow.pe_ttm),
    pb: valRow.pb == null ? null : Number(valRow.pb),
    marketCap: Number(valRow.total_market_cap),
  };
}

/**
 * 真实场次建场只读预检：检查 4×3 股票池、15 年交易日历、行情复权、停牌证据、估值、国债财富净值与转债样本。
 */
async function runRealPrecheck({ industries, startYear = 2011, totalRounds = 15 }) {
  const startYearNum = Number(startYear);
  const windowCheck = validateWindowBounds(startYearNum, totalRounds);
  const endYear = startYearNum + totalRounds - 1;
  const startDate = `${startYearNum - 1}-12-01`; // 留前一年末 5 个交易日给第 1 年期初停牌估值回溯
  const endDate = `${endYear}-12-31`;

  const industryList = Array.isArray(industries) ? industries : [];
  const universeErrors = [];
  if (!windowCheck.valid) {
    universeErrors.push(windowCheck.reason);
  }
  if (industryList.length !== 4) {
    universeErrors.push(`须选择恰好 4 个行业（当前 ${industryList.length} 个）`);
  }
  const seenIndustries = new Set();
  const seenCodes = new Set();
  const allCodes = [];
  industryList.forEach((ind, idx) => {
    const indName = String(ind && ind.industryName ? ind.industryName : '').trim();
    if (!indName) {
      universeErrors.push(`第 ${idx + 1} 个行业名称不能为空`);
    } else if (seenIndustries.has(indName)) {
      universeErrors.push(`行业名称「${indName}」重复，须为 4 个不同行业`);
    } else {
      seenIndustries.add(indName);
    }
    const codes = Array.isArray(ind && ind.codes) ? ind.codes.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean) : [];
    if (codes.length !== 3) {
      universeErrors.push(`行业「${indName || (idx + 1)}」须配置恰好 3 只股票（当前 ${codes.length} 只）`);
    }
    for (const code of codes) {
      if (seenCodes.has(code)) {
        universeErrors.push(`股票代码 ${code} 重复，12 只股票须跨行业互不重复`);
      } else {
        seenCodes.add(code);
      }
      allCodes.push(code);
    }
  });

  const {
    tradeDates,
    calSummaryRows,
    instruments,
    bondWealthSeries,
    sovYield,
    cbStats,
    cbBucketRows,
    dataVersion,
    instByCode,
    bars,
    valuations,
    suspensions,
    swNodes,
    swMemberships,
  } = await repo.withReadOnlySnapshot(async (client) => {
    const snapTradeDates = await repo.fetchCnOpenTradeDates(startDate, endDate, client);
    const snapCalSummaryRows = await repo.fetchCnCalendarSummaryByYear(startYearNum, endYear, client);
    const snapInstruments = await repo.fetchInstrumentsByCodes(allCodes, client);
    const snapBondWealthSeries = await repo.fetchBondWealthIndexSeries(`${startYearNum}-01-01`, endDate, client);
    const snapSovYield = await repo.fetchSovereignYieldCount(`${startYearNum}-01-01`, endDate, client);
    const snapCbStats = await repo.fetchCbCalibrationSampleStats(client);
    const snapCbBucketRows = await repo.fetchCbCalibrationBuckets(client);
    const snapDataVersion = await repo.fetchFactsDataVersion({ startDate, endDate }, client);

    const snapInstByCode = new Map();
    for (const row of snapInstruments) {
      // 优先保留带 SW2021 行业归属的记录
      const prev = snapInstByCode.get(row.canonical_code);
      if (!prev || (row.taxonomy_code === 'SW2021' && prev.taxonomy_code !== 'SW2021')) {
        snapInstByCode.set(row.canonical_code, row);
      }
    }
    const instIds = [...new Set(Array.from(snapInstByCode.values()).map((i) => i.instrument_id))];

    const snapBars = await repo.fetchDailyBarsWithAdj(instIds, startDate, endDate, client);
    const snapValuations = await repo.fetchDailyValuations(instIds, startDate, endDate, client);
    const snapSuspensions = await repo.fetchSuspensions(instIds, startDate, endDate, client);
    const snapSwNodes = await repo.fetchSw2021IndustryTree(client);
    const snapSwMemberships = await repo.fetchSw2021MembershipsByInstrumentIds(instIds, client);

    return {
      tradeDates: snapTradeDates,
      calSummaryRows: snapCalSummaryRows,
      instruments: snapInstruments,
      bondWealthSeries: snapBondWealthSeries,
      sovYield: snapSovYield,
      cbStats: snapCbStats,
      cbBucketRows: snapCbBucketRows,
      dataVersion: snapDataVersion,
      instByCode: snapInstByCode,
      bars: snapBars,
      valuations: snapValuations,
      suspensions: snapSuspensions,
      swNodes: snapSwNodes,
      swMemberships: snapSwMemberships,
    };
  });
  const calSummaryMap = new Map((calSummaryRows || []).map((r) => [Number(r.year), r]));

  const tradeDatesByYear = new Map();
  for (const d of tradeDates) {
    const yr = Number(d.slice(0, 4));
    if (!tradeDatesByYear.has(yr)) tradeDatesByYear.set(yr, []);
    tradeDatesByYear.get(yr).push(d);
  }

  const level1Map = resolveSw2021Level1Map(swNodes);
  const instLevel1Map = new Map();
  for (const m of swMemberships) {
    const key = String(m.instrument_id);
    if (!instLevel1Map.has(key)) instLevel1Map.set(key, new Map());
    const l1 = level1Map.get(String(m.industry_node_id));
    if (l1) instLevel1Map.get(key).set(l1.level1NodeId, l1);
  }

  const barMap = new Map();
  for (const b of bars) {
    const key = String(b.instrument_id);
    if (!barMap.has(key)) barMap.set(key, new Map());
    barMap.get(key).set(b.trade_date, b);
  }
  const valMap = new Map();
  for (const v of valuations) {
    const key = String(v.instrument_id);
    if (!valMap.has(key)) valMap.set(key, new Map());
    valMap.get(key).set(v.trade_date, v);
  }
  const suspMap = new Map();
  for (const s of suspensions) {
    if (s.suspend_type && s.suspend_type !== 'S') continue;
    const key = String(s.instrument_id);
    if (!suspMap.has(key)) suspMap.set(key, new Set());
    suspMap.get(key).add(s.trade_date);
  }

  const stockReports = [];
  let redCount = 0;
  let yellowCount = 0;
  const usedLevel1Ids = new Set();

  for (let groupIdx = 0; groupIdx < industryList.length; groupIdx++) {
    const ind = industryList[groupIdx];
    const groupName = String(ind && ind.industryName ? ind.industryName : '').trim();
    const expectedLevel1Id = ind && ind.industryNodeId ? String(ind.industryNodeId) : null;
    const groupLevel1Ids = new Set();

    for (const rawCode of (ind.codes || [])) {
      const code = String(rawCode).trim().toUpperCase();
      const inst = instByCode.get(code);
      if (!inst) {
        redCount++;
        stockReports.push({
          industryName: groupName,
          canonicalCode: code,
          stockName: null,
          status: 'red',
          reason: '证券主档中未找到该 A 股代码',
          years: [],
        });
        continue;
      }

      const l1Nodes = instLevel1Map.get(String(inst.instrument_id));
      if (!l1Nodes || l1Nodes.size === 0) {
        redCount++;
        stockReports.push({
          industryName: groupName,
          canonicalCode: code,
          stockName: inst.name,
          instrumentId: inst.instrument_id,
          swIndustryName: inst.sw_industry_name || null,
          status: 'red',
          reason: `${code} 在 SW2021 行业分类体系中缺少有效一级行业归属`,
          years: [],
        });
        continue;
      }
      if (l1Nodes.size > 1) {
        redCount++;
        stockReports.push({
          industryName: groupName,
          canonicalCode: code,
          stockName: inst.name,
          instrumentId: inst.instrument_id,
          swIndustryName: inst.sw_industry_name || null,
          status: 'red',
          reason: `${code} 存在多个冲突的 SW2021 一级行业归属`,
          years: [],
        });
        continue;
      }

      const [l1] = Array.from(l1Nodes.values());
      groupLevel1Ids.add(l1.level1NodeId);

      const idKey = String(inst.instrument_id);
      const bMap = barMap.get(idKey) || new Map();
      const vMap = valMap.get(idKey) || new Map();
      const sSet = suspMap.get(idKey) || new Set();

      const years = [];
      let stockStatus = 'green';
      for (let yr = startYearNum; yr <= endYear; yr++) {
        const yDates = tradeDatesByYear.get(yr) || [];
        const prevDates = tradeDatesByYear.get(yr - 1) || [];
        const cov = resolveYearStockCoverage({
          year: yr,
          yearTradeDates: yDates,
          prevYearTailTradeDates: prevDates.slice(-5),
          barByDate: bMap,
          valByDate: vMap,
          suspendDates: sSet,
        });
        years.push(cov);
        if (cov.status === 'red') {
          stockStatus = 'red';
        } else if (cov.status === 'yellow' && stockStatus !== 'red') {
          stockStatus = 'yellow';
        }
      }
      if (stockStatus === 'red') redCount++;
      if (stockStatus === 'yellow') yellowCount++;

      stockReports.push({
        industryName: groupName,
        canonicalCode: code,
        stockName: inst.name,
        instrumentId: inst.instrument_id,
        industryNodeId: l1.level1NodeId,
        swIndustryName: l1.level1Name,
        status: stockStatus,
        years,
      });
    }

    if (expectedLevel1Id && Array.from(groupLevel1Ids).some((id) => id !== expectedLevel1Id)) {
      const detail = stockReports
        .slice(-(ind.codes || []).length)
        .map((s) => `${s.stockName || s.canonicalCode}(${s.swIndustryName || '未分类'})`)
        .join('、');
      universeErrors.push(`第 ${groupIdx + 1} 组「${groupName || expectedLevel1Id}」存在不属于该一级行业的股票：${detail}`);
    }
    if (groupLevel1Ids.size > 1) {
      const detail = stockReports
        .slice(-(ind.codes || []).length)
        .map((s) => `${s.stockName || s.canonicalCode}(${s.swIndustryName || '未分类'})`)
        .join('、');
      universeErrors.push(`第 ${groupIdx + 1} 组「${groupName || (groupIdx + 1)}」内股票所属 SW2021 一级行业不一致，每组须同属单一一级行业：${detail}`);
    } else if (groupLevel1Ids.size === 1) {
      const [onlyId] = Array.from(groupLevel1Ids);
      if (usedLevel1Ids.has(onlyId)) {
        universeErrors.push('4 个行业分组须对应 4 个不同的 SW2021 一级行业');
      } else {
        usedLevel1Ids.add(onlyId);
      }
    }
  }

  for (let yr = startYearNum; yr <= endYear; yr++) {
    const calCheck = validateYearTradeCalendar(yr, tradeDatesByYear.get(yr) || [], calSummaryMap.get(yr) || null);
    if (!calCheck.ok) {
      universeErrors.push(calCheck.reason);
    }
  }

  // 按优先级逐年核验十年期国债财富净值首尾覆盖并计算年度总回报
  const bondMapByCode = new Map();
  for (const row of bondWealthSeries) {
    if (!bondMapByCode.has(row.index_code)) bondMapByCode.set(row.index_code, new Map());
    bondMapByCode.get(row.index_code).set(row.trade_date, Number(row.close));
  }

  let selectedBondCode = null;
  let bondReturnsByYear = {};
  let bondYearDetails = [];
  for (const code of BOND_CODE_PRIORITY) {
    const seriesMap = bondMapByCode.get(code);
    if (!seriesMap) continue;
    const returns = {};
    const details = [];
    let allYearsOk = true;
    for (let yr = startYear; yr <= endYear; yr++) {
      const yDates = tradeDatesByYear.get(yr) || [];
      if (yDates.length < 2) {
        allYearsOk = false;
        details.push({ year: yr, status: 'red', reason: `${yr} 年交易日历缺失` });
        continue;
      }
      const startTarget = yDates[0];
      const endTarget = yDates[yDates.length - 1];
      const startClose = seriesMap.get(startTarget);
      const endClose = seriesMap.get(endTarget);
      if (!(startClose > 0) || !(endClose > 0)) {
        allYearsOk = false;
        details.push({ year: yr, status: 'red', startTarget, endTarget, reason: `${yr} 年国债财富净值首尾缺失` });
      } else {
        const ret = Number(((endClose / startClose) - 1).toFixed(8));
        returns[yr] = ret;
        details.push({ year: yr, status: 'green', startTarget, endTarget, startClose, endClose, returnRate: ret });
      }
    }
    if (!selectedBondCode || allYearsOk) {
      selectedBondCode = code;
      bondReturnsByYear = returns;
      bondYearDetails = details;
    }
    if (allYearsOk) break;
  }

  const bondWealthCovered = Boolean(selectedBondCode)
    && bondYearDetails.length === totalRounds
    && bondYearDetails.every((d) => d.status === 'green');

  // 真实可转债样本按「剩余期限 × 转股价值位置」9 格分桶校准
  const REQUIRED_TENORS = ['short', 'mid', 'long'];
  const REQUIRED_MONEYNESS = ['otm', 'atm', 'itm'];
  const bucketMap = new Map();
  for (const row of (cbBucketRows || [])) {
    bucketMap.set(`${row.tenor_bucket}|${row.moneyness_bucket}`, row);
  }

  const buckets = {};
  const missingBuckets = [];
  for (const t of REQUIRED_TENORS) {
    for (const m of REQUIRED_MONEYNESS) {
      const key = `${t}|${m}`;
      const row = bucketMap.get(key);
      const premCnt = row ? Number(row.premium_cnt || 0) : 0;
      const bondPremCnt = row ? Number(row.bond_premium_cnt || 0) : 0;
      if (!row || premCnt < 1 || bondPremCnt < 1 || row.median_premium_pct == null || row.median_bond_premium_pct == null) {
        missingBuckets.push(`${key}(转股溢价样本=${premCnt},纯债溢价样本=${bondPremCnt})`);
      } else {
        const medPrem = Number(row.median_premium_pct);
        const medBondPrem = Number(row.median_bond_premium_pct);
        buckets[key] = {
          sampleCount: Number(row.cnt),
          premiumSampleCount: premCnt,
          bondPremiumSampleCount: bondPremCnt,
          cbCount: Number(row.cb_count || 0),
          medianPremiumPct: Number(medPrem.toFixed(2)),
          medianBondPremiumPct: Number(medBondPrem.toFixed(2)),
          volatility: Number(Math.min(0.45, Math.max(0.18, 0.22 + (medPrem / 100) * 0.25)).toFixed(4)),
          discountRate: Number(Math.min(0.055, Math.max(0.022, 0.036 - (medBondPrem / 100) * 0.02)).toFixed(4)),
        };
      }
    }
  }

  const cbCalibrated = missingBuckets.length === 0;
  const cbCalibration = {
    modelVersion: cbCalibrated ? 'cb_model_v2_bucket_calibrated' : 'cb_model_uncalibrated',
    calibratedFromSample: cbCalibrated,
    sampleCount: Number(cbStats.cnt || 0),
    cbCount: Number(cbStats.cb_count || 0),
    coveredBuckets: 9 - missingBuckets.length,
    totalBuckets: 9,
    missingBuckets,
    couponRate: 0.015,
    discountRate: 0.032,
    volatility: 0.28,
    buckets,
  };

  const resolvedInstrumentIds = new Set(instruments.map((i) => String(i.instrument_id)));
  if (instruments.length > 0 && resolvedInstrumentIds.size !== instruments.length) {
    universeErrors.push('解析到重复的证券身份，请检查 12 只股票代码是否互不重复');
  }

  const blockers = [...universeErrors];
  if (redCount > 0) blockers.push(`有 ${redCount} 只股票未通过 15 年数据覆盖预检`);
  if (!bondWealthCovered) {
    blockers.push('十年期国债财富净值序列（如中债 7-10 年期国债财富指数）未覆盖 15 个完整年度，真实场次禁止启用（可改用演示场次）');
  }
  if (!cbCalibrated) {
    blockers.push(`真实可转债样本未覆盖全部剩余期限×转股价值分桶（缺 ${missingBuckets.join(', ')}），无法冻结校准参数，真实场次禁止启用`);
  }

  return {
    pass: blockers.length === 0,
    startYear: startYearNum,
    endYear,
    totalRounds,
    dataVersion,
    taxonomy: 'SW2021',
    ruleVersion: PRECHECK_RULE_VERSION,
    survivorBiasNotice: SURVIVOR_BIAS_NOTICE,
    redCount,
    yellowCount,
    blockers,
    bondIndexCode: selectedBondCode,
    bondReturnsByYear,
    bondYearDetails,
    bondCheck: {
      wealthCovered: bondWealthCovered,
      indexCode: selectedBondCode,
      yearDetails: bondYearDetails,
      sovereignYieldBackground: sovYield,
    },
    cbCalibrationCheck: cbStats,
    cbCalibration,
    stockReports,
  };
}

function formatIsoTradeDate(raw) {
  const s = String(raw || '').replace(/-/g, '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * 真实场次建场预检（支持按需自动补齐缺失的 A 股历史日线、复权因子与估值快照）。
 * 若初始只读预检已通过则零外部请求直接返回；否则针对已上市但缺数的标的按需补齐后再复检。
 */
async function ensureRealClassroomDataAndPrecheck({
  industries,
  startYear = 2011,
  totalRounds = 15,
  autoBackfill = true,
  deps = {},
} = {}) {
  const initial = await (deps.runRealPrecheck || runRealPrecheck)({ industries, startYear, totalRounds });
  if (initial.pass || !autoBackfill) {
    return initial;
  }

  const redReports = (initial.stockReports || []).filter((r) => r && r.status === 'red' && r.canonicalCode);
  if (!redReports.length) {
    return initial;
  }

  const endYear = startYear + totalRounds - 1;
  const startDate = `${startYear - 1}-12-01`;
  const endDate = `${endYear}-12-31`;
  const startCutoff = `${startYear}-01-10`;

  const ds = deps.marketDatasets || marketDatasets;
  const refDs = deps.referenceDatasets || referenceDatasets;
  const proj = deps.stockProjection || stockProjection;
  const suspRepository = deps.suspensionRepo || suspensionRepo;
  const crRepo = deps.repo || repo;

  const redCodes = [...new Set(redReports.map((r) => r.canonicalCode))];
  const instRows = await crRepo.fetchInstrumentsByCodes(redCodes);
  const instByCode = new Map();
  for (const row of instRows) {
    if (!instByCode.has(row.canonical_code)) {
      instByCode.set(row.canonical_code, row);
    }
  }

  const attemptedCodes = [];
  const skippedNotListed = [];
  const errors = [];
  let filledBars = 0;
  let filledFactors = 0;
  let filledValuations = 0;
  let filledSuspensions = 0;

  async function fetchSuspensionsInChunks(tsCode) {
    const all = [];
    for (let y = startYear - 1; y <= endYear; y += 5) {
      const segStart = `${y}-01-01`;
      const segEnd = `${Math.min(endYear, y + 4)}-12-31`;
      const rows = await refDs.readSuspensions({ tsCode, startDate: segStart, endDate: segEnd });
      if (Array.isArray(rows) && rows.length) all.push(...rows);
    }
    return all;
  }

  for (const code of redCodes) {
    const inst = instByCode.get(code);
    if (!inst) {
      errors.push({ code, message: '证券主档中未找到该 A 股代码' });
      continue;
    }
    if (inst.list_date && inst.list_date > startCutoff) {
      skippedNotListed.push({ code, listDate: inst.list_date });
      continue;
    }

    attemptedCodes.push(code);
    try {
      const [dailyRows, factorRows, valRows, suspRows] = await Promise.all([
        ds.readStockDailySeries({ tsCode: code, startDate, endDate, market: 'cn' }),
        ds.readAdjustmentFactorSeries({ tsCode: code, startDate, endDate }),
        ds.readStockValuationHistory({ tsCode: code, startDate, endDate }),
        fetchSuspensionsInChunks(code).catch((err) => {
          errors.push({ code, message: `停牌日历补全失败：${err && err.message ? err.message : String(err)}` });
          return [];
        }),
      ]);

      await crRepo.withTransaction(async (client) => {
        const sources = await proj.sourceIds(client);
        for (const r of dailyRows || []) {
          const td = formatIsoTradeDate(r.trade_date);
          if (!td || r.close == null || !(Number(r.close) > 0)) continue;
          const sid = sources[r.source_code] || sources.tushare;
          if (!sid) continue;
          await proj.upsertDailyBar({ instrumentId: inst.instrument_id, tradeDate: td, sourceId: sid, close: Number(r.close) }, client);
          filledBars++;
        }
        for (const r of factorRows || []) {
          const td = formatIsoTradeDate(r.trade_date);
          if (!td || r.adj_factor == null || !(Number(r.adj_factor) > 0)) continue;
          const sid = sources[r.source_code] || sources.tushare;
          if (!sid) continue;
          await proj.upsertAdjustmentFactor({ instrumentId: inst.instrument_id, tradeDate: td, sourceId: sid, adjFactor: Number(r.adj_factor) }, client);
          filledFactors++;
        }
        for (const r of valRows || []) {
          const td = formatIsoTradeDate(r.trade_date);
          if (!td) continue;
          const sid = sources[r.source_code] || sources.tushare;
          if (!sid) continue;
          await proj.upsertDailyValuation({
            instrumentId: inst.instrument_id,
            tradeDate: td,
            sourceId: sid,
            peStatic: marketMultiple(r.pe),
            peTtm: marketMultiple(r.pe_ttm),
            pb: marketMultiple(r.pb),
            dividendYieldTtm: r.dv_ttm == null ? null : Number(r.dv_ttm) / 100,
            totalMarketCap: r.total_mv == null ? null : Number(r.total_mv) * 10000,
            circulatingMarketCap: r.circ_mv == null ? null : Number(r.circ_mv) * 10000,
            freeFloatMarketCap: null,
            currencyCode: 'CNY',
          }, client);
          filledValuations++;
        }
        const suspMapByDate = new Map();
        for (const r of suspRows || []) {
          const td = formatIsoTradeDate(r.trade_date);
          if (!td) continue;
          const prev = suspMapByDate.get(td);
          const nextType = String(r.suspend_type || 'S').trim().toUpperCase();
          // 同日同时有复牌(R)与停牌(S)记录时，保留停牌(S)证据
          if (!prev || nextType === 'S') {
            suspMapByDate.set(td, {
              instrument_id: inst.instrument_id,
              trade_date: td,
              suspend_type: nextType,
              suspend_reason: r.suspend_reason || '',
              raw_payload: r,
            });
          }
        }
        const suspBatch = Array.from(suspMapByDate.values());
        if (suspBatch.length && sources.tushare) {
          await suspRepository.insert_market_stock_suspend_calendar([JSON.stringify(suspBatch), sources.tushare], client);
          filledSuspensions += suspBatch.length;
        }
      });
    } catch (err) {
      errors.push({ code, message: err && err.message ? err.message : String(err) });
    }
  }

  const autoBackfillSummary = {
    attemptedCodes,
    skippedNotListed,
    filledBars,
    filledFactors,
    filledValuations,
    filledSuspensions,
    errors,
  };

  if (filledBars === 0 && filledFactors === 0 && filledValuations === 0 && filledSuspensions === 0) {
    return { ...initial, autoBackfill: autoBackfillSummary };
  }

  const rechecked = await (deps.runRealPrecheck || runRealPrecheck)({ industries, startYear, totalRounds });
  return { ...rechecked, autoBackfill: autoBackfillSummary };
}

function evaluateBondAndCbPublicGate({ startYear, totalRounds, tradeDatesByYear, calSummaryMap = null, bondWealthSeries, cbStats, cbBucketRows }) {
  const endYear = startYear + totalRounds - 1;
  const calendarMissingYears = [];
  const calendarGapReasons = [];
  for (let yr = startYear; yr <= endYear; yr++) {
    const yDates = tradeDatesByYear.get(yr) || [];
    const calCheck = validateYearTradeCalendar(yr, yDates, calSummaryMap ? calSummaryMap.get(yr) : null);
    if (!calCheck.ok) {
      calendarMissingYears.push(yr);
      calendarGapReasons.push(calCheck.reason);
    }
  }

  const bondMapByCode = new Map();
  for (const row of (bondWealthSeries || [])) {
    if (!bondMapByCode.has(row.index_code)) bondMapByCode.set(row.index_code, new Map());
    bondMapByCode.get(row.index_code).set(row.trade_date, Number(row.close));
  }

  let selectedBondCode = null;
  let bondYearDetails = [];
  for (const code of BOND_CODE_PRIORITY) {
    const seriesMap = bondMapByCode.get(code);
    if (!seriesMap) continue;
    const details = [];
    let allYearsOk = true;
    for (let yr = startYear; yr <= endYear; yr++) {
      const yDates = tradeDatesByYear.get(yr) || [];
      if (yDates.length < 2) {
        allYearsOk = false;
        details.push({ year: yr, status: 'red', reason: `${yr} 年交易日历缺失` });
        continue;
      }
      const startClose = seriesMap.get(yDates[0]);
      const endClose = seriesMap.get(yDates[yDates.length - 1]);
      if (!(startClose > 0) || !(endClose > 0)) {
        allYearsOk = false;
        details.push({ year: yr, status: 'red', reason: `${yr} 年国债财富净值首尾缺失` });
      } else {
        details.push({ year: yr, status: 'green', returnRate: Number(((endClose / startClose) - 1).toFixed(8)) });
      }
    }
    if (!selectedBondCode || allYearsOk) {
      selectedBondCode = code;
      bondYearDetails = details;
    }
    if (allYearsOk) break;
  }
  const bondWealthCovered = Boolean(selectedBondCode)
    && bondYearDetails.length === totalRounds
    && bondYearDetails.every((d) => d.status === 'green');

  const REQUIRED_TENORS = ['short', 'mid', 'long'];
  const REQUIRED_MONEYNESS = ['otm', 'atm', 'itm'];
  const bucketMap = new Map();
  for (const row of (cbBucketRows || [])) {
    bucketMap.set(`${row.tenor_bucket}|${row.moneyness_bucket}`, row);
  }
  const missingBuckets = [];
  for (const t of REQUIRED_TENORS) {
    for (const m of REQUIRED_MONEYNESS) {
      const key = `${t}|${m}`;
      const row = bucketMap.get(key);
      const premCnt = row ? Number(row.premium_cnt || 0) : 0;
      const bondPremCnt = row ? Number(row.bond_premium_cnt || 0) : 0;
      if (!row || premCnt < 1 || bondPremCnt < 1 || row.median_premium_pct == null || row.median_bond_premium_pct == null) {
        missingBuckets.push(key);
      }
    }
  }
  const cbCalibrated = missingBuckets.length === 0;
  const blockers = [];
  if (calendarMissingYears.length > 0) {
    blockers.push(`交易日历覆盖不完整：${calendarGapReasons.join('；')}`);
  }
  if (!bondWealthCovered) {
    blockers.push('十年期国债财富净值未覆盖完整 15 个年度');
  }
  if (!cbCalibrated) {
    blockers.push(`真实可转债样本未覆盖全部分桶（缺 ${missingBuckets.join(', ')}）`);
  }

  return {
    pass: blockers.length === 0,
    calendarOk: calendarMissingYears.length === 0,
    calendarMissingYears,
    bondWealthCovered,
    bondIndexCode: selectedBondCode,
    cbCalibrated,
    cbSampleCount: Number((cbStats && cbStats.cnt) || 0),
    missingBuckets,
    blockers,
  };
}

async function verifyCandidateBatch({ candidates, startYear, totalRounds, tradeDatesByYear }) {
  if (!candidates || candidates.length === 0) return [];
  const endYear = startYear + totalRounds - 1;
  const startDate = `${startYear - 1}-12-01`;
  const endDate = `${endYear}-12-31`;
  const instIds = candidates.map((c) => Number(c.instrumentId));

  const [bars, valuations, suspensions, swNodes, swMemberships] = await Promise.all([
    repo.fetchDailyBarsWithAdj(instIds, startDate, endDate),
    repo.fetchDailyValuations(instIds, startDate, endDate),
    repo.fetchSuspensions(instIds, startDate, endDate),
    repo.fetchSw2021IndustryTree(),
    repo.fetchSw2021MembershipsByInstrumentIds(instIds),
  ]);

  const level1Map = resolveSw2021Level1Map(swNodes);
  const instLevel1Map = new Map();
  for (const m of swMemberships) {
    const key = String(m.instrument_id);
    if (!instLevel1Map.has(key)) instLevel1Map.set(key, new Map());
    const l1 = level1Map.get(String(m.industry_node_id));
    if (l1) instLevel1Map.get(key).set(l1.level1NodeId, l1);
  }

  const barMap = new Map();
  for (const b of bars) {
    const key = String(b.instrument_id);
    if (!barMap.has(key)) barMap.set(key, new Map());
    barMap.get(key).set(b.trade_date, b);
  }
  const valMap = new Map();
  for (const v of valuations) {
    const key = String(v.instrument_id);
    if (!valMap.has(key)) valMap.set(key, new Map());
    valMap.get(key).set(v.trade_date, v);
  }
  const suspMap = new Map();
  for (const s of suspensions) {
    const key = String(s.instrument_id);
    if (!suspMap.has(key)) suspMap.set(key, new Set());
    suspMap.get(key).add(s.trade_date);
  }

  return candidates.map((cand) => {
    const bMap = barMap.get(cand.instrumentId) || new Map();
    const vMap = valMap.get(cand.instrumentId) || new Map();
    const sSet = suspMap.get(cand.instrumentId) || new Set();
    let status = 'green';
    let firstFailReason = '';
    let yellowCount = 0;

    for (let yr = startYear; yr <= endYear; yr++) {
      const yDates = tradeDatesByYear.get(yr) || [];
      const prevDates = tradeDatesByYear.get(yr - 1) || [];
      const cov = resolveYearStockCoverage({
        year: yr,
        yearTradeDates: yDates,
        prevYearTailTradeDates: prevDates.slice(-5),
        barByDate: bMap,
        valByDate: vMap,
        suspendDates: sSet,
      });
      if (cov.status === 'red') {
        status = 'red';
        firstFailReason = cov.reason;
        break;
      }
      if (cov.status === 'yellow') {
        status = 'yellow';
        yellowCount++;
      }
    }
    return {
      ...cand,
      status,
      yellowCount,
      reason: firstFailReason || (yellowCount ? `含 ${yellowCount} 年停牌顺延取价` : '15 年完整覆盖'),
    };
  });
}

/**
 * 分批核验指定历史窗口的 SW2021 一级行业与股票覆盖状态；支持缓存复用与超时保留进度。
 */
async function verifyIndustryPool({
  startYear,
  totalRounds = 15,
  targetIndustryNodeId = null,
  initialBatchSize = 10,
  requireFullIndustry = false,
  timeoutMs = 4000,
  now = new Date(),
}) {
  const startYearNum = Number(startYear);
  const windowCheck = validateWindowBounds(startYearNum, totalRounds, now);
  if (!windowCheck.valid) {
    return {
      windowStatus: { pass: false, blockers: [windowCheck.reason], calendarOk: false, bondWealthCovered: false, cbCalibrated: false },
      dataVersion: '',
      industries: [],
      excluded: [],
      timedOut: false,
    };
  }

  const endYear = windowCheck.endYear;
  const startDate = `${startYearNum - 1}-12-01`;
  const endDate = `${endYear}-12-31`;

  const {
    dataVersion,
    tradeDatesByYear,
    windowStatus,
    startDates,
    endDates,
    cached: initialCached,
  } = await repo.withReadOnlySnapshot(async (client) => {
    const tradeDates = await repo.fetchCnOpenTradeDates(startDate, endDate, client);
    const calSummaryRows = await repo.fetchCnCalendarSummaryByYear(startYearNum, endYear, client);
    const bondWealthSeries = await repo.fetchBondWealthIndexSeries(`${startYearNum}-01-01`, endDate, client);
    const cbStats = await repo.fetchCbCalibrationSampleStats(client);
    const cbBucketRows = await repo.fetchCbCalibrationBuckets(client);
    const snapDataVersion = await repo.fetchFactsDataVersion({ startDate, endDate }, client);
    const calSummaryMap = new Map((calSummaryRows || []).map((r) => [Number(r.year), r]));

    const snapTradeDatesByYear = new Map();
    for (const d of tradeDates) {
      const yr = Number(d.slice(0, 4));
      if (!snapTradeDatesByYear.has(yr)) snapTradeDatesByYear.set(yr, []);
      snapTradeDatesByYear.get(yr).push(d);
    }

    const snapWindowStatus = evaluateBondAndCbPublicGate({
      startYear: startYearNum,
      totalRounds,
      tradeDatesByYear: snapTradeDatesByYear,
      calSummaryMap,
      bondWealthSeries,
      cbStats,
      cbBucketRows,
    });

    const snapStartDates = snapTradeDatesByYear.get(startYearNum) || [];
    const snapEndDates = snapTradeDatesByYear.get(endYear) || [];
    if (snapStartDates.length < 2 || snapEndDates.length < 2) {
      return {
        dataVersion: snapDataVersion,
        tradeDatesByYear: snapTradeDatesByYear,
        windowStatus: snapWindowStatus,
        startDates: snapStartDates,
        endDates: snapEndDates,
        cached: null,
      };
    }

    const cacheKey = `${startYearNum}|${totalRounds}|SW2021|${PRECHECK_RULE_VERSION}|${snapDataVersion}`;
    let snapCached = windowPoolCache.get(cacheKey);
    if (!snapCached) {
      const nodes = await repo.fetchSw2021IndustryTree(client);
      const candidateRows = await repo.fetchCnStockCandidatesForWindow({
        firstTradeDate: snapStartDates[0],
        lastTradeDate: snapEndDates[snapEndDates.length - 1],
      }, client);
      snapCached = windowPoolCache.get(cacheKey);
      if (!snapCached) {
        const level1Map = resolveSw2021Level1Map(nodes);
        const grouped = groupCandidatesByLevel1Industry(candidateRows, level1Map);
        snapCached = {
          lock: Promise.resolve(),
          excluded: grouped.excluded,
          industries: grouped.industries.map((ind) => ({
            industryNodeId: ind.industryNodeId,
            industryCode: ind.industryCode,
            industryName: ind.industryName,
            candidates: ind.candidates,
            nextCursor: 0,
            qualifiedIds: new Set(),
            rejectedIds: new Set(),
            qualified: [],
            rejected: [],
          })),
        };
        windowPoolCache.set(cacheKey, snapCached);
      }
    }

    return {
      dataVersion: snapDataVersion,
      tradeDatesByYear: snapTradeDatesByYear,
      windowStatus: snapWindowStatus,
      startDates: snapStartDates,
      endDates: snapEndDates,
      cached: snapCached,
    };
  });

  if (startDates.length < 2 || endDates.length < 2) {
    return {
      windowStatus,
      dataVersion,
      industries: [],
      excluded: [],
      timedOut: false,
    };
  }
  const cached = initialCached;

  const deadline = Date.now() + Math.max(0, Number(timeoutMs));
  const runBatchVerify = async () => {
    let timedOut = false;
    for (const ind of cached.industries) {
      if (targetIndustryNodeId && ind.industryNodeId !== String(targetIndustryNodeId)) {
        continue;
      }
      const wantFull = requireFullIndustry || Boolean(targetIndustryNodeId);
      while (ind.nextCursor < ind.candidates.length) {
        if (!wantFull && ind.qualified.length >= 3 && ind.nextCursor >= initialBatchSize) {
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        const batch = ind.candidates.slice(ind.nextCursor, ind.nextCursor + initialBatchSize);
        const results = await verifyCandidateBatch({
          candidates: batch,
          startYear: startYearNum,
          totalRounds,
          tradeDatesByYear,
        });
        ind.nextCursor += batch.length;
        for (const r of results) {
          if (r.status === 'green' || r.status === 'yellow') {
            if (!ind.qualifiedIds.has(r.instrumentId)) {
              ind.qualifiedIds.add(r.instrumentId);
              ind.qualified.push(r);
            }
          } else if (!ind.rejectedIds.has(r.instrumentId)) {
            ind.rejectedIds.add(r.instrumentId);
            ind.rejected.push(r);
          }
        }
        if (!wantFull && ind.qualified.length >= 3 && ind.nextCursor >= initialBatchSize) {
          break;
        }
      }
      if (timedOut) break;
    }
    return timedOut;
  };

  const lockStep = cached.lock.then(runBatchVerify, runBatchVerify);
  cached.lock = lockStep.catch(() => {});
  const timedOut = await lockStep;

  const industries = cached.industries.map((ind) => {
    const exhausted = ind.nextCursor >= ind.candidates.length;
    const enabled = ind.qualified.length >= 3;
    let status = 'insufficient';
    if (enabled) status = 'ready';
    else if (!exhausted) status = 'verifying';
    return {
      industryNodeId: ind.industryNodeId,
      industryCode: ind.industryCode,
      industryName: ind.industryName,
      coarseCount: ind.candidates.length,
      verifiedCount: ind.nextCursor,
      qualifiedCount: ind.qualified.length,
      enabled,
      completed: exhausted,
      status,
      qualifiedStocks: ind.qualified,
    };
  });

  const qualifiedIndustriesCount = industries.filter((i) => i.enabled).length;
  const fullBlockers = [...windowStatus.blockers];
  if (qualifiedIndustriesCount < 4) {
    fullBlockers.push(`当前仅有 ${qualifiedIndustriesCount} 个合格一级行业（需至少 4 个且每行业至少 3 只合格股）`);
  }

  return {
    windowStatus: {
      ...windowStatus,
      pass: fullBlockers.length === 0,
      blockers: fullBlockers,
      qualifiedIndustriesCount,
    },
    dataVersion,
    taxonomy: 'SW2021',
    survivorBiasNotice: SURVIVOR_BIAS_NOTICE,
    industries,
    excluded: cached.excluded,
    timedOut,
  };
}

/**
 * 列出可建场的 15 年历史窗口及当前窗口的一级行业选项。
 */
async function getCreationOptions({ startYear = null, totalRounds = 15, timeoutMs = 4000, now = new Date() } = {}) {
  const sseYears = await repo.fetchAvailableSseYears();
  const sseYearMap = new Map(sseYears.map((r) => [Number(r.year), r]));
  const maxCompletedYear = getShanghaiCurrentYear(now) - 1;
  const minYear = sseYears.length > 0 ? Number(sseYears[0].year) : 2005;

  const candidateStartYears = [];
  for (let sy = minYear; sy + totalRounds - 1 <= maxCompletedYear; sy++) {
    let calOk = true;
    for (let y = sy; y <= sy + totalRounds - 1; y++) {
      const row = sseYearMap.get(y);
      if (!row || Number(row.cnt) < MIN_SSE_OPEN_DAYS_PER_YEAR || String(row.first_date).slice(5) > '01-15' || String(row.last_date).slice(5) < '12-20') {
        calOk = false;
        break;
      }
    }
    if (calOk) candidateStartYears.push(sy);
  }

  const availableWindows = [];
  const windowDiagnostics = [];
  for (const sy of candidateStartYears) {
    const poolRes = await verifyIndustryPool({
      startYear: sy,
      totalRounds,
      initialBatchSize: 10,
      requireFullIndustry: false,
      timeoutMs: Math.min(1500, timeoutMs),
      now,
    });
    if (poolRes.windowStatus.pass) {
      availableWindows.push({
        startYear: sy,
        endYear: sy + totalRounds - 1,
        qualifiedIndustriesCount: poolRes.windowStatus.qualifiedIndustriesCount,
        dataVersion: poolRes.dataVersion,
      });
    } else {
      windowDiagnostics.push({
        startYear: sy,
        endYear: sy + totalRounds - 1,
        blockers: poolRes.windowStatus.blockers,
      });
    }
  }

  const targetYear = startYear != null
    ? Number(startYear)
    : (availableWindows.length > 0 ? availableWindows[availableWindows.length - 1].startYear : (candidateStartYears[0] || 2011));

  const currentPool = await verifyIndustryPool({
    startYear: targetYear,
    totalRounds,
    initialBatchSize: 10,
    requireFullIndustry: false,
    timeoutMs,
    now,
  });

  let onlyOneWindowNote = null;
  if (availableWindows.length === 1) {
    const w = availableWindows[0];
    onlyOneWindowNote = `当前仅 ${w.startYear}–${w.endYear} 窗口同时满足交易日历、国债财富净值、转债校准及至少 4 个合格一级行业门槛。`;
  }

  return {
    availableWindows,
    onlyOneWindowNote,
    windowDiagnostics,
    selectedStartYear: targetYear,
    ...currentPool,
  };
}

/**
 * 纯函数：从已核验的行业与合格股池中等概率无放回抽取 4×3 组合或单组重抽。
 */
function buildRandomUniverseSelection({
  enabledIndustries,
  lockedGroups = [],
  targetGroupIndex = null,
  excludeComboKey = null,
  seed = null,
}) {
  const rng = createRng(seed);
  const byNodeId = new Map(enabledIndustries.map((ind) => [String(ind.industryNodeId), ind]));
  const notes = [];

  if (targetGroupIndex != null && lockedGroups.length === 4) {
    const idx = Number(targetGroupIndex);
    const targetGroup = lockedGroups[idx];
    const usedNodeIds = new Set(
      lockedGroups.filter((_, i) => i !== idx).map((g) => String(g.industryNodeId))
    );
    let ind = targetGroup && targetGroup.industryNodeId ? byNodeId.get(String(targetGroup.industryNodeId)) : null;
    if (!ind || usedNodeIds.has(String(ind.industryNodeId))) {
      const availInds = enabledIndustries.filter((x) => !usedNodeIds.has(String(x.industryNodeId)));
      if (availInds.length === 0) {
        throw new Error('没有可用的替代一级行业');
      }
      ind = sampleUniformWithoutReplacement(availInds, 1, rng)[0];
    }

    const prevCodes = Array.isArray(targetGroup && targetGroup.codes)
      ? targetGroup.codes.map((c) => String(c).toUpperCase()).sort().join(',')
      : '';
    let chosenStocks = sampleUniformWithoutReplacement(ind.qualifiedStocks, 3, rng);
    if (ind.qualifiedStocks.length === 3) {
      notes.push(`行业「${ind.industryName}」仅有 3 只合格股，沿用该组标的`);
    } else if (prevCodes) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const key = chosenStocks.map((s) => s.canonicalCode).sort().join(',');
        if (key !== prevCodes) break;
        chosenStocks = sampleUniformWithoutReplacement(ind.qualifiedStocks, 3, rng);
      }
    }

    const nextGroups = lockedGroups.map((g, i) => (i === idx ? {
      industryNodeId: ind.industryNodeId,
      industryName: ind.industryName,
      codes: chosenStocks.map((s) => s.canonicalCode),
      instrumentIds: chosenStocks.map((s) => s.instrumentId),
      stocks: chosenStocks,
    } : g));

    return { groups: nextGroups, notes };
  }

  if (enabledIndustries.length < 4) {
    throw new Error(`合格一级行业不足 4 个（当前 ${enabledIndustries.length} 个）`);
  }

  let selectedInds = sampleUniformWithoutReplacement(enabledIndustries, 4, rng);
  let groups = selectedInds.map((ind) => {
    const picked = sampleUniformWithoutReplacement(ind.qualifiedStocks, 3, rng);
    if (ind.qualifiedStocks.length === 3) {
      notes.push(`行业「${ind.industryName}」仅有 3 只合格股`);
    }
    return {
      industryNodeId: ind.industryNodeId,
      industryName: ind.industryName,
      codes: picked.map((s) => s.canonicalCode),
      instrumentIds: picked.map((s) => s.instrumentId),
      stocks: picked,
    };
  });

  if (excludeComboKey) {
    const comboKeyOf = (gs) => gs.map((g) => `${g.industryNodeId}:${g.codes.slice().sort().join(',')}`).sort().join('|');
    const canChange = enabledIndustries.length > 4 || selectedInds.some((ind) => ind.qualifiedStocks.length > 3);
    if (canChange) {
      for (let attempt = 0; attempt < 8 && comboKeyOf(groups) === excludeComboKey; attempt++) {
        selectedInds = sampleUniformWithoutReplacement(enabledIndustries, 4, rng);
        groups = selectedInds.map((ind) => {
          const picked = sampleUniformWithoutReplacement(ind.qualifiedStocks, 3, rng);
          return {
            industryNodeId: ind.industryNodeId,
            industryName: ind.industryName,
            codes: picked.map((s) => s.canonicalCode),
            instrumentIds: picked.map((s) => s.instrumentId),
            stocks: picked,
          };
        });
      }
    } else {
      notes.push('当前仅存在唯一一组合格 4×3 标的组合，已保留该组合');
    }
  }

  return { groups, notes };
}

async function sampleRealClassroomSelection({
  startYear,
  totalRounds = 15,
  lockedGroups = [],
  targetGroupIndex = null,
  excludeComboKey = null,
  seed = null,
  timeoutMs = 5000,
  now = new Date(),
}) {
  const targetIndId = (targetGroupIndex != null && lockedGroups[targetGroupIndex])
    ? lockedGroups[targetGroupIndex].industryNodeId
    : null;
  const poolRes = await verifyIndustryPool({
    startYear,
    totalRounds,
    targetIndustryNodeId: targetIndId,
    initialBatchSize: 10,
    requireFullIndustry: !targetIndId,
    timeoutMs,
    now,
  });

  if (poolRes.timedOut) {
    const err = new Error('候选股票池核验超时，尚未形成完整合格池，请重试后再抽样');
    err.status = 409;
    err.extra = { code: 'POOL_VERIFICATION_INCOMPLETE', timedOut: true, windowStatus: poolRes.windowStatus };
    throw err;
  }

  if (targetIndId) {
    const targetInd = poolRes.industries.find((i) => i.industryNodeId === String(targetIndId));
    if (targetInd && !targetInd.completed) {
      const err = new Error(`行业「${targetInd.industryName}」候选尚未核验完成，请重试后再抽样`);
      err.status = 409;
      err.extra = { code: 'POOL_VERIFICATION_INCOMPLETE', timedOut: true };
      throw err;
    }
  } else if (poolRes.industries.some((i) => !i.completed)) {
    const err = new Error('部分行业候选尚未核验完成，请重试后再抽样');
    err.status = 409;
    err.extra = { code: 'POOL_VERIFICATION_INCOMPLETE', timedOut: true };
    throw err;
  }

  if (!poolRes.windowStatus.pass) {
    const err = new Error(poolRes.windowStatus.blockers.join('；'));
    err.status = 400;
    err.extra = { windowStatus: poolRes.windowStatus };
    throw err;
  }

  const enabledIndustries = poolRes.industries.filter((i) => i.enabled);
  const sampled = buildRandomUniverseSelection({
    enabledIndustries,
    lockedGroups,
    targetGroupIndex,
    excludeComboKey,
    seed,
  });

  return {
    startYear: Number(startYear),
    dataVersion: poolRes.dataVersion,
    taxonomy: 'SW2021',
    survivorBiasNotice: SURVIVOR_BIAS_NOTICE,
    groups: sampled.groups,
    notes: sampled.notes,
  };
}

module.exports = {
  PRECHECK_RULE_VERSION,
  SURVIVOR_BIAS_NOTICE,
  getShanghaiCurrentYear,
  validateWindowBounds,
  validateYearTradeCalendar,
  resolveSw2021Level1Map,
  groupCandidatesByLevel1Industry,
  sampleUniformWithoutReplacement,
  buildRandomUniverseSelection,
  resolveYearStockCoverage,
  runRealPrecheck,
  ensureRealClassroomDataAndPrecheck,
  verifyIndustryPool,
  getCreationOptions,
  sampleRealClassroomSelection,
};
