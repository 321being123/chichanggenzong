// ========== 套利公告同步编排 ==========
// 首次 1 年同步 + 增量同步 + 游标管理 + 原始记录入库 + 公告/事件标准化
const { pool } = require('../db');
const hkex = require('./hkexAnnouncement');
const cninfo = require('./cninfoAnnouncement');
const parser = require('./arbitrageParser');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { fetchTencentQuotes } = require('./tencentQuote');
const { ensureInstrumentIdentity, isCleanSecurityName } = require('./securityIdentity');
const { fetchSseEventsBatch, fetchSzseEventsBatch } = require('./stockAnalysis');
const { sendAlert, resolveSourceEndpointAlerts } = require('./jobAlertMailer');
const { probeCninfoPermission } = require('./sourceEndpointProbe');
const txControl = require('../repositories/transactionControl');
const { createIngestionRun, findOpenCase, finishIngestionRun, getCursor, getSourceId, ingestRawRecord, upsertCursor } = require('../repositories/arbitrageAnnouncementSyncRepository.js');
const repository = require('../repositories/arbitrageAnnouncementSyncRepository.js');
const {
  cleanSecurityText,
  firstSecurityCode,
  firstSecurityName,
  classifyDocumentRole,
  isBuyerOfferAnnouncement,
  classifyRiskAnnouncement,
  buildEventKey,
  announcementMergeKey,
  PARSER_VERSION,
} = require('./arbitrageRules');

const SYNC_JOB = 'arbitrage_sync';
const MAX_PARSE_ATTEMPTS = 3;
const EXCHANGE_SCAN_DAYS = 7;
const ACTIVE_DOCUMENT_ROLES = ['amendment', 'terms', 'summary', 'proposal'];
const PRIMARY_A_SHARE_SOURCES = ['sse', 'szse'];

function normalizeAnnouncementDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

function splitExchangeWindows(fromDate, toDate) {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const windows = [];
  for (let cursor = start; cursor <= end;) {
    const windowEnd = new Date(Math.min(cursor.getTime() + (EXCHANGE_SCAN_DAYS - 1) * 86400000, end.getTime()));
    windows.push({ from: cursor.toISOString().slice(0, 10), to: windowEnd.toISOString().slice(0, 10) });
    cursor = new Date(windowEnd.getTime() + 86400000);
  }
  return windows;
}

function exchangeAnnouncementStockName(event) {
  const raw = event && event.raw || {};
  return cleanSecurityText(raw.SECURITY_NAME || raw.SECURITY_NAME_ABBR || raw.SECURITY_NAME_SHORT
    || raw.secName || raw.stockName || raw.securityName || raw.name || '');
}

function mapExchangeArbitrageAnnouncement(event, scope) {
  const code = String(event && event.stock_code || '').match(/\d{6}/);
  const title = cleanSecurityText(event && event.title);
  const announcedAt = normalizeAnnouncementDate(event && event.event_date);
  return {
    sourceKey: `${scope}:${event && (event.source_number || event.url || `${event.event_date || ''}:${event.stock_code || ''}:${title}`)}`,
    fileLink: event && event.url || '',
    title,
    announcedAt,
    stockCode: code ? code[0] : '',
    stockName: exchangeAnnouncementStockName(event),
    exchange: scope === 'sse' ? 'SSE' : 'SZSE',
    rawPayload: event && event.raw || event,
  };
}

function isRelevantExchangeArbitrageAnnouncement(event) {
  const text = [event && event.title, event && event.raw && event.raw.LONG_TEXT].filter(Boolean).join(' ');
  return Boolean(classifyRiskAnnouncement(text) || classifyTitle(text, 'sse') || detectUpdate(text)
    || isGenericControlChangeTermination(text));
}

