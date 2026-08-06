// 统一的快照新鲜度判定。
// 只封装「规则」：调用方负责提供当前数据库水位（主档、行情、公告等），本模块只做比较并产出结构化状态。
// 不建立第二套数据链路，不访问 Tushare / 公告源。
// 状态枚举：fresh（新鲜） / needs_refresh（需刷新） / live_overlay（实时覆盖，P1 扩展） / stale_usable（过期但可用） / unavailable（不可用）。

const CONV_PRICE_EPS = 0.001; // 转股价比较容差（元）

function finiteNum(v) {
  if (v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 把 Date / 'YYYY-MM-DD' / 'YYYYMMDD' 统一成 'YYYY-MM-DD'；无法识别返回 null
function isoDateSafe(v) {
  if (v == null) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function toTimeMs(v) {
  if (v == null || v === '') return null;
  const d = (v instanceof Date) ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

// 统一转成 epoch 毫秒再比较，避免 String() 字典序在跨格式 / 跨日期时出错
function laterThan(a, b) {
  const ta = toTimeMs(a), tb = toTimeMs(b);
  if (ta == null || tb == null) return false;
  return ta > tb;
}

// 可转债新鲜度判定
// ctx: { snapshotConvPrice, snapshotAsOf, snapshotCreatedAt, profileConvPrice, profileUpdatedAt,
//        latestBondTradeDate, latestStockTradeDate, currentFinancialEnd, currentRating, currentTermsHash, watermark }
function evaluateConvertibleBondFreshness(ctx = {}) {
  const reasons = [];
  const snapConv = finiteNum(ctx.snapshotConvPrice);
  const dbConv = finiteNum(ctx.profileConvPrice);
  if (snapConv != null && dbConv != null && Math.abs(snapConv - dbConv) > CONV_PRICE_EPS) {
    reasons.push({
      code: 'conv_price_mismatch',
      message: `快照转股价(${snapConv})与主档当前转股价(${dbConv})不一致`,
      snapshot_value: snapConv,
      db_value: dbConv,
    });
  }
  // 用完整时间戳比较（不截断到日期），否则同天主档晚于快照的更新无法被检出
  const dbUpdated = ctx.profileUpdatedAt;
  const snapCreated = ctx.snapshotCreatedAt;
  if (dbUpdated && snapCreated && laterThan(dbUpdated, snapCreated)) {
    reasons.push({
      code: 'profile_updated',
      message: `可转债主档已于 ${isoDateSafe(dbUpdated)} 更新，晚于快照生成时间 ${isoDateSafe(snapCreated)}`,
      profile_updated_at: isoDateSafe(dbUpdated),
    });
  }
  const bondTrade = isoDateSafe(ctx.latestBondTradeDate);
  const snapAsOf = isoDateSafe(ctx.snapshotAsOf);
  if (bondTrade && laterThan(bondTrade, snapAsOf)) {
    reasons.push({
      code: 'market_data_newer',
      message: `已有 ${bondTrade} 的新行情，快照仍停留在 ${snapAsOf}`,
    });
  }
  const wm = ctx.watermark;
  const hasWatermark = wm && typeof wm === 'object' && Object.keys(wm).length > 0;
  if (!hasWatermark) {
    reasons.push({ code: 'watermark_missing', message: '快照缺少数据依赖水位，无法证明输入仍然有效' });
  } else if (wm.conversion_price_event && typeof wm.conversion_price_event === 'object') {
    // 转股价公告已入库但快照还没吃到：即便主档尚未同步也要判失效
    // 仅对带该项水位的新版快照生效，旧版快照由 conv_price_mismatch 兜底，避免存量快照被误判
    const snapChange = isoDateSafe(wm.conversion_price_event.change_date);
    const dbChange = isoDateSafe(ctx.latestConvPriceChangeDate);
    if (dbChange && (!snapChange || laterThan(dbChange, snapChange))) {
      reasons.push({
        code: 'conv_price_event_newer',
        message: `已有 ${dbChange} 的转股价变动公告，快照尚未采用`,
        snapshot_value: snapChange,
        db_value: dbChange,
      });
    }
  }
  // 以下四项仅对「水位里确有该项」的快照生效，避免存量旧快照因缺字段被误判。
  // 正股行情：已写入水位的正股行情日若落后当前入库行情 -> 失效
  if (wm && wm.stock_daily && wm.stock_daily.trade_date
    && dateFieldNewer(ctx.latestStockTradeDate, wm.stock_daily.trade_date)) {
    reasons.push({
      code: 'stock_market_newer',
      message: `正股已有 ${isoDateSafe(ctx.latestStockTradeDate)} 的新行情，快照仍停留在 ${wm.stock_daily.trade_date}`,
    });
  }
  // 财务：已写入水位的报告期若落后当前入库财报 -> 失效
  if (wm && wm.financial && wm.financial.report_end_date
    && dateFieldNewer(ctx.currentFinancialEnd, wm.financial.report_end_date)) {
    reasons.push({
      code: 'financial_newer',
      message: `已有更新报告期 ${isoDateSafe(ctx.currentFinancialEnd)} 的财报，快照财务依赖已过期`,
    });
  }
  // 评级：已写入水位的信用评级若与当前主档评级不一致 -> 失效
  const wmRating = wm && wm.rating && wm.rating.newest_rating;
  if (wmRating != null && ctx.currentRating != null && ctx.currentRating !== wmRating) {
    reasons.push({
      code: 'rating_changed',
      message: `信用评级已变更（当前：${ctx.currentRating}，快照记录：${wmRating}）`,
    });
  }
  // 条款指纹：重算募集条款哈希与快照水位不一致 -> 失效
  if (wm && wm.terms_hash && ctx.currentTermsHash && wm.terms_hash !== ctx.currentTermsHash) {
    reasons.push({
      code: 'terms_changed',
      message: '募集条款已变更，快照条款依赖已过期',
    });
  }
  const needs_refresh = reasons.length > 0;
  return {
    status: needs_refresh ? 'needs_refresh' : 'fresh',
    needs_refresh,
    reasons,
    evaluated_at: new Date().toISOString(),
  };
}

// 当前 DB 实际值是否比快照水位更新（日期维度严格大于）；当前有值而水位缺也判为更新
function dateFieldNewer(cur, snap) {
  const c = isoDateSafe(cur), s = isoDateSafe(snap);
  if (!c) return false;
  if (!s) return true;
  return laterThan(c, s);
}

// 股票新鲜度判定
// ctx: { watermark, formula_bundle_version, expected_formula_version, latestTradeDate, current }
//   current: 当前数据库实际值 { financialEnd, financialAnn, dividendAnn, dividendEx, guidanceAnn, guidanceEnd, industryName, controllerName, eventDate }
function evaluateStockFreshness(ctx = {}) {
  const reasons = [];
  const wm = ctx.watermark;
  const cur = ctx.current || {};
  const isLegacy = !wm || (wm.source === 'legacy_projection' && Object.keys(wm).length === 1);
  if (isLegacy) {
    reasons.push({ code: 'watermark_legacy', message: '股票快照仍为旧版占位水位，需补全数据依赖后再确认有效性' });
  } else if (!wm.market || !wm.financial) {
    reasons.push({ code: 'watermark_incomplete', message: '快照水位缺少行情或财报依赖，无法证明输入仍然有效' });
  } else {
    const wmMarket = wm.market || {};
    const wmFinancial = wm.financial || {};
    const wmDividend = wm.dividend || {};
    const wmGuidance = wm.guidance || {};
    const wmIndustry = wm.industry || {};
    const wmController = wm.controller || {};
    const wmEvent = wm.event || {};
    const dbTrade = isoDateSafe(ctx.latestTradeDate);
    const snapTrade = isoDateSafe(wmMarket.trade_date);
    if (dbTrade && laterThan(dbTrade, snapTrade)) {
      reasons.push({
        code: 'market_data_newer',
        message: `已有 ${dbTrade} 的新行情，快照仍停留在 ${snapTrade}`,
      });
    }
    // 财报更正：报告期或公告日更新
    if (dateFieldNewer(cur.financialEnd, wmFinancial.report_end_date)
      || dateFieldNewer(cur.financialAnn, wmFinancial.report_ann_date)) {
      reasons.push({ code: 'financial_newer', message: '已有更新的财报（报告期或公告日），快照财务依赖已过期' });
    }
    // 分红方案：公告日或除权日更新
    if (dateFieldNewer(cur.dividendAnn, wmDividend.latest_ann_date)
      || dateFieldNewer(cur.dividendEx, wmDividend.latest_ex_date)) {
      reasons.push({ code: 'dividend_newer', message: '已有更新的分红方案（公告日或除权日），快照分红依赖已过期' });
    }
    // 业绩预告：公告日或报告期更新
    if (dateFieldNewer(cur.guidanceAnn, wmGuidance.ann_date)
      || dateFieldNewer(cur.guidanceEnd, wmGuidance.end_date)) {
      reasons.push({ code: 'guidance_newer', message: '已有更新的业绩预告，快照预告依赖已过期' });
    }
    // 行业：当前所属行业与水位记录不一致
    if (cur.industryName && cur.industryName !== wmIndustry.name) {
      reasons.push({ code: 'industry_changed', message: `所属行业已变更（当前：${cur.industryName}）` });
    }
    // 控制人：当前实际控制人与水位记录不一致
    if (cur.controllerName && cur.controllerName !== wmController.name) {
      reasons.push({ code: 'controller_changed', message: `实际控制人已变更（当前：${cur.controllerName}）` });
    }
    // 事件：已有更新的官方事件
    if (dateFieldNewer(cur.eventDate, wmEvent.latest_event_date)) {
      reasons.push({ code: 'event_newer', message: '已有更新的官方事件，快照事件依赖已过期' });
    }
  }
  if (ctx.formula_bundle_version && ctx.expected_formula_version
    && ctx.formula_bundle_version !== ctx.expected_formula_version) {
    reasons.push({
      code: 'formula_version_mismatch',
      message: `分析公式版本(${ctx.formula_bundle_version})与最新版本(${ctx.expected_formula_version})不一致`,
    });
  }
  const needs_refresh = reasons.length > 0;
  return {
    status: needs_refresh ? 'needs_refresh' : 'fresh',
    needs_refresh,
    reasons,
    evaluated_at: new Date().toISOString(),
  };
}

const STOCK_FORMULA_VERSION = '1';

module.exports = {
  evaluateConvertibleBondFreshness,
  evaluateStockFreshness,
  isoDateSafe,
  STOCK_FORMULA_VERSION,
  CONV_PRICE_EPS,
};
