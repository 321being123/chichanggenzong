// ========== 服务端数据校验（防畸形/超大载荷污染数据库）==========
// 仅允许“不含 HTML/脚本元字符”的字符串，从根上阻断持久型 XSS 注入
const SAFE_TEXT = /^[^<>"'&]*$/;
function validateAccountData(d) {
  if (!d || typeof d !== 'object') return { ok: false, msg: '数据格式错误' };
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const isStr = (x) => typeof x === 'string';
  // 净值/现金流日期：兼容 YYYY-MM-DD 和 ISO 带时间格式（SheetJS cellDates:true 序列化结果）
  const dateOk = (x) => isStr(x) && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(x);
  // 兼容两种时间格式：YYYY-MM-DD | YYYY-MM-DD HH:MM | YYYY-MM-DD HH:MM:SS
  // 前端交易录入用 HH:MM，created_at 等内部时间戳用 HH:MM:SS
  const dateTimeOk = (x) => isStr(x) && /^\d{4}-\d{2}-\d{2}( (\d{2}:\d{2}(:\d{2})?)?)?$/.test(x);
  const MAX = 5000;
  const len = (x, n) => x == null || (isStr(x) && x.length <= n);
  // 文本内容白名单：禁止 < > " ' & 等可构成 HTML/脚本的字符
  const safeText = (x, n) => x == null || (isStr(x) && x.length <= n && SAFE_TEXT.test(x));
  // ID 仅允许字母数字与 _ -（与前端 uid() 生成规则一致）
  const safeId = (x) => x == null || (isStr(x) && x.length > 0 && x.length <= 40 && /^[A-Za-z0-9_-]+$/.test(x));
  const ps = d.positions || [];
  if (!Array.isArray(ps) || ps.length > MAX) return { ok: false, msg: '持仓数量超限' };
  for (const p of ps) {
    if (!isStr(p.code) || p.code.length > 20) return { ok: false, msg: '持仓代码格式错误' };
    if (!safeId(p.id)) return { ok: false, msg: '持仓ID非法' };
    if (!safeText(p.name, 100)) return { ok: false, msg: '持仓名称含非法字符' };
    if (!isNum(p.price) || p.price < 0) return { ok: false, msg: '持仓价格非法' };
    if (!isNum(p.quantity)) return { ok: false, msg: '持仓数量非法' };
    if (!isNum(p.cost)) return { ok: false, msg: '持仓成本非法' };
    if (!safeText(p.type, 20)) return { ok: false, msg: '持仓类型非法' };
    if (!safeText(p.subtype, 20)) return { ok: false, msg: '持仓细类非法' };
    if (!safeText(p.note, 500)) return { ok: false, msg: '持仓备注含非法字符' };
  }
  const ts = d.trades || [];
  if (!Array.isArray(ts) || ts.length > MAX) return { ok: false, msg: '交易数量超限' };
  for (const t of ts) {
    if (!dateTimeOk(t.date)) return { ok: false, msg: '交易日期格式错误' };
    if (t.direction && t.direction !== 'buy' && t.direction !== 'sell') return { ok: false, msg: '交易方向非法' };
    if (!isNum(t.price) || t.price < 0) return { ok: false, msg: '交易价格非法' };
    if (!isNum(t.quantity)) return { ok: false, msg: '交易数量非法' };
    if (!isNum(t.amount)) return { ok: false, msg: '交易金额非法' };
    if (!safeId(t.id)) return { ok: false, msg: '交易ID非法' };
    if (!safeText(t.name, 100)) return { ok: false, msg: '交易名称含非法字符' };
    if (!safeText(t.type, 20)) return { ok: false, msg: '交易类型非法' };
    if (!safeText(t.subtype, 20)) return { ok: false, msg: '交易细类非法' };
    if (!safeText(t.note, 500)) return { ok: false, msg: '交易备注含非法字符' };
    if (t.created_at != null && !dateTimeOk(t.created_at)) return { ok: false, msg: '交易时间格式非法' };
  }
  const ns = d.navHistory || [];
  if (!Array.isArray(ns) || ns.length > MAX) return { ok: false, msg: '净值记录超限' };
  for (const n of ns) {
    if (!dateOk(n.date)) return { ok: false, msg: '净值日期格式错误' };
    if (!isNum(n.nav) || n.nav < 0) return { ok: false, msg: '净值非法' };
    if (n.totalAsset != null && (!isNum(n.totalAsset) || n.totalAsset < 0)) return { ok: false, msg: '总市值非法' };
    if (n.invested != null && !isNum(n.invested)) return { ok: false, msg: '投入金额非法' };
  }
  const cs = d.cashFlows || [];
  if (!Array.isArray(cs) || cs.length > MAX) return { ok: false, msg: '现金流记录超限' };
  for (const c of cs) {
    if (!dateOk(c.date)) return { ok: false, msg: '现金流日期格式错误' };
    if (!isNum(c.amount)) return { ok: false, msg: '现金流金额非法' };
    if (!safeId(c.id)) return { ok: false, msg: '现金流ID非法' };
    if (!safeText(c.note, 500)) return { ok: false, msg: '现金流备注含非法字符' };
    if (c.created_at != null && !dateTimeOk(c.created_at)) return { ok: false, msg: '现金流时间格式非法' };
  }
  if (d.cashType != null && !safeText(d.cashType, 20)) return { ok: false, msg: '现金类型非法' };
  if (d.cashSubtype != null && !safeText(d.cashSubtype, 20)) return { ok: false, msg: '现金细类非法' };
  if (d.feeSettings != null) {
    if (!d.feeSettings || typeof d.feeSettings !== 'object' || Array.isArray(d.feeSettings)) return { ok: false, msg: '税费设置格式错误' };
    const feeGroups = ['ashare_stock', 'ashare_bond', 'ashare_fund', 'hk_stock', 'us_stock', 'otc_fund'];
    const feeFields = ['commissionRate', 'commissionMin', 'stampTaxRate', 'transferRate', 'transferCap', 'otherRate'];
    for (const group of Object.keys(d.feeSettings)) {
      if (!feeGroups.includes(group) || !d.feeSettings[group] || typeof d.feeSettings[group] !== 'object') return { ok: false, msg: '税费设置分组非法' };
      for (const field of Object.keys(d.feeSettings[group])) {
        const value = d.feeSettings[group][field];
        if (!feeFields.includes(field) || !isNum(value) || value < 0) return { ok: false, msg: '税费设置数值非法' };
      }
    }
  }
  // 顶层标量字段边界（P1-3）：汇率/本金/总市值/基金记录必须合法，杜绝负汇率、负本金等畸形值落库
  if (d.cashBase != null && (!isNum(d.cashBase) || d.cashBase < 0)) return { ok: false, msg: '期初本金（cashBase）必须为非负数' };
  // 港币汇率必须为正（负汇率或 0 会让港股市值归零/反转，属高危畸形值）
  if (d.hkRate != null && (!isNum(d.hkRate) || d.hkRate <= 0 || d.hkRate > 100)) return { ok: false, msg: '港币汇率（hkRate）必须为正数' };
  if (d.totalAsset != null && (!isNum(d.totalAsset) || d.totalAsset < 0)) return { ok: false, msg: '总市值（totalAsset）必须为非负数' };
  // 基金记录：数组且有界，元素为安全文本（禁止 HTML 注入）
  if (d.fundRecord != null) {
    if (!Array.isArray(d.fundRecord) || d.fundRecord.length > 1000) return { ok: false, msg: '基金记录格式或数量超限' };
    for (const f of d.fundRecord) {
      if (!safeText(f, 200)) return { ok: false, msg: '基金记录含非法字符或超长' };
    }
  }
  return { ok: true };
}

// 账户名白名单：1~50 字符，禁止 < > " ' &（与持仓/交易文本规则一致）
function isValidAccountName(x) {
  return typeof x === 'string' && x.length >= 1 && x.length <= 50 && /^[^<>"'&]*$/.test(x);
}

module.exports = { validateAccountData, isValidAccountName };
