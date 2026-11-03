// 官网/Tushare 数据同步：中债 10 年期、恒指历史 PE；港股基准利率使用美国十年期国债收益率替代。
// 不用第三方替代中证全指 PE；该数据源未拿到精确 000985 指数值时保持缺失。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const grahamRepository = require('../repositories/marketGrahamRepository');
const marketYieldRepository = require('../repositories/marketYieldRepository');
const { tushareQuery, tsRows, normDate } = require('../services/market');
const { expectedTradeDate } = require('../routes/bondCycle');


function dateStr(d) { return d.toISOString().slice(0, 10); }
async function parseHsiWorkbook(buffer) {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const workbook = new (require('exceljs').Workbook)();
    await workbook.xlsx.load(buffer);
    if (!workbook.worksheets[0]) throw new Error('恒指 PE 文件没有工作表');
    return workbook.worksheets[0].getSheetValues().slice(1).map(row => row.slice(1));
  }
  return new Promise((resolve, reject) => {
  // 官方文件为旧版 xls；通过 requirements.txt 中受控的 pandas/xlrd 解析，避免引入有高危漏洞的 Node xlsx 包。
  const code = "import sys,io,json,pandas as p; print(json.dumps(p.read_excel(io.BytesIO(sys.stdin.buffer.read()),header=None).fillna('').values.tolist(),default=str))";
  const localPython = path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe');
  const python = process.env.PYTHON || (process.platform === 'win32' && fs.existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python.exe' : 'python3');
  const child = spawn(python, ['-c', code], { stdio: ['pipe', 'pipe', 'pipe'] }); let out='', err='';
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c); child.on('error', reject);
  child.on('close', n => { if (n !== 0) return reject(new Error('恒指 PE 文件解析失败（退出码 ' + n + '）：' + err)); try { resolve(JSON.parse(out)); } catch(e) { reject(e); } }); child.stdin.end(buffer);
}); }
async function syncChinaYield(start, end) {
  // 10 年国债属于「宏观数据集」：只向数据层要序列，主备来源与单位换算由数据层完成。
  const { readSovereignYieldSeries } = require('../dataAccess/marketDatasets');
  const rows = await readSovereignYieldSeries({ startDate: start, endDate: end });
  let saved = 0;
  for (const row of rows) {
    await marketYieldRepository.saveChinaYield(row, row.source_code || undefined);
    saved += 1;
  }
  if (saved) console.log(`[市场周期] 中国10年国债 写入=${saved}条（来源=${rows[0].source_code}）`);
  return saved;
}
// 「A股市场 PE」只认理杏仁官方：`cn/index/fundamental` 的 `pe_ttm.mcw`＝站内页面「总市值加权」口径。
// 沪深300（000300）自 2005-04-08 指数发布日起；中证全指（000985）自 2011-08-02 起（上线日，2011-08-01 无值）。
// 中证指数官网是**另一种算法**（整体法：Σ总市值 ÷ Σ净利润），与官方口径同日差 −17.6%～+18.7% 且随时间变化，
// 掺在同一条序列里会让格雷厄姆指数失真，因此这里不再回落中证官网：官方取不到就是本次失败（任务记 failed），
// 不写另一种口径的值冒充。中证官网的历史行已按一次性脚本清理（scripts/backfillCsiAllPeOfficial.js，支持 --benchmark）。
const CSI_OFFICIAL_PE_SINCE = Object.freeze({ CSI300: '2005-04-08', CSIALL: '2011-08-01' });
const CSI_OFFICIAL_PE_CHUNK_YEARS = 5; // 官方单次区间过长会返回空（实测 15 年返回 0 行，5 年正常）
const CSI_OFFICIAL_SOURCE = 'lixinger_official';
// 指数估值历史表的 index_code：沪深300 用既有基准代码，A股全市场用中证全指的真实指数代码 000985。
// 投资策略选股按方案 3.2 只认这张表的市值加权 PB，因此市场周期阶段必须把官方 PE/PB 一起写进来。
const CSI_INDEX_HISTORY_CODE = Object.freeze({ CSI300: 'CSI300', CSIALL: '000985' });
function csiPeChunks(since, end, years = CSI_OFFICIAL_PE_CHUNK_YEARS) {
  const chunks = [];
  let startYear = Number(String(since).slice(0, 4));
  const endYear = Number(String(end).slice(0, 4));
  let cursor = since; // 首段用真实起点（可能不是 01-01），后续段从年初开始
  while (startYear <= endYear) {
    const lastYear = Math.min(endYear, startYear + years - 1);
    const endOfChunk = lastYear === endYear ? end : `${lastYear}-12-31`;
    chunks.push([cursor, endOfChunk]);
    startYear = lastYear + 1;
    cursor = `${startYear}-01-01`;
  }
  return chunks;
}

