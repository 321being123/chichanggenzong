'use strict';

// 股市模拟沙盘演示场次剧本生成器（纯函数、确定性教学示例数据）。
// 仅用于 mode='demo' 的课堂演示与交互/对账测试，严禁冒充真实市场历史快照。

const DEMO_INDUSTRIES = [
  {
    industryName: '能源',
    stocks: [
      { assetId: 'stk_energy_a', alias: '能源 A', canonicalCode: 'DEMO_EN_A', stockName: '示例能源甲', baseCap: 1800, basePe: 11.2, basePb: 1.35 },
      { assetId: 'stk_energy_b', alias: '能源 B', canonicalCode: 'DEMO_EN_B', stockName: '示例能源乙', baseCap: 1200, basePe: 14.8, basePb: 1.82 },
      { assetId: 'stk_energy_c', alias: '能源 C', canonicalCode: 'DEMO_EN_C', stockName: '示例能源丙', baseCap: 850, basePe: 9.4, basePb: 1.05 },
    ],
  },
  {
    industryName: '制造',
    stocks: [
      { assetId: 'stk_mfg_a', alias: '制造 A', canonicalCode: 'DEMO_MF_A', stockName: '示例制造甲', baseCap: 1500, basePe: 22.5, basePb: 2.95 },
      { assetId: 'stk_mfg_b', alias: '制造 B', canonicalCode: 'DEMO_MF_B', stockName: '示例制造乙', baseCap: 980, basePe: 17.3, basePb: 2.15 },
      { assetId: 'stk_mfg_c', alias: '制造 C', canonicalCode: 'DEMO_MF_C', stockName: '示例制造丙', baseCap: 640, basePe: 28.4, basePb: 3.45 },
    ],
  },
  {
    industryName: '金融',
    stocks: [
      { assetId: 'stk_fin_a', alias: '金融 A', canonicalCode: 'DEMO_FN_A', stockName: '示例金融甲', baseCap: 2600, basePe: 7.2, basePb: 0.92 },
      { assetId: 'stk_fin_b', alias: '金融 B', canonicalCode: 'DEMO_FN_B', stockName: '示例金融乙', baseCap: 1950, basePe: 8.6, basePb: 1.12 },
      { assetId: 'stk_fin_c', alias: '金融 C', canonicalCode: 'DEMO_FN_C', stockName: '示例金融丙', baseCap: 1100, basePe: 10.5, basePb: 1.38 },
    ],
  },
  {
    industryName: '零售',
    stocks: [
      { assetId: 'stk_ret_a', alias: '零售 A', canonicalCode: 'DEMO_RT_A', stockName: '示例零售甲', baseCap: 1350, basePe: 24.0, basePb: 3.60 },
      { assetId: 'stk_ret_b', alias: '零售 B', canonicalCode: 'DEMO_RT_B', stockName: '示例零售乙', baseCap: 790, basePe: 19.8, basePb: 2.55 },
      { assetId: 'stk_ret_c', alias: '零售 C', canonicalCode: 'DEMO_RT_C', stockName: '示例零售丙', baseCap: 520, basePe: 31.2, basePb: 4.10 },
    ],
  },
];

// 15 轮示例年度市场周期因子（模拟牛熊切换、风格轮动与利率周期）
const DEMO_CYCLE_PROFILE = [
  { bond: 0.0412, mkt: -0.145, valScale: 1.00 }, // R1 (2011)
  { bond: 0.0365, mkt: 0.048, valScale: 0.88 },  // R2 (2012)
  { bond: 0.0185, mkt: 0.062, valScale: 0.92 },  // R3 (2013)
  { bond: 0.0920, mkt: 0.315, valScale: 0.96 },  // R4 (2014)
  { bond: 0.0715, mkt: 0.142, valScale: 1.24 },  // R5 (2015)
  { bond: 0.0290, mkt: -0.068, valScale: 1.15 }, // R6 (2016)
  { bond: 0.0110, mkt: 0.165, valScale: 1.08 },  // R7 (2017)
  { bond: 0.0780, mkt: -0.215, valScale: 1.18 }, // R8 (2018)
  { bond: 0.0460, mkt: 0.245, valScale: 0.91 },  // R9 (2019)
  { bond: 0.0325, mkt: 0.188, valScale: 1.09 },  // R10 (2020)
  { bond: 0.0520, mkt: 0.034, valScale: 1.22 },  // R11 (2021)
  { bond: 0.0315, mkt: -0.152, valScale: 1.14 }, // R12 (2022)
  { bond: 0.0465, mkt: -0.048, valScale: 0.95 }, // R13 (2023)
  { bond: 0.0680, mkt: 0.128, valScale: 0.89 },  // R14 (2024)
  { bond: 0.0275, mkt: 0.096, valScale: 1.02 },  // R15 (2025)
];

