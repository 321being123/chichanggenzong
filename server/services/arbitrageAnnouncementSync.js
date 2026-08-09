// ========== 套利公告同步编排 ==========
// 首次 1 年同步 + 增量同步 + 游标管理 + 原始记录入库 + 公告/事件标准化
const { pool } = require('../db');
const hkex = require('./hkexAnnouncement');
const cninfo = require('./cninfoAnnouncement');
const parser = require('./arbitrageParser');

const SYNC_JOB = 'arbitrage_sync';
const SCOPES = {
  hkex: { sourceCode: 'hkex_announcements', dataset: 'hkex_announcements', adapter: hkex },
  cninfo: { sourceCode: 'cninfo_announcements', dataset: 'cninfo_announcements', adapter: cninfo },
};

// 获取数据源 ID
async function getSourceId(sourceCode) {
  const { rows } = await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [sourceCode]);
  if (!rows.length) throw new Error('Data source not found: ' + sourceCode);
  return rows[0].source_id;
}

// 读取游标
async function getCursor(scopeKey, dataset) {
  const { rows } = await pool.query(
    'SELECT last_success_date, last_source_update, last_error, retry_count FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2',
    [scopeKey, dataset]
  );
  return rows.length ? rows[0] : null;
}

// 写入/更新游标
async function upsertCursor(scopeKey, dataset, lastSuccessDate, lastSourceUpdate, error) {
  await pool.query(`
    INSERT INTO ops.sync_cursors(scope_key, dataset_code, last_success_date, last_source_update, last_attempt_at, last_error, retry_count, updated_at)
    VALUES($1,$2,$3,$4,now(),$5,0,now())
    ON CONFLICT(scope_key, dataset_code) DO UPDATE SET
      last_success_date = COALESCE(EXCLUDED.last_success_date, ops.sync_cursors.last_success_date),
      last_source_update = COALESCE(EXCLUDED.last_source_update, ops.sync_cursors.last_source_update),
      last_attempt_at = now(),
      last_error = EXCLUDED.last_error,
      retry_count = CASE WHEN EXCLUDED.last_error <> '' THEN ops.sync_cursors.retry_count + 1 ELSE 0 END,
      updated_at = now()
  `, [scopeKey, dataset, lastSuccessDate, lastSourceUpdate, error || '']);
}

// 创建摄取运行记录
async function createIngestionRun(sourceId, dataset, range) {
  const { rows } = await pool.query(
    `INSERT INTO ops.ingestion_runs(source_id, dataset_code, request_range, status) VALUES($1,$2,$3,'running') RETURNING run_id`,
    [sourceId, dataset, JSON.stringify(range)]
  );
  return rows[0].run_id;
}

async function finishIngestionRun(runId, rowCount, errorMessage) {
  await pool.query(
    `UPDATE ops.ingestion_runs SET status=$1, row_count=$2, error_message=$3, finished_at=now() WHERE run_id=$4`,
    [errorMessage ? 'failed' : 'completed', rowCount, errorMessage || '', runId]
  );
}

// 入库原始记录（幂等）
async function ingestRawRecord(runId, sourceId, dataset, ann) {
  const sourceKey = ann.sourceKey;
  const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(ann.rawPayload)).digest('hex').slice(0, 32);
  const { rows } = await pool.query(`
    INSERT INTO ops.raw_records(run_id, source_id, dataset_code, source_key, source_updated_at, payload, payload_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(source_id, dataset_code, source_key, payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id, ingested_at=now()
    RETURNING raw_record_id
  `, [runId, sourceId, dataset, sourceKey, ann.announcedAt ? ann.announcedAt + 'T00:00:00Z' : null, JSON.stringify(ann.rawPayload), payloadHash]);
  return rows[0].raw_record_id;
}

// 查找同一标的 + 同一策略的「进行中」事件（用于把同一事项的多份公告合并成一条事件链）
async function findOpenCase(client, instrumentId, strategyType) {
  if (!instrumentId) return null;
  const { rows } = await client.query(`
    SELECT case_id, review_status FROM event.arbitrage_cases
    WHERE target_instrument_id=$1 AND strategy_type=$2
      AND event_status NOT IN ('completed','terminated','expired')
    ORDER BY created_at DESC LIMIT 1
  `, [instrumentId, strategyType]);
  return rows[0] || null;
}