// 返回写入条数；0 表示官方这条链路没有产出（调用方按失败处理，不回退中证官网）。
async function syncCsiPeFromOfficial(benchmark, indexCode, options = {}) {
  const since = options.fullSince || CSI_OFFICIAL_PE_SINCE[benchmark];
  if (!since) return 0;
  const today = dateStr(new Date());
  let from = since;
  if (!options.fullSince) {
    // 水位按来源看：官方还没有过数据就从指数上线日全量回填，否则往前 45 天重叠窗口。
    const wm = await marketYieldRepository.readCsiWatermark(benchmark, 'lixinger_official');
    const maxDate = wm.rows[0] && wm.rows[0].mx;
    if (maxDate) from = dateStr(new Date(new Date(maxDate).getTime() - 45 * 86400000));
  }
  const { readIndexValuationSeries } = require('../dataAccess/marketDatasets');
  let written = 0;
  for (const [start, end] of csiPeChunks(from, today)) {
    // allowFallback=false：只回官方数据。数据层的指数估值入口默认还会回退 Tushare index_dailybasic，
    // 那是另一种算法（整体法），若被这里按官方名义落库就是来源误标（复核样本：官方返空、Tushare=77，
    // 结果写成「理杏仁 77」）。回退关掉后官方没有就是空，走下面的失败分支。
    const rows = await readIndexValuationSeries({ indexCode, startDate: start, endDate: end, allowFallback: false });
    const kept = [];
    const keptForHistory = [];
    const foreignSources = new Set();
    for (const row of rows || []) {
      if (row.source_code && row.source_code !== CSI_OFFICIAL_SOURCE) { foreignSources.add(String(row.source_code)); continue; }
      const pe = Number(row.pe);
      const pb = Number(row.pb);
      if (!row.day) continue;
      // 选股需要指数 PB：官方同一响应里就有 pb.mcw，不能因为 PE 缺失把整行丢掉。
      if ((pe > 0) || (pb > 0)) keptForHistory.push({ day: row.day, pe: pe > 0 ? pe : null, pb: pb > 0 ? pb : null, marketCap: row.marketCap ?? null, raw: row.raw });
      if (!(pe > 0)) continue;
      kept.push({ day: row.day, pe, raw: row.raw });
    }
    // 万一数据层以后又把回退打开，这里也不许把别家口径写成官方：直接失败，不静默落库。
    if (foreignSources.size) {
      throw new Error(`指数PE(${benchmark}) 数据层返回非官方来源（${[...foreignSources].join(',')}），拒绝按官方口径落库`);
    }
    if (!kept.length && !keptForHistory.length) continue;
    // 市场周期既有消费者仍读 market_valuation_daily 的 PE；选股需要的 PE+PB 写入指数估值历史表，
    // 两条写入同源同方法，不新增第三套市场估值事实表。
    if (kept.length) await marketYieldRepository.saveCsiValuations(benchmark, kept, CSI_OFFICIAL_SOURCE);
    const historyCode = CSI_INDEX_HISTORY_CODE[benchmark];
    if (historyCode && keptForHistory.length) {
      await marketYieldRepository.saveIndexValuationHistoryRows({
        indexCode: historyCode, rows: keptForHistory, sourceCode: CSI_OFFICIAL_SOURCE,
      });
    }
    written += keptForHistory.length;
  }
  if (written) console.log(`[市场周期] 指数PE(${benchmark}) 官方口径 区间(${from}起) 写入=${written}条（总市值加权 pe_ttm.mcw）`);
  return written;
}

