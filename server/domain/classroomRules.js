'use strict';

// 股市模拟沙盘领域规则（纯函数、无 DB/IO、确定性十进制分结算）
// 金额统一以人民币分（integer / BigInt）计算，1 万元 = 1,000,000 分。

const CENTS_PER_WAN = 1000000;
const INITIAL_CASH_CENTS = 100000000; // 100 万元

const ASSET_TYPE_LABELS = {
  stock: '股票',
  bond: '债券',
  index: '指数基金',
  strategy: '策略基金',
  cb: '可转债',
};

const STRATEGY_DEFINITIONS = [
  { assetId: 'strat_low_pe_4', name: '低市盈率 4', metric: 'pe_ttm', order: 'asc', count: 4 },
  { assetId: 'strat_low_pb_4', name: '低市净率 4', metric: 'pb', order: 'asc', count: 4 },
  { assetId: 'strat_low_pe_8', name: '低市盈率 8', metric: 'pe_ttm', order: 'asc', count: 8 },
  { assetId: 'strat_low_pb_8', name: '低市净率 8', metric: 'pb', order: 'asc', count: 8 },
  { assetId: 'strat_high_pe_4', name: '高市盈率 4', metric: 'pe_ttm', order: 'desc', count: 4 },
  { assetId: 'strat_high_pb_4', name: '高市净率 4', metric: 'pb', order: 'desc', count: 4 },
];

/**
 * 解析万元金额文本为整数分（最多 6 位小数，对应精确到分）。
 * 空值或空白按 0 处理。拒绝负数、科学计数法、超过 6 位小数及非法字符。
 */
function parseWanToCents(raw) {
  if (raw === null || raw === undefined) return { ok: true, cents: 0 };
  const s = String(raw).trim().replace(/,/g, '');
  if (s === '') return { ok: true, cents: 0 };
  if (!/^\d+(?:\.\d+)?$/.test(s)) {
    return { ok: false, error: '金额格式无效，请输入非负数字（最多 6 位万元小数）' };
  }
  const parts = s.split('.');
  const intPart = parts[0];
  const fracPart = parts[1] || '';
  if (fracPart.length > 6) {
    return { ok: false, error: '金额最多支持 6 位万元小数（精确到分）' };
  }
  const paddedFrac = fracPart.padEnd(6, '0');
  const combined = intPart + paddedFrac;
  const num = Number(combined);
  if (!Number.isSafeInteger(num) || num < 0) {
    return { ok: false, error: '金额超出安全整数范围' };
  }
  return { ok: true, cents: num };
}

/**
 * 将分格式化为万元字符串（保留必要小数，最多 6 位，去掉尾随 0）。
 */
function centsToWanStr(cents) {
  const n = Math.trunc(Number(cents || 0));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const intPart = Math.floor(abs / CENTS_PER_WAN);
  const fracPart = String(abs % CENTS_PER_WAN).padStart(6, '0').replace(/0+$/, '');
  return sign + (fracPart ? `${intPart}.${fracPart}` : String(intPart));
}

/**
 * 确定性十进制定点乘法并四舍五入到分（half-up）。
 * 支持 rateStr 为小数字符串（如 '0.04', '-0.123456', '0.1'）或数字。
 * 计算：round_half_up(cents * (1 + rate))
 */
function settleAmountHalfUp(investedCents, rateInput) {
  const invested = BigInt(Math.trunc(Number(investedCents || 0)));
  if (invested === 0n) return 0;
  const rateStr = typeof rateInput === 'number'
    ? rateInput.toFixed(10)
    : String(rateInput == null ? '0' : rateInput).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(rateStr)) {
    throw new Error(`非法收益率格式: ${rateStr}`);
  }
  const neg = rateStr.startsWith('-');
  const clean = neg ? rateStr.slice(1) : rateStr;
  const [intPart, fracPart = ''] = clean.split('.');
  const scale = fracPart.length;
  const denom = 10n ** BigInt(scale);
  const absRateScaled = BigInt(intPart + fracPart);
  const rateScaled = neg ? -absRateScaled : absRateScaled;
  // multiplier = (1 + rate) * denom
  const multScaled = denom + rateScaled;
  const numer = invested * multScaled;
  // half-up rounding for positive/zero ending value
  if (numer <= 0n) return 0;
  const rounded = (numer + denom / 2n) / denom;
  return Number(rounded);
}