async function searchExchangeArbitrageAnnouncements(scope, { fromDate, toDate, _fetcher, _cninfo } = {}) {
  const fetcher = _fetcher || (scope === 'sse' ? fetchSseEventsBatch : fetchSzseEventsBatch);
  const backupAdapter = _cninfo || cninfo;
  if (!fetcher) throw new Error(`未配置交易所公告适配器：${scope}`);
  const events = [];
  let usedFallback = false;
  for (const window of splitExchangeWindows(fromDate, toDate)) {
    let result;
    let primaryComplete = true;
    try {
      result = await fetcher(window.from, window.to, '');
      primaryComplete = !(result && result.complete === false);
    } catch (error) {
      primaryComplete = false;
      result = { events: [], diagnostics: { primary_error: error.message } };
    }
    if (!primaryComplete) {
      const backup = await backupAdapter.searchAnnouncements({
        fromDate: window.from, toDate: window.to,
        exchanges: [scope],
        keywords: ['要约收购', '现金选择权', '换股吸收合并', '供股', '终止', '完成'],
        requestDelayMs: 0,
        structured: true,
      });
      if (!backup.complete) {
        const error = new Error(`${scope.toUpperCase()} 主源分页不完整且 CNINFO 备源也未完整`);
        error.code = 'PAGINATION_INCOMPLETE';
        error.errorType = 'data_quality';
        error.source = scope;
        throw error;
      }
      usedFallback = true;
      events.push(...backup.events.map(event => ({ ...event, fallback_source: 'cninfo', primary_source: scope })));
    } else {
      events.push(...(result && result.events || []));
    }
  }
  const output = [...new Map(events
    .filter(isRelevantExchangeArbitrageAnnouncement)
    .map(event => [announcementMergeKey({ securityCode: event.stock_code, announcedAt: normalizeAnnouncementDate(event.event_date), title: event.title })
      || `${scope}:${event.source_number || event.url || `${event.event_date}:${event.title}`}`, event]))
    .values()].map(event => mapExchangeArbitrageAnnouncement(event, scope));
  Object.defineProperty(output, 'fallbackUsed', { value: usedFallback, enumerable: false });
  return output;
}

async function updateFallbackRuntime(scope, usedFallback) {
  const sourceCode = scope === 'sse' ? 'sse' : 'szse';
  const { rows } = await repository.select_ops_data_sources([sourceCode]);
  if (!rows[0]) return null;
  const runtime = await repository.insert_ops_source_endpoint_runtime([rows[0].source_id, Boolean(usedFallback)]);
  const state = runtime.rows[0] || null;
  if (!usedFallback) {
    await resolveSourceEndpointAlerts(sourceCode, '*').catch(() => {});
  }
  if (usedFallback && state && Number(state.consecutive_fallback_count) >= 3) {
    await sendAlert({
      alertKey: `source_fallback_degraded:${sourceCode}:arbitrage`, alertType: 'source_fallback_degraded', severity: 'warning',
      scopeType: 'source_endpoint', scopeKey: `${sourceCode}:*`, jobCode: SYNC_JOB,
      subject: `${sourceCode.toUpperCase()} 公告主源连续退化`,
      summary: `${sourceCode.toUpperCase()} 主源连续 ${state.consecutive_fallback_count} 轮使用 CNINFO 备源，需检查分页或接口可用性。`,
    });
  }
  return state;
}

const exchangeAdapters = {
  sse: { searchAnnouncements: params => searchExchangeArbitrageAnnouncements('sse', params) },
  szse: { searchAnnouncements: params => searchExchangeArbitrageAnnouncements('szse', params) },
};

const SCOPES = {
  hkex: { sourceCode: 'hkex_announcements', dataset: 'hkex_announcements', adapter: hkex },
  sse: { sourceCode: 'sse', dataset: 'sse_announcements', adapter: exchangeAdapters.sse },
  szse: { sourceCode: 'szse', dataset: 'szse_announcements', adapter: exchangeAdapters.szse },
};

function todayShanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeCursorDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : todayShanghaiDate(date);
}

// 获取数据源 ID
/* getSourceId 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

// 读取游标
/* getCursor 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

// 写入/更新游标：失败只能记录错误，不能把已有成功水位回退到重叠窗口起点。
/* upsertCursor 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

// 创建摄取运行记录
/* createIngestionRun 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

/* finishIngestionRun 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

// 入库原始记录（幂等）
/* ingestRawRecord 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

// 查找同一标的 + 同一策略的「进行中」事件（用于把同一事项的多份公告合并成一条事件链）
/* findOpenCase 已迁入 server/repositories/arbitrageAnnouncementSyncRepository.js */