async function syncCsiIndexPe(benchmark, indexCode) {
  // 沪深300 与 A股全市场都只走理杏仁官方：取不到就抛错让任务记失败，绝不回落另一种算法。
  if (!CSI_OFFICIAL_PE_SINCE[benchmark]) {
    throw new Error(`基准 ${benchmark} 未配置官方 PE 起点，拒绝按中证官网口径写入`);
  }
  const written = await syncCsiPeFromOfficial(benchmark, indexCode);
  if (!written) throw new Error(`${benchmark} 官方口径本次无数据写入`);
  return written;
}
async function syncHsiPe() {
  // 恒指估值属于「指数估值数据集」：官方市值加权优先、官网文件备源，均由数据层决定。
  const { readIndexValuationSeries } = require('../dataAccess/marketDatasets');
  const end = dateStr(new Date());
  const start = dateStr(new Date(Date.now() - 400 * 86400000));
  const rows = await readIndexValuationSeries({ indexCode: 'HSI', market: 'hk', startDate: start, endDate: end });
  let saved = 0;
  for (const row of rows) {
    const pe = Number(row.pe);
    const pb = Number(row.pb);
    // 恒指 PB 同样是选股的市场准入依据：官方返回 pb.mcw 时必须落库，不能只留 PE。
    if (!(pe > 0) && !(pb > 0)) continue;
    if (pe > 0) await marketYieldRepository.saveHsiMarketValuation(row.day, pe, row.raw, row.source_code);
    await marketYieldRepository.saveHsiIndexHistory(row.day, pe > 0 ? pe : null, row.raw, row.source_code, pb > 0 ? pb : null);
    saved += 1;
  }
  if (saved) console.log(`[市场周期] 恒指估值 写入=${saved}条（来源=${rows[0].source_code}）`);
  return saved;
}
const US_TREASURY_YIELD_SOURCE = 'tushare_us_tycr';

async function syncUsTreasuryYield(end = dateStr(new Date())) {
  const wm = await marketYieldRepository.readUsYieldWatermark(US_TREASURY_YIELD_SOURCE);
  const maxDate = wm.rows[0] && wm.rows[0].mx;
  const start = maxDate
    ? dateStr(new Date(new Date(maxDate + 'T00:00:00Z').getTime() - 14 * 86400000))
    : '2012-01-01';
  if (!(process.env.TUSHARE_TOKEN || process.env.TUSHARE_BACKUP_TOKEN)) return 0;

  let cursor = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  let count = 0;
  while (cursor <= last) {
    const rangeEnd = new Date(Date.UTC(cursor.getUTCFullYear() + 5, cursor.getUTCMonth(), cursor.getUTCDate() - 1));
    const to = rangeEnd < last ? rangeEnd : last;
    const fromTs = tsDate(dateStr(cursor));
    const toTs = tsDate(dateStr(to));
    // 美债收益率属于「宏观数据集」：只向数据层要，来源与窗口拼装在数据层。
    const yieldRows = await require('../dataAccess/referenceDatasets')
      .readUsTreasuryYield({ startDate: fromTs, endDate: toTs });
    const rows = yieldRows.map(row => ({
      day: normDate(row.date),
      yieldPct: Number(row.y10),
      raw: row,
    })).filter(row => row.day && Number.isFinite(row.yieldPct));
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await marketYieldRepository.saveUsYieldBatch(batch, US_TREASURY_YIELD_SOURCE);
      count += batch.length;
    }
    cursor = new Date(to.getTime() + 86400000);
  }
  console.log(`[市场周期] 美国十年期国债收益率(Tushare us_tycr) 写入=${count}条`);
  return count;
}
async function calculateGraham(pg = pool, recalcFrom = null) {
  // 水位：上次计算最大日期往前 45 天重叠窗口；仅重算本轮变化的日期
  const wm = await grahamRepository.readWatermark(pg);
  const maxDate = wm.rows[0].mx;
  const since = recalcFrom || (maxDate ? dateStr(new Date(new Date(maxDate).getTime() - 45 * 86400000)) : '2005-01-01');
  const { rows } = await grahamRepository.listInputs(pg, since);
  if (!rows.length) return 0;
  const rowsToInsert = [];
  for (const r of rows) {
    const earnings = 100 / Number(r.pe), y = Number(r.yield_pct);
    if (!(y > 0)) continue;
    const status = String(r.yield_date) === String(r.trade_date) ? 'normal' : 'carried_forward';
    rowsToInsert.push({
      market_code: r.market_code, benchmark_code: r.benchmark_code, trade_date: r.trade_date,
      pe: r.pe, earnings, y, yield_date: r.yield_date, graham: earnings - y, status,
    });
  }
  if (!rowsToInsert.length) return 0;
  // 分批写入：每批内部占位符从 $1 重新编号，避免首次全量超过 PostgreSQL 参数上限（每批 1000 行）
  const BATCH = 1000;
  for (let i = 0; i < rowsToInsert.length; i += BATCH) {
    const chunk = rowsToInsert.slice(i, i + BATCH);
    await grahamRepository.saveChunk(pg, chunk);
  }
  console.log(`[市场周期] 格雷厄姆指数 重算窗口(${since}起)=${rows.length}条, 有效写入=${rowsToInsert.length}条`);
  return rowsToInsert.length;
}