/**
 * 精确加法：将两个十进制字符串/数字做复利连乘 (1 + r1) * (1 + r2) - 1
 */
function compoundReturn(prevLevel, rateInput) {
  const r = Number(rateInput || 0);
  return Number((Number(prevLevel) * (1 + r)).toFixed(6));
}

function bucketPe(pe) {
  if (pe === null || pe === undefined || pe === '') return '数据不足';
  const n = Number(pe);
  if (!Number.isFinite(n)) return '数据不足';
  if (n <= 0) return '亏损';
  const low = Math.floor(n / 5) * 5;
  const high = low + 5;
  return `${low}–${high}倍`;
}

function bucketPb(pb) {
  if (pb === null || pb === undefined || pb === '') return '数据不足';
  const n = Number(pb);
  if (!Number.isFinite(n)) return '数据不足';
  if (n <= 0) return '不适用';
  const low = Math.floor(n * 2) / 2;
  const high = low + 0.5;
  return `${low.toFixed(1)}–${high.toFixed(1)}倍`;
}

/**
 * 计算市场汇总 PE(TTM) 与 PB。
 * 汇总利润包含已确认亏损（cap / pe_ttm）；分母非正显示「不适用」，事实不全显示「数据不足」。
 */
function computeMarketValuation(stocks) {
  let totalCap = 0;
  let totalEarnings = 0;
  let totalEquity = 0;
  let missingPe = false;
  let missingPb = false;

  for (const s of stocks) {
    const cap = Number(s.marketCap);
    if (!Number.isFinite(cap) || cap <= 0) {
      missingPe = true;
      missingPb = true;
      continue;
    }
    totalCap += cap;

    const pe = s.peTtm == null ? null : Number(s.peTtm);
    if (pe === null || !Number.isFinite(pe) || pe === 0) {
      missingPe = true;
    } else {
      totalEarnings += cap / pe;
    }

    const pb = s.pb == null ? null : Number(s.pb);
    if (pb === null || !Number.isFinite(pb) || pb === 0) {
      missingPb = true;
    } else {
      totalEquity += cap / pb;
    }
  }

  let peDisplay = '数据不足';
  let peValue = null;
  if (!missingPe && totalCap > 0) {
    if (totalEarnings <= 0) {
      peDisplay = '不适用';
    } else {
      peValue = Number((totalCap / totalEarnings).toFixed(2));
      peDisplay = peValue.toFixed(2);
    }
  }

  let pbDisplay = '数据不足';
  let pbValue = null;
  if (!missingPb && totalCap > 0) {
    if (totalEquity <= 0) {
      pbDisplay = '不适用';
    } else {
      pbValue = Number((totalCap / totalEquity).toFixed(2));
      pbDisplay = pbValue.toFixed(2);
    }
  }

  return { peValue, peDisplay, pbValue, pbDisplay, totalCap };
}

/**
 * 第 8 轮起的等权策略基金选样。
 * 只选取有效正值；同值按 canonicalCode 稳定升序。合格数量不足时暂停该策略。
 */
function selectStrategyConstituents(stocks, strategyDef) {
  const field = strategyDef.metric === 'pe_ttm' ? 'peTtm' : 'pb';
  const eligible = stocks
    .filter((s) => s[field] !== null && s[field] !== undefined && Number.isFinite(Number(s[field])) && Number(s[field]) > 0)
    .slice()
    .sort((a, b) => {
      const va = Number(a[field]);
      const vb = Number(b[field]);
      if (va !== vb) {
        return strategyDef.order === 'asc' ? va - vb : vb - va;
      }
      return String(a.canonicalCode || a.assetId).localeCompare(String(b.canonicalCode || b.assetId));
    });

  if (eligible.length < strategyDef.count) {
    return {
      assetId: strategyDef.assetId,
      name: strategyDef.name,
      paused: true,
      pauseReason: `有效正值标的仅 ${eligible.length} 只，不足 ${strategyDef.count} 只，本轮暂停配置`,
      constituents: [],
    };
  }

  const picked = eligible.slice(0, strategyDef.count);
  const weightPct = Number((100 / strategyDef.count).toFixed(2));
  return {
    assetId: strategyDef.assetId,
    name: strategyDef.name,
    paused: false,
    pauseReason: null,
    constituents: picked.map((s) => ({
      assetId: s.assetId,
      industryName: s.industryName,
      alias: s.alias,
      canonicalCode: s.canonicalCode,
      stockName: s.stockName,
      metricValue: Number(s[field]),
      weightPct,
    })),
  };
}