// 历史数据中的巨潮文档可能没有 announcement_merge_key，不能只靠 raw_payload 去重。
// 按证券、公告日和规范化标题再比一次，确保后续交易所公告能接回原事件链。
async function findCaseByAnnouncementMergeKey(client, instrumentId, mergeKey, announcedAt) {
  if (!instrumentId || !mergeKey || !announcedAt) return null;
  const { rows } = await repository.select_event_arbitrage_case_documents([instrumentId, announcedAt], client);
  return rows.find(row => announcementMergeKey({
    securityCode: row.canonical_code,
    announcedAt: row.announced_at,
    title: row.title,
    market: 'CN',
  }) === mergeKey) || null;
}

// 已终态事件的后续进程公告（换股实施、终止上市、实施结果、股份变动等）必须续接原事件链。
// 2026-10-27 根因：中金换股吸收合并的实施公告出现在案件已 completed 之后，原逻辑只在
// 「已有案件的最后公告不早于新公告」时归档，晚于它的一律新建，于是同一合并案被拆成
// 208/209（有合并方、无实施公告）与 294/295/296（有实施公告、合并方为空或反向）多条平行案件，
// 换股比例与合并方散落各处，持仓换股无法可靠判定。
// 这里按「同标的 + 同策略 + 最近终态案件 + 365 天窗口」续接，只挂公告、不改事件状态、不重解析条款。
const FOLLOW_UP_WINDOW_DAYS = 365;

async function findFollowUpCaseId(client, instrumentId, strategyType, announcedAt) {
  if (!instrumentId || !strategyType || !announcedAt) return null;
  const { rows } = await client.query(`
    SELECT c.case_id, c.review_status, max(d.announced_at) AS last_date
      FROM event.arbitrage_cases c
      JOIN event.arbitrage_case_documents acd ON acd.case_id=c.case_id
      JOIN event.documents d ON d.document_id=acd.document_id
     WHERE c.target_instrument_id=$1 AND c.strategy_type=$2
       AND c.event_status IN ('completed','terminated','expired')
     GROUP BY c.case_id, c.review_status
    HAVING max(d.announced_at) < $3::date
       AND max(d.announced_at) >= $3::date - ($4::int * INTERVAL '1 day')
     ORDER BY last_date DESC, c.case_id DESC
     LIMIT 1
  `, [instrumentId, strategyType, announcedAt, FOLLOW_UP_WINDOW_DAYS]);
  return rows[0] || null;
}

