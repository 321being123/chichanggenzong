// ========== 自动记录每日收盘价（按市场收盘时刻精准触发 + 休市识别 + 缺失补漏） ==========
const { pool, loadAccountData, saveDailyPrices, syncConfirmedCloseToPositions, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { toTsCode } = require('../services/market');
const { getMarketState, isCnTradingDate, prefetchMarketFacts, shanghaiDateTime, parseClock } = require('../services/marketState');
const { runNavSnapshotJob } = require('./navSnapshot');
const { runIndexRecentJob } = require('./indexBaseline');
const { runHkRateJob } = require('./hkRate');
const { backfillDailyPrices, historicalKindFor } = require('./replayNav');
const { getExternalCallStats } = require('../services/externalCallGuard');
const classifyCode = require('../../public/js/code-classify');
const repository = require('../repositories/marketCloseRepository.js');
const { withTransaction } = require('../db/transaction');
const { isPublishedDatasetEvidence } = require('../services/datasetPartitionRegistry');
const { publishCoveragePartition } = require('../services/datasetPartitions');
const { PRIVATE_SOURCES } = require('../services/effectivePrice');
const sharedQuotePromises = new Map();
const legacyFinalTasks = new Map();

// 各市场收盘时间：{ hour, minute, 适用的代码前缀匹配规则 }
const MARKET_CLOSE_TIMES = [
  { h: 15, m: 30, label: 'A股', market: 'CN', match: (code, position) => position && position.subtype !== '港股' && String(code).length >= 6 && /^(00|30|60|68|[48])/.test(code) && !/(债|转债)/.test(String(position.name || '')) },
  { h: 16, m: 30, label: '港股', market: 'HK', match: (code, position) => position && (position.subtype === '港股' || String(position.quoteCurrency || '').toUpperCase() === 'HKD') || code.length === 5 },
  { h: 15, m: 30, label: '可转债', market: 'CN', match: code => /^(11|12)/.test(code) },
  { h: 15, m: 30, label: 'LOF/ETF', market: 'CN', match: code => classifyCode.isFundEtfCode(code) },
  { h: 15, m: 30, label: '非标准证券', market: 'CN', match: (code, position) => isUncoveredPosition(code, position) },
];

// 固定东八区偏移（毫秒）：显式使用 Asia/Shanghai，不依赖容器本地时区，避免 UTC 容器下任务错时
const CN_OFFSET_MS = 8 * 3600 * 1000;

// 东八区日期 YYYY-MM-DD（任意输入 Date 都按北京时间解释，不受容器时区影响）
function fmtCN(d) {
  const x = new Date(d);
  const cn = new Date(x.getTime() + CN_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

// 今天（东八区）
function cnDateStr() { return fmtCN(new Date()); }

// 北京时间的星期几（0=周日），不依赖容器本地时区
function cnWeekday(d) {
  const ds = fmtCN(d || new Date());
  return new Date(ds + 'T00:00:00Z').getUTCDay();
}

// 是否为交易日：周一至周五 且 非法定节假日（按北京时间判断）
function isTradingDay(d) {
  return isCnTradingDate(fmtCN(d || new Date()));
}

async function isMarketTradingDate(market, date) {
  if (market === 'HK') {
    return (await getMarketState({ market: 'HK', businessDate: date, time: '00:00' })).status === 'open';
  }
  return isCnTradingDate(date);
}

// 距离「北京时间 h:m」还有多少毫秒（显式东八区，不依赖容器时区）
function msUntil(h, m, nowInput) {
  const now = nowInput ? new Date(nowInput) : new Date();
  const cnNow = new Date(now.getTime() + CN_OFFSET_MS);
  const target = new Date(cnNow);
  target.setUTCHours(h, m, 0, 0); // cnNow 的内部 UTC 字段即北京时间，用 UTC 访问器设时分
  if (target <= cnNow) target.setUTCDate(target.getUTCDate() + 1);
  const targetEpoch = target.getTime() - CN_OFFSET_MS; // 转回真实 epoch
  return targetEpoch - now.getTime();
}

// 计算到「下一个交易日北京时间 h:m」的毫秒数（显式东八区，不依赖容器本地时区）
// 复用 msUntil 得到下一个北京时间 h:m 的落点，再按北京时间日期跳过非交易日。
function nextRunDelay(h, m) {
  let epoch = Date.now() + msUntil(h, m) + 60000; // +1 分钟缓冲，避开当前执行点
  let guard = 0;
  while (!isTradingDay(new Date(epoch)) && guard < 14) {
    epoch += 86400000; // 顺延一天（毫秒，跨时区安全）
    guard++;
  }
  return Math.max(epoch - Date.now(), 5000);
}

function quoteForCode(quoteMap, code) {
  if (!quoteMap) return null;
  const value = String(code || '').trim();
  const exact = quoteMap.get(value);
  if (exact) return exact;
  const fallback = quoteMap.get(value.replace(/\.(SH|SZ|BJ|HK)$/i, ''));
  const market = String(fallback?.market || '').toLowerCase();
  if (/\.HK$/i.test(value) ? market !== 'hk' : market === 'hk') return null;
  return fallback || null;
}

function isUsableQuote(quote, expectedDate) {
  return Boolean(quote && Number.isFinite(Number(quote.price)) && quote.price > 0 && (!expectedDate || (quote.quote_time && fmtCN(quote.quote_time) === expectedDate)));
}

function mergeQuoteMaps(target, source) {
  if (!target || !source) return target;
  source.forEach((quote, key) => target.set(key, quote));
  return target;
}

// 纯函数：从持仓中挑出「属于该市场(matchFn)且当日尚无价格」的代码。
// 这是 P0-3 修复的核心：以「代码」而非「账户当天任意一条记录」判断缺失，
// 保证 A 股已写入时，可转债/ETF 仍会被抓取，部分缺失也能补齐。
function pickMissingCodes(positions, existingCodes, matchFn) {
  return (positions || [])
    .filter(p => p && p.code && matchFn(p.code, p) && !existingCodes.has(p.code))
    .map(p => p.code);
}

// 为单个账户记录某交易日某市场收盘价。
// 幂等到「代码」级别：只抓取当日该市场持仓中【尚未记录】的代码，
// 因此 A 股先写入后，可转债/ETF 不会被整体跳过；部分缺失也能补齐。
// 返回 { recorded, failed, error }；error=true 表示有持仓却全部抓取失败
// 报价时刻按上海时区取“日期 + 时钟”，用于判断这条报价是否已经落在收盘之后。
const quoteFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function quoteParts(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(quoteFormatter.formatToParts(date).map(item => [item.type, item.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    epochMs: date.getTime(),
  };
}

// 港交所收市竞价时段（CAS）在收市前 2 分钟随机收市（全日市 16:08–16:10，半日市 12:08–12:10），
// 腾讯行情接口返回最后一笔成交/收市时刻通常落在 16:08:xx（或 12:08:xx），市场已过收市时刻后应视为有效终盘报价。
const HK_CAS_RANDOM_CLOSE_WINDOW_MINUTES = 2;

function isQuoteBeforeClose(state, quoteClock, closeTime) {
  const closeMinute = parseClock(closeTime);
  if (closeMinute === null) return false;
  if (String(state && state.market || '').toUpperCase() === 'HK') {
    const cutoffMinute = Math.max(0, closeMinute - HK_CAS_RANDOM_CLOSE_WINDOW_MINUTES);
    const cutoffClock = `${String(Math.floor(cutoffMinute / 60)).padStart(2, '0')}:${String(cutoffMinute % 60).padStart(2, '0')}:00`;
    return quoteClock < cutoffClock;
  }
  return quoteClock <= `${closeTime}:00`;
}

// 收盘写入准入（合同 8.3.1-4）：一条报价要写成“已确认终盘价”，必须同时满足
// ①当日是该市场交易日且任务执行时已过当地收市时刻；②这条报价的报价时刻属于当日；
// ③报价时刻晚于当地收市时刻（港股含收市前 2 分钟 CAS 随机收市窗口）；④报价时刻不得晚于本次取价/任务运行时刻。
// 收市前或异常未来时刻缓存只能写候选，等待重新取价。
function qualifyCloseQuote(state, quoteTime, cnDate, closeTime, nowInput) {
  if (state.status !== 'open' || state.isAfterMarketClose !== true) {
    return { quality: 'candidate', isFinal: null, reason: 'market_not_closed' };
  }
  const parts = quoteParts(quoteTime);
  if (!parts) return { quality: 'candidate', isFinal: null, reason: 'quote_time_missing' };
  if (parts.date !== cnDate) return { quality: 'candidate', isFinal: null, reason: 'quote_not_same_day' };
  if (parseClock(closeTime) === null) return { quality: 'candidate', isFinal: null, reason: 'close_time_unknown' };
  if (isQuoteBeforeClose(state, parts.time, closeTime)) return { quality: 'candidate', isFinal: null, reason: 'quote_before_close' };
  const nowMs = nowInput !== undefined ? new Date(nowInput).getTime() : Date.now();
  if (!Number.isFinite(nowMs)) return { quality: 'candidate', isFinal: null, reason: 'run_time_invalid' };
  if (parts.epochMs > nowMs) return { quality: 'candidate', isFinal: null, reason: 'quote_in_future' };
  return { quality: 'confirmed', isFinal: true, reason: null };
}

// 同一天的共享报价也可能来自开市期间；收盘重试必须刷新这种旧报价。
function quoteNeedsCloseRefresh(quote, state, cnDate, nowInput) {
  if (!isUsableQuote(quote, cnDate)) return true;
  if (!state || state.status !== 'open' || state.isAfterMarketClose !== true) return false;
  return qualifyCloseQuote(state, quote.quote_time, cnDate, state.closeTime, nowInput).quality !== 'confirmed';
}

// 历史共享日线修复仍要求同证券、同交易日、不复权的终盘证据。
// 品种 → 历史收盘数据集类型。判定复用历史补录的同一入口（historicalKindFor），
// 避免收盘核验与历史补录各写一套品种规则；三个类型在数据层都只给不复权收盘价：
// stock 官方 ex_rights 优先 / 腾讯 day / Tushare daily，bond 走 cb_daily，fund 走 fund_daily。
const TERMINAL_SERIES_KIND = { stock: 'stock', hk_stock: 'stock', bond: 'bond', fund: 'fund' };

// 已发布的共享日线（market.daily_bars）只接受来源已登记的供应商；
// 但来源名本身不能证明这条记录是不复权终盘价（同表里还有可转债同步写入的实时报价），
// 真正的采信条件是行级证据（口径/终盘/质量）与分区发布状态，见 isTerminalBarEvidence。
const PUBLISHED_BAR_SOURCES = ['lixinger_official', 'tushare', 'tencent'];

// 收盘任务亲自核验并落库的日线证据分区：两市场各自一个数据集，
// 与全市场 stock_daily 分区语义不同（那里是全市场行情完整性，这里只是本任务核验过的证券）。
const CLOSE_BAR_DATASET = { CN: 'position_close_bars_cn', HK: 'position_close_bars_hk' };

// 任务品种范围：CN 下 A股 / 可转债 / LOF-ETF 共用同一个市场，只能靠品种区分职责。
// 缺口重建必须按品种筛选——否则 A 股任务会把可转债、基金的缺口登记到自己名下，
// 去要转债/基金日线，把自己变成 partial，两个任务互相补采。
// 未登记品种范围的任务（如非标准证券）不参与缺口重建。
const LABEL_TERMINAL_KINDS = Object.freeze({
  'A股': ['stock'],
  '可转债': ['bond'],
  'LOF/ETF': ['fund'],
  '港股': ['hk_stock'],
});

function labelOwnsKind(label, kind) {
  const allowed = LABEL_TERMINAL_KINDS[label];
  if (!allowed) return false;
  return allowed.includes(String(kind || ''));
}

function dateOnlyOf(value) {
  const text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const digits = text.replace(/-/g, '');
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : '';
}

// 港股代码规范只应有一份实现：放在数据访问层（发给供应商的代码就在那里决定），
// 这里转发同一函数，避免收盘核验与历史补录各写一套规则而漂移。
// 说明：padStart(5) 不会缩短六位补零代码（000001），那会被当成另一只证券，共享日线与外采都查不到。
const normalizeHkCode = require('../dataAccess/marketDatasets').normalizeHkSecurityCode;

// 终盘证据的证券代码：港股必须补足 5 位并带 .HK 才会走港股日线入口，
// 其余品种由统一代码规则决定 .SH/.SZ/.BJ（可转债 11/12 开头独立映射）。
function terminalSeriesCode(code, kind) {
  const text = String(code || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK)$/i, '');
  if (kind === 'hk_stock') return `${normalizeHkCode(text)}.HK`;
  return toTsCode(text);
}

function resolveTerminalKind({ code, position, subtype, name, type, market }) {
  const info = position || {};
  const kind = historicalKindFor(code, {
    subtype: subtype !== undefined ? subtype : info.subtype,
    name: name !== undefined ? name : info.name,
    type: type !== undefined ? type : info.type,
  });
  // 港股收盘任务里持仓 subtype 可能缺失，市场规则已确定为 HK 时不能按 A 股日线核对。
  if (kind === 'stock' && String(market || '').toUpperCase() === 'HK') return 'hk_stock';
  return kind;
}

// 一条共享日线要能当"已确认终盘价"的证据，必须同时满足四件事，缺一不可：
// ①该行口径是不复权；②该行状态是终盘（不是盘中/实时报价）；③该行质量通过；
// ④该交易日该市场「收盘任务核验日线」分区已发布、未失真、质量通过。
// 只看来源名会把可转债同步写进同表的腾讯实时报价当成收盘价。
function isTerminalBarEvidence(row, datasetCode, coverageKind = null) {
  if (!row) return false;
  if (String(row.bar_status || '') !== 'terminal') return false;
  if (String(row.price_adjust || '') !== 'none') return false;
  if (String(row.quality_status || '') !== 'passed') return false;
  const diagnostics = row.partition_diagnostics || {};
  if (coverageKind && (!Array.isArray(diagnostics.coverage_kinds) || !diagnostics.coverage_kinds.includes(coverageKind))) return false;
  // 整行 quality_status 是所有品种的合并结论：某品种未补齐会让整行 failed，
  // 不能因此把另一品种已经完整发布的日线也否掉。品种级结论存在时以它为准。
  const kindCoverage = coverageKind && diagnostics.coverage_by_kind
    ? diagnostics.coverage_by_kind[coverageKind] : null;
  const kindQuality = kindCoverage && kindCoverage.status
    ? (kindCoverage.status === 'complete' || kindCoverage.status === 'no_target' ? 'passed' : 'failed')
    : undefined;
  return isPublishedDatasetEvidence({
    status: row.partition_status,
    is_stale: row.partition_is_stale === true,
    diagnostics,
  }, datasetCode, kindQuality ? { requireQuality: true, qualityStatus: kindQuality } : { requireQuality: true });
}

// 从候选行里挑出唯一可用的终盘证据：repository 已按来源优先级排序，这里只做资格裁决。
// 抽成纯函数是为了能离线回归"没有终盘证据的行不得被采信"。
function pickTerminalBarRow(rows, datasetCode, coverageKind = null) {
  for (const row of (rows || [])) {
    if (!isTerminalBarEvidence(row, datasetCode, coverageKind)) continue;
    return { close: Number(row.close), source_code: row.source_code, price_adjust: row.price_adjust };
  }
  return null;
}

async function readPublishedDailyBar({ tsCode, tradeDate, market, kind }) {
  const datasetCode = CLOSE_BAR_DATASET[String(market || '').toUpperCase()];
  if (!datasetCode) return null;
  try {
    const { rows } = await repository.select_published_daily_bar([tsCode, tradeDate, PUBLISHED_BAR_SOURCES, datasetCode]);
    return pickTerminalBarRow(rows, datasetCode, kind || null);
  } catch (_) {
    // 共享日线读不到（表缺失/权限）不是终盘结论，交给外采路径判定，不在这里认定"无日线"。
    return null;
  }
}

// 外采到的不复权终盘日线必须回到共享日线事实里，否则下一次任务或重试会把同一证券、
// 同一交易日再采一遍（多账户、跨市场收盘任务都会重复）。入库同时保留供应商、口径与核验方式。
// tencent_day 是数据层内部口径标记，落库要映射到来源表里已登记的 tencent。
const BAR_SOURCE_ALIASES = {
  tencent_day: 'tencent',
  tencent: 'tencent',
  tushare: 'tushare',
  lixinger: 'lixinger_official',
  lixinger_official: 'lixinger_official',
};

async function persistTerminalBar({ tsCode, tradeDate, close, provider, market }) {
  const sourceCode = BAR_SOURCE_ALIASES[String(provider || '')];
  if (!sourceCode) return { persisted: false, reason: 'bar_source_not_registered' };
  if (!(Number(close) > 0)) return { persisted: false, reason: 'bar_close_invalid' };
  try {
    const { rowCount } = await repository.upsert_daily_bar_evidence([tsCode, tradeDate, Number(close), sourceCode,
      JSON.stringify({
        provider: provider || null, price_adjust: 'none', bar_status: 'terminal', quality_status: 'passed',
        market: market || null, verified_via: 'market_close_task', verified_at: new Date().toISOString(),
      })]);
    if (!rowCount) return { persisted: false, reason: 'instrument_or_source_not_found' };
    return { persisted: true, sourceCode };
  } catch (error) {
    return { persisted: false, reason: 'bar_persist_failed', detail: error && error.message };
  }
}

// 分区行数必须来自实际证据行：写进去几条由查询复核，不能用"本次采到几条"自报。
// 返回值必须区分三件事：有没有合格日线（rowCount）、发布是否成功（published）、失败原因（error）。
// 只返回"发布对象或 null"会让"发布失败"和"没有日线"看起来一样，重跑就会误判成 not_needed。
// 分区质量必须同时满足"有合格日线"和"该品种目标证券齐全"：
// 旧实现只拦 rowCount<=0，单条转债终盘行就能把整类分区标成 quality_status=passed，
// 调度重验读分区就判 ready，部分覆盖被当成整类恢复。目标集合用本任务范围内
// 已确认的账户日价并上当前持仓（按品种过滤）——不含未确认候选的旧口径会把
// "连账户日价都没落地"的证券漏出分母，分母偏小同样会误判完整。
// 同一 CN 分区由 A股/转债/基金三类任务共用，质量状态必须按品种分别记录，
// 不能拿最后一次发布（例如基金补齐）覆盖掉另一品种的未就绪结论。
async function publishCloseBarPartition(market, tradeDate, label = '', accounts = null) {
  const datasetCode = CLOSE_BAR_DATASET[String(market || '').toUpperCase()];
  if (!datasetCode) return { rowCount: 0, published: false, status: null, error: 'dataset_not_registered' };
  const coverageKind = LABEL_TERMINAL_KINDS[label] && LABEL_TERMINAL_KINDS[label][0];
  const scopeUsers = Array.isArray(accounts) && accounts.length
    ? [...new Set(accounts.map(item => (item && item.username) || item).filter(Boolean).map(String))]
    : null;
  let rowCount = null;
  try {
    const { rows } = await repository.count_position_close_bars([tradeDate, market, coverageKind || null]);
    rowCount = Number(rows[0] && rows[0].row_count) || 0;
  } catch (error) {
    // 数不清就不能声称"没有日线"：按发布失败处理，任务必须报未完成。
    console.warn('[market_close] 日线证据行数读取失败 ' + market + ' ' + tradeDate + '：' + (error && error.message));
    return { rowCount: null, published: false, status: null, error: error && error.message, coverage: null };
  }
  if (rowCount <= 0) return { rowCount: 0, published: false, status: null, error: null, coverage: null };
  let coverage = null;
  try {
    const { rows } = await repository.count_close_bar_coverage([tradeDate, market, coverageKind || null, scopeUsers]);
    const expected = Number(rows[0] && rows[0].expected_count) || 0;
    const covered = Number(rows[0] && rows[0].covered_count) || 0;
    coverage = {
      expected,
      covered,
      // no_target：当天该品种没有目标证券（如该品种无持仓且无已确认日价），
      // 此时只能沿用原行数口径，不能凭空判成"部分覆盖"。
      status: expected === 0 ? 'no_target' : (covered >= expected ? 'complete' : 'partial'),
    };
  } catch (error) {
    // 覆盖算不出来同样不能声称已就绪：按发布失败处理，让任务重跑并保留上一份失败原因。
    console.warn('[market_close] 日线覆盖对账失败 ' + market + ' ' + tradeDate + '：' + (error && error.message));
    return { rowCount, published: false, status: null, error: `coverage_check_failed: ${error.message}`, coverage: null };
  }
  // 品种结论的合并与整行质量判定全部在数据库端完成（publishCoveragePartition）：
  // 这里若"先读旧分区再整体写回"，转债与基金并发发布时会互相覆盖——
  // 转债写 partial 后，基金拿着读到的旧 complete 提交就把它冲掉，调度重验随即误判就绪。
  try {
    const published = await publishCoveragePartition(datasetCode, market, {
      partitionKey: tradeDate, dataAsOf: tradeDate, rowCount,
      coverageKind: coverageKind || null,
      coverage,
      diagnostics: {
        query_status: 'success', reason: 'job:market_close', market,
        coverage_status: coverage.status, expected_count: coverage.expected, covered_count: coverage.covered,
      },
    });
    const mergedDiagnostics = (published && published.diagnostics) || {};
    const mergedByKind = mergedDiagnostics.coverage_by_kind && typeof mergedDiagnostics.coverage_by_kind === 'object'
      ? mergedDiagnostics.coverage_by_kind : {};
    return {
      rowCount, published: Boolean(published), status: published ? published.status : null,
      error: published ? null : 'publish_returned_empty',
      coverage, qualityStatus: mergedDiagnostics.quality_status || null, coverageByKind: mergedByKind,
    };
  } catch (error) {
    console.warn('[market_close] 日线证据分区发布失败 ' + market + ' ' + tradeDate + '：' + (error && error.message));
    return { rowCount, published: false, status: null, error: error && error.message, coverage };
  }
}

// 取某交易日某证券的不复权日线（终盘证据）：
// ①先读已核验落库的共享日线，命中即用；②未命中才按品种外采一次，并把结果写回共享日线。
// 任务级去重由调用方负责，这里只做"取一条证据"。
async function loadTerminalBar({ code, kind, date, fetchSeries, readPublishedBar, persistBar }) {
  const seriesKind = TERMINAL_SERIES_KIND[kind];
  if (!seriesKind) return { ok: false, reason: 'terminal_evidence_not_applicable' };
  const market = kind === 'hk_stock' ? 'HK' : 'CN';
  const tsCode = terminalSeriesCode(code, kind);
  // 测试注入 fetchSeries / readPublishedBar 时不读写库，保证终盘核验逻辑可离线回归。
  const readPublished = readPublishedBar === undefined ? (fetchSeries ? null : readPublishedDailyBar) : readPublishedBar;
  if (readPublished) {
    const published = await Promise.resolve(readPublished({ tsCode, tradeDate: date, market, kind })).catch(() => null);
    const close = Number(published && published.close);
    if (close > 0) {
      return {
        ok: true, close, provider: published.source_code || 'published_bar', adjust: 'none', via: 'published_bar',
        // 已发布日线也是"这只证券这一天已补齐"的证据，缺口销账要用到它的身份。
        code: String(code || ''), kind, tsCode, market, tradeDate: date,
      };
    }
  }
  try {
    // fetchSeries 只用于测试注入；生产走数据层的「官方不复权优先、备源同口径」入口。
    const readSeries = fetchSeries || require('../dataAccess/marketDatasets').readHistoricalCloseSeries;
    const rows = await readSeries({ tsCode, kind: seriesKind, startDate: date, endDate: date });
    const row = (rows || []).find(item => dateOnlyOf(item.trade_date) === date);
    if (!row) return { ok: false, reason: 'terminal_bar_missing' };
    if (String(row.price_adjust || '') !== 'none') return { ok: false, reason: 'terminal_bar_adjusted' };
    const close = Number(row.close);
    if (!(close > 0)) return { ok: false, reason: 'terminal_bar_missing' };
    // 外采结果落库复用：失败不改变本次核验结论（证据本身就来自这次真实请求），
    // 但要把持久化结果带回调用方，避免"下次又重复采"被当成已解决。
    const persist = persistBar === undefined ? (fetchSeries ? null : persistTerminalBar) : persistBar;
    const saved = persist
      ? await Promise.resolve(persist({ tsCode, tradeDate: date, close, provider: row.source_code, market })).catch(error => ({ persisted: false, reason: 'bar_persist_failed', detail: error && error.message }))
      : null;
    return {
      ok: true, close, provider: row.source_code || null, adjust: row.price_adjust, via: 'series',
      persisted: Boolean(saved && saved.persisted),
      persistReason: saved ? (saved.persisted ? null : saved.reason) : 'persist_not_configured',
      // 缺口登记要按原始证券身份与品种来：重跑时只有这些信息才能重新取同一条日线。
      code: String(code || ''), kind, tsCode, market, tradeDate: date,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'terminal_evidence_error',
      detail: e && e.message ? e.message : String(e),
      terminalError: terminalFailureDetails(e),
    };
  }
}

// 终盘日线请求失败与“上游尚未发布该交易日数据”是两种不同事实。
// 失败必须把统一执行器可识别的分类一路带回去，不能在候选价路径被降级成 pending_confirmation。
function terminalFailureDetails(error) {
  const message = String(error && error.message || error || '终盘日线请求失败');
  const rawCode = error && (error.code || error.errorCode);
  const code = rawCode ? String(rawCode).toUpperCase()
    : (/\b5\d\d\b|上游.*5\d\d|timeout|超时/i.test(message) ? 'UPSTREAM_5XX' : 'TERMINAL_EVIDENCE_ERROR');
  const errorType = error && (error.errorType || error.type)
    ? String(error.errorType || error.type)
    : (/\b5\d\d\b|上游.*5\d\d|timeout|超时/i.test(message) ? 'network' : 'upstream');
  return {
    code,
    errorType,
    retryable: error && typeof error.retryable === 'boolean' ? error.retryable : true,
    source: error && error.source ? String(error.source) : null,
    apiName: error && error.apiName ? String(error.apiName) : null,
    recoverAt: error && error.recoverAt ? error.recoverAt : null,
    message: message.slice(0, 500),
  };
}

// 历史共享日线修复：按市场、证券和目标日读取日线与存储证据。
async function verifyTerminalClose({
  code, position, subtype, name, type, market, date, kind,
  fetchSeries, readPublishedBar, readBar,
}) {
  const resolvedKind = kind || resolveTerminalKind({ code, position, subtype, name, type, market });
  if (!TERMINAL_SERIES_KIND[resolvedKind]) return { ok: false, reason: 'terminal_evidence_not_applicable' };
  const load = () => loadTerminalBar({ code, kind: resolvedKind, date, fetchSeries, readPublishedBar });
  const bar = readBar
    ? await readBar(`${String(market || '').toUpperCase()}|${terminalSeriesCode(code, resolvedKind)}|${date}`, load)
    : await load();
  if (!bar || !bar.ok) return bar || { ok: false, reason: 'terminal_evidence_unavailable' };
  return {
    ok: true, reason: null, close: bar.close, provider: bar.provider, adjust: bar.adjust, via: bar.via,
    // 共享日线的持久化结果必须一路带上去：只统计成功条数会让"全部保存失败"看起来像"无需发布"，
    // 下一次任务又会重复外采，任务结果里也查不出缺口原因。
    persisted: bar.persisted === true,
    persistReason: bar.persistReason || null,
    // 缺口重建要用到：日线代码与品种，缺口表写不进去时靠日价证据恢复。
    tsCode: bar.tsCode || null,
    kind: bar.kind || null,
  };
}

// 当日收盘估值直接采用合格腾讯报价，保留原始时间和确认依据。
function buildCloseRecord({ row, market, label, state, cnDate, now }) {
  const qualification = qualifyCloseQuote(state, row.quote_time, cnDate, state.closeTime, now);
  return {
    ...row,
    quality: qualification.quality,
    is_final: qualification.isFinal,
    quote_at: row.quote_time,
    market,
    source: 'market_close_task:' + label,
    evidence: {
      businessDate: cnDate,
      marketState: state.status,
      closeTime: state.closeTime || null,
      isAfterMarketClose: state.isAfterMarketClose === true,
      quoteAt: row.quote_time || null,
      quotePrice: row.price,
      price_adjust: 'none',
      qualification: qualification.reason || 'confirmed',
      priceBasis: qualification.isFinal ? 'tencent_post_close_quote' : 'quote_candidate',
    },
  };
}

function buildConfirmedPriceMap(rows) {
  const map = new Map();
  for (const row of (rows || [])) {
    const market = dailyPriceRowMarket(row);
    const key = identityOf(market, row.code);
    const price = Number(row.price);
    if (!map.has(key) && price > 0) {
      map.set(key, {
        code: row.code,
        market,
        price,
        name: row.name || '',
        source: row.source || null,
        quote_at: row.quote_at || null,
        evidence: row.evidence && typeof row.evidence === 'object' ? row.evidence : null,
      });
    }
  }
  return map;
}

async function loadConfirmedClosePriceMap(market, cnDate) {
  const { rows } = await repository.select_confirmed_daily_prices([cnDate, market, PRIVATE_SOURCES]);
  return buildConfirmedPriceMap(rows);
}

function buildReusedCloseRecord({ pos, existing, market, label, cnDate }) {
  const baseEvidence = existing.evidence && typeof existing.evidence === 'object' ? existing.evidence : {};
  return {
    code: pos.code,
    name: pos.name || existing.name || '',
    price: existing.price,
    quality: 'confirmed',
    is_final: true,
    quote_at: existing.quote_at || null,
    market,
    source: existing.source || ('market_close_task:' + label),
    evidence: {
      ...baseEvidence,
      businessDate: cnDate,
      price_adjust: 'none',
      reusedFromConfirmedClose: true,
    },
  };
}

async function recordCloseOne(username, accountName, label, matchFn, dateStr, context = {}) {
  const cnDate = dateStr || cnDateStr();

  const result = await loadAccountData(username, accountName);
  const positions = (result.positions || []);
  if (positions.length === 0) return { recorded: 0, failed: 0, skipped: 0 };

  // 已有价格集合只收“已确认终盘价”，且必须按「市场 + 代码」的身份收集：
  // 同一账户同时持有同形证券（A 股 000001 与港股 00001）时，只按代码收集会把另一只的确认价
  // 当成“已处理”，直接跳过它的抓取。盘中候选或遗留未核验价不能阻止收盘任务重取并升级。
  const { rows: existingRows } = await repository.select_daily_prices([username, accountName, cnDate]);
  const existingIdentities = confirmedExistingCodes(existingRows);
  // 同一天已经有哪些「证券身份」有记录（含迁移后统一标记为未核验的存量行）：
  // 历史补漏据此区分“缺行补齐”与“改写既有历史日价”两类动作。必须按「市场+代码」判断，
  // 否则另一市场存在同形代码时，缺失的 HK|000001 会被当成在改写 CN|000001 的历史而阻断。
  const existingAnyIdentities = new Set((existingRows || []).map(row => identityOf(dailyPriceRowMarket(row), row.code)));

  // 仅抓取缺失证券（按规范证券身份去重，避免同一代码因多条持仓记录而重复抓取）
  const market = MARKET_CLOSE_TIMES.find(item => item.label === label).market;
  const missing = pickMissingPositions(positions, existingIdentities,
    (code, position) => positionMarketOf(position) === market && matchFn(code, position));
  if (missing.length === 0) return { recorded: 0, failed: 0, skipped: 0 };

  let recorded = 0, failed = 0, skipped = 0;
  const prices = [];
  // 退市/人工估值等非标准证券没有可靠的市场收盘价：保留未归因状态，
  // 记录跳过数量供任务审计，但不把“无行情”伪装成成功价格或反复触发接口失败。
  if (label === '非标准证券') {
    skipped = missing.length;
    return { recorded, failed, skipped, error: false };
  }
  // 历史补漏必须走对应证券类型的历史接口，不能把当前实时价写入过去日期。
  // 但“缺行补齐”和“改写既有历史日价”是两件事：迁移把存量行统一标成未核验，
  // 直接重写等于在没有只读审计的情况下替换历史事实，因此默认禁止，
  // 只有显式授权（context.allowHistoricalRevision 或 MARKET_CLOSE_ALLOW_HISTORY_REVISION=1）才允许修订。
  if (cnDate !== cnDateStr()) {
    const allowRevision = context.allowHistoricalRevision === true
      || String(process.env.MARKET_CLOSE_ALLOW_HISTORY_REVISION || '') === '1';
    const plan = splitHistoricalBackfill(missing.map(pos => positionIdentityKey(pos)), existingAnyIdentities, allowRevision);
    for (const pos of missing) {
      if (plan.blocked.includes(positionIdentityKey(pos))) continue;
      const ok = await backfillDailyPrices(username, accountName, pos.code, cnDate, cnDate, pos);
      if (ok) recorded++;
      else failed++;
    }
    return { recorded, failed, skipped, blockedRevision: plan.blocked.length, error: recorded === 0 && failed > 0 };
  }
  const confirmedPrices = context.confirmedPrices instanceof Map
    ? context.confirmedPrices
    : await loadConfirmedClosePriceMap(market, cnDate);
  const reusedRecords = [];
  const needQuotePositions = [];
  for (const pos of missing) {
    const existingConfirmed = confirmedPrices.get(positionIdentityKey(pos));
    if (existingConfirmed) {
      reusedRecords.push(buildReusedCloseRecord({ pos, existing: existingConfirmed, market, label, cnDate }));
      recorded++;
    } else {
      needQuotePositions.push(pos);
    }
  }
  if (reusedRecords.length > 0) {
    // 先把本地已确认可复用的价格原子落库，避免后续上游取价失败拖累本可复用的证券。
    await withTransaction(async tx => {
      await saveDailyPrices(username, accountName, cnDate, reusedRecords, { client: tx });
      await syncConfirmedCloseToPositions(username, accountName, cnDate, { client: tx });
    });
  }
  let activeQuoteMap = context.quoteMap || null;
  let refreshError = null;
  if (needQuotePositions.length > 0) {
    if (!activeQuoteMap && context.ensureQuoteMap) {
      activeQuoteMap = await context.ensureQuoteMap();
    }
    if (activeQuoteMap && context.refreshMissingQuotes) {
      try {
        await context.refreshMissingQuotes(needQuotePositions.map(pos => closeQuoteCode(pos, market)), activeQuoteMap);
      } catch (err) {
        // 补取缺价证券失败时不能丢掉同批已拿到的有效报价：先保留有效报价落库，再触发缺价重试。
        refreshError = err;
      }
    }
  }
  for (const pos of needQuotePositions) {
    const q = quoteForCode(activeQuoteMap, closeQuoteCode(pos, market));
    if (isUsableQuote(q, cnDate)) {
      prices.push({ code: pos.code, name: pos.name || q.name || '', price: q.price, quote_time: q.quote_time || null });
      recorded++;
    } else {
      failed++;
    }
  }
  let candidateCount = 0;
  if (prices.length > 0) {
    const state = context.quoteState
      || await getMarketState({ market, businessDate: cnDate, time: shanghaiDateTime().time });
    const nowAt = context.now !== undefined ? context.now : new Date();
    const freshRows = prices.map(row => buildCloseRecord({ row, market, label, state, cnDate, now: nowAt }));
    candidateCount = freshRows.filter(row => row.is_final !== true).length;
    // 日价写入与兼容持仓价回写同一事务：任一失败整体回滚，任务如实失败，
    // 不留“日价有了、持仓价没更新”的半成品状态。
    await withTransaction(async tx => {
      await saveDailyPrices(username, accountName, cnDate, freshRows, { client: tx });
      await syncConfirmedCloseToPositions(username, accountName, cnDate, { client: tx });
    });
    for (const saved of freshRows) {
      if (saved.quality === 'confirmed' && saved.is_final === true && Number(saved.price) > 0) {
        const key = identityOf(market, saved.code);
        if (!confirmedPrices.has(key)) {
          confirmedPrices.set(key, {
            code: saved.code,
            market,
            price: Number(saved.price),
            name: saved.name || '',
            source: saved.source || null,
            quote_at: saved.quote_at || null,
            evidence: saved.evidence || null,
          });
        }
      }
    }
  }
  if (refreshError && ['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN', 'DATASET_LOCKED'].includes(refreshError.code)) {
    throw refreshError;
  }
  if (refreshError && failed === 0) failed += 1;
  const error = recorded === 0 && failed > 0;
  return { recorded, failed, skipped, error, candidateCount };
}

function closeQuoteCode(position, market) {
  return market === 'HK' ? identityCode(market, position.code) + '.HK' : toTsCode(position.code);
}

// 同一交易日的收盘任务复用腾讯批量行情；过期的单只报价按证券身份补取。
async function getSharedQuoteMap(cnDate) {
  const key = String(cnDate || cnDateStr());
  if (sharedQuotePromises.has(key)) return sharedQuotePromises.get(key);
  const promise = (async () => {
    const { rows } = await repository.select_positions();
    const codes = [...new Set(rows.map(row => closeQuoteCode(row, positionMarketOf(row))).filter(code =>
      /^(00|30|43|48|50|51|60|68|83|87|92|11|12|15|16|[0-9]{5})/.test(code)
    ))];
    const { readRealtimeQuotes } = require('../dataAccess/marketDatasets');
    return readRealtimeQuotes({ codes, businessDate: key });
  })().catch(error => { sharedQuotePromises.delete(key); throw error; });
  sharedQuotePromises.set(key, promise);
  return promise;
}

// 为所有账户记录某市场某交易日收盘价；任一证券失败都进入统一有限重试，避免部分账户缺数却显示成功。
async function recordMarketClose(label, matchFn, dateStr, context = {}) {
  const cnDate = dateStr || cnDateStr();
  const market = MARKET_CLOSE_TIMES.find(item => item.label === label);
  if (!market || !(await isMarketTradingDate(market.market, cnDate))) {
    return { recorded: 0, failed: 0, skipped: 0, verifiedNoChange: true, reason: 'market_closed_or_unknown' };
  }
  const isCurrentDate = cnDate === cnDateStr();
  let quoteMap = context.quoteMap || null;
  const ensureQuoteMap = isCurrentDate && label !== '非标准证券'
    ? async () => {
      if (!quoteMap) quoteMap = await getSharedQuoteMap(cnDate);
      return quoteMap;
    }
    : null;
  // 终盘证据去重：同一「市场|证券|交易日」在一次任务里只取一次。
  // 多个账户持有同一证券时不再各采一遍；同一证券也不会因多条持仓记录重复请求。
  // 本次新采集的日线会写回共享日线事实（loadTerminalBar），任务结束再按实际证据行发布分区，
  // 这样下一次任务或重试直接复用，不会重复外采。
  const terminalBarCache = new Map();
  let persistedBars = 0;
  // 外采后没写回共享日线的对象及原因：只统计成功条数会让"全部失败"看起来像"无需发布"。
  const persistFailures = [];
  const terminalFailures = [];
  const terminalFailureKeys = new Set();
  const noteTerminalFailure = failure => {
    if (!failure) return;
    const key = [failure.code, failure.apiName, failure.message].join('|');
    if (terminalFailureKeys.has(key)) return;
    terminalFailureKeys.add(key);
    terminalFailures.push(failure);
  };
  // 缺口表本身出问题时（登记/销账/读取/计数失败）不能降级成"没有缺口"：
  // 那会让下一次运行只看得到"账户已确认"，把没补齐的共享日线报成成功。
  let gapStoreError = null;
  const noteGapStoreError = (action, error, key) => {
    if (!gapStoreError) gapStoreError = { action, reason: (error && error.message) || String(error), identity: key || null };
    console.warn('[market_close] 共享日线缺口表' + action + '失败 ' + (key || '') + '：' + ((error && error.message) || error));
  };
  const readTerminalBar = (key, loader) => {
    if (!terminalBarCache.has(key)) {
      terminalBarCache.set(key, Promise.resolve().then(loader)
        .then(async result => {
          if (result && result.terminalError) noteTerminalFailure(result.terminalError);
          if (result && result.ok && result.via === 'series') {
            if (result.persisted) {
              persistedBars += 1;
              // 销账：缺口确实补上了才算完成，否则重跑永远不知道它已解决。
              await repository.resolve_bar_gap([label, result.tsCode, cnDate])
                .catch(error => noteGapStoreError('销账', error, key));
            } else {
              const reason = result.persistReason || 'persist_not_attempted';
              persistFailures.push({ identity: key, reason });
              // 缺口独立落库：账户日价已确认不代表共享日线已写进去，
              // 只放内存的话重跑会因"该证券当日已确认"直接跳过，缺口再也补不上。
              await repository.upsert_bar_gap([label, market.market, result.code, result.tsCode, result.kind,
                cnDate, result.close, reason,
                JSON.stringify({ identity: key, provider: result.provider || null })])
                .catch(error => noteGapStoreError('登记', error, key));
            }
          } else if (result && result.ok && result.via === 'published_bar' && result.tsCode) {
            // 命中已发布日线同样是"这只证券这一天已补齐"：上一次可能日线写完、发布成功，
            // 但销账那一步正好撞上缺口表异常；若这里不销账，缺口会永久留着、任务永远 partial。
            await repository.resolve_bar_gap([label, result.tsCode, cnDate])
              .catch(error => noteGapStoreError('销账', error, key));
          }
          return result;
        })
        .catch(error => ({
          ok: false,
          reason: 'terminal_evidence_error',
          detail: error && error.message,
          terminalError: terminalFailureDetails(error),
        })));
    }
    return terminalBarCache.get(key);
  };
  // 缺口重建：账户日价证据里写着"这条终盘证据没写回共享日线"，它是缺口表写不进去时
  // 唯一可恢复的事实来源。每次运行先据此补登记，避免登记失败后状态彻底丢失。
  // 必须按本任务的品种范围筛选：同一市场下 A股/可转债/基金各有自己的任务与日线入口，
  // 把别的品种登记进来会让任务去补不属于它的缺口，状态与补采范围互相干扰。
  if (!isCurrentDate && LABEL_TERMINAL_KINDS[label]) {
    const unsynced = await repository.select_unsynced_bar_evidence([cnDate, market.market])
      .catch(error => { noteGapStoreError('重建读取', error); return { rows: [] }; });
    for (const row of (unsynced.rows || [])) {
      const kind = row.kind || resolveTerminalKind({ code: row.code, market: market.market });
      if (!labelOwnsKind(label, kind)) continue;
      const tsCode = row.ts_code || terminalSeriesCode(row.code, kind);
      // 已经有合格日线的证券不再登记（补过之后不能反复重开缺口）。
      const existing = await repository.count_terminal_daily_bars([tsCode, cnDate])
        .catch(error => { noteGapStoreError('重建核对', error, tsCode); return { rows: [{ bars: null }] }; });
      const bars = existing.rows && existing.rows[0] ? existing.rows[0].bars : null;
      if (bars === null) continue;
      if (Number(bars) > 0) continue;
      await repository.upsert_bar_gap([label, market.market, String(row.code), tsCode, kind, cnDate, null,
        'evidence_terminal_not_persisted', JSON.stringify({ source: 'daily_price_evidence', kind })])
        .catch(error => noteGapStoreError('重建登记', error, tsCode));
    }
  }
  // 先补上一次运行留下的共享日线缺口：这一步与"账户当日是否已有确认价"无关，
  // 否则重跑会把缺口永远跳过（首次账户日价成功、共享日线失败的场景）。
  const openGapsBefore = isCurrentDate ? { rows: [] } : await repository.select_open_bar_gaps([label, cnDate])
    .catch(error => { noteGapStoreError('读取', error); return { rows: [] }; });
  for (const gap of (openGapsBefore.rows || [])) {
    await verifyTerminalClose({ code: gap.code, kind: gap.kind, market: gap.market, date: cnDate, readBar: readTerminalBar });
  }
  const refreshAttempted = new Set();
  const confirmedPrices = isCurrentDate && label !== '非标准证券'
    ? (context.confirmedPrices instanceof Map
      ? context.confirmedPrices
      : await loadConfirmedClosePriceMap(market.market, cnDate))
    : null;
  const quoteState = isCurrentDate && label !== '非标准证券'
    ? await getMarketState({ market: market.market, businessDate: cnDate, time: shanghaiDateTime().time })
    : null;
  const refreshMissingQuotes = isCurrentDate && label !== '非标准证券' ? async (codes, targetQuoteMap) => {
    const map = targetQuoteMap || quoteMap;
    if (!map) return;
    const candidates = [...new Set((codes || []).map(code => String(code || '').trim()).filter(Boolean))]
      .filter(code => !refreshAttempted.has(code) && quoteNeedsCloseRefresh(quoteForCode(map, code), quoteState, cnDate, context.now));
    candidates.forEach(code => refreshAttempted.add(code));
    if (!candidates.length) return;
    const { readRealtimeQuotes } = require('../dataAccess/marketDatasets');
    const refreshed = await readRealtimeQuotes({ codes: candidates, businessDate: cnDate, force: true });
    mergeQuoteMaps(map, refreshed);
  } : null;
  // 账户范围可显式收窄（人工定向补跑/回归用）：默认仍是全库所有账户。
  // 共享日线缺口按「任务标签 + 交易日」独立重试，与账户范围无关。
  const { rows: accounts } = context.accounts && context.accounts.length
    ? { rows: context.accounts }
    : await repository.select_accounts();
  let recorded = 0, failed = 0, skipped = 0, pendingConfirmation = 0, blockedRevision = 0;
  for (const account of accounts) {
    const r = await recordCloseOne(account.username, account.account_name, label, matchFn, cnDate, {
      quoteMap, ensureQuoteMap, quoteState, refreshMissingQuotes, confirmedPrices, now: context.now,
      allowHistoricalRevision: context.allowHistoricalRevision === true,
    })
      .catch(error => {
        if (error && (error.terminalFailure || ['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN', 'DATASET_LOCKED'].includes(error.code))) {
          error.externalCalls = getExternalCallStats().total;
          throw error;
        }
        return { recorded: 0, failed: 1, error: true };
      });
    recorded += Number(r && r.recorded || 0);
    failed += Number(r && r.failed || 0);
    skipped += Number(r && r.skipped || 0);
    // 只拿到候选（未确认终盘）的证券必须计入缺口：不能因为“写进去了”就报成功。
    pendingConfirmation += Number(r && r.candidateCount || 0);
    // 需要授权才能改写的历史日价同样要计数：既不能静默覆盖，也不能当成补写成功。
    blockedRevision += Number(r && r.blockedRevision || 0);
  }
  if (terminalFailures.length) {
    const first = terminalFailures[0];
    const error = new Error(`终盘日线请求失败 (${label} ${cnDate})：${first.message}`);
    error.code = first.code;
    error.errorType = first.errorType;
    error.retryable = first.retryable;
    error.source = first.source;
    error.apiName = first.apiName;
    error.recoverAt = first.recoverAt;
    error.terminalFailure = true;
    error.terminalFailures = terminalFailures.slice(0, 20);
    error.externalCalls = getExternalCallStats().total;
    throw error;
  }
  if (failed > 0) {
    // 失败必须按统一执行器重试：if (failed > 0) throw new Error(...)
    const error = new Error(`收盘记录存在缺失 (${label} ${cnDate})：成功 ${recorded}，失败 ${failed}`);
    error.externalCalls = getExternalCallStats().total;
    throw error;
  }
  if (isCurrentDate) {
    return {
      recorded, failed, skipped, pendingConfirmation, blockedRevision,
      priceBasis: 'tencent_post_close_quote',
      publishDatasetCodes: ['account_daily_prices'],
      verifiedNoChange: recorded === 0 && skipped === 0,
      externalCalls: getExternalCallStats().total,
    };
  }
  // 每次运行都核对并补发布：上一次可能"日线已落库、分区发布失败"，
  // 而这一次没有任何新增日线、也没有待重试缺口——若只在有写入时才发布，
  // 重跑就会把未发布的分区报成 not_needed 并成功。发布本身是幂等 upsert，代价极小。
  const gapRetried = (openGapsBefore.rows || []).length;
  const barPartition = await publishCloseBarPartition(market.market, cnDate, label, accounts);
  // 一条都没写进去时不能报"无需发布"：共享日线发布本身就是未完成，
  // 下一次任务会重复外采同一批证券。这里把失败对象和原因一并带回去。
  const persistFailed = persistFailures.length;
  // 以数据库里的未销账缺口为准：内存里的 persistFailures 只覆盖本次运行，
  // 只有缺口表也清空了，才算"共享日线确实补齐"。计数失败同样不能当成"没有缺口"。
  const openGapCount = await repository.count_open_bar_gaps([label, cnDate])
    .catch(error => { noteGapStoreError('计数', error); return { rows: [{ open_gaps: null }] }; });
  const openGapsRaw = openGapCount.rows && openGapCount.rows[0] ? openGapCount.rows[0].open_gaps : null;
  const openBarGaps = openGapsRaw === null ? null : (Number(openGapsRaw) || 0);
  // 分区状态：有合格日线就必须发布成功；发布失败/数不清一律按 publish_failed 处理。
  const barPartitionStatus = barPartition.published
    ? barPartition.status
    : (barPartition.error || barPartition.rowCount !== 0
      ? 'publish_failed'
      : (Number(openBarGaps) > 0 ? 'gaps_open'
        : (persistFailed > 0 ? 'persist_failed' : 'not_needed')));
  const persistReasonCounts = {};
  for (const item of persistFailures) {
    persistReasonCounts[item.reason] = (persistReasonCounts[item.reason] || 0) + 1;
  }
  // 完成判定＝本次零失败 ＋ 缺口清零（计数成功）＋ 分区发布成功（或确实没有日线）。
  const sharedBarComplete = persistFailed === 0
    && openBarGaps === 0
    && !gapStoreError
    && (barPartition.published || barPartition.rowCount === 0);
  // 兼容持仓价的回写已在 recordCloseOne 的同一事务内完成（日价 + 持仓价原子提交）；
  // 任务级不再单独补一次，避免事务外二次写入与“回写失败仍报成功”。
  return {
    recorded, failed, skipped, pendingConfirmation, blockedRevision,
    persistedBars,
    // 本任务实际产出的分区数据集：账户日价由统一发布器落库；
    // 共享日线证据分区（position_close_bars_*）已在本函数内按市场自行发布，
    // 因此只声明归属、不再交给通用发布器重复写（避免覆盖成缺少质量证据的分区行）。
    publishDatasetCodes: ['account_daily_prices'],
    // 缺口是否清零以缺口表为准：本次没新增失败也可能还有上次没销账的缺口。
    sharedBarPublication: sharedBarComplete ? 'complete' : 'incomplete',
    sharedBarPersist: {
      persisted: persistedBars,
      failed: persistFailed,
      reasons: persistReasonCounts,
      samples: persistFailures.slice(0, 10).map(item => ({ identity: item.identity, reason: item.reason })),
      gapsRetried: gapRetried,
      gapsOpen: openBarGaps,
      // 缺口表自身异常（登记/销账/读取/计数失败）：结果为 null 时必须让任务报未完成。
      storeError: gapStoreError ? { action: gapStoreError.action, reason: gapStoreError.reason } : null,
    },
    barPartition: {
      rowCount: barPartition.rowCount,
      published: barPartition.published,
      error: barPartition.error || null,
      // 覆盖对账结果随任务结果返回：只报"分区已发布"看不出部分覆盖，
      // 三交易日观察需要能直接读到 expected/covered。
      coverage: barPartition.coverage || null,
      qualityStatus: barPartition.qualityStatus || null,
    },
    // 分区没发布出去就意味着下次还会重复外采，必须在结果里可见，不能只留在日志。
    barPartitionStatus,
    verifiedNoChange: recorded === 0 && skipped === 0 && pendingConfirmation === 0 && blockedRevision === 0
      && openBarGaps === 0 && !gapStoreError,
    externalCalls: getExternalCallStats().total,
  };
}

async function recentMarketDays(count) {
  const days = [];
  const now = new Date();
  const dates = [];
  for (let i = 1; i <= 21; i++) dates.push(fmtCN(new Date(now.getTime() - i * 86400000)));
  await prefetchMarketFacts('HK', dates);
  for (let i = 1; i <= 21 && days.length < count; i++) {
    const dd = new Date(now.getTime() - i * 86400000);
    const date = fmtCN(dd);
    const [cnOpen, hkOpen] = await Promise.all([
      Promise.resolve(isCnTradingDate(date)),
      isMarketTradingDate('HK', date),
    ]);
    if (cnOpen || hkOpen) days.push(date);
  }
  return days;
}

function isUncoveredPosition(code, position) {
  return Number(position && position.quantity) > 0 &&
    !MARKET_CLOSE_TIMES.filter(mkt => mkt.label !== '非标准证券').some(mkt => mkt.match(code, position));
}

// 手动补漏先查询账户已有收盘价的日期范围，再找出其中遗漏的交易日。
// 不把 daily_prices 首日之前的历史当成“遗漏”，避免在功能启用前的旧数据被误判为待补。
async function findMissingCloseDates(username, accountName) {
  const range = await repository.select_daily_prices_1([username, accountName]);
  const firstDate = range.rows[0] && range.rows[0].first_date;
  const lastDate = (await recentMarketDays(1))[0];
  if (!firstDate || !lastDate || firstDate > lastDate) return [];

  const [existing, scope] = await Promise.all([
    repository.select_daily_prices_2([username, accountName, firstDate, lastDate]),
    repository.select_position_scope([username, accountName]),
  ]);
  // 缺口精确到证券身份：某天只要有一只该市场持仓没有已确认收盘价，这一天就算未补齐。
  // 身份键与收盘任务、持仓回写同源（「市场｜代码」），A 股 000001 的确认价不能顶替港股 00001 的缺口。
  const confirmedByDate = new Map();
  for (const row of existing.rows) {
    if (!confirmedByDate.has(row.date)) confirmedByDate.set(row.date, new Set());
    confirmedByDate.get(row.date).add(identityOf(dailyPriceRowMarket(row), row.code));
  }
  const heldPositions = (scope.rows || []).map(row => ({ code: String(row.code), subtype: row.subtype }));
  const missingDates = [];
  const cursor = new Date(firstDate + 'T12:00:00Z');
  const end = new Date(lastDate + 'T12:00:00Z');
  const rangeDates = [];
  for (let date = firstDate; date <= lastDate; date = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)) rangeDates.push(date);
  await prefetchMarketFacts('HK', rangeDates);
  while (cursor <= end) {
    const date = fmtCN(cursor);
    const hkOpen = await isMarketTradingDate('HK', date);
    if (isCnTradingDate(date) || hkOpen) {
      const confirmedCodes = confirmedByDate.get(date) || new Set();
      let gap = false;
      for (const marketRule of MARKET_CLOSE_TIMES) {
        if (marketRule.label === '非标准证券') continue;
        if (!(await isMarketTradingDate(marketRule.market, date))) continue;
        if (hasConfirmedGap(marketRule, heldPositions, confirmedCodes)) { gap = true; break; }
      }
      if (gap) missingDates.push(date);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return missingDates;
}

// 缺失补漏：自动任务只回看近期；手动任务查询每个账户已落库区间的全部缺失交易日。
async function backfillMissingCloses(options) {
  const scanAllMissingDates = !!(options && options.scanAllMissingDates);
  const recentDays = scanAllMissingDates ? null : await recentMarketDays(6);
  const { rows: accounts } = await repository.select_accounts();
  let accountCount = 0, missingDates = 0, recorded = 0, failed = 0, skipped = 0, blockedRevision = 0, errors = 0;
  for (const account of accounts) {
    const accountName = account.account_name;
    const days = scanAllMissingDates
      ? await findMissingCloseDates(account.username, accountName)
      : recentDays;
    if (!days.length) continue;
    accountCount++;
    missingDates += days.length;
    for (const day of days) {
      // 不再用「当天任意一条记录」判断是否跳过：recordCloseOne 内部按代码幂等，
      // 只补齐缺失代码，已完整的市场不会重复抓取，缺失的市场会被补上。
      for (const mkt of MARKET_CLOSE_TIMES) {
        if (!(await isMarketTradingDate(mkt.market, day))) continue;
        const result = await recordCloseOne(account.username, accountName, mkt.label, mkt.match, day)
          .catch(e => {
            // 异常必须计数并带回调用方：吞掉异常会让“补漏失败”看起来像“补漏成功”。
            console.warn('[backfill] ' + day + ' ' + accountName + ' 失败:', e.message);
            errors += 1;
            return null;
          });
        if (result) {
          recorded += result.recorded || 0;
          failed += result.failed || 0;
          skipped += result.skipped || 0;
          blockedRevision += result.blockedRevision || 0;
        }
      }
    }
  }
  return { accounts: accountCount, missingDates, recorded, failed, skipped, blockedRevision, errors };
}

// 收盘任务的结果契约（纯函数）：当日收盘价是否记录、共享日线是否写完是两件事。
// 共享日线没写完不能报成功——否则调度与监控会把"未完成"当成"已完成"，缺口也不会自动续跑；
// 但收盘价已如实落库时仍要标 pricesRecorded=true，让下游净值生成继续，别用共享缓存缺口挡住当日净值。
function resolveCloseJobOutcome({ result, label, dateStr }) {
  const scope = `${label} ${dateStr || ''}`.trim();
  if (Number(result.blockedRevision) > 0) {
    const message = `历史日价待授权修订 (${scope})：需改写 ${result.blockedRevision} 条既有历史日价，`
      + '默认不改写存量历史，须先做只读审计并显式授权（MARKET_CLOSE_ALLOW_HISTORY_REVISION=1）';
    return { ok: false, status: 'failed', errorType: 'historical_revision_blocked', error: message, pricesRecorded: false, retryable: false, failures: [] };
  }
  if (Number(result.pendingConfirmation) > 0) {
    const message = `收盘后腾讯报价未到齐 (${scope})：候选 ${result.pendingConfirmation}，已确认 ${result.recorded - result.pendingConfirmation}，请重新取价`;
    return { ok: false, status: 'failed', errorType: 'close_quote_not_ready', error: message, pricesRecorded: false, retryable: true, failures: [] };
  }
  const persist = result.sharedBarPersist || {};
  const incomplete = result.sharedBarPublication === 'incomplete';
  if (incomplete || result.barPartitionStatus === 'publish_failed') {
    const reasonText = Object.entries(persist.reasons || {})
      .map(([reason, count]) => `${reason}×${count}`).join('、') || '原因未知';
    const gapsOpen = Number(persist.gapsOpen);
    // 缺口表自身异常时，"缺口是否清零"根本没有答案，绝不能按"没有缺口"处理。
    const storeError = persist.storeError;
    let message;
    if (storeError) {
      message = `共享日线缺口表不可用 (${scope})：${storeError.action}失败（${storeError.reason}）；`
        + '收盘价虽已记录，但无法确认共享日线是否补齐，需修复缺口表后重跑';
    } else if (incomplete) {
      const gapsText = Number.isFinite(gapsOpen) && gapsOpen > 0
        ? `仍有 ${gapsOpen} 条共享日线缺口未补齐（本次重试 ${persist.gapsRetried || 0} 条）`
        : `证据分区未发布（${result.barPartitionStatus}）`;
      message = `共享日线未写完 (${scope})：本次落库 ${result.persistedBars || 0} 条，失败 ${persist.failed || 0} 条`
        + `（${reasonText}），${gapsText}；收盘价已记录，但共享日线复用未完成，需按原因补齐后重跑`;
    } else {
      message = `共享日线证据分区未发布 (${scope})：已核验 ${result.persistedBars || 0} 条`
        + `（${result.barPartitionStatus}），下次任务会重复外采`;
    }
    return {
      ok: false,
      status: 'partial',
      errorType: 'shared_bar_incomplete',
      error: message,
      retryable: true,
      pricesRecorded: true,
      failures: persist.samples || [],
    };
  }
  return { ok: true, status: 'succeeded', errorType: null, error: null, pricesRecorded: true, retryable: false, failures: [] };
}

// 带幂等锁与执行记录的收盘任务（跨实例单跑，失败留痕供告警）
async function runMarketCloseJob(label, matchFn, dateStr, context = {}) {
  if (!(await tryClaimJob('market_close:' + label))) return { skipped: true, reason: 'already_running' }; // 其他实例已在跑，跳过
  const runId = await startJobRun('market_close:' + label);
  try {
    const result = await recordMarketClose(label, matchFn, dateStr, context);
    const outcome = resolveCloseJobOutcome({ result, label, dateStr });
    // 执行记录必须与契约一致：partial 也是 false，不能写成成功。
    await finishJobRun(runId, outcome.ok, outcome.error || `写入 ${result.recorded}，跳过 ${result.skipped || 0}，失败 0`);
    return {
      ...result,
      ok: outcome.ok,
      status: outcome.status,
      label,
      error: outcome.error,
      errorType: outcome.errorType,
      retryable: outcome.retryable,
      pricesRecorded: outcome.pricesRecorded,
      failures: outcome.failures,
    };
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    console.error('[market_close:' + label + '] 失败:', e.message || e);
    return {
      ok: false,
      error: e.message || String(e),
      errorCode: e.code,
      errorType: e.errorType || e.type,
      retryable: e.retryable,
      recoverAt: e.recoverAt,
      source: e.source,
      apiName: e.apiName,
      terminalFailures: e.terminalFailures || [],
      externalCalls: Number(e.externalCalls || context.externalCallCount || 0),
    };
  } finally {
    await releaseJob('market_close:' + label);
  }
}

async function runMarketCloseByLabel(label, dateStr, context = {}) {
  const market = MARKET_CLOSE_TIMES.find(item => item.label === label);
  if (!market) return { ok: false, unsupported: true, error: `未找到收盘市场规则：${label}` };
  return runMarketCloseJob(market.label, market.match, dateStr, context);
}

function marketTimeEpoch(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  const minute = parseClock(time);
  return Date.UTC(year, month - 1, day, Math.floor(minute / 60) - 8, minute % 60, 0, 0);
}

async function waitUntilBusinessTime(date, time) {
  const delay = marketTimeEpoch(date, time) - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
}

async function runLegacyFinalTaskOnce(date, taskName, task) {
  const key = `${date}|${taskName}`;
  if (legacyFinalTasks.has(key)) return legacyFinalTasks.get(key);
  const promise = Promise.resolve().then(task).then(result => {
    if (!result || result.ok !== false) return result;
    legacyFinalTasks.delete(key);
    return result;
  }).catch(error => {
    legacyFinalTasks.delete(key);
    throw error;
  });
  legacyFinalTasks.set(key, promise);
  for (const existingKey of legacyFinalTasks.keys()) {
    if (existingKey.slice(0, 10) < fmtCN(new Date(Date.now() - 7 * 86400000))) legacyFinalTasks.delete(existingKey);
  }
  return promise;
}

function shouldRunLegacyNavAfterHkClose(cnStatus, hkCloseQuoteTime) {
  const closeMinute = parseClock(hkCloseQuoteTime);
  const halfDay = closeMinute != null && closeMinute <= 15 * 60 + 10;
  return cnStatus === 'closed' || (cnStatus === 'open' && !halfDay);
}

async function runLegacyPostCloseCycle(marketRule, date, result) {
  // 后续汇率/净值只依赖“当日收盘价是否已记录”，不依赖共享日线是否写完：
  // 共享日线缺口由任务自身的 partial 状态和重试去补，不能因此让当日净值缺失。
  if (!result || result.pricesRecorded !== true) return;
  const [cn, hk] = await Promise.all([
    getMarketState({ market: 'CN', businessDate: date, time: '00:00' }),
    getMarketState({ market: 'HK', businessDate: date, time: '00:00' }),
  ]);
  if (marketRule.market === 'HK') {
    const fx = await runLegacyFinalTaskOnce(date, 'hk-rate', () => runHkRateJob({ final: true, targetDate: date }));
    if (fx && fx.ok && shouldRunLegacyNavAfterHkClose(cn.status, hk.closeQuoteTime)) {
      // 净值依赖当日回购利率，统一等 18:30（早于该时点跑会因 Tushare repo_daily 当日未出而缺利率）。
      await waitUntilBusinessTime(date, '18:30');
      await runLegacyFinalTaskOnce(date, 'nav-snapshot', () => runNavSnapshotJob({ targetDate: date }));
      await runLegacyFinalTaskOnce(date, 'index-recent', () => runIndexRecentJob());
    }
    return;
  }
  const hkHalfDayAlreadyClosed = hk.status === 'open' && hk.closeQuoteTime && parseClock(hk.closeQuoteTime) <= 15 * 60 + 10;
  if (hk.status === 'closed' || hkHalfDayAlreadyClosed) {
    await waitUntilBusinessTime(date, hk.status === 'closed' ? '16:15' : '15:20');
    const fx = await runLegacyFinalTaskOnce(date, 'hk-rate', () => runHkRateJob({ final: true, targetDate: date }));
    if (!fx || !fx.ok) return;
    // 净值统一等 18:30（当日回购利率发布后），不再跟 16:20 收盘就绪时间。
    await waitUntilBusinessTime(date, '18:30');
    await runLegacyFinalTaskOnce(date, 'nav-snapshot', () => runNavSnapshotJob({ targetDate: date }));
    await runLegacyFinalTaskOnce(date, 'index-recent', () => runIndexRecentJob());
  }
}

async function nextMarketCloseDelay(marketRule, nowInput = new Date()) {
  const now = new Date(nowInput);
  const dates = [];
  for (let offset = 0; offset <= 31; offset++) dates.push(fmtCN(new Date(now.getTime() + offset * 86400000)));
  if (marketRule.market === 'HK') await prefetchMarketFacts('HK', dates);
  for (const date of dates) {
    const state = await getMarketState({ market: marketRule.market, businessDate: date, time: '00:00' });
    if (state.status !== 'open') continue;
    const closeQuoteTime = marketRule.market === 'HK' ? state.closeQuoteTime : null;
    const time = closeQuoteTime || `${String(marketRule.h).padStart(2, '0')}:${String(marketRule.m).padStart(2, '0')}`;
    const target = marketTimeEpoch(date, time);
    if (target > now.getTime()) return Math.max(target - now.getTime(), 5000);
  }
  return 12 * 60 * 60 * 1000;
}

// 旧调度兼容入口仍使用同一市场状态服务，港股收盘采集在实际收市后20分钟运行。
function scheduleAllMarketCloses() {
  let lastBackfill = '';
  for (const marketRule of MARKET_CLOSE_TIMES) {
    const scheduleNext = async () => {
      const delay = await nextMarketCloseDelay(marketRule).catch(() => 12 * 60 * 60 * 1000);
      setTimeout(async () => {
        try {
          const today = cnDateStr();
          if (await isMarketTradingDate(marketRule.market, today)) {
            if (today !== lastBackfill) {
              lastBackfill = today;
              backfillMissingCloses().catch(error => console.error('[worker] 补漏失败:', error.message));
            }
            const result = await runMarketCloseJob(marketRule.label, marketRule.match, today);
            await runLegacyPostCloseCycle(marketRule, today, result);
          }
        } catch (error) {
          console.error(`[worker] ${marketRule.label} 收盘任务失败:`, error.message || error);
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }
}

// 补漏结果判定：失败、待授权改写、被捕获的异常都算“未完成”，
// 任务记录与接口状态必须据此给出 ok:false，不能因为返回了统计就当成补齐成功。
function summarizeBackfill(result) {
  const data = result || {};
  const failed = Number(data.failed || 0);
  const blockedRevision = Number(data.blockedRevision || 0);
  const errors = Number(data.errors || 0);
  const incomplete = failed > 0 || blockedRevision > 0 || errors > 0;
  const message = '检查 ' + Number(data.accounts || 0) + ' 个账户，发现 ' + Number(data.missingDates || 0)
    + ' 个缺失交易日，补写 ' + Number(data.recorded || 0) + ' 条价格'
    + (incomplete
      ? '；失败 ' + failed + ' 条，待授权修订 ' + blockedRevision + ' 条，异常 ' + errors + ' 次（历史日价默认不改写）'
      : '');
  return { incomplete, failed, blockedRevision, errors, message };
}

// 历史补漏目标拆分：缺行补齐（可以直接写）与存量历史修订（需显式授权）必须分开。
// 迁移把存量日价统一标成未核验，若把它们当“缺失”直接重写，就等于在没有只读审计的情况下替换历史事实。
// 入参是「市场|规范代码」的证券身份，不是裸代码：另一市场存在同形代码时，
// A 股 000001 的存量行不能被当成港股 000001 已被写过，反之亦然。
function splitHistoricalBackfill(missingIdentities, existingAnyIdentities, allowRevision) {
  const writable = [];
  const blocked = [];
  for (const identity of (missingIdentities || [])) {
    if (!allowRevision && existingAnyIdentities && existingAnyIdentities.has(String(identity))) blocked.push(String(identity));
    else writable.push(String(identity));
  }
  return { writable, blocked };
}

// 日价行的市场身份：market 明确时以它为准（迁移会写 HK/CN/UNKNOWN），
// market 为空（迁移前旧行/测试夹具）时按代码形状兜底（5 位港股、6 位 A 股）。
// 明确标记为身份不明（UNKNOWN）时不得再按长度猜：猜错会把另一只证券的价格认成自己的。
function dailyPriceRowMarket(row) {
  const text = String((row && row.market) || '').toUpperCase();
  if (text === 'HK' || text === 'CN') return text;
  if (text) return 'UNKNOWN';
  return String((row && row.code) || '').length === 5 ? 'HK' : 'CN';
}

// 持仓的规范证券身份：与收盘市场规则同源（subtype 港股 / 5 位代码属港股，其余按 A 股）。
function positionMarketOf(position) {
  const code = String((position && position.code) || '');
  const subtype = String((position && position.subtype) || '');
  const currency = String((position && (position.quoteCurrency || position.quote_currency)) || '').toUpperCase();
  return subtype === '港股' || currency === 'HKD' || /^\d{5}$/.test(code) ? 'HK' : 'CN';
}

// 身份里的代码必须与终盘查询同源规范化：港股 000001 与 00001 是同一只证券（规范代码 00001），
// 直接拿原始代码拼身份，就会把同一只港股当成两只——缺口判定、幂等跳过和历史修订门禁全部错位。
// 身份不明（UNKNOWN）的行不做规范化：它本来就不构成任何证券的证据。
function identityCode(market, code) {
  const text = String(code || '');
  return String(market || '').toUpperCase() === 'HK' ? normalizeHkCode(text) : text;
}

function identityOf(market, code) {
  return `${String(market || '')}|${identityCode(market, code)}`;
}

function positionIdentityKey(position) {
  return identityOf(positionMarketOf(position), position && position.code);
}

// 纯函数：挑出该市场当日本身缺失的持仓，按「市场 + 代码」去重。
// 同形证券（A 股 000001 / 港股 00001）各自算一只，一只已确认不影响另一只。
function pickMissingPositions(positions, existingIdentities, matchFn) {
  const seen = new Set();
  const out = [];
  for (const position of (positions || [])) {
    if (!position || !position.code || !matchFn(position.code, position)) continue;
    const key = positionIdentityKey(position);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existingIdentities && existingIdentities.has(key)) continue;
    out.push(position);
  }
  return out;
}

// 兼容入口：只要代码清单，但缺口判定与去重同样按证券身份，不再按裸代码。
function pickMissingCodes(positions, existingIdentities, matchFn) {
  return pickMissingPositions(positions, existingIdentities, matchFn).map(position => String(position.code));
}

// 某市场的当日缺口判定（纯函数）：该市场任一持仓没有「同市场同代码」的已确认收盘价，即算缺口。
// 补漏、收盘任务与持仓回写必须用同一身份口径，否则同形证券会互相顶替。
function hasConfirmedGap(marketRule, heldPositions, confirmedIdentities) {
  const rule = marketRule || {};
  if (typeof rule.match !== 'function') return false;
  return (heldPositions || []).some(position => position && position.code
    && rule.match(position.code, position)
    && !confirmedIdentities.has(positionIdentityKey(position)));
}

// 从当日已有记录中筛出“已确认终盘”的证券身份；候选与遗留价不参与幂等跳过。
function confirmedExistingCodes(rows) {
  const set = new Set();
  for (const row of (rows || [])) {
    if (String(row.quality || '') !== 'confirmed' || row.is_final !== true) continue;
    set.add(identityOf(dailyPriceRowMarket(row), row.code));
  }
  return set;
}

module.exports = { qualifyCloseQuote, quoteNeedsCloseRefresh, verifyTerminalClose, loadTerminalBar, buildCloseRecord, confirmedExistingCodes, hasConfirmedGap, splitHistoricalBackfill, summarizeBackfill, scheduleAllMarketCloses, runMarketCloseByLabel, backfillMissingCloses, findMissingCloseDates, isTradingDay, isMarketTradingDate, nextMarketCloseDelay, fmtCN, pickMissingCodes, pickMissingPositions, positionIdentityKey, dailyPriceRowMarket, resolveTerminalKind, isUncoveredPosition, cnWeekday, msUntil, nextRunDelay, quoteForCode, isUsableQuote, mergeQuoteMaps, shouldRunLegacyNavAfterHkClose, runLegacyPostCloseCycle,
  // 第七轮验收新增的可回归纯函数/入口：港股代码规范化、共享日线证据裁决、外采日线落库与分区发布。
  normalizeHkCode, terminalSeriesCode, isTerminalBarEvidence, pickTerminalBarRow, persistTerminalBar, publishCloseBarPartition, readPublishedDailyBar,
  // 第八轮验收：同一港股的五位/六位代码必须落到同一个身份，身份里不做规范化就会当成两只证券。
  identityCode, identityOf, positionMarketOf,
  // 第八轮复核：共享日线没写完时任务契约必须是 partial（不能报成功），可离线回归。
  resolveCloseJobOutcome,
  // 第八轮五次复核：缺口重建必须按任务品种范围筛选，A股/可转债/基金互不串扰。
  LABEL_TERMINAL_KINDS, labelOwnsKind };
