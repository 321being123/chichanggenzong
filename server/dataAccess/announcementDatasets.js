// 数据层：公告数据集中立需求入口。
//
// 上层只说「要哪只证券/哪个日期区间的公告」，不表达"从哪家取"。
// 现有合同：交易所原文优先（沪→上交所、深→深交所、其余→巨潮），聚合层（Tushare anns_d）只做按日期批量兜底；
// 理杏仁也有公告接口（cn/company/announcement），但它返回的就是交易所原文 PDF 链接，经它反而多一跳，
// 因此发现层仍直连原文来源，这条口径写在技术架构里。
// 直连底层：查询走 services/tushare，格式化走 services/tushareFormat（零 I/O 纯工具）。
const { tushareQuery } = require('../services/tushare');
const { tsRows } = require('../services/tushareFormat');
const defaultAdapter = require('./adapters/announcementSourceAdapter');

const ABORT_CODES = new Set(['JOB_BUDGET_EXCEEDED', 'POLICY_NOT_CONFIGURED', 'DATASET_LOCKED']);

function isAbort(error) {
  return Boolean(error && ABORT_CODES.has(error.code));
}

// 采集口可注入：默认用真实适配器；测试注入桩即可验证「交易所原文优先→巨潮兜底」的选源语义，
// 不需要把选源逻辑复制到测试里。
function createAnnouncementReader({ adapter = defaultAdapter } = {}) {
  // 单只证券的公告：沪市先问上交所，深市先问深交所，其余或失败再问巨潮。
  // 返回 { events, source }，events 里 is_official 为 true 表示来自交易所原文站点。
  async function readAnnouncementEvents({ tsCode, startDate, endDate, structured = true } = {}) {
    const code = String(tsCode || '').toUpperCase();
    // 交易所/巨潮适配器统一吃 YYYYMMDD（调用方可能传带横线的日期），在这里归一，避免上层各自处理。
    const from = String(startDate || '').replace(/-/g, '');
    const to = String(endDate || '').replace(/-/g, '');
    const exchange = code.endsWith('.SH') ? 'sse' : code.endsWith('.SZ') ? 'szse' : null;
    const call = async (fetcher, source) => {
      const result = await fetcher(code, from, to, '', { structured });
      if (!result || !result.complete || !Array.isArray(result.events)) {
        throw new Error(`${source} 公告采集未完成`);
      }
      return { events: result.events.filter(event => event.is_official), source };
    };
    if (exchange) {
      try {
        return await call(exchange === 'sse' ? adapter.fetchSseEvents : adapter.fetchSzseEvents, exchange);
      } catch (error) {
        if (isAbort(error)) throw error;
        console.warn(`[数据层] ${exchange} 公告不可用，改用巨潮：${String(error.message).slice(0, 120)}`);
      }
    }
    return call(adapter.fetchCninfoEvents, 'cninfo');
  }

  // 按日期区间只走聚合层（Tushare anns_d）：给"交易所批量已覆盖、只差聚合层补漏"的调用方用。
  async function readAggregateAnnouncementBatch({ startDate, endDate } = {}) {
    const data = await tushareQuery('anns_d', {
      start_date: String(startDate).replace(/-/g, ''), end_date: String(endDate).replace(/-/g, ''),
    }, 'ts_code,ann_date,title,url', { allowEmpty: true });
    const rows = tsRows(data);
    return rows.map(row => ({
      source: 'tushare',
      source_number: `${row.ts_code || ''}:${row.ann_date || ''}:${row.title || ''}`,
      stock_code: adapter.announcementStockCode(row, String(row.ts_code || '').endsWith('.SH') ? 'SH' : 'SZ'),
      event_date: String(row.ann_date || '').replace(/-/g, ''),
      title: String(row.title || ''),
      url: String(row.url || ''),
      category: adapter.eventCategory(row.title || ''),
      is_official: false,
      raw: row,
    })).filter(event => event.event_date && event.title && event.url);
  }

  // 按日期区间批量取公告（转债公告回补用）：先交易所批量，再巨潮批量，最后聚合层按日期兜底。
  // 返回 { events, sources }，sources 记录每个成功来源的条数，供调用方诊断。
  async function readAnnouncementBatch({ startDate, endDate, includeAggregate = true } = {}) {
    const events = [];
    const sources = {};
    const attempts = [
      ['sse', () => adapter.fetchSseEventsBatch(startDate, endDate)],
      ['szse', () => adapter.fetchSzseEventsBatch(startDate, endDate)],
      ['cninfo', () => adapter.fetchCninfoEventsBatch(startDate, endDate)],
    ];
    for (const [source, fetcher] of attempts) {
      try {
        const result = await fetcher();
        const list = Array.isArray(result) ? result : (result && result.events) || [];
        if (list.length) {
          events.push(...list);
          sources[source] = list.length;
        }
      } catch (error) {
        if (isAbort(error)) throw error;
        console.warn(`[数据层] ${source} 公告批量不可用：${String(error.message).slice(0, 120)}`);
      }
    }
    if (includeAggregate && !events.length) {
      try {
        const aggregate = await readAggregateAnnouncementBatch({ startDate, endDate });
        if (aggregate.length) {
          events.push(...aggregate);
          sources.tushare = aggregate.length;
        }
      } catch (error) {
        if (isAbort(error)) throw error;
        console.warn(`[数据层] 按日期公告批量不可用：${String(error.message).slice(0, 120)}`);
      }
    }
    return { events: adapter.dedupeAnnouncementEvents(events), sources };
  }

  return { readAggregateAnnouncementBatch, readAnnouncementBatch, readAnnouncementEvents };
}

const defaultReader = createAnnouncementReader();

// 港股公告发现（港交所披露易）：参数形态与 A 股不同（按日期区间 + 证券代码检索），
// 单独一个入口，上层只说"要某只港股某区间的公告"。
async function readHkexAnnouncements({ fromDate, toDate, stockCode } = {}) {
  return require('../services/hkexAnnouncement').searchAnnouncements({ fromDate, toDate, stockCode });
}

module.exports = {
  createAnnouncementReader,
  readHkexAnnouncements,
  ...defaultReader,
};