// 标准化公告 -> event.documents + event.arbitrage_cases（按标的+策略合并成事件链）
async function standardizeAnnouncement(sourceId, rawRecordId, ann, scope) {
  ann = {
    ...ann,
    stockCode: firstSecurityCode(ann.stockCode, scope === 'hkex' ? 'HK' : 'CN'),
    stockName: firstSecurityName(ann.stockName),
    title: cleanSecurityText(ann.title),
  };
  const mergeKey = announcementMergeKey({ securityCode: ann.stockCode, announcedAt: ann.announcedAt, title: ann.title, market: scope === 'hkex' ? 'HK' : 'CN' });
  ann.rawPayload = { ...(ann.rawPayload || {}), announcement_merge_key: mergeKey };
  if (scope !== 'hkex' && /境内上市外资股转换上市地|B股转H股|B转H/.test(ann.title || '')
      && /^0\d{5}$/.test(String(ann.stockCode || ''))) {
    const bCode = '2' + String(ann.stockCode).slice(1);
    const quoteMap = await fetchTencentQuotes([bCode]);
    const quote = quoteMap.get(bCode);
    ann = {
      ...ann,
      stockCode: bCode,
      stockName: quote && quote.name ? quote.name.replace('Ｂ', 'B') : `${ann.stockName || ''}B`,
      exchange: 'SZSE',
    };
  }
  const client = await pool.connect();
  let createdNew = false;
  let createdCaseId = null;
  let touchedCaseId = null;
  let touchedDocumentId = null;
  let touchedDocumentRole = 'other';
  try {
    await txControl.begin(client);

    // 查找或创建 instrument
    let instrumentId = null;
    if (ann.stockCode) {
      const code = scope === 'hkex' ? ann.stockCode + '.HK' : ann.stockCode;
      const { rows: ins } = await repository.select_core_instruments([code], client);
      if (ins.length) {
        instrumentId = ins[0].instrument_id;
        if (ann.stockName && isCleanSecurityName(ann.stockName)) {
          await repository.update_core_instruments([ann.stockName, instrumentId], client);
        }
      } else {
        // 自动创建 instrument
        const assetClass = 'stock';
        const market = scope === 'hkex' ? 'HK' : 'CN';
        // 交易所：港交所固定 SEHK；巨潮按 pageColumn 映射（SH*→SSE，SZ*→SZSE，BJ*→BSE）
        const exchange = scope === 'hkex' ? 'SEHK'
          : (ann.exchange === 'SSE' ? 'SSE' : ann.exchange === 'SZSE' ? 'SZSE' : ann.exchange === 'BSE' ? 'BSE' : 'SZSE');
        const currency = scope === 'hkex' || /^2\d{5}$/.test(String(ann.stockCode || '')) ? 'HKD' : 'CNY';
        const master = await ensureInstrumentIdentity({ canonicalCode: code, name: ann.stockName || '', assetClass, market, exchangeCode: exchange, currencyCode: currency, status: 'listed', companyName: ann.stockName || '' }, client.query.bind(client));
        instrumentId = master.instrumentId;
      }
    }

    // 查找或创建 document
    const contentHash = require('crypto').createHash('md5').update(ann.fileLink || ann.title || '').digest('hex');
    const { rows: docRows } = await repository.insert_event_documents([null, 'arbitrage_announcement', ann.title, ann.announcedAt, ann.fileLink || '', sourceId, contentHash, rawRecordId, JSON.stringify(ann.rawPayload)], client);
    const documentId = docRows[0].document_id;
    // 后续进程公告（完成/终止/换股实施等）：必须同时命中「套利事件语义」+「终态动作词」，
    // 且只更新「同标的 + 同策略类型」的进行中事件，避免「工商变更登记」「股份回购完成」等无关公告误关有效机会。
    // 港交所部分公告（如创维集团）只在 LONG_TEXT 分类标签里写“私有化”，
    // 正式标题只写“计划安排/股份回购/撤销上市”，分类时需一并使用元数据。
    const classificationText = [ann.title, ann.rawPayload && ann.rawPayload.LONG_TEXT]
      .filter(Boolean)
      .join(' ');
    const risk = classifyRiskAnnouncement(ann.title);
    const documentRole = risk ? 'risk' : classifyDocumentRole(ann.title);

    // 风险公告不新建套利案件；按公告证券代码挂到同一证券参与的进行中 A 股事件。
    if (risk && instrumentId) {
      const { rows: riskCases } = await repository.select_event_arbitrage_cases([instrumentId], client);
      for (const riskCase of riskCases) {
        await repository.insert_event_arbitrage_case_documents([riskCase.case_id, documentId, ann.announcedAt], client);
        await repository.update_event_arbitrage_cases([riskCase.case_id], client);
      }
      await txControl.commit(client);
      return;
    }
    const update = detectUpdate(classificationText);
    if (update && update.strategyType && instrumentId) {
      const { rows: open } = await repository.select_event_arbitrage_cases_1([instrumentId, update.strategyType], client);
      if (open.length) {
        const caseId = open[0].case_id;
        await repository.insert_event_arbitrage_case_documents_1([caseId, documentId, ann.announcedAt, documentRole], client);
        await repository.update_event_arbitrage_cases_1([update.status, caseId], client);
        await txControl.commit(client);
        return;
      }
      // 找不到进行中事件时，把终态公告归到最近的同标的同策略案件；绝不反向新建进行中案件。
      const { rows: latest } = await repository.select_event_arbitrage_cases_2([instrumentId, update.strategyType], client);
      if (latest.length) {
        await repository.insert_event_arbitrage_case_documents_2([latest[0].case_id, documentId, ann.announcedAt, documentRole], client);
        await repository.update_event_arbitrage_cases_2([update.status, latest[0].case_id], client);
      }
      await txControl.commit(client);
      return;
    }

    // 部分控制权变更/协议转让终止公告不会在标题中重复写出“要约收购”，
    // 但它们仍然代表关联的 A 股套利事件已经终止（例如君亭酒店）。
    // 只在巨潮公告、已知标的、且明确出现“终止/撤回/取消”与控制权变更语义时处理，
    // 避免把普通工商变更或其他无关公告误关。
    if (scope !== 'hkex' && isGenericControlChangeTermination(classificationText) && instrumentId) {
      const { rows: broadOpen } = await repository.select_event_arbitrage_cases_3([instrumentId], client);
      for (const row of broadOpen) {
        await repository.insert_event_arbitrage_case_documents_3([row.case_id, documentId, ann.announcedAt], client);
        await repository.update_event_arbitrage_cases_3([ann.announcedAt || null, row.case_id], client);
      }
      await txControl.commit(client);
      return;
    }

    // 标题分类 -> 确定策略类型
    const strategyType = classifyTitle(classificationText, scope);

    if (strategyType) {
      // 合并优先级：先按「标的+策略」匹配进行中事件；无则按 source_key 幂等匹配（同一公告重复同步）
      let existing = instrumentId ? await findOpenCase(client, instrumentId, strategyType) : null;
      // 如果同标的同策略已有时间更晚的终态公告，当前历史方案只能归档，不能重新打开事件。
      if (!existing && mergeKey) {
        existing = await findCaseByAnnouncementMergeKey(client, instrumentId, mergeKey, ann.announcedAt);
      }
      if (!existing && mergeKey) {
        const { rows: merged } = await repository.select_event_documents([mergeKey], client);
        existing = merged[0] || null;
      }
      if (!existing && instrumentId && ann.announcedAt) {
        const { rows: terminal } = await repository.select_event_arbitrage_cases_4([instrumentId, strategyType, ann.announcedAt], client);
        if (terminal.length) existing = { case_id: terminal[0].case_id, review_status: 'approved', terminal: true };
      }
      // 终态之后才发布的进程公告（实施、退市、结果）续接原事件，不新建平行案件。
      if (!existing) {
        const followUp = await findFollowUpCaseId(client, instrumentId, strategyType, ann.announcedAt);
        if (followUp) existing = { case_id: followUp.case_id, review_status: followUp.review_status, terminal: true };
      }
      if (!existing) {
        const { rows: byKey } = await repository.select_event_arbitrage_cases_5([sourceId, ann.sourceKey], client);
        existing = byKey[0] || null;
      }

      if (existing) {
        // 并入已有事件链
        const caseId = existing.case_id;
        await repository.insert_event_arbitrage_case_documents_1([caseId, documentId, ann.announcedAt, documentRole], client);
        await repository.update_event_arbitrage_cases_4([caseId], client);
        if (!existing.terminal) {
          touchedCaseId = caseId;
          touchedDocumentId = documentId;
          touchedDocumentRole = documentRole;
        }
      } else {
        // 新建候选事件
        const market = scope === 'hkex' ? 'HK' : 'CN';
        const canonicalCode = scope === 'hkex' ? ann.stockCode + '.HK' : ann.stockCode;
        const eventKey = buildEventKey({ market, strategyType, canonicalCode, announcedAt: ann.announcedAt, sourceKey: ann.sourceKey });
        const { rows: newCase } = await repository.insert_event_arbitrage_cases([market, strategyType, sourceId, ann.sourceKey, instrumentId, documentId, ann.announcedAt, JSON.stringify(ann.rawPayload), eventKey], client);

        await repository.insert_event_arbitrage_case_documents_1([newCase[0].case_id, documentId, ann.announcedAt, documentRole], client);

        createdNew = true;
        createdCaseId = newCase[0].case_id;
        touchedCaseId = createdCaseId;
        touchedDocumentId = documentId;
        touchedDocumentRole = documentRole;
      }
    }

    await txControl.commit(client);

    // 每份条款类 PDF 只解析一次并把证据存入数据库；再按公告角色聚合，不允许低优先级公告覆盖正式方案。
    if (touchedCaseId && touchedDocumentId && touchedDocumentRole !== 'terminal' && ann.fileLink && /\.pdf$/i.test(ann.fileLink)) {
      try {
        const payload = await parser.parseAndStoreDocument(touchedCaseId, touchedDocumentId, ann.fileLink, ann.stockCode, touchedDocumentRole);
        if (payload) await parser.rebuildCaseTerms(touchedCaseId);
      } catch (parseErr) {
        // 解析失败（Python 缺失 / PDF 下载或提取异常）记录为数据质量错误，便于排查，不阻断同步
        try { await parser.recordParseFailure(touchedCaseId, sanitizeJobError(parseErr.message || parseErr, 500)); } catch (_) {}
      }
    }
  } catch (err) {
    await txControl.rollback(client);
    throw err;
  } finally {
    client.release();
  }
}

