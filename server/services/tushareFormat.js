// Tushare 响应格式化纯工具（零 I/O，数据层可共用）。
function tsRows(data) {
  if (!data || !Array.isArray(data.items)) return [];
  const fields = data.fields || [];
  return data.items.map((it) => { const o = {}; fields.forEach((f, i) => o[f] = it[i]); return o; });
}

function tsDateStr(d) {
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return '' + cn.getUTCFullYear() + p(cn.getUTCMonth() + 1) + p(cn.getUTCDate());
}

// 统一日期格式为 YYYY-MM-DD：上游 trade_date 是 20230101，行情源多是横线格式。
function normDate(s) {
  const text = String(s == null ? '' : s);
  if (/^\d{8}$/.test(text)) return text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8);
  return text;
}

module.exports = { tsRows, tsDateStr, normDate };