// 标准化公告 -> event.documents + event.arbitrage_cases（按标的+策略合并成事件链）
async function standardizeAnnouncement(sourceId, rawRecordId, ann, scope) {
  const client = await pool.connect();
  let createdNew = false;
  let createdCaseId = null;
  try {
    await client.query('BEGIN');

    // 查找或创建 instrument
    let instrumentId = null;
    if (ann.stockCode) {
      const code = scope === 'hkex' ? ann.stockCode + '.HK' : ann.stockCode;
      const { rows: ins } = await client.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [code]);
      if (ins.length) {
        instrumentId = ins[0].instrument_id;
      } else {
        // 自动创建 instrument
        const assetClass = 'stock';
        const market = scope === 'hkex' ? 'HK' : 'CN';
        // 交易所：港交所固定 SEHK；巨潮按 pageColumn 映射（SH*→SSE，SZ*→SZSE，BJ*→BSE）
        const exchange = scope === 'hkex' ? 'SEHK'
          : (ann.exchange === 'SSE' ? 'SSE' : ann.exchange === 'SZSE' ? 'SZSE' : ann.exchange === 'BSE' ? 'BSE' : 'SZSE');
        const currency = scope === 'hkex' ? 'HKD' : 'CNY';
        const { rows: newIns } = await client.query(
          `INSERT INTO core.instruments(canonical_code, name, asset_class, market, exchange_code, currency_code, status)
           VALUES($1,$2,$3,$4,$5,$6,'listed') ON CONFLICT(canonical_code) DO UPDATE SET name=EXCLUDED.name RETURNING instrument_id`,
          [code, ann.stockName || '', assetClass, market, exchange, currency]
        );
        instrumentId = newIns[0].instrument_id;
      }
    }

    // 查找或创建 document
    const contentHash = require('crypto').createHash('md5').update(ann.fileLink || ann.title || '').digest('hex');
    const { rows: docRows } = await client.query(`
      INSERT INTO event.documents(company_id, document_type, title, announced_at, url, source_id, content_hash, raw_record_id, raw_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(source_id, url, content_hash) DO UPDATE SET title=EXCLUDED.title, announced_at=COALESCE(EXCLUDED.announced_at, event.documents.announced_at), raw_payload=EXCLUDED.raw_payload
      RETURNING document_id
    `, [null, 'arbitrage_announcement', ann.title, ann.announcedAt, ann.fileLink || '', sourceId, contentHash, rawRecordId, JSON.stringify(ann.rawPayload)]);
    const documentId = docRows[0].document_id;

    // 后续进程公告（完成/终止/换股实施等）：必须同时命中「套利事件语义」+「终态动作词」，
    // 且只更新「同标的 + 同策略类型」的进行中事件，避免「工商变更登记」「股份回购完成」等无关公告误关有效机会。
    const update = detectUpdate(ann.title);
    if (update && update.strategyType && instrumentId) {
      const { rows: open } = await client.query(`
        SELECT case_id FROM event.arbitrage_cases
        WHERE target_instrument_id=$1 AND strategy_type=$2 AND event_status NOT IN ('completed','terminated','expired')
        ORDER BY created_at DESC LIMIT 1
      `, [instrumentId, update.strategyType]);
      if (open.length) {
        const caseId = open[0].case_id;
        await client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at)
          VALUES($1,$2,'announcement',$3)
          ON CONFLICT(case_id, document_id) DO NOTHING
        `, [caseId, documentId, ann.announcedAt]);
        await client.query(`UPDATE event.arbitrage_cases SET event_status=$1, terms_updated_at=now(), updated_at=now() WHERE case_id=$2`, [update.status, caseId]);
        await client.query('COMMIT');
        return;
      }
    }

    // 标题分类 -> 确定策略类型
    const strategyType = classifyTitle(ann.title, scope);

    if (strategyType) {
      // 合并优先级：先按「标的+策略」匹配进行中事件；无则按 source_key 幂等匹配（同一公告重复同步）
      let existing = instrumentId ? await findOpenCase(client, instrumentId, strategyType) : null;
      if (!existing) {
        const { rows: byKey } = await client.query(
          `SELECT case_id, review_status FROM event.arbitrage_cases WHERE source_id=$1 AND source_key=$2`,
          [sourceId, ann.sourceKey]
        );
        existing = byKey[0] || null;
      }

      if (existing) {
        // 并入已有事件链
        const caseId = existing.case_id;
        await client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at)
          VALUES($1,$2,'announcement',$3)
          ON CONFLICT(case_id, document_id) DO NOTHING
        `, [caseId, documentId, ann.announcedAt]);
        await client.query(`UPDATE event.arbitrage_cases SET terms_updated_at=now(), updated_at=now() WHERE case_id=$1`, [caseId]);
      } else {
        // 新建候选事件
        const market = scope === 'hkex' ? 'HK' : 'CN';
        const { rows: newCase } = await client.query(`
          INSERT INTO event.arbitrage_cases(market, strategy_type, source_id, source_key, target_instrument_id, primary_document_id,
            event_status, review_status, announced_at, terms_updated_at, raw_payload)
          VALUES($1,$2,$3,$4,$5,$6,'proposed','approved',$7,now(),$8)
          RETURNING case_id
        `, [market, strategyType, sourceId, ann.sourceKey, instrumentId, documentId, ann.announcedAt, JSON.stringify(ann.rawPayload)]);

        await client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at)
          VALUES($1,$2,'announcement',$3)
          ON CONFLICT(case_id, document_id) DO NOTHING
        `, [newCase[0].case_id, documentId, ann.announcedAt]);

        createdNew = true;
        createdCaseId = newCase[0].case_id;
      }
    }

    await client.query('COMMIT');

    // 新事件且有 PDF 公告时，调用解析器补充条款（含参考/供股证券关系与 rights_units_per_new_share）
    if (createdNew && createdCaseId && ann.fileLink && /\.pdf$/i.test(ann.fileLink)) {
      try {
        const parsed = await parser.runPythonExtraction(ann.fileLink);
        await parser.applyExtractedTerms(createdCaseId, parsed);
      } catch (parseErr) {
        // 解析失败（Python 缺失 / PDF 下载或提取异常）记录为数据质量错误，便于排查，不阻断同步
        try { await parser.recordParseFailure(createdCaseId, parseErr.message); } catch (_) {}
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 标题分类
function classifyTitle(title, scope) {
  if (!title) return null;
  const t = title.toLowerCase();

  if (scope === 'hkex') {
    if (/私有化|privatisation|privatization/.test(title)) return 'hk_privatisation';
    if (/供股|rights issue|rights subscription/.test(title)) return 'hk_rights';
    if (/要约|offer|acquisition/.test(title)) return 'hk_privatisation';
    return null;
  }

  // A 股
  if (/换股吸收合并/.test(title)) return 'a_share_swap';
  if (/现金选择权|异议股东收购请求权/.test(title)) return 'a_cash_offer';
  if (/要约收购/.test(title)) return 'a_cash_offer';
  return null;
}

// 后续进程公告识别：必须同时命中「套利事件语义」+「终态动作词」，并返回匹配的策略类型，
// 以便只更新「同标的 + 同策略」的进行中事件；泛泛的「完成/终止」但无套利语义时不处理。
function detectUpdate(title) {
  if (!title) return null;

  // 无关「完成」场景直接排除（工商变更登记、股份回购、年报、权益分派、利润分配等）
  const unrelatedComplete = /工商登记|变更登记|股份回购|回购|年报|季报|权益分派|利润分配|现金分红|减资|股权激励|可转债/.test(title);

  const isTerminate = /终止(本次|本次要约|筹划|实施|本次交易|该次|本次重大|本次重组|私有化)?/.test(title)
    || /lapsed|terminated|withdrawn/i.test(title);
  const isComplete = !unrelatedComplete
    && /(完成|实施结果|实施完成|过户完成|已实施|顺利完成)/.test(title);

  // 事件语义：标题必须体现具体套利类型，才能确定关闭哪一类事件
  let strategyType = null;
  if (/私有化|privatisation|privatization/.test(title)) strategyType = 'hk_privatisation';
  else if (/换股吸收合并|吸收合并|换股/.test(title)) strategyType = 'a_share_swap';
  else if (/供股|rights issue|rights subscription/.test(title)) strategyType = 'hk_rights';
  else if (/要约收购|现金选择权|异议股东收购请求权/.test(title)) strategyType = 'a_cash_offer';

  if (!strategyType) return null; // 无套利语义，不处理
  if (isTerminate) return { status: 'terminated', strategyType };
  if (isComplete) return { status: 'completed', strategyType };
  return null;
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
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const windows = generateMonthWindows(oneYearAgo, today);
  return runSync(windows, true);
}

// 增量同步
async function runIncrementalSync() {
  const today = new Date().toISOString().slice(0, 10);
  const windows = [];

  for (const [scopeName, cfg] of Object.entries(SCOPES)) {
    const cursor = await getCursor('arbitrage_' + scopeName, cfg.dataset);
    const fromDate = cursor && cursor.last_success_date ? cursor.last_success_date : today;
    windows.push({ scope: scopeName, from: fromDate, to: today });
  }

  return runSync(windows, false);
}

// 执行同步
// 游标规则：某窗口内有任一条公告入库失败（或整窗拉取失败），则不推进游标，
// 并把 last_success_date 指向该窗口起点，下一次增量同步会重新拉取该窗口并重试失败记录（入库幂等）。
async function runSync(windows, isFirst) {
  const results = { hkex: { total: 0, errors: [] }, cninfo: { total: 0, errors: [] } };

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

        let count = 0;
        for (const ann of announcements) {
          try {
            const rawRecordId = await ingestRawRecord(runId, sourceId, cfg.dataset, ann);
            await standardizeAnnouncement(sourceId, rawRecordId, ann, scopeName);
            count++;
          } catch (err) {
            results[scopeName].errors.push(`${ann.sourceKey}: ${err.message}`);
            windowFailed = true;
            lastError = `${ann.sourceKey}: ${err.message}`;
          }
        }

        await finishIngestionRun(runId, count, windowFailed ? 'partial: some records failed' : '');
        results[scopeName].total += count;
      } catch (err) {
        await finishIngestionRun(runId, 0, err.message);
        results[scopeName].errors.push(`${win.from}~${win.to}: ${err.message}`);
        windowFailed = true;
        lastError = `${win.from}~${win.to}: ${err.message}`;
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

  return results;
}

module.exports = {
  runFirstSync,
  runIncrementalSync,
  runSync,
  generateMonthWindows,
  standardizeAnnouncement,
  classifyTitle,
  detectUpdate,
  SCOPES,
};
