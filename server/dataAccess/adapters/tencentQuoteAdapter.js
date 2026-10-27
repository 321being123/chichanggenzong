// 腾讯行情适配器（批次1/4，方案 4.1 的 data_adapter 落点）。
//
// 约定：
//   - 适配器只负责"取一次外部结果并原样返回"，不做缓存策略、不做业务判定、不吞异常。
//   - 异常交由网关捕获并记入 externalCalls，由网关决定是否继续尝试下一个备源。
//   - keyOf 提供该来源使用的代码归一规则，供网关判断"哪些证券已被补齐"，避免网关依赖具体来源。
const { fetchTencentQuotes, normalizeCode } = require('../../services/tencentQuote');

const tencentQuoteAdapter = {
  source: 'tencent-quote',
  keyOf: normalizeCode,
  // 返回 Map<normalizeCode(code), quote>
  async fetchQuotes({ codes }) {
    return fetchTencentQuotes(codes);
  },
};

module.exports = { tencentQuoteAdapter };