function resolveCbBucketKey(remainingYears, conversionValue) {
  const rem = Number(remainingYears || 0);
  const tenor = rem <= 2 ? 'short' : (rem <= 4 ? 'mid' : 'long');
  const cv = Number(conversionValue || 0);
  const moneyness = cv < 90 ? 'otm' : (cv <= 115 ? 'atm' : 'itm');
  return `${tenor}|${moneyness}`;
}

/**
 * 模拟可转债定价模型（第 11–15 轮）。
 * 第 11 轮统一以 100 元建仓，期初模型价锚定 100 元，初始期限 6 年。
 * 含息回报口径：债底按贴现率 + 票息率推进，避免票息重复计入现金。
 */
function priceSimulatedConvertibleBond({
  simStockPrice,
  conversionPrice,
  remainingYears,
  couponRate = 0.015,
  discountRate = 0.032,
  volatility = 0.28,
  bucketParams = null,
}) {
  const parity = (100 / conversionPrice) * simStockPrice;
  const rem = Math.max(0, Number(remainingYears));
  let effVol = Number(volatility);
  let effDisc = Number(discountRate);
  if (bucketParams && typeof bucketParams === 'object') {
    const bKey = resolveCbBucketKey(rem, parity);
    const bp = bucketParams[bKey];
    if (bp) {
      if (bp.volatility != null) effVol = Number(bp.volatility);
      if (bp.discountRate != null) effDisc = Number(bp.discountRate);
    }
  }
  if (rem === 0) {
    // 到期按面值+末期票息与转股价值孰高结算
    const redeemValue = 100 * (1 + couponRate);
    return Number(Math.max(redeemValue, parity).toFixed(4));
  }
  let bondFloor = 0;
  for (let t = 1; t <= Math.ceil(rem); t++) {
    const frac = t <= rem ? 1 : rem - (t - 1);
    bondFloor += (100 * couponRate * frac) / Math.pow(1 + effDisc, Math.min(t, rem));
  }
  bondFloor += 100 / Math.pow(1 + effDisc, rem);

  const moneyness = parity / Math.max(bondFloor, 1);
  // 平滑期权时间价值：在平价附近最大，深度虚值/实值收敛
  const sigmaT = effVol * Math.sqrt(rem);
  const optionPremium = Math.max(0, bondFloor * 0.16 * Math.exp(-Math.pow(Math.log(Math.max(moneyness, 0.25)), 2) / (2 * Math.max(sigmaT * sigmaT, 0.08))) * Math.min(1, rem / 4));
  const modelPrice = Math.max(bondFloor, parity) + optionPremium;
  return Number(modelPrice.toFixed(4));
}

/**
 * 构建单轮开放资产目录（含股票、国债、第 8 轮起基金、第 11 轮起可转债）及市场概览。
 */
