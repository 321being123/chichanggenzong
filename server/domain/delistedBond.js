// 退市债识别：全项目唯一判定入口。
// 净值归因、净值快照和统一估值都复用这一份规则，禁止各自再写 404002 或名称正则。
// 只认明确标记为退市债的证券，避免把普通证券的旧价格误当成固定价。
function isDelistedBond(row, code) {
  const plainCode = String(code || row && (row.code || row.instrumentCode) || '')
    .toUpperCase().replace(/\.(SH|SZ|BJ|HK|US)$/i, '');
  const name = String(row && row.name || '').replace(/\s+/g, '');
  return plainCode === '404002' || /退债|退市债|退市转债/.test(name);
}

module.exports = { isDelistedBond };
