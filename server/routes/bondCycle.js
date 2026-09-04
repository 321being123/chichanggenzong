const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const svc = require('../services/convertibleBondCycleService');
const cycle = require('../services/convertibleBondCycle');
const { isTradingDay } = require('../jobs/marketClose');
const { applyPublicCache } = require('../middleware/publicCache');

const FORMULA_VERSION = cycle.FORMULA_VERSION;
const UNIVERSE_VERSION = cycle.UNIVERSE_VERSION;
// 每日周期数据发布时刻（与同步任务统一为 18:00）
const PUBLISH_HOUR = 18, PUBLISH_MINUTE = 0;

// Date -> 本地 'YYYY-MM-DD'（node-pg 把 DATE 解析为本地零点的 Date，避免 toISOString 的 UTC 偏移）
function isoDate(d) {
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(d || '').slice(0, 10);
}

// 预期数据日：最近一个「应有数据」的交易日（用交易日历判断，法定节假日不误报；
// 当天为交易日但未到发布时刻时，允许展示上一交易日、不标记过期）。
// now 按 UTC 真实时间解读：内部 +8h 转到北京时间再做判断与返回，与 fmtCN 一致，不受容器时区影响。
function expectedTradeDate(now = new Date()) {
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const beforePublish = cn.getUTCHours() < PUBLISH_HOUR || (cn.getUTCHours() === PUBLISH_HOUR && cn.getUTCMinutes() < PUBLISH_MINUTE);
  if (!isTradingDay(cn) || beforePublish) cn.setUTCDate(cn.getUTCDate() - 1);
  let guard = 0;
  while (!isTradingDay(cn) && guard++ < 30) cn.setUTCDate(cn.getUTCDate() - 1);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

const DIAGNOSTICS = {
  valid_start: null,
  lookback_days: cycle.LOOKBACK_DAYS,
  minimum_bonds: cycle.MIN_BONDS,
  minimum_coverage_ratio: cycle.MIN_COVERAGE,
};

function sampleHistory(rows, maxPoints) {
  const limit = Math.max(2, Math.min(800, Number(maxPoints) || 800));
  if (!Array.isArray(rows) || rows.length <= limit) return rows || [];
  const sampled = [];
  for (let i = 0; i < limit; i++) sampled.push(rows[Math.round(i * (rows.length - 1) / (limit - 1))]);
  return sampled;
}

router.get('/', asyncHandler(async (req, res) => {
  const range = String(req.query.range || '5y');
  if (!['1y', '3y', '5y', 'all'].includes(range)) {
    return res.status(400).json({ error: '非法的 range 参数，仅支持 1y / 3y / 5y / all' });
  }
  const homeView = String(req.query.view || '').toLowerCase() === 'home';
  const latest = await svc.getLatestCycle(FORMULA_VERSION, UNIVERSE_VERSION);
  const latestVersion = latest
    ? [latest.trade_date, latest.calculated_at, FORMULA_VERSION, UNIVERSE_VERSION, range, homeView ? 'home' : 'full', homeView ? (req.query.maxPoints || '800') : ''].join('|')
    : ['empty', FORMULA_VERSION, UNIVERSE_VERSION, range, homeView ? 'home' : 'full', homeView ? (req.query.maxPoints || '800') : ''].join('|');
  if (applyPublicCache(req, res, latestVersion)) return;
  if (!latest) {
    return res.json({
      formula_version: FORMULA_VERSION,
      universe_version: UNIVERSE_VERSION,
      source: 'tushare_cb_daily',
      updated_at: null,
      source_trade_date: null,
      expected_trade_date: expectedTradeDate(),
      stale: false,
      latest: null,
      history: [],
      diagnostics: DIAGNOSTICS,
    });
  }
  const history = await svc.getCycleHistory(FORMULA_VERSION, range, UNIVERSE_VERSION);
  const sourceTradeDate = isoDate(latest.trade_date);
  const expected = expectedTradeDate();
  const stale = sourceTradeDate < expected;
  const fullHistory = history.map((r) => ({
    date: isoDate(r.trade_date),
    cycle_level: r.cycle_level,
    rolling_percentile: r.rolling_percentile,
    composite_value: r.composite_value,
    median_price: r.median_price,
    median_conversion_premium_pct: r.median_conversion_premium_pct,
    median_conversion_value: r.median_conversion_value,
    premium_weight: r.premium_weight,
    bond_count: r.bond_count,
    coverage_ratio: r.coverage_ratio,
  }));
  const responseHistory = homeView ? sampleHistory(fullHistory, req.query.maxPoints) : fullHistory;
  res.json({
    formula_version: FORMULA_VERSION,
    universe_version: UNIVERSE_VERSION,
    source: 'tushare_cb_daily',
    updated_at: latest.calculated_at,
    source_trade_date: sourceTradeDate,
    expected_trade_date: expected,
    stale,
    latest: {
      cycle_level: latest.cycle_level,
      rolling_percentile: latest.rolling_percentile,
      composite_value: latest.composite_value,
      median_price: latest.median_price,
      median_conversion_premium_pct: latest.median_conversion_premium_pct,
      median_conversion_value: latest.median_conversion_value,
      premium_weight: latest.premium_weight,
      bond_count: latest.bond_count,
      premium_count: latest.premium_count,
      coverage_ratio: latest.coverage_ratio,
    },
    history: responseHistory,
    view: homeView ? 'home' : 'full',
    diagnostics: DIAGNOSTICS,
  });
}));

module.exports = router;
module.exports.expectedTradeDate = expectedTradeDate; // 供测试验证过期判断
