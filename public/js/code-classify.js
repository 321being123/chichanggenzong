// ============================================================
// code-classify.js – 代码→品种 单一分类函数（前后端共用）
//
// 浏览器: <script src="/js/code-classify.js"> 注入全局 classifyCode
// Node:    const classifyCode = require('./public/js/code-classify.js');
//
// 返回: { type, subtype, market, isHK, secids }
//   type    '股权' | '债权'
//   subtype '沪市' | '深市' | '京市' | '港股' | '美股' | '可转债' | '信用债'
//   market  'sh' | 'sz' | 'bj' | 'hk' | 'kcb' | 'us'
//   isHK    boolean
//   secids  东方财富行情 secid 候选列表（fetchQuoteByCode 使用）
//
// 额外工具: classifyCode.normalizeCode(rawCode)
//   根据分类结果补齐证券代码前导零：A股/基金/可转债 6位，港股 5位，美股不变。
//   用于 Excel/图片导入时恢复被读取成数字后丢失的前导零。
//
// 这是代码分类的唯一真相源，recognizeCode / fetchQuoteByCode /
// inferSubtype 全部委托本函数，避免 4 处前缀规则漂移。
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.classifyCode = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function classifyCode(rawCode) {
    if (!rawCode) return null;
    var code = String(rawCode).trim().toUpperCase()
      .replace(/\.(SH|SZ|HK|US)$/i, '')
      .replace(/^(SH|SZ|HK|US)/i, '');
    if (!code) return null;

    var len = code.length;
    var first1 = code.substring(0, 1);
    var first2 = code.substring(0, 2);
    var first3 = code.substring(0, 3);
    var isHK = len <= 5;

    var type = '股权', subtype = '深市', market = 'sz';

    if (isHK) {
      type = '股权'; subtype = '港股'; market = 'hk';
    } else if (/^[A-Z]{1,4}$/.test(code)) {
      type = '股权'; subtype = '美股'; market = 'us';
    } else if (first3 === '123' || first3 === '127' || first2 === '11' || first2 === '12') {
      // 可转债（沪市 11x/113x，深市 12x）
      type = '债权'; subtype = '可转债'; market = 'sz';
      if (first1 === '1' && (first2 === '11' || first3 === '113')) market = 'sh';
    } else if (first2 === '13') {
      type = '债权'; subtype = '信用债'; market = 'sh';
    } else if (first3 === '688' || first1 === '6') {
      type = '股权'; subtype = '沪市'; market = (first3 === '688') ? 'kcb' : 'sh';
    } else if (first2 === '00' || first2 === '30') {
      type = '股权'; subtype = '深市'; market = 'sz';
    } else if (first3 === '920' || first1 === '4' || first1 === '8') {
      type = '股权'; subtype = '京市'; market = 'bj';
    } else {
      // 其他 6 位数字（基金/ETF/5 开头等）默认归入沪市，双市场尝试
      type = '股权'; subtype = '沪市'; market = 'sh';
    }

    // 东方财富行情 secid 候选列表（与原 fetchQuoteByCode 逻辑一致）
    var secids = [];
    if (isHK) {
      secids.push('0.' + code.padStart(5, '0') + '.hk');
    } else {
      if (first1 === '6' || code.startsWith('5') || code.startsWith('11')) secids.push('1.' + code);
      secids.push('0.' + code);
    }

    return { type: type, subtype: subtype, market: market, isHK: isHK, secids: secids };
  }

  function normalizeCode(rawCode) {
    if (!rawCode) return rawCode;
    var code = String(rawCode).trim().toUpperCase()
      .replace(/\.(SH|SZ|HK|US)$/i, '')
      .replace(/^(SH|SZ|HK|US)/i, '');
    if (!code) return code;

    var info = classifyCode(code);
    if (!info) return code;

    // 美股代码保持原样（字母）
    if (info.subtype === '美股') return code;
    // 港股固定 5 位
    if (info.subtype === '港股') return code.padStart(5, '0');
    // 其他数字代码（A股/基金/ETF/可转债/信用债等）统一 6 位
    if (/^\d+$/.test(code)) return code.padStart(6, '0');
    return code;
  }

  classifyCode.normalizeCode = normalizeCode;

  return classifyCode;
});