// 标题分类
function classifyTitle(title, scope) {
  if (!title) return null;

  if (scope !== 'hkex' && isBuyerOfferAnnouncement(title)) return null;

  // 完成/终止类公告只用于关闭已有事件，不能在找不到旧事件时反向新建一条“进行中”案件。
  if (detectUpdate(title)) return null;

  if (scope === 'hkex') {
    if (/私有化|privatisation|privatization/.test(title)) return 'hk_privatisation';
    if (/供股|rights issue|rights subscription/.test(title)) return 'hk_rights';
    if (/要约|offer|acquisition/.test(title)) return 'hk_privatisation';
    return null;
  }

  // A 股
  if (/换股吸收合并/.test(title)) return 'a_share_swap';
  if (/现金选择权|异议股东收购请求权/.test(title)) return 'a_cash_offer';
  if (/境内上市外资股转换上市地|B股转H股|B转H/.test(title)) return 'a_cash_offer';
  // “免于发出要约”没有现金要约价，不构成可计算的套利机会。
  if (/免于发出要约|免於發出要約/.test(title)) return null;
  if (/要约收购/.test(title)) return 'a_cash_offer';
  return null;
}

// 后续进程公告识别：必须同时命中「套利事件语义」+「终态动作词」，并返回匹配的策略类型，
// 以便只更新「同标的 + 同策略」的进行中事件；泛泛的「完成/终止」但无套利语义时不处理。
function detectUpdate(title) {
  if (!title) return null;
  // 买方投资的完成/终止也不能关闭以发布人为目标的其他退出事件。
  if (isBuyerOfferAnnouncement(title)) return null;

  // 无关「完成」场景直接排除（工商变更登记、股份回购、年报、权益分派、利润分配等）
  const unrelatedComplete = /工商登记|变更登记|股份回购|回购|年报|季报|权益分派|利润分配|现金分红|减资|股权激励|可转债/.test(title);

  // “终止上市”是换股吸收合并中被吸收方退市的进程，不代表套利事项终止；
  // 其他“终止本次交易/要约”等明确终态仍按原规则处理。
  const isTerminate = /(?:终止(?!上市)|終止(?!上市))(本次|本次要约|筹划|实施|本次交易|该次|本次重大|本次重组|私有化)?/.test(title)
    || /lapsed|terminated|withdrawn/i.test(title);
  const isComplete = !unrelatedComplete
    && /(完成|完成過戶|实施结果|實施結果|申报结果|申報結果|供股.{0,12}结果|供股.{0,12}結果|已实施|已實施|生效.*撤回上市地位)/.test(title);

  // 事件语义：标题必须体现具体套利类型，才能确定关闭哪一类事件
  let strategyType = null;
  if (/私有化|privatisation|privatization/.test(title)) strategyType = 'hk_privatisation';
  else if (/换股吸收合并|吸收合并|换股/.test(title)) strategyType = 'a_share_swap';
  else if (/供股|rights issue|rights subscription/.test(title)) strategyType = 'hk_rights';
  else if (/要约收购|现金选择权|异议股东收购请求权|境内上市外资股转换上市地|B股转H股|B转H/.test(title)) strategyType = 'a_cash_offer';

  if (!strategyType) return null; // 无套利语义，不处理
  if (isTerminate) return { status: 'terminated', strategyType };
  if (isComplete) return { status: 'completed', strategyType };
  return null;
}

