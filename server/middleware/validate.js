// ========== 服务端数据校验（防畸形/超大载荷污染数据库）==========
function validateAccountData(d) {
  if (!d || typeof d !== 'object') return { ok: false, msg: '数据格式错误' };
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const isStr = (x) => typeof x === 'string';
  const dateOk = (x) => isStr(x) && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const MAX = 5000;
  const len = (x, n) => x == null || (isStr(x) && x.length <= n);
  const ps = d.positions || [];
  if (!Array.isArray(ps) || ps.length > MAX) return { ok: false, msg: '持仓数量超限' };
  for (const p of ps) {
    if (!isStr(p.code) || p.code.length > 20) return { ok: false, msg: '持仓代码格式错误' };
    if (!len(p.name, 100)) return { ok: false, msg: '持仓名称过长' };
    if (!isNum(p.price) || p.price < 0) return { ok: false, msg: '持仓价格非法' };
    if (!isNum(p.quantity)) return { ok: false, msg: '持仓数量非法' };
    if (!isNum(p.cost) || p.cost < 0) return { ok: false, msg: '持仓成本非法' };
    if (!len(p.note, 500)) return { ok: false, msg: '持仓备注过长' };
  }
  const ts = d.trades || [];
  if (!Array.isArray(ts) || ts.length > MAX) return { ok: false, msg: '交易数量超限' };
  for (const t of ts) {
    if (!dateOk(t.date)) return { ok: false, msg: '交易日期格式错误' };
    if (t.direction && t.direction !== 'buy' && t.direction !== 'sell') return { ok: false, msg: '交易方向非法' };
    if (!isNum(t.price) || t.price < 0) return { ok: false, msg: '交易价格非法' };
    if (!isNum(t.quantity)) return { ok: false, msg: '交易数量非法' };
    if (!isNum(t.amount)) return { ok: false, msg: '交易金额非法' };
    if (!len(t.note, 500)) return { ok: false, msg: '交易备注过长' };
  }
  const ns = d.navHistory || [];
  if (!Array.isArray(ns) || ns.length > MAX) return { ok: false, msg: '净值记录超限' };
  for (const n of ns) {
    if (!dateOk(n.date)) return { ok: false, msg: '净值日期格式错误' };
    if (!isNum(n.nav) || n.nav <= 0) return { ok: false, msg: '净值非法' };
    if (!isNum(n.totalAsset) || n.totalAsset < 0) return { ok: false, msg: '总市值非法' };
    if (n.invested != null && !isNum(n.invested)) return { ok: false, msg: '投入金额非法' };
  }
  const cs = d.cashFlows || [];
  if (!Array.isArray(cs) || cs.length > MAX) return { ok: false, msg: '现金流记录超限' };
  for (const c of cs) {
    if (!dateOk(c.date)) return { ok: false, msg: '现金流日期格式错误' };
    if (!isNum(c.amount)) return { ok: false, msg: '现金流金额非法' };
    if (!len(c.note, 500)) return { ok: false, msg: '现金流备注过长' };
  }
  return { ok: true };
}

module.exports = validateAccountData;