function buildRoundOpenCatalog(roundMeta, prevRoundSettled, prevCbStates) {
  const roundNo = Number(roundMeta.roundNo);
  const stocks = roundMeta.stocks; // 12 stocks with open peTtm, pb, marketCap, canonicalCode, alias, industryName
  const mktVal = computeMarketValuation(stocks);

  const assets = [];
  for (const s of stocks) {
    assets.push({
      assetId: s.assetId,
      assetType: 'stock',
      industryName: s.industryName,
      alias: s.alias,
      canonicalCode: s.canonicalCode,
      stockName: s.stockName,
      peTtm: s.peTtm,
      pb: s.pb,
      marketCap: s.marketCap,
      paused: false,
      pauseReason: null,
    });
  }

  // 第 13 行固定：债券｜十年期国债
  assets.push({
    assetId: 'bond_10y',
    assetType: 'bond',
    industryName: '债券',
    alias: '十年期国债',
    canonicalCode: 'CN10Y_WEALTH',
    stockName: '十年期国债财富指数',
    peTtm: null,
    pb: null,
    paused: false,
    pauseReason: null,
  });

  const strategies = [];
  if (roundNo >= 8) {
    assets.push({
      assetId: 'idx_composite',
      assetType: 'index',
      industryName: '指数基金',
      alias: '模拟综指基金',
      canonicalCode: 'SIM_COMPOSITE',
      stockName: '模拟综指基金',
      peTtm: mktVal.peValue,
      pb: mktVal.pbValue,
      paused: false,
      pauseReason: null,
    });
    for (const def of STRATEGY_DEFINITIONS) {
      const sel = selectStrategyConstituents(stocks, def);
      strategies.push(sel);
      assets.push({
        assetId: sel.assetId,
        assetType: 'strategy',
        industryName: '策略基金',
        alias: sel.name,
        canonicalCode: sel.assetId.toUpperCase(),
        stockName: sel.name,
        peTtm: null,
        pb: null,
        paused: sel.paused,
        pauseReason: sel.pauseReason,
        constituents: sel.constituents,
      });
    }
  }

  const cbStates = {};
  if (roundNo >= 11) {
    const cbSpecs = roundMeta.convertibleBonds || [];
    for (const spec of cbSpecs) {
      let openPrice = 100;
      let simStockPrice = 100;
      let remainingYears = 6;
      const conversionPrice = Number(spec.conversionPrice || 100);
      if (roundNo > 11 && prevCbStates && prevCbStates[spec.assetId]) {
        const prev = prevCbStates[spec.assetId];
        openPrice = prev.endPrice;
        simStockPrice = prev.endSimStockPrice;
        remainingYears = Math.max(0, prev.remainingYears - 1);
      }
      const conversionValue = Number(((100 / conversionPrice) * simStockPrice).toFixed(4));
      const premiumPct = Number((((openPrice / conversionValue) - 1) * 100).toFixed(2));
      cbStates[spec.assetId] = {
        assetId: spec.assetId,
        underlyingAssetId: spec.underlyingAssetId,
        industryName: spec.industryName,
        alias: spec.alias,
        openPrice,
        simStockPrice,
        conversionPrice,
        conversionValue,
        premiumPct,
        remainingYears,
        couponRate: Number(spec.couponRate || 0.015),
        discountRate: Number(spec.discountRate || 0.032),
        volatility: Number(spec.volatility || 0.28),
        bucketParams: spec.bucketParams || null,
      };
      assets.push({
        assetId: spec.assetId,
        assetType: 'cb',
        industryName: '可转债',
        alias: spec.alias,
        canonicalCode: spec.canonicalCode || spec.assetId.toUpperCase(),
        stockName: spec.stockName || spec.alias,
        peTtm: null,
        pb: null,
        paused: false,
        pauseReason: null,
        cbInfo: cbStates[spec.assetId],
      });
    }
  }

  const indexOpenLevel = roundNo === 1
    ? 1000
    : Number((prevRoundSettled && prevRoundSettled.indexEndLevel) || 1000);

  return {
    roundNo,
    calendarYear: roundMeta.calendarYear,
    marketHeaderTitle: roundNo >= 8 ? '模拟综指' : '市场总体',
    showIndexLevel: roundNo >= 8,
    indexOpenLevel,
    marketPeValue: mktVal.peValue,
    marketPeDisplay: mktVal.peDisplay,
    marketPbValue: mktVal.pbValue,
    marketPbDisplay: mktVal.pbDisplay,
    assets,
    strategies,
    cbStates,
  };
}

/**
 * 计算单轮市场结算结果（股票、国债、综指、策略基金、可转债）。
 */