function tsDate(value) { return String(value || '').replace(/-/g, ''); }
function monthDate(value) {
  const month = String(value || '');
  return /^\d{6}$/.test(month) ? month.slice(0, 4) + '-' + month.slice(4, 6) + '-01' : null;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function syncCsi300Valuation(full) {
  // 水位：本地 CSI300 估值最新日期；空表才全量，否则只拉最近 45 天重叠窗口
  const wm = await marketYieldRepository.readCsi300Watermark();
  const maxDate = wm.rows[0].mx;
  // 沪深300估值是否全量，只看它自己表是否为空；不再受“A股总市值表为空”牵连，避免总市值丢失时误触发估值全量重拉
  const needFull = !maxDate;
  const end = tsDate(dateStr(new Date()));
  const ranges = needFull
    ? [['20040101', '20151231'], ['20160101', end]]
    : [[tsDate(dateStr(new Date(Date.now() - 45 * 86400000))), end]];
  const { readIndexValuationSeries } = require('../dataAccess/marketDatasets');
  let count = 0;
  for (const [startDate, endDate] of ranges) {
    const rows = await readIndexValuationSeries({ indexCode: '000300', startDate, endDate });
    if (!rows.length) continue;
    await marketYieldRepository.saveCsi300Valuations(rows, rows[0].source_code);
    count += rows.length;
  }
  console.log(`[市场周期] 沪深300估值 ${needFull ? '全量' : '增量(45天)'} 写入=${count}条`);
  return count;
}

async function syncMoneySupply() {
  // 货币供应属于「宏观数据集」：官方优先、备源由数据层决定，这里只做水位与重叠窗口。
  const { readMoneySupplySeries } = require('../dataAccess/marketDatasets');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const rows = await readMoneySupplySeries({ startDate: '1990-01-01', endDate: today });
  if (!rows.length) return 0;
  const wm = await marketYieldRepository.readMoneyWatermark();
  const maxMonth = wm.rows[0].mx;
  const since = maxMonth ? (new Date(maxMonth).getUTCFullYear() - 2) + '-' + String(new Date(maxMonth).getUTCMonth() + 1).padStart(2, '0') + '-01' : '1990-01-01';
  const kept = rows.filter(row => !maxMonth || row.month >= since).map(row => ({ month: `${row.month}-01`, m2: row.m2, row }));
  if (kept.length) await marketYieldRepository.saveMoneySupply(kept, rows[0].source_code);
  console.log(`[市场周期] 货币供应量 来源=${rows[0].source_code} 返回=${rows.length}条, 重叠窗口保留=${kept.length}条`);
  return kept.length;
}
async function tradeMonthEnds(startYear, endYear) {
  // daily_basic 是收盘后数据；盘中不能把当天“已开市但尚未发布”的空结果当成接口故障。
  const result = [], today = tsDate(expectedTradeDate());
  for (let year = startYear; year <= endYear; year++) {
    const calendarRows = await require('../dataAccess/referenceDatasets')
      .readTradingCalendar({ exchange: 'SSE', startDate: year + '0101', endDate: year + '1231', openOnly: true });
    const data = { fields: ['cal_date', 'is_open'], items: calendarRows.map(row => [row.cal_date, row.is_open]) };
    if (!data) continue;
    const latest = new Map();
    for (const row of tsRows(data)) {
      if (String(row.is_open) !== '1' || !/^\d{8}$/.test(String(row.cal_date)) || String(row.cal_date) > today) continue;
      const day = String(row.cal_date), month = day.slice(0, 6), previous = latest.get(month);
      if (!previous || day > previous) latest.set(month, day);
    }
    result.push(...latest.values());
  }
  return result.sort();
}

// 全市场总市值完整性门禁：统一层（market.daily_valuations）证券数低于该值视为不完整，
// 拒绝使用并回退到对应交易日的 Tushare daily_basic 全量快照（A股两市约 5500 只）。
const MIN_UNIFIED_MARKET_COUNT = 4500;
// 统一层 total_market_cap 单位：元 → 存储列 total_market_cap_100m_yuan 单位：亿元
const YUAN_TO_100M = 100000000;

async function syncAShareMarketCap(full) {
  const currentYear = new Date().getUTCFullYear();
  const dates = await tradeMonthEnds(full ? 2010 : currentYear, currentYear);
  if (!dates.length) return 0;
  const existing = await marketYieldRepository.listMarketCapDates();
  const seen = new Set(existing.rows.map(row => row.day));
  const targets = full ? dates.filter(day => !seen.has(day)) : [dates.at(-1)].filter(day => day && !seen.has(day));
  let count = 0;
  for (const day of targets) {
    // A 股总市值属于「市场总量数据集」：统一分区 → 官方中证全指 → 备源，全部由数据层决定。
    const { readTotalAShareMarketCap } = require('../dataAccess/marketDatasets');
    const cap = await readTotalAShareMarketCap({ day: normDate(day), minUnifiedCount: MIN_UNIFIED_MARKET_COUNT });
    if (!cap) continue;
    const { totalYi, securityCount, fromUnified, sourceCode: capSource } = cap;
    await marketYieldRepository.saveMarketCap({ day: normDate(day), totalYi, securityCount, fromUnified,
      sourceCode: capSource || undefined });
    count++;
    if (!fromUnified) await wait(350);  // 只有回退 Tushare 才需要限流
  }
  return count;
}

async function m2MarketCapInputFreshness() {
  const { rows } = await marketYieldRepository.readM2Inputs();
  const row = rows[0] || {};
  const today = new Date(`${dateStr(new Date())}T00:00:00Z`);
  const m2Date = row.m2_month ? new Date(`${String(row.m2_month).slice(0, 10)}T00:00:00Z`) : null;
  const capDate = row.cap_date ? new Date(`${String(row.cap_date).slice(0, 10)}T00:00:00Z`) : null;
  const m2LagMonths = m2Date && !Number.isNaN(m2Date.getTime())
    ? (today.getUTCFullYear() - m2Date.getUTCFullYear()) * 12 + today.getUTCMonth() - m2Date.getUTCMonth() : null;
  const capLagDays = capDate && !Number.isNaN(capDate.getTime())
    ? Math.floor((today - capDate) / 86400000) : null;
  return {
    m2_month: row.m2_month || null, cap_date: row.cap_date || null,
    m2_lag_months: m2LagMonths, cap_lag_days: capLagDays,
    fresh: m2LagMonths != null && m2LagMonths <= 2 && capLagDays != null && capLagDays <= 1,
  };
}

async function calculateM2MarketCap(options = {}) {
  if (options.requireFresh) {
    const freshness = await m2MarketCapInputFreshness();
    if (!freshness.fresh) return { status: 'stale', rowCount: 0, freshness };
  }
  const result = await marketYieldRepository.calculateM2MarketCap(options.executor);
  return options.requireFresh ? { status: 'fresh', rowCount: result.rowCount } : result.rowCount;
}

async function syncMarketCycleMetrics(full, options = {}) {
  if (!(process.env.TUSHARE_TOKEN || process.env.TUSHARE_BACKUP_TOKEN)) return { skipped: 'TUSHARE_TOKEN/TUSHARE_BACKUP_TOKEN missing' };
  const requested = new Set(options.stages || []);
  const runAll = requested.size === 0;
  const wants = stage => runAll || requested.has(stage);
  const result = {
    ...(wants('csi300_valuation') ? { csi300Valuation: await syncCsi300Valuation(full) } : {}),
    ...(wants('m2') ? { moneySupply: await syncMoneySupply() } : {}),
    ...(wants('a_share_market_cap') ? { aShareMarketCap: await syncAShareMarketCap(full) } : {}),
  };
  if (runAll || wants('m2') || wants('a_share_market_cap') || wants('m2_market_cap')) {
    result.m2MarketCap = await calculateM2MarketCap({ requireFresh: true });
  }
  return result;
}

// calendar 指定该子项按哪个市场的交易日计滞后；未指定则按自然日（本地没有对应日历）。
const MARKET_SUBDATASET_POLICIES = Object.freeze({
  cn_yield: { maxLagDays: 1, calendar: 'SSE' },
  csi300_pe: { maxLagDays: 1, calendar: 'SSE' },
  csi_all_pe: { maxLagDays: 1, calendar: 'SSE' },
  hsi_pe: { maxLagDays: 45, calendar: 'HKEX' },
  // 美国市场：本地没有美股交易日历，仍按自然日；阈值 10 天足以容纳周末与短假。
  us_treasury_yield: { maxLagDays: 10 },
  m2: { maxLagMonths: 2 },
  a_share_market_cap: { maxLagDays: 1, calendar: 'SSE' },
  m2_market_cap: { maxLagDays: 1, calendar: 'SSE' },
  graham_csi300: { maxLagDays: 1, calendar: 'SSE' },
  graham_csi_all: { maxLagDays: 1, calendar: 'SSE' },
});

async function readMarketSubdatasetFreshness(targetDate) {
  const targetText = String(targetDate || dateStr(new Date())).slice(0, 10);
  const target = new Date(`${targetText}T00:00:00Z`);
  const diagnostics = {};
  // 每个市场只查一次本地交易日历，组内复用；取不到就退回自然日，
  // 不能因为日历缺失把滞后算小而误判 fresh（宁可多报一次 stale）。
  const calendars = {};
  const tradingDaysFor = async (exchange) => {
    if (!Object.prototype.hasOwnProperty.call(calendars, exchange)) {
      const fromDate = new Date(target.getTime() - 120 * 86400000).toISOString().slice(0, 10);
      try {
        const days = await marketYieldRepository.listOpenTradingDays({ exchange, fromDate, toDate: targetText });
        calendars[exchange] = days.length ? days : null;
      } catch (_) {
        calendars[exchange] = null;
      }
    }
    return calendars[exchange];
  };
  for (const [code, policy] of Object.entries(MARKET_SUBDATASET_POLICIES)) {
    const { calendar, ...policyFields } = policy;
    const { rows } = await marketYieldRepository.readSubdatasetFreshness(code);
    const raw = rows[0] && rows[0].data_as_of;
    const dataAsOf = raw ? String(raw).slice(0, 10) : null;
    const actual = dataAsOf ? new Date(`${dataAsOf}T00:00:00Z`) : null;
    let lagDays = actual && !Number.isNaN(actual.getTime()) ? Math.max(0, Math.floor((target - actual) / 86400000)) : null;
    if (calendar && dataAsOf) {
      // 交易日口径：只数 dataAsOf 之后、目标日（含）之前的开市日。
      const days = await tradingDaysFor(calendar);
      if (days) lagDays = days.filter(day => day > dataAsOf).length;
    }
    const lagMonths = dataAsOf ? Math.max(0, (target.getUTCFullYear() - actual.getUTCFullYear()) * 12 + target.getUTCMonth() - actual.getUTCMonth()) : null;
    const fresh = policy.maxLagMonths != null ? lagMonths != null && lagMonths <= policy.maxLagMonths : lagDays != null && lagDays <= policy.maxLagDays;
    diagnostics[code] = { status: fresh ? 'fresh' : 'stale', data_as_of: dataAsOf, ...(lagDays == null ? {} : { lag_days: lagDays }), ...(lagMonths == null ? {} : { lag_months: lagMonths }), ...policyFields };
  }
  return diagnostics;
}

async function runMarketVolatilitySync(context = {}) {
  if (!(await tryClaimJob('market_volatility_sync'))) return { skipped: true, reason: 'locked' };
  const id = await startJobRun('market_volatility_sync');
    const requested = new Set((context.failedDatasets || []).map(item => typeof item === 'string' ? item : item && item.code).filter(Boolean));
    if (requested.has('cycle_metrics')) ['csi300_valuation', 'm2', 'a_share_market_cap', 'm2_market_cap'].forEach(code => requested.add(code));
  const failedDatasets = [];
  const failures = [];
  const result = {};
  const shouldRun = code => !requested.size || requested.has(code);
  const runDataset = async (code, task) => {
    if (!shouldRun(code)) { result[code] = { status: 'succeeded', skipped: true }; return; }
    try { result[code] = await task(); }
    catch (error) {
      failedDatasets.push(code);
      failures.push({ code: error.code || 'JOB_FAILED', errorType: error.errorType || error.type || 'unknown', source: error.source || null, error: error.message });
      result[code] = { status: 'failed', error: error.message, errorCode: error.code, errorType: error.errorType, source: error.source };
    }
  };
  try {
    const end = String(context.targetDate || context.businessDate || process.env.JOB_BUSINESS_DATE || dateStr(new Date())).slice(0, 10);
    const seen = await marketYieldRepository.countChinaYield();
    const first = seen.rows[0].n === 0;
    const capSeen = await marketYieldRepository.countMarketCap();
    const cycleFirst = capSeen.rows[0].n === 0;
    const start = first ? '2006-03-01' : dateStr(new Date(Date.now() - 14 * 86400000));
    await runDataset('cn_yield', () => syncChinaYield(start, end));
    await runDataset('csi300_pe', () => syncCsiIndexPe('CSI300', '000300'));
    await runDataset('csi_all_pe', () => syncCsiIndexPe('CSIALL', '000985'));
    await runDataset('hsi_pe', () => syncHsiPe());
    await runDataset('us_treasury_yield', () => syncUsTreasuryYield(end));
    // 子阶段必须和 failedDatasets 使用同一代码，定向重试 m2 时不能重新抓取已经成功的指标。
    const cycleStages = ['csi300_valuation', 'm2', 'a_share_market_cap'];
    for (const stage of cycleStages) {
      await runDataset(stage, () => syncMarketCycleMetrics(cycleFirst, { stages: [stage] }));
    }
    if (!requested.size || requested.has('cycle_metrics') || requested.has('m2') || requested.has('a_share_market_cap') || requested.has('m2_market_cap')) {
      await runDataset('m2_market_cap', () => syncMarketCycleMetrics(false, { stages: ['m2_market_cap'] }));
    }
    // 各市场只使用已落库有效输入；恒指请求失败不能阻断 A 股派生计算。
    await calculateGraham();
    const subdatasets = await readMarketSubdatasetFreshness(end).catch(error => ({ freshness_check: { status: 'failed', error: error.message } }));
    const staleSubdatasets = Object.entries(subdatasets).filter(([, item]) => item && item.status === 'stale').map(([code]) => code);
    staleSubdatasets.forEach(code => { if (!failedDatasets.includes(code)) failedDatasets.push(code); result[code] = { status: 'stale', ...subdatasets[code] }; });
    const ok = failedDatasets.length === 0;
    await finishJobRun(id, ok, JSON.stringify({ result, failedDatasets }));
    console.log('[市场周期] 本次同步汇总:', JSON.stringify({ result, failedDatasets }));
    const firstFailure = failures[0] || null;
    return {
      ok,
      status: ok ? 'succeeded' : 'partial',
      failedDatasets,
      dataAsOf: ok ? end : Object.values(subdatasets).map(item => item && item.data_as_of).filter(Boolean).sort()[0] || end,
      datasetDiagnostics: { market_volatility: { subdatasets, stale_subdatasets: staleSubdatasets, query_status: 'success' } },
      datasets: Object.keys(result).map(code => ({ code, status: failedDatasets.includes(code) ? 'failed' : 'succeeded' })),
      ...(failedDatasets.length && firstFailure ? { error: firstFailure.error, errorCode: firstFailure.code, errorType: firstFailure.errorType, source: firstFailure.source } : {}),
    };
  } catch (error) {
    await finishJobRun(id, false, error.message || String(error));
    return { ok: false, error: error.message || String(error), failedDatasets: ['cycle_metrics'] };
  } finally { await releaseJob('market_volatility_sync'); }
}
function scheduleMarketVolatilitySync() { runMarketVolatilitySync().catch(e => console.error('股市波动首次同步失败:', e.message)); const now=new Date(), next=new Date(); next.setHours(18,45,0,0); if(next<=now) next.setDate(next.getDate()+1); const first=setTimeout(function(){ runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)); const timer=setInterval(()=>runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)),86400000); if(timer.unref) timer.unref(); }, next-now); if(first.unref) first.unref(); }
module.exports = { syncChinaYield, syncCsiIndexPe, syncCsiPeFromOfficial, CSI_OFFICIAL_PE_SINCE, syncHsiPe, syncUsTreasuryYield, calculateGraham, parseHsiWorkbook,
  syncCsi300Valuation, syncMoneySupply, tradeMonthEnds, syncAShareMarketCap, calculateM2MarketCap,
  syncMarketCycleMetrics, runMarketVolatilitySync, scheduleMarketVolatilitySync, readMarketSubdatasetFreshness };
