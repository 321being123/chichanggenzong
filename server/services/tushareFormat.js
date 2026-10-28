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

module.exports = { tsRows, tsDateStr };