function computeRoundMarketSettlement(openSnapshot, roundMeta) {
  const assetReturns = {};
  const stockById = new Map();
  let totalCap = 0;
  let weightedReturn = 0;

  for (const s of roundMeta.stocks) {
    const r = Number(s.returnRate);
    assetReturns[s.assetId] = r;
    stockById.set(s.assetId, { ...s, returnRate: r });
    const cap = Number(s.marketCap || 0);
    totalCap += cap;
  }
  for (const s of roundMeta.stocks) {
    const cap = Number(s.marketCap || 0);
    const w = totalCap > 0 ? cap / totalCap : 1 / roundMeta.stocks.length;
    weightedReturn += w * Number(s.returnRate);
  }

  assetReturns.bond_10y = Number(roundMeta.bondReturnRate);

  const indexReturn = Number(weightedReturn.toFixed(8));
  const indexOpenLevel = Number(openSnapshot.indexOpenLevel || 1000);
  const indexEndLevel = compoundReturn(indexOpenLevel, indexReturn);
  assetReturns.idx_composite = indexReturn;

  for (const strat of (openSnapshot.strategies || [])) {
    if (strat.paused || !strat.constituents || strat.constituents.length === 0) {
      assetReturns[strat.assetId] = 0;
    } else {
      const avg = strat.constituents.reduce((acc, c) => {
        const st = stockById.get(c.assetId);
        return acc + (st ? st.returnRate : 0);
      }, 0) / strat.constituents.length;
      assetReturns[strat.assetId] = Number(avg.toFixed(8));
    }
  }

  const nextCbStates = {};
  for (const [cbId, cb] of Object.entries(openSnapshot.cbStates || {})) {
    const underlying = stockById.get(cb.underlyingAssetId);
    const stockRet = underlying ? underlying.returnRate : 0;
    const endSimStockPrice = Number((cb.simStockPrice * (1 + stockRet)).toFixed(4));
    const endRemainingYears = Math.max(0, cb.remainingYears - 1);
    const endPrice = priceSimulatedConvertibleBond({
      simStockPrice: endSimStockPrice,
      conversionPrice: cb.conversionPrice,
      remainingYears: endRemainingYears,
      couponRate: cb.couponRate,
      discountRate: cb.discountRate,
      volatility: cb.volatility,
      bucketParams: cb.bucketParams || null,
    });
    const cbReturn = Number(((endPrice / cb.openPrice) - 1).toFixed(8));
    const endConversionValue = Number(((100 / cb.conversionPrice) * endSimStockPrice).toFixed(4));
    const endPremiumPct = Number((((endPrice / endConversionValue) - 1) * 100).toFixed(2));
    assetReturns[cbId] = cbReturn;
    nextCbStates[cbId] = {
      ...cb,
      endSimStockPrice,
      endPrice,
      endConversionValue,
      endPremiumPct,
      premiumChangePct: Number((endPremiumPct - cb.premiumPct).toFixed(2)),
      underlyingReturn: stockRet,
      cbReturn,
      remainingYears: cb.remainingYears,
    };
  }

  return {
    roundNo: openSnapshot.roundNo,
    calendarYear: openSnapshot.calendarYear,
    indexOpenLevel,
    indexEndLevel,
    indexReturn,
    assetReturns,
    cbResults: nextCbStates,
  };
}

/**
 * 开放本轮前，根据上一轮结算持仓与本轮暂停资产生成学员期初状态（幂等基础）。
 */
function computeMemberRoundOpening({ prevSettlement, openSnapshot, initialCashCents = INITIAL_CASH_CENTS }) {
  if (!prevSettlement) {
    return {
      openingTotalCents: initialCashCents,
      defaultAllocations: {},
      defaultCashCents: initialCashCents,
      liquidationEvents: [],
    };
  }

  const pausedMap = new Map();
  const openSet = new Set();
  for (const a of (openSnapshot.assets || [])) {
    if (a.paused) pausedMap.set(a.assetId, a.pauseReason || '策略本轮暂停配置');
    else openSet.add(a.assetId);
  }

  let cashCents = Number(prevSettlement.ending_cash_cents ?? prevSettlement.endingCashCents ?? 0);
  const defaultAllocations = {};
  const liquidationEvents = [];

  for (const item of (prevSettlement.item_details || prevSettlement.itemDetails || [])) {
    const endCents = Number(item.endingCents || 0);
    if (endCents <= 0) continue;
    if (pausedMap.has(item.assetId)) {
      cashCents += endCents;
      liquidationEvents.push({
        assetId: item.assetId,
        alias: item.alias || item.assetId,
        amountCents: endCents,
        reason: pausedMap.get(item.assetId),
      });
    } else if (openSet.has(item.assetId)) {
      defaultAllocations[item.assetId] = endCents;
    } else {
      cashCents += endCents;
    }
  }

  const openingTotalCents = Number(prevSettlement.ending_total_cents ?? prevSettlement.endingTotalCents ?? cashCents);
  return {
    openingTotalCents,
    defaultAllocations,
    defaultCashCents: cashCents,
    liquidationEvents,
  };
}

/**
 * 服务端独立校验配置金额字典（单位：分）。
 */
