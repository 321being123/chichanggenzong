// 中立数据读取网关（批次1，方案 4.1）。
//
// 约定：
//   - 业务只提出数据需求（证券、所需字段、质量要求），不传供应商 URL、接口名、Token 或主备角色。
//   - readValuation（事实）：先读本地已落库事实 → 仅在字段不满足且允许外采时，按登记顺序尝试适配器。
//     **备源判定以"必需字段是否齐备"为准**——主源返回了行但缺必需字段，仍继续尝试下一个备源；
//     适配器抛异常只记入 externalCalls 并继续，不中断整批读取。
//   - readQuotes（实时报价）：允许外采时按登记顺序取；同样对异常逐源降级，
//     取不到的证券留在 missing，由调用方按"无实时报价"处理（不伪造价格）。
//   - 网关不重排库内候选、不改写标准口径；仓储不触发外采；业务不做第三次优选。
//   - 估值外采适配器（adapters）默认为空：估值事实读取走纯本地；
//     接入新来源必须在 governance/architecture-boundaries.json 登记为 data_adapter 并在批次2/3 建档。
const stockRepository = require('../repositories/stockRepository');
const { tencentQuoteAdapter } = require('./adapters/tencentQuoteAdapter');

function createMarketDataGateway({
  repository = stockRepository,
  adapters = [],
  quoteAdapters = [],
  allowExternal = false,
} = {}) {
  if (!Array.isArray(adapters)) throw new TypeError('adapters 必须是数组');
  if (!Array.isArray(quoteAdapters)) throw new TypeError('quoteAdapters 必须是数组');
  const ordered = adapters.map((adapter, index) => ({ ...adapter, order: index }));
  const orderedQuoteAdapters = quoteAdapters.map((adapter, index) => ({ ...adapter, order: index }));

  // 必需字段是否齐备：null/undefined 算缺；0 与空串算有值，避免把合法零值当成缺字段。
  function absentFields(row, requireFields) {
    return requireFields.filter(field => row == null || row[field] === null || row[field] === undefined);
  }

  return {
    /**
     * 读取证券估值事实。
     * @param {{codes: string[], requireFields?: string[], allowExternal?: boolean, tx?: object}} demand
     * @returns {Promise<{rows: object[], missing: object[], externalCalls: object[], strategy: string}>}
     */
    async readValuation(demand = {}) {
      const codes = Array.isArray(demand.codes) ? demand.codes.filter(Boolean) : [];
      const requireFields = Array.isArray(demand.requireFields) ? demand.requireFields : [];
      if (!codes.length) return { rows: [], missing: [], externalCalls: [], strategy: 'empty' };

      // 同一事务 client 由调用方传入；只读单语句，缺省用连接池。
      const local = await repository.listLatestValuations({ codes }, demand.tx);
      const byCode = new Map(local.map(row => [row.stock_code, row]));
      const satisfied = [];
      const unmet = [];
      for (const code of codes) {
        const row = byCode.get(code);
        const absent = absentFields(row, requireFields);
        if (row && absent.length === 0) satisfied.push(row);
        else unmet.push({ code, absent, localRow: row || null });
      }
      if (!unmet.length) return { rows: satisfied, missing: [], externalCalls: [], strategy: 'local' };

      const externalAllowed = demand.allowExternal === undefined ? allowExternal : Boolean(demand.allowExternal);
      if (!externalAllowed || !ordered.length) {
        return { rows: satisfied, missing: unmet, externalCalls: [], strategy: externalAllowed ? 'no_adapter' : 'local_only' };
      }

      const filled = [];
      const externalCalls = [];
      for (const item of unmet) {
        for (const adapter of ordered) {
          let result;
          try {
            result = await adapter.fetchValuation({ code: item.code, requireFields });
          } catch (error) {
            // 单个来源失败不中断整批：记录后尝试下一个备源。
            externalCalls.push({
              source: adapter.source, code: item.code, ok: false,
              error: (error && error.message) || String(error),
            });
            continue;
          }
          if (!result) {
            externalCalls.push({ source: adapter.source, code: item.code, ok: false, reason: 'no_result' });
            continue;
          }
          const absent = absentFields(result, requireFields);
          if (absent.length) {
            // 主源有返回但缺必需字段：不算成功，继续尝试备源。
            externalCalls.push({ source: adapter.source, code: item.code, ok: false, reason: 'missing_fields', missing: absent });
            continue;
          }
          externalCalls.push({ source: adapter.source, code: item.code, ok: true });
          filled.push({ ...result, stock_code: result.stock_code || item.code, source: adapter.source });
          break;
        }
      }
      const filledCodes = new Set(filled.map(item => item.stock_code));
      return {
        rows: [...satisfied, ...filled],
        missing: unmet.filter(item => !filledCodes.has(item.code)),
        externalCalls,
        strategy: filled.length ? 'external' : 'local_only',
      };
    },

    /**
     * 读取实时报价。返回 Map 的键由适配器 keyOf 决定（当前为去除交易所后缀的大写代码）。
     * allowExternal=false 时零外采，返回空 Map（与"只读页面不取行情"一致）。
     * @param {{codes: string[], allowExternal?: boolean}} demand
     * @returns {Promise<{quotes: Map<string, object>, missing: string[], externalCalls: object[], strategy: string}>}
     */
    async readQuotes(demand = {}) {
      const codes = Array.isArray(demand.codes) ? demand.codes.filter(Boolean) : [];
      if (!codes.length) return { quotes: new Map(), byCode: new Map(), missing: [], externalCalls: [], strategy: 'empty' };
      const externalAllowed = demand.allowExternal === undefined ? allowExternal : Boolean(demand.allowExternal);
      if (!externalAllowed || !orderedQuoteAdapters.length) {
        return {
          quotes: new Map(), byCode: new Map(), missing: codes, externalCalls: [],
          strategy: externalAllowed ? 'no_adapter' : 'readonly',
        };
      }

      const quotes = new Map();
      // byCode 用调用方传入的原始代码作键，业务侧无需知道各来源的代码归一规则。
      const byCode = new Map();
      const externalCalls = [];
      let pending = codes.slice();
      for (const adapter of orderedQuoteAdapters) {
        if (!pending.length) break;
        const keyOf = typeof adapter.keyOf === 'function' ? adapter.keyOf : (code => code);
        let returned;
        try {
          returned = await adapter.fetchQuotes({ codes: pending.slice() });
        } catch (error) {
          // 行情源异常同样逐源降级：本次读取视为"无实时报价"，不伪造、不中断。
          externalCalls.push({
            source: adapter.source, ok: false,
            error: (error && error.message) || String(error),
          });
          continue;
        }
        const map = returned instanceof Map ? returned : new Map();
        const stillPending = [];
        for (const code of pending) {
          const key = keyOf(code);
          if (map.has(key)) {
            quotes.set(key, map.get(key));
            byCode.set(code, map.get(key));
          } else stillPending.push(code);
        }
        externalCalls.push({
          source: adapter.source, ok: true,
          requested: pending.length, filled: pending.length - stillPending.length,
        });
        pending = stillPending;
      }
      return {
        quotes,
        byCode,
        missing: pending,
        externalCalls,
        strategy: quotes.size ? 'external' : 'unavailable',
      };
    },
  };
}

module.exports = {
  createMarketDataGateway,
  defaultGateway: createMarketDataGateway({ quoteAdapters: [tencentQuoteAdapter] }),
};