// 控制权变更/协议转让整体终止的公告，标题可能不再出现“要约收购”等策略词。
function isGenericControlChangeTermination(text) {
  if (!text) return false;
  return /(?:终止(?!上市)|終止(?!上市)|撤回|取消)/.test(text)
    && /(控制权变更|协议转让)/.test(text);
}

// 生成月窗口：每段 ≤31 天；首段起点严格等于 fromDate（不回退到当月 1 日，避免越过一年边界）
function generateMonthWindows(fromDate, toDate) {
  const start = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  const windows = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const firstMonthStart = cur.getTime();
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth();
    const nextMonthEnd = new Date(Date.UTC(y, m + 1, 0)); // 当月月末
    const wEnd = nextMonthEnd > end ? end : nextMonthEnd;
    // 首段用真实起点 fromDate；其余段对齐到当月 1 日
    const wStart = (cur.getTime() === firstMonthStart) ? start : cur;
    windows.push({
      from: wStart.toISOString().slice(0, 10),
      to: wEnd.toISOString().slice(0, 10),
    });
    cur = new Date(Date.UTC(y, m + 1, 1));
  }
  return windows;
}

// 首次 1 年同步
async function runFirstSync() {
  const today = todayShanghaiDate();
  const oneYearAgo = todayShanghaiDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  const windows = generateMonthWindows(oneYearAgo, today);
  return runSync(windows, true);
}

