// 持仓导出行的纯函数装配（Excel 导出用）。
// 唯一职责：把服务端统一估值结果转成导出行，并如实标出缺价与不完整。
// 设计约束：缺价时不得回填旧持仓价、不得输出 0 或按部分金额算比例——
// 否则导出会重新形成第二套价格，看起来还是完整的。
const { toTsCode } = require('./market');

const HEADER = ['代码', '代码', '正股/转债名称', '现价', '持有数量', '人民币市值', '持仓比例', '类型', '细类'];

function buildPositionExport(result) {
  const data = result || {};
  const hkRate = Number(data.hkRate) > 0 ? Number(data.hkRate) : 0.868;
  const positions = (data.positions || []).filter(position => Number(position.quantity) > 0);
  const rows = [HEADER.slice()];
  const missingCodes = [];
  let positionValue = 0;

  for (const position of positions) {
    const code = position.code || '';
    const canonicalCode = toTsCode(code);
    const suffix = canonicalCode.startsWith(code) ? canonicalCode.slice(code.length) : '';
    const quantity = Number(position.quantity) || 0;
    const price = Number(position.price);
    if (!(price > 0)) {
      missingCodes.push(code);
      rows.push([code, code + suffix, position.name || '', '缺价', quantity, null, null,
        position.type || '', position.subtype || '']);
      continue;
    }
    // 价格存在但资格不足（遗留未核验/兼容持仓价/过期参考价/派生价）时，
    // 只能显示这个参考价本身，不得据此输出市值和比例——否则导出里会出现“看起来已完成”的金额。
    const qualified = ['confirmed', 'candidate'].includes(String(position.priceQuality || ''));
    if (!qualified) {
      missingCodes.push(code);
      const label = position.subtype === '港股' ? 'HK$' + price.toFixed(2) : price.toFixed(2);
      rows.push([code, code + suffix, position.name || '', label + '（未确认）', quantity, null, null,
        position.type || '', position.subtype || '']);
      continue;
    }
    const marketValue = price * quantity * (position.subtype === '港股' ? hkRate : 1);
    positionValue += marketValue;
    rows.push([code, code + suffix, position.name || '',
      position.subtype === '港股' ? 'HK$' + price.toFixed(2) : price.toFixed(2),
      quantity, Math.round(marketValue * 100) / 100, null, position.type || '', position.subtype || '']);
  }

  // 只有完整总资产才允许计算比例；totalAsset 为空即代表“没有完整总资产”。
  const complete = Boolean(data.valuation && data.valuation.complete === true) && data.totalAsset != null;
  let totalAsset = null;
  if (complete) {
    const declared = Number(data.totalAsset);
    totalAsset = declared > 0 ? declared : (missingCodes.length === 0 ? positionValue : null);
  }
  for (const row of rows.slice(1)) {
    row[6] = totalAsset > 0 && row[5] != null ? Math.round(row[5] / totalAsset * 10000) / 10000 : null;
  }

  const cash = Number(data.cash) || 0;
  rows.push([null, null, null, null, null, Math.round(cash * 100) / 100,
    totalAsset > 0 ? Math.round(cash / totalAsset * 10000) / 10000 : null, '债权', '现金']);
  if (!complete) {
    const gap = missingCodes.length > 0
      ? missingCodes.length + ' 只证券缺价或价格未确认'
      : '估值数据不完整';
    rows.push([null, null, '⚠ 估值不完整：' + gap + '，合计与比例未计算', null, null, null, null, '提示', '']);
  }

  return { rows, complete, missingCodes, positionValue, totalAsset };
}

module.exports = { buildPositionExport, EXPORT_HEADER: HEADER };
