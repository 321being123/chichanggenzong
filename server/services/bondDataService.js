// ====== 可转债统一数据服务（批次1：SQL 已迁 server/repositories/bondRepository.js）======
// 统一读取层：所有可转债展示与打新读取都经过 bond_unified 视图。
//
// 当前真实调用方：
//   - getBondBySecurityCode / getBondHistoryList：ipo.js 打新日历路由（读）。
//   - 可转债主同步：convertibleBondAnalysis.js 直接写入标准主档、发行事实和事件（写）。
// 本文件只做参数校验、字段完整性判断与兼容转发，不再持有 SQL。
const { canonicalizeSecurityCode } = require('./securityIdentity');
const bondRepository = require('../repositories/bondRepository');

// 正股代码 → 标准代码（补后缀并校验已有后缀），规则与 SQL normalize_stock_code() 保持一致。
function normalizeStockCode(code) {
  return canonicalizeSecurityCode(code, 'stock');
}

async function getBondList(filters = {}) {
  return bondRepository.listBonds({ filters });
}

async function getBondDetail(code) {
  return bondRepository.findDetail({ code });
}

// 根据纯数字代码查（兼容 IPO 模块调用方式）
async function getBondBySecurityCode(securityCode) {
  return bondRepository.findBySecurityCode({ securityCode });
}

// 打新历史列表（读取统一视图）
// 对外契约：security_code 保持六位纯数字（兼容前端交易所判断/报告链接）；标准代码走 canonical_code。
// 返回字段含 first_day_return、history_stage 与 data_as_of（数据日期），
// 以及 field_status（逐字段 value/pending/missing 质量状态）；
// SQL 与质量状态构造在 server/repositories/bondRepository.js#listHistory。
async function getBondHistoryList(limit = 50) {
  return bondRepository.listHistory({ limit });
}

async function getActiveBondCodes() {
  return bondRepository.listActiveCodes();
}

async function getRatingDistribution() {
  return bondRepository.ratingDistribution();
}

// 字段完整性判断：有 bond_code + bond_name + conv_price + stock_code 就算基础完整。
async function checkBondCompleteness(code) {
  const row = await getBondDetail(code);
  if (!row) return { exists: false, complete: false, missingFields: ['all'] };
  const missing = [];
  if (!row.bond_code) missing.push('bond_code');
  if (!row.bond_name) missing.push('bond_name');
  if (!row.conv_price && !row.display_conv_price) missing.push('conv_price');
  if (!row.stock_code) missing.push('stock_code');
  if (!row.listing_date) missing.push('listing_date');
  if (!row.display_rating && !row.rating) missing.push('rating');
  if (!row.issue_size && !row.display_issue_size) missing.push('issue_size');
  if (!row.onl_date) missing.push('onl_date');
  if (!row.ann_date) missing.push('ann_date');
  // maturity_date 如果为空说明 cb_basic 也没数据，不影响基础可用性
  return { exists: true, complete: missing.length === 0, missingFields: missing, data: row };
}

module.exports = {
  getBondList,
  getBondDetail,
  getBondBySecurityCode,
  getBondHistoryList,
  getActiveBondCodes,
  getRatingDistribution,
  checkBondCompleteness,
  normalizeStockCode,
};