function validateAllocations({ rawAllocations, openSnapshot, openingTotalCents }) {
  if (!rawAllocations || typeof rawAllocations !== 'object' || Array.isArray(rawAllocations)) {
    return { ok: false, error: '配置格式无效' };
  }

  const assetMap = new Map();
  for (const a of (openSnapshot.assets || [])) {
    assetMap.set(a.assetId, a);
  }

  const normalized = {};
  let sumCents = 0;

  for (const [assetId, rawVal] of Object.entries(rawAllocations)) {
    if (rawVal === null || rawVal === undefined || rawVal === '' || rawVal === 0 || rawVal === '0') {
      continue;
    }
    const asset = assetMap.get(assetId);
    if (!asset) {
      return { ok: false, error: `资产 ${assetId} 在本轮不可配置` };
    }
    if (asset.paused) {
      return { ok: false, error: `${asset.alias || assetId} 本轮已暂停配置` };
    }
    let cents;
    if (typeof rawVal === 'string' && /^\d+$/.test(rawVal)) {
      cents = Number(rawVal);
    } else if (typeof rawVal === 'number' && Number.isSafeInteger(rawVal)) {
      cents = rawVal;
    } else {
      return { ok: false, error: `资产 ${assetId} 金额必须是十进制整数分` };
    }
    if (!Number.isSafeInteger(cents) || cents < 0) {
      return { ok: false, error: `资产 ${assetId} 金额不能为负` };
    }
    if (cents > 0) {
      normalized[assetId] = cents;
      sumCents += cents;
    }
  }

  if (sumCents > openingTotalCents) {
    return {
      ok: false,
      error: `配置总额 ${centsToWanStr(sumCents)} 万元超过本轮期初总资产 ${centsToWanStr(openingTotalCents)} 万元`,
    };
  }

  return {
    ok: true,
    allocations: normalized,
    allocatedTotalCents: sumCents,
    cashCents: openingTotalCents - sumCents,
  };
}

/**
 * 结算单一成员的某一轮配置。
 */
function settleMemberRound({ openingTotalCents, allocations, openSnapshot, settledMarket }) {
  const assetMap = new Map((openSnapshot.assets || []).map((a) => [a.assetId, a]));
  const returns = settledMarket.assetReturns || {};
  const itemDetails = [];
  let investedSum = 0;
  let endingAssetsSum = 0;
  let totalPnl = 0;

  for (const [assetId, rawCents] of Object.entries(allocations || {})) {
    const investedCents = Math.trunc(Number(rawCents || 0));
    if (investedCents <= 0) continue;
    const asset = assetMap.get(assetId);
    const rate = returns[assetId] != null ? returns[assetId] : 0;
    const endingCents = settleAmountHalfUp(investedCents, rate);
    const pnlCents = endingCents - investedCents;
    investedSum += investedCents;
    endingAssetsSum += endingCents;
    totalPnl += pnlCents;
    itemDetails.push({
      assetId,
      assetType: asset ? asset.assetType : 'stock',
      industryName: asset ? asset.industryName : '',
      alias: asset ? asset.alias : assetId,
      investedCents,
      returnRate: rate,
      endingCents,
      pnlCents,
    });
  }

  const endingCashCents = openingTotalCents - investedSum;
  const endingTotalCents = endingCashCents + endingAssetsSum;

  return {
    openingTotalCents,
    endingTotalCents,
    roundPnlCents: totalPnl,
    endingCashCents,
    itemDetails,
  };
}

/**
 * 计算正式榜单（同资产并列，后一名跳位）。
 */
function rankOfficialSettlements(rows) {
  const sorted = rows.slice().sort((a, b) => Number(b.endingTotalCents) - Number(a.endingTotalCents));
  let prevTotal = null;
  let currentRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const tot = Number(sorted[i].endingTotalCents);
    if (prevTotal === null || tot < prevTotal) {
      currentRank = i + 1;
      prevTotal = tot;
    }
    sorted[i].officialRank = currentRank;
    sorted[i].officialParticipantCount = sorted.length;
  }
  return sorted;
}

/**
 * 计算迟到补录（100 万元全现金）在已冻结正式榜单上的参考名次。
 */