function buildDemoScenario({ startYear = 2011, totalRounds = 15 } = {}) {
  const rounds = [];
  const capState = new Map();
  for (const ind of DEMO_INDUSTRIES) {
    for (const st of ind.stocks) {
      capState.set(st.assetId, st.baseCap);
    }
  }

  for (let i = 0; i < totalRounds; i++) {
    const roundNo = i + 1;
    const calendarYear = startYear + i;
    const prof = DEMO_CYCLE_PROFILE[i % DEMO_CYCLE_PROFILE.length];
    const stocks = [];

    let stockIdx = 0;
    for (const ind of DEMO_INDUSTRIES) {
      for (const st of ind.stocks) {
        const cap = Number((capState.get(st.assetId) || st.baseCap).toFixed(2));
        // 确定性个股轮动偏移
        const phase = ((i * 7 + stockIdx * 5) % 11) - 5; // -5..+5
        const ret = Number((prof.mkt + phase * 0.028).toFixed(4));
        // 第 10 轮故意让 5 只股票呈亏损（负 PE），用于验证「低/高市盈率 8」合格不足暂停并自动转现金的机制
        let peTtm = Number((st.basePe * prof.valScale * (1 + (phase * 0.04))).toFixed(2));
        if (roundNo === 10 && stockIdx % 2 === 1 && stockIdx < 10) {
          peTtm = Number((-12.5 - stockIdx).toFixed(2));
        }
        const pb = Number(Math.max(0.45, st.basePb * prof.valScale * (1 + (phase * 0.03))).toFixed(2));

        stocks.push({
          assetId: st.assetId,
          industryName: ind.industryName,
          alias: st.alias,
          canonicalCode: st.canonicalCode,
          stockName: st.stockName,
          marketCap: cap,
          peTtm,
          pb,
          returnRate: ret,
        });

        capState.set(st.assetId, Math.max(200, cap * (1 + ret)));
        stockIdx++;
      }
    }

    const convertibleBonds = roundNo >= 11
      ? DEMO_INDUSTRIES.map((ind, idx) => ({
        assetId: `cb_${idx}`,
        alias: `${ind.industryName}转债`,
        canonicalCode: `DEMO_CB_${idx + 1}`,
        stockName: `示例${ind.industryName}转债`,
        industryName: ind.industryName,
        underlyingAssetId: ind.stocks[0].assetId,
        conversionPrice: 100,
        couponRate: 0.015,
        discountRate: 0.032,
        volatility: 0.28,
      }))
      : [];

    rounds.push({
      roundNo,
      calendarYear,
      bondReturnRate: prof.bond,
      stocks,
      convertibleBonds,
    });
  }

  return {
    schemaVersion: 1,
    mode: 'demo',
    dataLabel: '教学示例数据（非真实历史行情）',
    cbModelVersion: 'cb_model_v1_teaching',
    bondSeriesSource: 'demo_10y_wealth_series',
    startYear,
    endYear: startYear + totalRounds - 1,
    totalRounds,
    industries: DEMO_INDUSTRIES.map((ind) => ({
      industryName: ind.industryName,
      stockCount: ind.stocks.length,
    })),
    rounds,
  };
}

module.exports = {
  DEMO_INDUSTRIES,
  buildDemoScenario,
};
