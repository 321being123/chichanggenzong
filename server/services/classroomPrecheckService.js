'use strict';

const repo = require('../repositories/classroomRepository');

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
  const endYear = startYear + totalRounds - 1;
  const startDate = `${startYear - 1}-12-01`; // 留前一年末 5 个交易日给第 1 年期初停牌估值回溯
  const endDate = `${endYear}-12-31`;

  const industryList = Array.isArray(industries) ? industries : [];
  const universeErrors = [];
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

  const [tradeDates, instruments, bondWealthSeries, sovYield, cbStats, cbBucketRows] = await Promise.all([
    repo.fetchCnOpenTradeDates(startDate, endDate),
    repo.fetchInstrumentsByCodes(allCodes),
    repo.fetchBondWealthIndexSeries(`${startYear}-01-01`, endDate),
    repo.fetchSovereignYieldCount(`${startYear}-01-01`, endDate),
    repo.fetchCbCalibrationSampleStats(),
    repo.fetchCbCalibrationBuckets(),
  ]);

  const tradeDatesByYear = new Map();
  for (const d of tradeDates) {
    const yr = Number(d.slice(0, 4));
    if (!tradeDatesByYear.has(yr)) tradeDatesByYear.set(yr, []);
    tradeDatesByYear.get(yr).push(d);
  }

  const instByCode = new Map();
  for (const row of instruments) {
    // 优先保留带 SW2021 行业归属的记录
    const prev = instByCode.get(row.canonical_code);
    if (!prev || (row.taxonomy_code === 'SW2021' && prev.taxonomy_code !== 'SW2021')) {
      instByCode.set(row.canonical_code, row);
    }
  }
  const instIds = [...new Set(Array.from(instByCode.values()).map((i) => i.instrument_id))];

  const [bars, valuations, suspensions] = await Promise.all([
    repo.fetchDailyBarsWithAdj(instIds, startDate, endDate),
    repo.fetchDailyValuations(instIds, startDate, endDate),
    repo.fetchSuspensions(instIds, startDate, endDate),
  ]);

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

  const stockReports = [];
  let redCount = 0;
  let yellowCount = 0;
  const groupDbIndustries = new Set();

  for (const ind of industryList) {
    const groupName = String(ind && ind.industryName ? ind.industryName : '').trim();
    const groupNodeIds = new Set();
    const groupNodeNames = new Set();

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

      if (!inst.industry_node_id || inst.taxonomy_code !== 'SW2021') {
        redCount++;
        stockReports.push({
          industryName: groupName,
          canonicalCode: code,
          stockName: inst.name,
          instrumentId: inst.instrument_id,
          swIndustryName: inst.sw_industry_name || null,
          status: 'red',
          reason: `${code} 在 SW2021 行业分类体系中缺少有效行业归属`,
          years: [],
        });
        continue;
      }

      groupNodeIds.add(String(inst.industry_node_id));
      groupNodeNames.add(inst.sw_industry_name);

      if (groupName && inst.sw_industry_name !== groupName) {
        redCount++;
        stockReports.push({
          industryName: groupName,
          canonicalCode: code,
          stockName: inst.name,
          instrumentId: inst.instrument_id,
          swIndustryName: inst.sw_industry_name,
          status: 'red',
          reason: `${code} 库内行业为「${inst.sw_industry_name}」，与分组「${groupName}」不符`,
          years: [],
        });
        continue;
      }

      const idKey = String(inst.instrument_id);
      const bMap = barMap.get(idKey) || new Map();
      const vMap = valMap.get(idKey) || new Map();
      const sSet = suspMap.get(idKey) || new Set();

      const years = [];
      let stockStatus = 'green';
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
        industryNodeId: inst.industry_node_id,
        swIndustryName: inst.sw_industry_name,
        status: stockStatus,
        years,
      });
    }

    if (groupNodeIds.size > 1) {
      universeErrors.push(`分组「${groupName}」内股票分属多个不同 SW2021 行业（${[...groupNodeNames].join('、')}）`);
    } else if (groupNodeIds.size === 1) {
      const nodeId = [...groupNodeIds][0];
      if (groupDbIndustries.has(nodeId)) {
        universeErrors.push(`多个分组映射到同一 SW2021 行业（${[...groupNodeNames][0]}）`);
      } else {
        groupDbIndustries.add(nodeId);
      }
    }
  }

  // 按优先级逐年核验十年期国债财富净值首尾覆盖并计算年度总回报
  const BOND_CODE_PRIORITY = ['CBA00601', 'CN10Y_WEALTH', 'CHINABOND_7_10Y_WEALTH'];
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
    startYear,
    endYear,
    totalRounds,
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

module.exports = {
  resolveYearStockCoverage,
  runRealPrecheck,
};