function computeLateReferenceRank(officialEndingTotals, backfillCents = INITIAL_CASH_CENTS) {
  let strictlyHigher = 0;
  for (const t of officialEndingTotals) {
    if (Number(t) > Number(backfillCents)) strictlyHigher++;
  }
  return 1 + strictlyHigher;
}

/**
 * 盲玩/防剧透字段白名单裁剪（学员端 & 投屏共用）。
 */
function projectAssetsForViewer({ openSnapshot, settledMarket, blindActive, isRevealed }) {
  const returns = (isRevealed && settledMarket && settledMarket.assetReturns) ? settledMarket.assetReturns : null;
  return (openSnapshot.assets || []).map((a) => {
    const base = {
      assetId: a.assetId,
      assetType: a.assetType,
      industryName: a.industryName,
      alias: a.alias,
      paused: Boolean(a.paused),
      pauseReason: a.pauseReason || null,
    };

    if (a.assetType === 'bond') {
      base.peDisplay = '—';
      base.pbDisplay = '—';
    } else if (a.assetType === 'stock') {
      base.peDisplay = blindActive
        ? bucketPe(a.peTtm)
        : (a.peTtm == null ? '数据不足' : Number(a.peTtm).toFixed(2));
      base.pbDisplay = blindActive
        ? bucketPb(a.pb)
        : (a.pb == null ? '数据不足' : Number(a.pb).toFixed(2));
    } else if (a.assetType === 'index') {
      base.peDisplay = blindActive ? bucketPe(a.peTtm) : (openSnapshot.marketPeDisplay || '—');
      base.pbDisplay = blindActive ? bucketPb(a.pb) : (openSnapshot.marketPbDisplay || '—');
    } else {
      base.peDisplay = '—';
      base.pbDisplay = '—';
    }

    if (!blindActive) {
      base.canonicalCode = a.canonicalCode || null;
      base.stockName = a.stockName || null;
      if (a.marketCap != null) base.marketCap = a.marketCap;
    }

    if (a.assetType === 'strategy' && Array.isArray(a.constituents)) {
      base.constituents = a.constituents.map((c) => {
        const item = {
          assetId: c.assetId,
          industryName: c.industryName,
          alias: c.alias,
          weightPct: c.weightPct,
          metricDisplay: blindActive
            ? (a.assetId.includes('pe') ? bucketPe(c.metricValue) : bucketPb(c.metricValue))
            : Number(c.metricValue).toFixed(2),
        };
        if (!blindActive) {
          item.canonicalCode = c.canonicalCode;
          item.stockName = c.stockName;
        }
        return item;
      });
    }

    if (a.assetType === 'cb' && a.cbInfo) {
      const cb = a.cbInfo;
      base.cbInfo = {
        underlyingAssetId: cb.underlyingAssetId,
        underlyingAlias: cb.industryName ? `${cb.industryName}正股` : cb.underlyingAssetId,
        openPrice: cb.openPrice,
        conversionPrice: cb.conversionPrice,
        conversionValue: cb.conversionValue,
        premiumPct: cb.premiumPct,
        remainingYears: cb.remainingYears,
      };
      if (isRevealed && settledMarket && settledMarket.cbResults && settledMarket.cbResults[a.assetId]) {
        const res = settledMarket.cbResults[a.assetId];
        base.cbInfo.endPrice = res.endPrice;
        base.cbInfo.endPremiumPct = res.endPremiumPct;
        base.cbInfo.premiumChangePct = res.premiumChangePct;
        base.cbInfo.underlyingReturn = res.underlyingReturn;
      }
    }

    if (returns && returns[a.assetId] != null) {
      base.returnRate = returns[a.assetId];
    }

    return base;
  });
}

module.exports = {
  CENTS_PER_WAN,
  INITIAL_CASH_CENTS,
  ASSET_TYPE_LABELS,
  STRATEGY_DEFINITIONS,
  parseWanToCents,
  centsToWanStr,
  settleAmountHalfUp,
  compoundReturn,
  bucketPe,
  bucketPb,
  computeMarketValuation,
  selectStrategyConstituents,
  priceSimulatedConvertibleBond,
  buildRoundOpenCatalog,
  computeRoundMarketSettlement,
  computeMemberRoundOpening,
  validateAllocations,
  settleMemberRound,
  rankOfficialSettlements,
  computeLateReferenceRank,
  projectAssetsForViewer,
};
