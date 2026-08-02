// ===================== 复制仓位测算服务（整手约束下的买入股数与误差计算） =====================
// 对应 docs/仓位对比功能_开发文档.md 7 节：
//   - 7.2 理论目标（复制后总资产 × 标杆占比 - 当前市值）
//   - 7.3 交易单位（主板 100 整数倍 / 科创板 200 起 1 股递增 / 港股按每手股数）
//   - 7.4 最小误差（贪心：每次加入能最大降低总误差且资金足够的最小增量；超配 0 股）
//   - 7.5 测算结果（建议股数、预计金额、复制后占比、误差、状态）
//
// 2026-08-01 修复（验收阻断）：
//   1) 增量扣款：每次只加一手，金额只按"新增一手"计算，不再拿累计股数当本轮新增重复扣款；
//   2) 运算优先级：Math.abs((simValue[code] || 0) - targetRatio) 括号必须包住减法两侧；
//   3) 现金方向：买入用掉现金，复制后现金占比 = 剩余现金 / 新总资产（原实现方向加反）；
//   4) 港股汇率：理论股数 = 人民币缺口 ÷ (港币价 × 汇率)，原实现直接用港币价算错。
// 算法：维护模拟账户（simValue 各证券人民币市值 + simCash 现金），每轮对每只证券评估"再加一手"的
//       误差收益，选收益最大且资金足够的一手；加到无一手能改善误差或资金耗尽为止。
const { getATradeRule } = require('./tradeLot');

// 可交易股数集合的候选生成：围绕理论股数生成相邻可行值
// 规则：主板 {0,100,200,...}；科创板 {0,200,201,202,...}；港股 {0,lot,2lot,...}
// 返回排序后的候选数组（升序，含 0）
function candidateQuantities(rule, theoreticalShares) {
  if (!rule) return [0];
  const { minLot, increment } = rule;
  const lots = [];
  if (increment === 1) {
    // 科创板：0 或 >=200 的任意整数（1 股递增）
    lots.push(0);
    for (let q = minLot; q <= theoreticalShares + minLot; q += 1) lots.push(q);
  } else {
    // 主板 / 港股：整手倍数
    for (let n = 0; n * minLot <= theoreticalShares + minLot; n++) lots.push(n * minLot);
  }
  // 去重、去负，并确保包含理论值附近上/下一手（边界兜底）
  const set = new Set(lots.filter(q => q >= 0));
  return [...set].sort((a, b) => a - b);
}

// 给定可用资金与当前市值，计算该证券在"资金可行"前提下最接近理论股数的可行值
function nearestFeasible(rule, theoreticalShares, theoreticalAmount, price, availableCash) {
  const candidates = candidateQuantities(rule, theoreticalShares);
  let best = 0, bestScore = Infinity;
  for (const q of candidates) {
    const amount = q * price;
    if (amount > availableCash + 1e-9) break; // 资金不足后续更大数量也不可行
    const score = Math.abs(q - theoreticalShares); // 尽量贴近理论股数
    if (score < bestScore) { bestScore = score; best = q; }
  }
  return best;
}

// 总仓位误差（7.4）
function totalError(ratios, benchmarkRatios, cashRatio, benchmarkCashRatio) {
  const keys = new Set([...Object.keys(ratios), ...Object.keys(benchmarkRatios)]);
  let error = 0;
  for (const key of keys) {
    error += Math.abs((ratios[key] || 0) - (benchmarkRatios[key] || 0));
  }
  error += Math.abs((cashRatio || 0) - (benchmarkCashRatio || 0));
  return error;
}

// 计算某证券每手占用金额（一手人民币资金，港股折算）
function lotAmount(rule, price, hkRate) {
  const qty = rule ? rule.minLot : 0;
  return qty * price * (rule && rule.market === 'HK' ? hkRate : 1);
}

// 判断 code 是否为港股（纯数字 1-5 位）
function isHkCode(code) {
  return /^\d{1,5}$/.test(String(code || '').replace(/\D/g, ''));
}