// 增量同步
async function runIncrementalSync() {
  const today = todayShanghaiDate();
  const windows = [];

  for (const [scopeName, cfg] of Object.entries(SCOPES)) {
    const cursor = await getCursor('arbitrage_' + scopeName, cfg.dataset);
    const fromDate = cursor && normalizeCursorDate(cursor.last_success_date) || today;
    for (const window of generateMonthWindows(fromDate, today)) {
      windows.push({ scope: scopeName, ...window });
    }
  }

  return runSync(windows, false);
}

// 每次同步顺带补跑所有未解析/旧版本核心公告；不再用固定条数让旧案件长期排队。
// 单次任务的 maxExternalCallsPerRun 和来源级 Guard 仍负责外部请求止损，触发保护线时停止本轮补跑。
async function retryPendingDocuments() {
  const superseded = await supersedeLegacyDocumentsWithOfficial();
  const cninfoProbe = await probeCninfoPermission().catch(error => ({
    status: 'probe_error', attempted: 0, recovered: 0,
    error: sanitizeJobError(error.message || error, 240),
  }));
  const { rows } = await repository.select_event_arbitrage_case_documents_1([PARSER_VERSION, MAX_PARSE_ATTEMPTS]);
  const touched = new Set();
  const result = { attempted: 0, parsed: 0, failed: 0, superseded, cninfoProbe };
  const stopCodes = new Set([
    'BUDGET_WAIT', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN',
    'JOB_BUDGET_EXCEEDED', 'POLICY_NOT_CONFIGURED', 'POLICY_DISABLED', 'PERMISSION_DENIED',
  ]);
  for (const doc of rows) {
    result.attempted++;
    try {
      const payload = await parser.parseAndStoreDocument(doc.case_id, doc.document_id, doc.url, doc.canonical_code, doc.document_role, true);
      if (!payload) continue;
      touched.add(String(doc.case_id));
      result.parsed++;
    } catch (err) {
      const code = String(err && err.code || '').toUpperCase();
      if (stopCodes.has(code)) {
        result.waitingExternal = true;
        result.errorCode = code;
        result.recoverAt = err.recoverAt || null;
        break;
      }
      result.failed++;
    }
  }
  for (const caseId of touched) await parser.rebuildCaseTerms(caseId);
  const { rows: retryState } = await repository.select_event_arbitrage_case_documents_2([PARSER_VERSION, MAX_PARSE_ATTEMPTS]);
  result.pending = Number(retryState[0] && retryState[0].pending || 0);
  result.pendingNotDue = Number(retryState[0] && retryState[0].pending_not_due || 0);
  result.exhausted = Number(retryState[0] && retryState[0].exhausted || 0);
  return result;
}

// 交易所原文已经入库后，旧的 CNINFO 同公告只保留审计证据，不再参与解析重试和案件完整性判断。
// 只按同一事件链内的证券、公告日、规范化标题精确匹配，避免把后续公告误当成替代件。
async function supersedeLegacyDocumentsWithOfficial() {
  const { rows } = await repository.select_event_arbitrage_case_documents_3([ACTIVE_DOCUMENT_ROLES, PRIMARY_A_SHARE_SOURCES]);

  let superseded = 0;
  for (const row of rows) {
    const legacyKey = announcementMergeKey({
      securityCode: row.canonical_code,
      announcedAt: row.legacy_announced_at,
      title: row.legacy_title,
      market: 'CN',
    });
    const officialKey = announcementMergeKey({
      securityCode: row.canonical_code,
      announcedAt: row.official_announced_at,
      title: row.official_title,
      market: 'CN',
    });
    if (!legacyKey || legacyKey !== officialKey) continue;
    const updated = await repository.update_event_arbitrage_case_documents([row.case_id, row.document_id, ACTIVE_DOCUMENT_ROLES]);
    superseded += Number(updated.rowCount || 0);
  }
  return superseded;
}