// 主测算入口
// 输入：
//   my:      { positions: [{code,name,type,subtype,quantity,marketValue,ratio,instrument_id}], cash, cashRatio, totalAsset }
//   bench:   { positions: [{code,name,type,subtype,ratio,quantity,marketValue,instrument_id}], cash, cashRatio, totalAsset }
//   cashToUse: 计划用于复制的新增资金（>0，人民币；仅这笔钱可用于买入，账户已有现金不用于买入）
//   lotRules:  Map<code, {market:'A',board,minLot,increment} 或 {market:'HK', buy_lot_size_shares}>（港股缺规则时无该项）
//   prices:   Map<code, price>（统一估值后的最新价格：A股人民币、港股港币）
//   hkRate:   港币兑人民币汇率
// 返回：{ items:[...], summary:{ usedCash, remainingCash, errorBefore, errorAfter, improvement } }
function replicatePositions(my, bench, cashToUse, lotRules, prices, hkRate) {
  // ---- 初始模拟账户（全部金额为人民币口径） ----
  const simValue = {};   // code -> 证券人民币市值（含后续买入）
  const myRatioBase = {}; // 复制前我的占比（用于 errorBefore）
  for (const p of my.positions) {
    simValue[p.code] = p.marketValue || 0;
    myRatioBase[p.code] = p.ratio || 0;
  }
  // 买入预算：仅用户输入的新增资金可用于买入（文档 7.4：不超过用户输入的可用资金）
  let budget = cashToUse;
  // 复制后现金 = 原现金 + 新增资金 - 已买入金额（用于计算复制后现金占比）
  let simCash = (my.cash || 0) + cashToUse;
  const newTotal = my.totalAsset + cashToUse;

  const benchRatios = {};
  for (const p of bench.positions) benchRatios[p.code] = p.ratio || 0;
  const benchCashRatio = bench.cashRatio || 0;
  const myCashRatioBefore = my.cashRatio || 0;

  const errorBefore = totalError(myRatioBase, benchRatios, myCashRatioBefore, benchCashRatio);

  // ---- 逐证券规则与理论目标（人民币口径） ----
  const plans = bench.positions.map(bp => {
    const price = prices.get(bp.code) || bp.price;
    const rule = lotRules.get(bp.code) || null;
    const hk = isHkCode(bp.code);
    const currentValue = simValue[bp.code] || 0;
    const targetValue = newTotal * (bp.ratio || 0);
    const gapRmb = Math.max(0, targetValue - currentValue); // 人民币缺口
    // 理论股数：港股用人民币缺口 ÷ (港币价×汇率)；A股 人民币缺口 ÷ 人民币价
    const priceRmb = hk ? (price || 0) * hkRate : (price || 0);
    const theoreticalShares = priceRmb > 0 ? gapRmb / priceRmb : 0;
    // 一手步长（股）：港股按每手股数；科创板首手 200 之后 1 股；主板/创业板 100
    let lotSize;
    if (hk) lotSize = rule && rule.buy_lot_size_shares ? rule.buy_lot_size_shares : null;
    else if (rule && rule.increment === 1) lotSize = rule.minLot; // 科创板展示"每手"= 最低 200
    else lotSize = 100;
    return {
      code: bp.code, name: bp.name, type: bp.type || '', subtype: bp.subtype || '',
      benchmarkRatio: bp.ratio || 0,
      myQuantity: (my.positions.find(p => p.code === bp.code) || {}).quantity || 0,
      price, priceRmb, hk, rule, lotSize,
      quoteTime: bp.quoteTime != null ? bp.quoteTime : null,
      gapRmb, theoreticalShares,
      status: 'pending',
    };
  });

  // ---- 判断该证券当前能否继续加一手，返回 [step 股数, 一手人民币金额] 或 null ----
  function nextLot(plan, currentShares) {
    if (plan.gapRmb <= 1e-9) return null;            // 已超配
    if (plan.price == null || plan.price <= 0) return null; // 缺行情
    if (plan.hk) {
      if (!plan.lotSize) return null;                // 港股缺每手数据
      return [plan.lotSize, plan.lotSize * plan.priceRmb];
    }
    if (plan.rule && plan.rule.increment === 1) {
      // 科创板：首手 200，之后 1 股
      const step = currentShares < plan.rule.minLot ? plan.rule.minLot : 1;
      return [step, step * plan.priceRmb];
    }
    return [100, 100 * plan.priceRmb];               // 主板/创业板
  }

  // ---- 贪心买入（7.4） ----
  const buyPlan = {}; // code -> 累计建议股数
  let guard = 0;
  while (guard++ < 100000) {
    let best = null; // { plan, step, amount, gain }
    for (const plan of plans) {
      const currentShares = buyPlan[plan.code] || 0;
      const lot = nextLot(plan, currentShares);
      if (!lot) continue;
      const [step, amountRmb] = lot;
      if (amountRmb > budget + 1e-9) continue; // 买入预算不够一手（仅限新增资金）
      // 加这一手后的误差收益
      const before = Math.abs((simValue[plan.code] || 0) - plan.benchmarkRatio * newTotal) / newTotal;
      const after = Math.abs((simValue[plan.code] || 0) + amountRmb - plan.benchmarkRatio * newTotal) / newTotal;
      const gain = before - after;
      if (gain > 1e-12 && (!best || gain > best.gain)) best = { plan, step, amount: amountRmb, gain };
    }
    if (!best) break;
    buyPlan[best.plan.code] = (buyPlan[best.plan.code] || 0) + best.step;
    simValue[best.plan.code] = (simValue[best.plan.code] || 0) + best.amount;
    budget -= best.amount;
    simCash -= best.amount;
    if (budget < 1e-6) break;
  }

  // ---- 汇总结果（7.5） ----
  const items = plans.map(plan => {
    const suggested = buyPlan[plan.code] || 0;
    const afterValue = simValue[plan.code] || 0;
    const afterRatio = newTotal > 0 ? afterValue / newTotal : 0;
    let status = 'suggest';
    if (plan.gapRmb <= 1e-9) status = 'over_weighted';
    else if (plan.hk && !plan.lotSize) status = 'no_lot_data';
    else if (plan.price == null || plan.price <= 0) status = 'no_quote';
    else if (suggested === 0) status = 'insufficient_cash';
    return {
      code: plan.code, name: plan.name, market: plan.hk ? 'HK' : 'A',
      type: plan.type, subtype: plan.subtype,
      benchmarkRatio: plan.benchmarkRatio,
      myQuantity: plan.myQuantity,
      theoreticalShares: plan.theoreticalShares,
      lotSize: plan.lotSize,
      suggestedShares: suggested,
      suggestedAmount: suggested * plan.priceRmb, // 人民币
      afterRatio,
      diff: afterRatio - plan.benchmarkRatio,
      status,
      quotePrice: plan.price,
      quoteTime: plan.quoteTime,
    };
  });

  const usedCash = cashToUse - budget; // 实际用于买入的新增资金
  const remainingCash = budget;        // 新增资金剩余（保留为现金）
  // 复制后现金占比 = 剩余现金 / 新总资产（方向正确：买入花掉钱现金减少）
  const afterCashRatio = newTotal > 0 ? simCash / newTotal : 0;
  // 复制后各证券占比 = 模拟市值 / 新总资产
  const afterRatios = {};
  for (const plan of plans) afterRatios[plan.code] = newTotal > 0 ? (simValue[plan.code] || 0) / newTotal : 0;
  // 仅我持有（标杆没有）的证券也计入复制后占比
  for (const p of my.positions) {
    if (afterRatios[p.code] === undefined) afterRatios[p.code] = newTotal > 0 ? (simValue[p.code] || 0) / newTotal : 0;
  }
  const errorAfter = totalError(afterRatios, benchRatios, afterCashRatio, benchCashRatio);

  return {
    items,
    summary: {
      usedCash: Math.max(0, usedCash), remainingCash: Math.max(0, remainingCash),
      errorBefore, errorAfter, improvement: Math.max(0, errorBefore - errorAfter),
      newTotal,
    },
  };}

module.exports = { candidateQuantities, nearestFeasible, totalError, replicatePositions, lotAmount, isHkCode };