// 执行同步
// 游标规则：某窗口内有任一条公告入库失败（或整窗拉取失败），则不推进游标，
// 保留已有成功水位，下一次增量同步会从重叠窗口重新拉取并重试失败记录（入库幂等）。
async function runSync(windows, isFirst) {
  const results = Object.fromEntries(Object.keys(SCOPES).map(scope => [scope, { total: 0, errors: [], failureDetails: [] }]));

  for (const [scopeName, cfg] of Object.entries(SCOPES)) {
    const sourceId = await getSourceId(cfg.sourceCode);
    const scopeWindows = isFirst ? windows : windows.filter(w => w.scope === scopeName);

    let scopeFailed = false;
    let cursorSafe = null;     // 下次同步起点（最后成功窗口的 to，或失败窗口的 from）
    let lastError = '';

    for (const win of scopeWindows) {
      const runId = await createIngestionRun(sourceId, cfg.dataset, { from: win.from, to: win.to });
      let windowFailed = false;
      try {
        const announcements = await cfg.adapter.searchAnnouncements({
          fromDate: win.from,
          toDate: win.to,
        });
        if (scopeName === 'sse' || scopeName === 'szse') {
          await updateFallbackRuntime(scopeName, Boolean(announcements.fallbackUsed));
        }
        announcements.sort((a, b) => String(a.announcedAt || '').localeCompare(String(b.announcedAt || ''))
          || String(a.sourceKey || '').localeCompare(String(b.sourceKey || '')));

        let count = 0;
        for (const ann of announcements) {
          try {
            const actualSourceId = ann.fallback_source === 'cninfo' ? await getSourceId('cninfo') : sourceId;
            const rawRecordId = await ingestRawRecord(runId, actualSourceId, cfg.dataset, ann);
            await standardizeAnnouncement(actualSourceId, rawRecordId, ann, scopeName);
            count++;
          } catch (err) {
            const safeError = sanitizeJobError(err.message || err, 1000);
            results[scopeName].errors.push(`${ann.sourceKey}: ${safeError}`);
            windowFailed = true;
            lastError = `${ann.sourceKey}: ${safeError}`;
          }
        }

        await finishIngestionRun(runId, count, windowFailed ? 'partial: some records failed' : '');
        results[scopeName].total += count;
      } catch (err) {
        const safeError = sanitizeJobError(err.message || err, 1000);
        await finishIngestionRun(runId, 0, safeError);
        results[scopeName].errors.push(`${win.from}~${win.to}: ${safeError}`);
        results[scopeName].failureDetails.push({
          code: err.code || 'JOB_FAILED',
          errorType: err.errorType || err.type || 'unknown',
          source: err.source || scopeName,
          recoverAt: err.recoverAt || null,
          error: err.message,
        });
        windowFailed = true;
        lastError = `${win.from}~${win.to}: ${safeError}`;
      }

      if (windowFailed) {
        // 不推进：下次从本窗口起点重试（含失败公告）
        cursorSafe = win.from;
        scopeFailed = true;
        break;
      }
      cursorSafe = win.to;
    }

    if (scopeFailed) {
      await upsertCursor('arbitrage_' + scopeName, cfg.dataset, cursorSafe, null, lastError);
    } else {
      await upsertCursor('arbitrage_' + scopeName, cfg.dataset, cursorSafe, new Date().toISOString(), '');
    }
  }

  results.recovery = await retryPendingDocuments();

  return results;
}

module.exports = {
  runFirstSync,
  runIncrementalSync,
  runSync,
  generateMonthWindows,
  standardizeAnnouncement,
  retryPendingDocuments,
  supersedeLegacyDocumentsWithOfficial,
  classifyTitle,
  detectUpdate,
  isGenericControlChangeTermination,
  classifyRiskAnnouncement,
  findFollowUpCaseId,
  FOLLOW_UP_WINDOW_DAYS,
  todayShanghaiDate,
  normalizeCursorDate,
  normalizeAnnouncementDate,
  splitExchangeWindows,
  searchExchangeArbitrageAnnouncements,
  SCOPES,
};
