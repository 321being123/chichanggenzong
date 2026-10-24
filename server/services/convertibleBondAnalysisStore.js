// 数据读写与 Python 提取器
// R-10 拆分自 ./convertibleBondAnalysis.js（2026-10-21）：本文件只放数据读写与 Python 提取器；对外入口仍是 ./convertibleBondAnalysis.js。
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { fetchTencentQuotes, describeTencentCode } = require('./tencentQuote');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveCanonicalCode, ensureInstrumentIdentity } = require('./securityIdentity');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');
const { STOCK_STATUS_FIELDS, addDays, addYears, finite, hasNetAssetFloorClause, instrumentStatus, isoDate, normalizePriceChange, normalizePriceChanges, parseTriggerRatio, parseWindow, revisionDecision } = require('./convertibleBondAnalysisCore.js');

async function sourceIds(client = pool) {
  const { rows } = await client.query(`SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','tencent','cninfo','sse','szse','calculated')`);
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

function announcementSourceId(event, sources, fallback) {
  return (sources && sources[String(event && event.source || '').toLowerCase()]) || fallback;
}

async function ensureInstrument(client, tsCode, name, assetClass, listDate, delistDate, subscriptionDate = null) {
  tsCode = await resolveCanonicalCode(tsCode, assetClass, client);
  if (!tsCode) throw new Error(`证券代码无法解析：${name || ''}`);
  const market = tsCode.endsWith('.SH') ? 'SSE' : tsCode.endsWith('.BJ') ? 'BSE' : 'SZSE';
  const result = await ensureInstrumentIdentity({
    canonicalCode: tsCode, name: name || tsCode, assetClass, market: 'CN', exchangeCode: market,
    currencyCode: 'CNY', listDate: isoDate(listDate), status: assetClass === 'convertible_bond'
      ? (listDate || delistDate || subscriptionDate ? instrumentStatus(delistDate, isoDate(new Date()), listDate, subscriptionDate) : 'announced') : 'listed',
    rawData: { delist_date: isoDate(delistDate), subscription_date: isoDate(subscriptionDate) }, companyName: null,
  }, client.query.bind(client));
  if (isoDate(delistDate)) await client.query('UPDATE core.instruments SET delist_date=COALESCE(delist_date,$2::date) WHERE instrument_id=$1', [result.instrumentId, isoDate(delistDate)]);
  return result.instrumentId;
}

// 一次性把 stock_basic 主档写入统一证券层。行情按交易日全市场落库时，
// 不能只为可转债正股建 instrument，否则 daily/daily_basic 会再次退化为散落旧表。
async function loadTrackedDelistedStocks(listedRows, targetCodes = [], deps = {}) {
  if (!listedRows.length && !targetCodes.length) return [];
  const query = deps.query || pool.query.bind(pool);
  const fetch = deps.fetch || tushareQuery;
  const { rows } = await query(`SELECT i.canonical_code FROM core.instruments i
    WHERE i.asset_class='stock' AND i.status='listed'
      AND NOT (i.canonical_code=ANY($1::text[]))
      AND (cardinality($2::text[])=0 OR i.canonical_code=ANY($2::text[]))
      AND (EXISTS(SELECT 1 FROM stock_watchlist w WHERE w.ts_code=i.canonical_code)
        OR EXISTS(SELECT 1 FROM positions p WHERE p.instrument_id=i.instrument_id))`,
  [listedRows.map(row => row.ts_code), targetCodes]);
  const confirmed = [];
  for (const { canonical_code: code } of rows) {
    const data = await fetch('stock_basic', { ts_code: code, list_status: 'D' }, STOCK_STATUS_FIELDS, { allowEmpty: true });
    const matches = tsRows(data).filter(row => row.ts_code === code && row.list_status === 'D' && isoDate(row.delist_date));
    if (matches.length === 1) confirmed.push(matches[0]);
  }
  return confirmed;
}

async function syncTrackedStockLifecycle(targetCodes) {
  if (!Array.isArray(targetCodes) || !targetCodes.length || targetCodes.some(code => !/^\d{6}\.(SH|SZ|BJ)$/.test(code))) {
    throw new Error('退市核验必须显式指定股票代码');
  }
  const rows = await loadTrackedDelistedStocks([], targetCodes);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureStockUniverse(client, rows);
    const { rows: checked } = await client.query(`SELECT canonical_code,delist_date::text FROM core.instruments
      WHERE canonical_code=ANY($1::text[]) AND asset_class='stock' AND status='delisted' AND delist_date IS NOT NULL`, [targetCodes]);
    await client.query('COMMIT');
    const codes = checked.map(row => row.canonical_code).sort();
    const ok = codes.length === new Set(targetCodes).size;
    return { ok, status: ok ? 'succeeded' : 'partial', mode: 'stock_lifecycle', codes,
      stageComplete: ok, publishDatasetCodes: [], publishDatasets: false,
      remaining: targetCodes.filter(code => !codes.includes(code)), remainingCount: new Set(targetCodes).size - codes.length,
      lifecycleEvidence: checked, ...(ok ? {} : { error: '缺少明确退市状态和实际退市日，保留原主档', errorType: 'data_quality' }) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function ensureStockUniverse(client, stockRows, sourceId = null) {
  const rows = [...new Map((stockRows || [])
    .map(row => [String(row.ts_code || '').trim().toUpperCase(), row])
    .filter(([code]) => /^[0-9]{6}\.(SH|SZ|BJ)$/.test(code))).values()];
  if (!rows.length) return new Map();
  const payload = rows.map(row => ({
    ts_code: String(row.ts_code).trim().toUpperCase(),
    name: String(row.name || row.ts_code || '').trim(),
    list_date: isoDate(row.list_date),
    delist_date: row.list_status === 'D' ? isoDate(row.delist_date) : null,
    status: row.list_status === 'D' && isoDate(row.delist_date) ? 'delisted'
      : String(row.list_status || 'L').trim().toUpperCase() === 'L' ? 'listed' : 'inactive',
    raw_data: row,
  }));
  await client.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,delist_date,status,raw_data)
     SELECT x.ts_code,x.name,'stock','CN',
            CASE WHEN x.ts_code LIKE '%.SH' THEN 'SSE' WHEN x.ts_code LIKE '%.BJ' THEN 'BSE' ELSE 'SZSE' END,
            'CNY',x.list_date,x.delist_date,x.status,x.raw_data
       FROM jsonb_to_recordset($1::jsonb) AS x(ts_code text,name text,list_date date,delist_date date,status text,raw_data jsonb)
     ON CONFLICT(canonical_code) DO UPDATE SET
       name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE core.instruments.name END,
       asset_class='stock',market='CN',exchange_code=EXCLUDED.exchange_code,currency_code='CNY',
       list_date=COALESCE(EXCLUDED.list_date,core.instruments.list_date),status=EXCLUDED.status,
       delist_date=COALESCE(EXCLUDED.delist_date,core.instruments.delist_date),
       raw_data=core.instruments.raw_data || EXCLUDED.raw_data,updated_at=now()`,
    [JSON.stringify(payload)]
  );
  const codes = payload.map(row => row.ts_code);
  const { rows: instruments } = await client.query(
    `SELECT instrument_id,canonical_code FROM core.instruments WHERE canonical_code=ANY($1::text[])`, [codes]
  );
  const instrumentMap = new Map(instruments.map(row => [row.canonical_code, row.instrument_id]));
  // 股票主档必须同时建立公司实体与证券关系，分析/三表查询以 company_id 归属，不能只留下孤立 instrument。
  await client.query(
    `WITH stock_rows AS (
       SELECT DISTINCT ON (NULLIF(x.name,'')) NULLIF(x.name,'') AS legal_name, x.name, x.raw_data
         FROM jsonb_to_recordset($1::jsonb) AS x(ts_code text,name text,list_date date,status text,raw_data jsonb)
        WHERE NULLIF(x.name,'') IS NOT NULL
     )
     INSERT INTO core.companies(legal_name,short_name,country_code,raw_data)
     SELECT legal_name,name,'CN',raw_data FROM stock_rows
     ON CONFLICT(country_code,legal_name) DO UPDATE SET short_name=EXCLUDED.short_name,raw_data=core.companies.raw_data || EXCLUDED.raw_data,updated_at=now()`,
    [JSON.stringify(payload)]
  );
  await client.query(
    `INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
     SELECT c.company_id,i.instrument_id,'issued_by',i.list_date
       FROM core.instruments i JOIN core.companies c ON c.country_code='CN' AND c.legal_name=i.name
      WHERE i.canonical_code=ANY($1::text[])
     ON CONFLICT(company_id,instrument_id,relation_type) DO UPDATE SET valid_from=COALESCE(core.company_instruments.valid_from,EXCLUDED.valid_from)`,
    [codes]
  );
  const { rows: sources } = await client.query(
    `SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','tencent','eastmoney','sina')`
  );
  const sourceMap = Object.fromEntries(sources.map(row => [row.source_code, row.source_id]));
  const identifiers = [];
  for (const row of payload) {
    const instrumentId = instrumentMap.get(row.ts_code);
    if (!instrumentId) continue;
    identifiers.push({ instrument_id: instrumentId, source_id: sourceMap.tushare || sourceId, identifier_type: 'ts_code', identifier_value: row.ts_code, valid_from: row.list_date || '0001-01-01' });
    const quote = describeTencentCode(row.ts_code);
    if (sourceMap.tencent && quote?.symbol) identifiers.push({ instrument_id: instrumentId, source_id: sourceMap.tencent, identifier_type: 'quote_symbol', identifier_value: quote.symbol, valid_from: row.list_date || '0001-01-01' });
    const match = row.ts_code.match(/^(\d{5,6})\.(SH|SZ|BJ)$/);
    if (match && sourceMap.eastmoney) identifiers.push({ instrument_id: instrumentId, source_id: sourceMap.eastmoney, identifier_type: 'f10_code', identifier_value: `${match[2]}${match[1]}`, valid_from: row.list_date || '0001-01-01' });
    if (match && sourceMap.sina) identifiers.push({ instrument_id: instrumentId, source_id: sourceMap.sina, identifier_type: 'symbol', identifier_value: `${match[2].toLowerCase()}${match[1]}`, valid_from: row.list_date || '0001-01-01' });
  }
  if (identifiers.length) {
    await client.query(
      `INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
       SELECT x.instrument_id,x.source_id,x.identifier_type,x.identifier_value,x.valid_from
         FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,source_id smallint,identifier_type text,identifier_value text,valid_from date)
        WHERE x.source_id IS NOT NULL
       ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`,
      [JSON.stringify(identifiers)]
    );
  }
  return instrumentMap;
}

async function saveTerms(client, instrumentId, profile, tushareSource) {
  const entries = [
    ['put', profile.put_clause], ['call', profile.call_clause], ['reset', profile.reset_clause],
    ['maturity_call', profile.maturity_call_price]
  ];
  await client.query("DELETE FROM fundamental.convertible_bond_terms WHERE instrument_id=$1 AND term_type IN ('conversion','reset')", [instrumentId]);
  for (const [type, clause] of entries) {
    if (!clause) continue;
    // 定向发行债券偶尔把“向上修正150%”写入 reset_clause；这不是下修条款。
    if (type === 'reset' && /向上修正/.test(String(clause)) && !/(向下修正|下修)/.test(String(clause))) continue;
    const window = parseWindow(clause, type);
    const ratio = parseTriggerRatio(clause);
    const compact = String(clause).replace(/\s+/g, '');
    const parseStatus = ratio != null && window.observation_days > 0 && window.required_days > 0 && window.required_days <= window.observation_days
      ? 'complete' : 'partial';
    const direction = type === 'reset' ? 'down' : '';
    const comparison = type === 'call' ? 'gte' : type === 'reset' || type === 'put' ? 'lt' : '';
    const netAsset = hasNetAssetFloorClause(compact);
    await client.query(
      `INSERT INTO fundamental.convertible_bond_terms
       (instrument_id,term_type,effective_from,clause_text,trigger_ratio,observation_days,required_days,source_id,source_key,raw_payload,
        revision_direction,comparison_operator,parse_status,parser_version,net_asset_floor_applicable)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
       ON CONFLICT(instrument_id,term_type,effective_from,source_key) DO UPDATE SET clause_text=EXCLUDED.clause_text,
         trigger_ratio=EXCLUDED.trigger_ratio,observation_days=EXCLUDED.observation_days,required_days=EXCLUDED.required_days,
         revision_direction=EXCLUDED.revision_direction,comparison_operator=EXCLUDED.comparison_operator,
         parse_status=EXCLUDED.parse_status,parser_version=EXCLUDED.parser_version,
         net_asset_floor_applicable=EXCLUDED.net_asset_floor_applicable,raw_payload=EXCLUDED.raw_payload`,
      [instrumentId, type, isoDate(profile.value_date) || isoDate(profile.list_date) || '0001-01-01', String(clause), ratio,
        window.observation_days, window.required_days, tushareSource, `cb_basic:${profile.ts_code}:${type}`, JSON.stringify({ clause, parse_status: parseStatus, parser_version: 'terms-v3', compact }),
        direction, comparison, parseStatus, 'terms-v3', netAsset]
    );
  }
}

async function saveProfile(client, profile, sources, subscriptionDate = null) {
  const bondId = await ensureInstrument(client, profile.ts_code, profile.bond_short_name, 'convertible_bond', profile.list_date, profile.delist_date, subscriptionDate);
  const stockId = profile.stk_code ? await ensureInstrument(client, profile.stk_code, profile.stk_short_name, 'stock', null, null) : null;
  await client.query(
    `INSERT INTO fundamental.convertible_bond_profiles
     (instrument_id,stock_instrument_id,bond_full_name,bond_short_name,cb_type,par_value,issue_price,issue_size,remain_size,
      value_date,maturity_date,conv_start_date,conv_end_date,conv_stop_date,first_conv_price,current_conv_price,coupon_rate,
      add_rate,pay_per_year,rate_type,rate_clause,maturity_call_price,guarantor,guarantee_type,issue_rating,newest_rating,
      rating_company,source_id,raw_payload,source_updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,now())
     ON CONFLICT(instrument_id) DO UPDATE SET stock_instrument_id=EXCLUDED.stock_instrument_id,bond_full_name=EXCLUDED.bond_full_name,
      bond_short_name=EXCLUDED.bond_short_name,cb_type=EXCLUDED.cb_type,par_value=EXCLUDED.par_value,issue_price=EXCLUDED.issue_price,
      issue_size=EXCLUDED.issue_size,remain_size=EXCLUDED.remain_size,value_date=EXCLUDED.value_date,maturity_date=EXCLUDED.maturity_date,
      conv_start_date=EXCLUDED.conv_start_date,conv_end_date=EXCLUDED.conv_end_date,conv_stop_date=EXCLUDED.conv_stop_date,
      first_conv_price=EXCLUDED.first_conv_price,current_conv_price=EXCLUDED.current_conv_price,coupon_rate=EXCLUDED.coupon_rate,
      add_rate=EXCLUDED.add_rate,pay_per_year=EXCLUDED.pay_per_year,rate_type=EXCLUDED.rate_type,rate_clause=EXCLUDED.rate_clause,
      maturity_call_price=EXCLUDED.maturity_call_price,guarantor=EXCLUDED.guarantor,guarantee_type=EXCLUDED.guarantee_type,
      issue_rating=EXCLUDED.issue_rating,newest_rating=EXCLUDED.newest_rating,rating_company=EXCLUDED.rating_company,
      raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload || jsonb_build_object(
        'prospectus_source_url',COALESCE(fundamental.convertible_bond_profiles.raw_payload->>'prospectus_source_url',''),
        'prospectus_source_title',COALESCE(fundamental.convertible_bond_profiles.raw_payload->>'prospectus_source_title',''),
        'prospectus_parser_version',COALESCE(fundamental.convertible_bond_profiles.raw_payload->>'prospectus_parser_version','')
      ),source_updated_at=now(),updated_at=now()`,
    [bondId, stockId, profile.bond_full_name || '', profile.bond_short_name || '', profile.cb_type || 'CB', finite(profile.par),
      finite(profile.issue_price), finite(profile.issue_size), finite(profile.remain_size), isoDate(profile.value_date), isoDate(profile.maturity_date),
      isoDate(profile.conv_start_date), isoDate(profile.conv_end_date), isoDate(profile.conv_stop_date), finite(profile.first_conv_price),
      finite(profile.conv_price), finite(profile.coupon_rate), finite(profile.add_rate), finite(profile.pay_per_year), profile.rate_type || '',
      profile.rate_clause || '', profile.maturity_call_price || '', profile.guarantor || '', profile.guarantee_type || '',
      profile.issue_rating || '', profile.newest_rating || '', profile.rating_comp || '', sources.tushare, JSON.stringify(profile)]
  );
  await saveTerms(client, bondId, profile, sources.tushare);
  return { bondId, stockId };
}

function revisionEventDecision(title) {
  const text = String(title || '').replace(/\s+/g, '');
  if (!/(向下修正|下修|低于当期转股价格)/.test(text)) return null;
  if (/不向下修正|不下修|不修正/.test(text)) return null;
  if (/未(?:获|经)?[^。；，,]{0,12}通过|未通过|否决/.test(text)) return 'meeting_rejected';
  if (/终止|取消/.test(text)) return 'terminated';
  // 交易所公告常用“向下修正……暨转股停牌/停复牌”标题，不一定出现“实施/生效”。
  // 这类公告已经给出执行动作，必须优先标记为已实施，避免落到待公告或数学状态。
  if (/实施|生效|结果|暨转股停(?:复)?牌|转股价格(?:已)?由[^，。]{1,30}调整为/.test(text)) return 'implemented';
  if (/股东大会.{0,16}(通过|审议通过)|通过.{0,16}(下修|向下修正)/.test(text)) return 'meeting_approved';
  if (/股东大会.{0,16}(通知|召开|审议)|提交.{0,16}股东大会/.test(text)) return 'meeting_notice';
  if (/提议|拟向下修正|建议/.test(text)) return 'proposal';
  if (/触发|满足|提示性|可能/.test(text)) return 'trigger_notice';
  return null;
}

function announcementSourceKey(event) {
  const source = String(event && event.source || 'official').toLowerCase();
  const number = event && (event.source_number || event.announcement_number || event.announcement_id);
  return `${source}:${String(number || (event && event.url) || `${event && event.event_date || ''}:${event && event.title || ''}`).trim()}`;
}

async function saveRevisionEvents(client, instrumentId, announcements, priceChangeDetails, sourceId, sources = null) {
  const priceMap = new Map((priceChangeDetails || []).map(item => [item.source_url, item]));
  for (const event of announcements || []) {
    const detail = priceMap.get(event.url) || {};
    const eventSourceId = announcementSourceId(event, sources, sourceId);
    const before = finite(detail.price_before), after = finite(detail.price_after), floor = finite(detail.revision_floor_price);
    let eventType = revisionEventDecision(event.title);
    // 公告标题有时只写“向下修正……公告”，但正文解析已经落出转股价变动；
    // 以已落库的官方价格变动事实作为实施证据，补齐事件链。
    if (!eventType && after != null && /(?:向下修正|下修)/.test(String(event.title || '').replace(/\s+/g, ''))
      && !/(?:不向下修正|不下修|预计|提示|提议|议案)/.test(String(event.title || '').replace(/\s+/g, ''))) {
      eventType = 'implemented';
    }
    if (!eventType || !isoDate(event.event_date)) continue;
    const sourceKey = `revision:${announcementSourceKey(event)}`;
    await client.query(
      `INSERT INTO event.convertible_bond_revision_events
       (instrument_id,event_type,announced_at,effective_date,price_before,revision_floor_price,price_after,reached_floor,
        summary,source_id,source_key,source_number,source_url,title,parse_status,parser_version,details,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'revision-v1',$16::jsonb,$17::jsonb)
       ON CONFLICT(source_id,source_key) DO UPDATE SET event_type=EXCLUDED.event_type,
         effective_date=COALESCE(EXCLUDED.effective_date,event.convertible_bond_revision_events.effective_date),
         price_before=COALESCE(EXCLUDED.price_before,event.convertible_bond_revision_events.price_before),
         revision_floor_price=COALESCE(EXCLUDED.revision_floor_price,event.convertible_bond_revision_events.revision_floor_price),
         price_after=COALESCE(EXCLUDED.price_after,event.convertible_bond_revision_events.price_after),
         reached_floor=COALESCE(EXCLUDED.reached_floor,event.convertible_bond_revision_events.reached_floor),
         summary=EXCLUDED.summary,source_number=EXCLUDED.source_number,title=EXCLUDED.title,parse_status=EXCLUDED.parse_status,
         parser_version=EXCLUDED.parser_version,details=EXCLUDED.details,raw_payload=EXCLUDED.raw_payload,updated_at=now()` ,
      [instrumentId, eventType, isoDate(event.event_date), isoDate(detail.change_date), before, floor, after,
        after != null && floor != null ? Math.abs(after - floor) <= 0.005 : null, event.title || '', eventSourceId, sourceKey,
        event.source_number || '', event.url || '', event.title || '', eventType === 'implemented' && after == null ? 'partial' : 'complete',
        JSON.stringify(Object.assign({}, event, { price_change: detail })), JSON.stringify(event)]
    );
  }
}

async function saveDailyBar(client, instrumentId, row, sourceId) {
  if (!row || !row.trade_date || finite(row.close) == null) return;
  await client.query(
    `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
       close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
    [instrumentId, isoDate(row.trade_date), sourceId, finite(row.open), finite(row.high), finite(row.low), finite(row.close), finite(row.vol), finite(row.amount)]
  );
}

async function saveRatingHistory(client, instrumentId, rows, sourceId) {
  for (const row of rows || []) {
    if (!row.rating_date) continue;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_ratings
       (instrument_id,rating_date,announced_at,rating_company,rating_method,rating_type,rating,rating_outlook,source_id,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(instrument_id,rating_date,rating_company) DO UPDATE SET announced_at=EXCLUDED.announced_at,
         rating=EXCLUDED.rating,
         rating_outlook=COALESCE(NULLIF(EXCLUDED.rating_outlook,''),fundamental.convertible_bond_ratings.rating_outlook),
         raw_payload=fundamental.convertible_bond_ratings.raw_payload || EXCLUDED.raw_payload`,
      [instrumentId, isoDate(row.rating_date), isoDate(row.ann_date), row.rating_com_name || '', row.rating_way || '',
        row.rating_type || '', row.rating || '', row.rating_outlook || '', sourceId, JSON.stringify(row)]
    );
  }
}

// 评级历史自动补齐：找出评级表里还没有记录的可转债，逐只从 Tushare cb_rating 拉全量历史写入。
// 每日同步的一环（cb_rating 无法批量拉取，只能逐只传 ts_code）；幂等 upsert，失败只跳过该只不影响主同步。
async function backfillMissingRatings(reason = 'scheduled') {
  const { rows: missing } = await pool.query(`
    SELECT i.instrument_id, i.canonical_code
      FROM core.instruments i
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
      LEFT JOIN (SELECT DISTINCT instrument_id FROM fundamental.convertible_bond_ratings) r
             ON r.instrument_id = i.instrument_id
     WHERE p.cb_type IN ('CB', '')
       AND r.instrument_id IS NULL
     ORDER BY i.canonical_code`);
  if (!missing.length) return { skipped: true, reason: 'no_missing' };
  const sources = await sourceIds();
  const client = await pool.connect();
  let filled = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    for (const bond of missing) {
      try {
        const data = await tushareQuery('cb_rating', { ts_code: bond.canonical_code },
          'ts_code,ann_date,rating_date,rating_com_name,rating_way,rating_type,rating,rating_outlook');
        const rows = tsRows(data);
        if (!rows.length) { failed += 1; continue; }
        await saveRatingHistory(client, bond.instrument_id, rows, sources.tushare);
        filled += 1;
      } catch (error) {
        failed += 1;
        if (reason !== 'scheduled') console.warn(`[ratings] ${bond.canonical_code} 拉取失败: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 150)); // 限流缓冲
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log(`[ratings] 评级补齐完成：新增 ${filled} 只，无数据/失败 ${failed} 只（reason=${reason}）`);
  return { ok: true, filled, failed };
}

async function savePriceChanges(client, instrumentId, rows, sourceId) {
  for (const original of rows || []) {
    const row = normalizePriceChange(original);
    if (!row.change_date) continue;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_price_changes
       (instrument_id,publish_date,change_date,initial_price,price_before,price_after,reason,source_id,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(instrument_id,change_date) DO UPDATE SET publish_date=EXCLUDED.publish_date,price_before=EXCLUDED.price_before,
         price_after=EXCLUDED.price_after,reason=COALESCE(EXCLUDED.reason,fundamental.convertible_bond_price_changes.reason),
         raw_payload=fundamental.convertible_bond_price_changes.raw_payload || EXCLUDED.raw_payload`,
      [instrumentId, isoDate(row.publish_date) || '0001-01-01', isoDate(row.change_date), finite(row.convert_price_initial),
        finite(row.convertprice_bef), finite(row.convertprice_aft), row.reason || null, sourceId, JSON.stringify(row)]
    );
  }
}

async function saveCouponSchedule(client, instrumentId, rows, sourceId) {
  const sorted = (rows || []).slice().sort((a,b) => String(a.rate_start_date).localeCompare(String(b.rate_start_date)));
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    const rate = finite(row.coupon_rate);
    await client.query(
      `INSERT INTO fundamental.convertible_bond_coupon_schedule
       (instrument_id,interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest,source_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(instrument_id,interest_year) DO UPDATE SET coupon_rate=EXCLUDED.coupon_rate,pay_date=EXCLUDED.pay_date,
         pre_tax_interest=EXCLUDED.pre_tax_interest,after_tax_interest=EXCLUDED.after_tax_interest,updated_at=now()`,
      [instrumentId, index + 1, rate, isoDate(row.rate_end_date), rate, rate == null ? null : rate * 0.8, sourceId]
    );
  }
}

async function saveFundHolding(client, instrumentId, rows, sourceId) {
  if (!rows || !rows.length) return;
  const latestDate = rows.map(row => String(row.end_date || '')).sort().reverse()[0];
  const latest = rows.filter(row => String(row.end_date) === latestDate);
  const funds = latest.filter(row => /基金|养老金|年金|社保|资产管理计划|集合资产管理/.test(String(row.holder_name || '')));
  if (!latestDate || !funds.length) return;
  const quantity = funds.reduce((sum,row) => sum + (finite(row.hold_amount) || 0), 0);
  const ratio = funds.reduce((sum,row) => sum + (finite(row.hold_ratio) || 0), 0) / 100;
  await client.query(
    `INSERT INTO fundamental.convertible_bond_fund_holdings
     (instrument_id,report_date,fund_count,holding_quantity,holding_market_value,remain_size_ratio,source_id,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT(instrument_id,report_date) DO UPDATE SET fund_count=EXCLUDED.fund_count,holding_quantity=EXCLUDED.holding_quantity,
       holding_market_value=EXCLUDED.holding_market_value,remain_size_ratio=EXCLUDED.remain_size_ratio,raw_payload=EXCLUDED.raw_payload` ,
    [instrumentId, isoDate(latestDate), funds.length, quantity, quantity * 100, ratio, sourceId, JSON.stringify(funds)]
  );
}

function reportPeriod(title) {
  const match = String(title || '').match(/(20\d{2})\s*年\s*(半年度|年度)报告/);
  if (!match) return null;
  return `${match[1]}-${match[2] === '半年度' ? '06-30' : '12-31'}`;
}

function isFullReport(event) {
  return Boolean(reportPeriod(event.title) && event.url && !/摘要|英文|取消/.test(String(event.title || '')) &&
    /20\d{2}年(?:半年度|年度)报告(?:全文)?(?:[（(](?:修订|更新|更正)(?:版|稿|后)?[）)])?$/.test(String(event.title || '').replace(/\s+/g, '')));
}

function latestFullReport(events) {
  return (events || []).filter(isFullReport)
    .sort((a, b) => reportPeriod(b.title).localeCompare(reportPeriod(a.title)) ||
      String(isoDate(b.event_date || b.announced_at) || '').localeCompare(String(isoDate(a.event_date || a.announced_at) || '')))[0] || null;
}

function pythonCandidates() {
  const root = path.resolve(__dirname, '..', '..');
  const venvs = process.platform === 'win32'
    ? [path.join(root, 'venv', 'Scripts', 'python.exe')]
    : [path.join(root, 'venv', 'bin', 'python'), path.join(root, 'ipo-report', 'venv', 'bin', 'python')];
  return [process.env.IPO_PYTHON_PATH, ...venvs.filter(candidate => fs.existsSync(candidate)),
    process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean);
}

function runHoldingExtractor(executable, url) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondFundHoldings.py');
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, url] : [script, url];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || `基金持仓提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('基金持仓提取结果格式错误')); }
    });
  });
}

async function extractReportFundHolding(events) {
  const report = latestFullReport(events);
  if (!report) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runHoldingExtractor(executable, report.url);
      if (!result || !result.fund_count) return null;
      return Object.assign(result, { report_date: reportPeriod(report.title), report_title: report.title, source_url: report.url });
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[convertible-bond] 最近报告基金持仓提取失败:', lastError.message);
  return null;
}

function runPriceHistoryExtractor(executable, url, initialPrice, bondName) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondPriceHistory.py');
  const scriptArgs = [script, url];
  if (finite(initialPrice) != null) scriptArgs.push('--initial-price', String(finite(initialPrice)));
  if (bondName) scriptArgs.push('--bond-name', String(bondName));
  const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', ...scriptArgs] : scriptArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || `定期报告转股价历史提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('定期报告转股价历史格式错误')); }
    });
  });
}

async function extractReportPriceHistory(events, initialPrice, bondName, cachedReportUrl, cachedParserVersion) {
  const report = latestFullReport(events);
  if (!report || (report.url === cachedReportUrl && cachedParserVersion === '9')) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runPriceHistoryExtractor(executable, report.url, initialPrice, bondName);
      if (!result || (!(result.price_changes || []).length && !result.rating_outlook)) return null;
      return Object.assign(result, { report_title: report.title });
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[convertible-bond] 定期报告转股价历史提取失败:', lastError.message);
  return null;
}

function runRatingExtractor(executable, event) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondRating.py');
  const scriptArgs = [script, event.url, '--announcement-date', isoDate(event.event_date)];
  const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', ...scriptArgs] : scriptArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || `评级报告提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('评级报告提取结果格式错误')); }
    });
  });
}

async function extractRatingOutlooks(events, cachedUrls) {
  const reports = (events || []).filter(event => /评级报告|评级调整/.test(String(event.title || '')) && event.url && !cachedUrls.has(event.url));
  const results = [];
  for (const event of reports) {
    for (const executable of pythonCandidates()) {
      try {
        const result = await runRatingExtractor(executable, event);
        if (result && result.rating_outlook) results.push(result);
        break;
      } catch (_) { /* 尝试下一个本机 Python */ }
    }
  }
  return results;
}

async function saveRatingOutlooks(client, instrumentId, rows) {
  for (const row of rows || []) {
    await client.query(
      `UPDATE fundamental.convertible_bond_ratings SET rating_outlook=$3,
         raw_payload=raw_payload || jsonb_build_object('outlook_source_url',$4::text)
       WHERE instrument_id=$1 AND rating_date=(
         SELECT rating_date FROM fundamental.convertible_bond_ratings
          WHERE instrument_id=$1 AND ABS(rating_date-$2::date)<=15
            AND ($5::text IS NULL OR rating=$5 OR COALESCE(rating,'')='')
          ORDER BY ABS(rating_date-$2::date) LIMIT 1)`,
      [instrumentId, isoDate(row.rating_date), row.rating_outlook, row.source_url, row.rating || null]
    );
  }
  await client.query(
    `WITH matches AS (
       SELECT target.ctid AS row_id,
         source.rating_date AS source_date,source.rating_outlook,source.raw_payload
       FROM fundamental.convertible_bond_ratings target
       CROSS JOIN LATERAL (
         SELECT candidate.rating_date,candidate.rating_outlook,candidate.raw_payload
           FROM fundamental.convertible_bond_ratings candidate
          WHERE candidate.instrument_id=target.instrument_id AND candidate.rating=target.rating
            AND COALESCE(candidate.rating_outlook,'')<>''
          ORDER BY ABS(candidate.rating_date-target.rating_date) LIMIT 1
       ) source
       WHERE target.instrument_id=$1 AND COALESCE(target.rating_outlook,'')=''
     )
     UPDATE fundamental.convertible_bond_ratings target SET
       rating_outlook=matches.rating_outlook,
       raw_payload=target.raw_payload || jsonb_build_object(
         'outlook_source_url',matches.raw_payload->>'outlook_source_url',
         'outlook_inferred_from_date',matches.source_date::text)
     FROM matches WHERE target.ctid=matches.row_id`,
    [instrumentId]
  );
}

async function saveReportFundHolding(client, instrumentId, holding, sourceId) {
  if (!holding || !holding.report_date || holding.fund_count == null) return;
  await client.query(
    `INSERT INTO fundamental.convertible_bond_fund_holdings
     (instrument_id,report_date,fund_count,holding_quantity,holding_market_value,remain_size_ratio,source_id,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT(instrument_id,report_date) DO UPDATE SET fund_count=EXCLUDED.fund_count,holding_quantity=EXCLUDED.holding_quantity,
       holding_market_value=EXCLUDED.holding_market_value,remain_size_ratio=EXCLUDED.remain_size_ratio,source_id=EXCLUDED.source_id,
       raw_payload=EXCLUDED.raw_payload`,
    [instrumentId, holding.report_date, holding.fund_count, holding.holding_quantity, holding.holding_market_value,
      holding.remain_size_ratio, sourceId, JSON.stringify(holding)]
  );
}

function latestProspectus(events, { allowGeneric = false, preferUrl = null } = {}) {
  const correctionRank = event => (/更正版|修订版|更新版|更正后/.test(String(event.title || '')) ? 0 : 1);
  const candidates = (events || [])
    .filter(event => (/(?:可转换公司债(?:券)?|可转债).{0,20}募集说明书/.test(String(event.title || ''))
      || allowGeneric && /募集说明书/.test(String(event.title || '')) && !/发行.*股票|公司债券(?!.*可转换)/.test(event.title)) && event.url
      && !/摘要|申报稿|上会稿|反馈|补充法律意见|更正公告|提示(?:性)?公告/.test(event.title));
  // 同一发行常有旧版/更正版同名文件：已核验文件优先保留，未绑定时按 日期新→更正版→网址 确定性择优，禁止随机换绑。
  const preferred = preferUrl ? candidates.find(event => event.url === preferUrl) : null;
  return preferred || candidates.sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))
    || correctionRank(a) - correctionRank(b) || String(a.url).localeCompare(String(b.url)))[0] || null;
}

function runProspectusExtractor(executable, url) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondProspectus.py');
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, url] : [script, url];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || `募集说明书提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('募集说明书提取结果格式错误')); }
    });
  });
}

async function extractProspectusDetails(events) {
  const prospectus = latestProspectus(events);
  if (!prospectus) return null;
  let lastError;
  for (const executable of pythonCandidates()) {
    try {
      const result = await runProspectusExtractor(executable, prospectus.url);
      return Object.assign(result || {}, { source_url: prospectus.url, source_title: prospectus.title });
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[convertible-bond] 募集说明书提取失败:', lastError.message);
  return null;
}

function runNoRevisionExtractor(executable, events) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondNoRevision.py');
  return new Promise((resolve, reject) => {
    const urls = events.map(event => event.url);
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, ...urls] : [script, ...urls];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || `不下修公告提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('不下修公告提取结果格式错误')); }
    });
  });
}

async function extractNoRevisionPeriods(events, cachedRows, { allowFailed = false } = {}) {
  // 保留正文解析确认过锁定期的实施公告；旧版本只按标题筛“不向下修正”，
  // 会漏掉“已下修但公告正文规定一段时间内不得再次下修”的公告。
  const cached = new Map((cachedRows || [])
    .filter(row => /(?:不向下修正|不下修|不修正)/.test(String(row.summary || ''))
      || row.lock_declared === true || row.no_revision_evidence === true)
    .map(row => [isoDate(row.announced_at), row]));
  // 不下修决定或锁定期有时写在“转股价格调整/实施”公告正文中，不能只凭标题筛选。
  const candidates = (events || []).filter(event => {
    const decision = revisionDecision(event.title);
    const cache = cached.get(isoDate(event.event_date)) || {};
    const cacheComplete = cache.parser_version === '7'
      && (cache.no_revision_evidence === true || cache.lock_declared === true)
      && cache.symbolic_lock !== null;
    const forcedCachedReparse = Boolean(event.raw && event.raw.cached_reparse);
    return ['no_revision', 'revised', 'adjusted'].includes(decision) && event.url
      && (forcedCachedReparse || !cacheComplete || (allowFailed && cache.reparse_status === 'failed'))
      && (allowFailed || cache.reparse_status !== 'failed');
  }).slice(0, 10);
  const markFailure = (event, reason) => {
    const key = isoDate(event && event.event_date);
    const row = cached.get(key) || (cachedRows || []).find(item => isoDate(item.announced_at) === key);
    if (row) {
      row.reparse_status = 'failed';
      row.reparse_reason = reason;
      cached.set(key, row);
    }
  };
  if (candidates.length) {
    let extracted = null;
    let lastError = null;
    for (const executable of pythonCandidates()) {
      try { extracted = await runNoRevisionExtractor(executable, candidates); break; } catch (error) { lastError = error; }
    }
    if (!extracted) {
      // 单只债券的 PDF 解析失败不能阻断全市场公告回填；保留该券已有缓存，下一次重叠窗口再补偿。
      console.warn('[bond-revision] 不下修期限解析失败，保留缓存并继续处理其他债券:', lastError && lastError.message);
      candidates.forEach(event => markFailure(event, 'parser_execution_failed'));
      return [...cached.values()].sort((a,b) => String(b.announced_at).localeCompare(String(a.announced_at)));
    }
    const parsedUrls = new Set();
    for (const item of extracted || []) {
      const event = candidates.find(candidate => candidate.url === item.source_url);
      const announcedAt = isoDate(event && event.event_date);
      if (event) parsedUrls.add(event.url);
      const nextEligible = isoDate(item.next_eligible_date);
      const explicitTitle = /(?:不向下修正|不下修|不修正)/.test(String(event && event.title || ''));
      const lockEvidence = explicitTitle || item.no_revision_evidence === true || item.lock_declared === true;
      // 普通实施公告没有锁定期是正常结果，不应被记录成解析失败；只有正文明确了
      // 不下修或锁定期，才作为 no_revision 事实返回并写入历史表。
      if (!lockEvidence) {
        if (event && event.raw && event.raw.cached_reparse) markFailure(event, 'no_revision_evidence_not_found');
        continue;
      }
      // 明确“不下修”但公告未承诺锁定期限时，仍是有效事实；这类记录不应
      // 阻断数学计数，只需保持 lock_declared=false、next_eligible_date=null。
      if ((nextEligible && announcedAt && nextEligible < announcedAt)) {
        console.warn(`[bond-revision] 不下修期限解析不完整，跳过该条并保留缓存：${event ? event.title : item.source_url}`);
        markFailure(event, 'parser_output_incomplete');
        continue;
      }
      if (event) cached.set(isoDate(event.event_date), Object.assign(item, { announced_at: isoDate(event.event_date) }));
    }
    candidates.filter(event => event.raw && event.raw.cached_reparse && !parsedUrls.has(event.url))
      .forEach(event => markFailure(event, 'no_revision_evidence_not_found'));
  }
  return [...cached.values()].sort((a,b) => String(b.announced_at).localeCompare(String(a.announced_at)));
}

function runPriceChangeExtractor(executable, events) {
  const script = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondPriceChange.py');
  return new Promise((resolve, reject) => {
    const urls = events.map(event => event.url);
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', script, ...urls] : [script, ...urls];
    const child = spawn(executable, args, { cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      mergeExternalCallStatsFromStderr(error);
      if (code !== 0) return reject(new Error(error || `转股价格公告提取失败（${code}）`));
      try { resolve(JSON.parse(output)); } catch (_) { reject(new Error('转股价格公告提取结果格式错误')); }
    });
  });
}

async function extractPriceChangeDetails(events, cachedRows) {
  const cachedUrls = new Set((cachedRows || []).filter(row => finite(row.price_after) != null && row.source_url && row.parser_version === '3').map(row => row.source_url));
  const candidates = (events || []).filter(event => ['revised','adjusted'].includes(revisionDecision(event.title)) &&
    event.url && !cachedUrls.has(event.url)).slice(0, 10);
  if (!candidates.length) return [];
  for (const executable of pythonCandidates()) {
    try {
      const extracted = await runPriceChangeExtractor(executable, candidates);
      return (extracted || []).map(item => Object.assign(item, { event: candidates.find(candidate => candidate.url === item.source_url) }));
    } catch (_) { /* try next interpreter */ }
  }
  return [];
}

async function saveProspectusDetails(client, instrumentId, profile, details, sourceId) {
  if (!details) return;
  if (details.fundraising_purpose) {
    await client.query(
      `UPDATE fundamental.convertible_bond_profiles SET fundraising_purpose=$2,
       raw_payload=raw_payload || jsonb_build_object('prospectus_source_url',$3::text,'prospectus_source_title',$4::text,'prospectus_parser_version','4'),updated_at=now()
       WHERE instrument_id=$1`,
      [instrumentId, details.fundraising_purpose, details.source_url || '', details.source_title || '']
    );
  }
  for (const row of details.coupon_rates || []) {
    const interestYear = Number(row.interest_year), rate = finite(row.coupon_rate);
    if (!interestYear || rate == null) continue;
    const valueDate = isoDate(profile.value_date);
    const payDate = valueDate ? addYears(new Date(`${valueDate}T00:00:00+08:00`), interestYear) : null;
    const payDateText = payDate ? isoDate(payDate) : null;
    await client.query(
      `INSERT INTO fundamental.convertible_bond_coupon_schedule
       (instrument_id,interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest,source_id)
       VALUES($1,$2,$3::numeric,$4,$3::numeric,$5,$6)
       ON CONFLICT(instrument_id,interest_year) DO UPDATE SET coupon_rate=EXCLUDED.coupon_rate,pay_date=EXCLUDED.pay_date,
         pre_tax_interest=EXCLUDED.pre_tax_interest,after_tax_interest=EXCLUDED.after_tax_interest,source_id=EXCLUDED.source_id,updated_at=now()`,
      [instrumentId, interestYear, rate, payDateText, rate * 0.8, sourceId]
    );
  }
}

async function loadSafety(code) {
  const { rows } = await pool.query('SELECT data,source_updated_at FROM bond_safety_snapshots ORDER BY id DESC LIMIT 1');
  const snapshot = rows[0];
  if (!snapshot || !Array.isArray(snapshot.data)) return null;
  // 快照里 bond_code 可能带后缀（113049.SH）也可能不带（113049），传入的 code 也两种都有
  const codeStr = String(code || '');
  const codeBare = codeStr.split('.')[0];
  const candidates = codeStr === codeBare ? [codeStr] : [codeStr, codeBare];
  const item = snapshot.data.find(row => {
    const rowCode = String(row.bond_code || '');
    const rowBare = rowCode.split('.')[0];
    return candidates.includes(rowCode) || candidates.includes(rowBare);
  });
  return item ? Object.assign({ source_updated_at: snapshot.source_updated_at }, item) : null;
}

async function loadExtraData(instrumentId, targetDate = isoDate(new Date())) {
  const [ratings, history, coupons, holdings,standardChanges] = await Promise.all([
    pool.query(`SELECT rating_date::text,announced_at::text,rating_company,rating,rating_outlook,
      (NULLIF(raw_payload->>'outlook_source_url','') IS NULL AND NULLIF(raw_payload->>'outlook_inferred_from_date','') IS NOT NULL) AS outlook_estimated
      FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 AND rating_date<=$2::date ORDER BY rating_date DESC`, [instrumentId,targetDate]),
    pool.query("SELECT * FROM analytics.convertible_bond_announcement_history WHERE instrument_id=$1 AND announced_at<=$2::date AND fact_type IN ('price_change','no_revision') ORDER BY effective_date DESC NULLS LAST,announced_at DESC", [instrumentId,targetDate]),
    pool.query('SELECT interest_year,coupon_rate,pay_date::text,pre_tax_interest,after_tax_interest FROM fundamental.convertible_bond_coupon_schedule WHERE instrument_id=$1 ORDER BY interest_year', [instrumentId]),
    pool.query(`SELECT report_date::text,fund_count,holding_quantity,holding_market_value,remain_size_ratio
      FROM fundamental.convertible_bond_fund_holdings WHERE instrument_id=$1 AND report_date<=$2::date
      AND report_date>=(SELECT value_date FROM fundamental.convertible_bond_profiles WHERE instrument_id=$1)
      ORDER BY report_date DESC LIMIT 1`, [instrumentId,targetDate]),
    pool.query(`SELECT publish_date,change_date,price_before,price_after,reason,raw_payload->>'source_url' AS source_url
      FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1 AND change_date<=$2::date AND publish_date<=$2::date
      ORDER BY change_date DESC`,[instrumentId,targetDate]),
  ]);
  const changes = history.rows.filter(row => row.fact_type === 'price_change').map(row => ({
    publish_date: row.announced_at, change_date: row.effective_date, price_before: row.price_before,
    price_after: row.price_after, reason: row.summary, source_url: row.source_url,
    revision_floor_price: row.raw_payload && row.raw_payload.revision_floor_price,
  }));
  const noRevision = history.rows.filter(row => row.fact_type === 'no_revision').map(row => ({
    announced_at: isoDate(row.announced_at), valid_until: isoDate(row.valid_until), next_eligible_date: isoDate(row.next_eligible_date),
    summary: row.summary, source_url: row.source_url,
  }));
  return { ratings: ratings.rows, price_changes: normalizePriceChanges([...standardChanges.rows,...changes]), no_revision_history: noRevision, coupons: coupons.rows, fund_holding: holdings.rows[0] || null };
}

async function latestFinancial(stockTsCode) {
  const { rows } = await pool.query('SELECT data FROM bond_safety_financial_cache WHERE ts_code=$1', [stockTsCode]);
  return rows[0] && rows[0].data || {};
}

async function loadProspectusCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT p.fundraising_purpose,p.raw_payload->>'prospectus_source_url' AS source_url,
       p.raw_payload->>'prospectus_source_title' AS source_title,
       p.raw_payload->>'prospectus_parser_version' AS parser_version,
       p.raw_payload->>'price_history_report_url' AS price_history_report_url,
       p.raw_payload->>'price_history_parser_version' AS price_history_parser_version,
       (SELECT COUNT(*)::int FROM fundamental.convertible_bond_coupon_schedule c WHERE c.instrument_id=p.instrument_id) AS coupon_count
     FROM fundamental.convertible_bond_profiles p JOIN core.instruments i ON i.instrument_id=p.instrument_id
     WHERE i.canonical_code=$1`, [tsCode]
  );
  return rows[0] || { fundraising_purpose: '', coupon_count: 0 };
}

async function loadNoRevisionCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT h.announced_at,h.valid_until,h.next_eligible_date,h.summary,h.source_url,h.parser_version,
            COALESCE((h.raw_payload->>'lock_declared')::boolean,false) AS lock_declared,
            COALESCE((h.raw_payload->>'no_revision_evidence')::boolean,false) AS no_revision_evidence,
            COALESCE(h.raw_payload->'reparse'->>'status','') AS reparse_status,
            CASE WHEN h.raw_payload ? 'symbolic_lock' THEN (h.raw_payload->>'symbolic_lock')::boolean END AS symbolic_lock,
            h.raw_payload->>'symbolic_reference_type' AS symbolic_reference_type,
            h.raw_payload->>'symbolic_report_period' AS symbolic_report_period,
            h.raw_payload->>'symbolic_check_from' AS symbolic_check_from,
            h.raw_payload->>'symbolic_resolution_status' AS symbolic_resolution_status
       FROM analytics.convertible_bond_announcement_history h JOIN core.instruments i ON i.instrument_id=h.instrument_id
      WHERE i.canonical_code=$1 AND h.fact_type='no_revision' ORDER BY h.announced_at DESC`, [tsCode]
  );
  return rows;
}

async function loadPriceChangeCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT h.effective_date AS change_date,h.price_before,h.price_after,h.source_url,h.parser_version
       FROM analytics.convertible_bond_announcement_history h JOIN core.instruments i ON i.instrument_id=h.instrument_id
      WHERE i.canonical_code=$1 AND h.fact_type='price_change' ORDER BY h.effective_date DESC`, [tsCode]
  );
  return rows;
}

// 定点补回历史实施公告正文中的锁定期：只在明确传入债券代码的 cachedOnly
// 重解析中读取事件事实，避免启动补漏把全市场所有实施公告重复下载。
async function loadRevisionEventCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT e.announced_at,e.source_url,e.source_number,e.title
       FROM event.convertible_bond_revision_events e
       JOIN core.instruments i ON i.instrument_id=e.instrument_id
      WHERE i.canonical_code=$1 AND e.event_type='implemented' AND NULLIF(e.source_url,'') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM analytics.convertible_bond_announcement_history h
           WHERE h.instrument_id=e.instrument_id AND h.fact_type='no_revision' AND h.source_url=e.source_url
        )
       ORDER BY e.announced_at DESC,e.event_id DESC`, [tsCode]
  );
  return rows;
}

async function loadRatingSourceCache(tsCode) {
  const { rows } = await pool.query(
    `SELECT r.raw_payload->>'outlook_source_url' AS source_url,r.rating_outlook
       FROM fundamental.convertible_bond_ratings r JOIN core.instruments i ON i.instrument_id=r.instrument_id
      WHERE i.canonical_code=$1`, [tsCode]
  );
  return { urls: new Set(rows.map(row => row.source_url).filter(Boolean)), missing: !rows.length || rows.some(row => !String(row.rating_outlook || '').trim()) };
}

async function saveStockValuation(client, stockId, row, sourceId) {
  if (!row || !row.trade_date) return;
  if ([row.pe, row.pe_ttm, row.pb, row.dv_ttm, row.total_mv, row.circ_mv].every(value => finite(value) == null)) return;
  await client.query(
    `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,
       pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,total_market_cap=EXCLUDED.total_market_cap,
       circulating_market_cap=EXCLUDED.circulating_market_cap,ingested_at=now()`,
    [stockId, isoDate(row.trade_date), sourceId, finite(row.pe), finite(row.pe_ttm), finite(row.pb), finite(row.dv_ttm) == null ? null : finite(row.dv_ttm) / 100,
      finite(row.total_mv) == null ? null : finite(row.total_mv) * 10000,
      finite(row.circ_mv) == null ? null : finite(row.circ_mv) * 10000]
  );
}

async function saveFullStockMarketPartition(client, instrumentMap, dailyRows, valuationRows, sourceId, adjustmentRows = []) {
  const bars = (dailyRows || []).map(row => {
    const instrumentId = instrumentMap.get(row.ts_code);
    return instrumentId ? {
      instrument_id: instrumentId, trade_date: isoDate(row.trade_date),
      open: finite(row.open), high: finite(row.high), low: finite(row.low), close: finite(row.close),
      volume: finite(row.vol), amount: finite(row.amount),
    } : null;
  }).filter(row => row && row.trade_date);
  if (bars.length) {
    await client.query(
      `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
       SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
       FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
         close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
      [JSON.stringify(bars), sourceId]
    );
  }
  const valuations = (valuationRows || []).map(row => {
    const instrumentId = instrumentMap.get(row.ts_code);
    return instrumentId ? {
      instrument_id: instrumentId, trade_date: isoDate(row.trade_date),
      pe_static: finite(row.pe), pe_ttm: finite(row.pe_ttm), pb: finite(row.pb),
      // Tushare daily_basic.dv_ttm 是百分数点（5 表示 5%），标准层统一存小数（0.05）。
      dividend_yield_ttm: finite(row.dv_ttm) == null ? null : finite(row.dv_ttm) / 100,
      total_market_cap: finite(row.total_mv) == null ? null : finite(row.total_mv) * 10000,
      circulating_market_cap: finite(row.circ_mv) == null ? null : finite(row.circ_mv) * 10000,
    } : null;
  }).filter(row => row && row.trade_date && [
    row.pe_static, row.pe_ttm, row.pb, row.dividend_yield_ttm, row.total_market_cap, row.circulating_market_cap,
  ].some(value => value != null));
  if (valuations.length) {
    await client.query(
      `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap)
       SELECT x.instrument_id,x.trade_date,$2,x.pe_static,x.pe_ttm,x.pb,x.dividend_yield_ttm,x.total_market_cap,x.circulating_market_cap
       FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,pe_static numeric,pe_ttm numeric,pb numeric,dividend_yield_ttm numeric,total_market_cap numeric,circulating_market_cap numeric)
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,
         pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,total_market_cap=EXCLUDED.total_market_cap,
         circulating_market_cap=EXCLUDED.circulating_market_cap,ingested_at=now()`,
      [JSON.stringify(valuations), sourceId]
    );
  }
  const factors = (adjustmentRows || []).map(row => {
    const instrumentId = instrumentMap.get(row.ts_code);
    const factor = finite(row.adj_factor);
    return instrumentId && factor != null && isoDate(row.trade_date)
      ? { instrument_id: instrumentId, trade_date: isoDate(row.trade_date), adj_factor: factor }
      : null;
  }).filter(Boolean);
  if (factors.length) {
    await client.query(
      `INSERT INTO market.adjustment_factors(instrument_id,trade_date,source_id,adj_factor)
       SELECT x.instrument_id,x.trade_date,$2,x.adj_factor
         FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,adj_factor numeric)
       ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET adj_factor=EXCLUDED.adj_factor,ingested_at=now()`,
      [JSON.stringify(factors), sourceId]
    );
  }
  return { bars: bars.length, valuations: valuations.length, factors: factors.length };
}

function mergeDailyRows(cachedRows, freshRows) {
  const merged = new Map();
  for (const row of cachedRows || []) {
    const date = isoDate(row.trade_date);
    if (date) merged.set(date, Object.assign({}, row, { trade_date: date }));
  }
  for (const row of freshRows || []) {
    const date = isoDate(row.trade_date);
    if (date) merged.set(date, Object.assign({}, row, { trade_date: date }));
  }
  return [...merged.values()].sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)));
}

function incrementalStart(rows, fallback) {
  const latest = rows && rows[0] && isoDate(rows[0].trade_date);
  if (!latest) return fallback;
  return tsDateStr(addDays(new Date(`${latest}T00:00:00+08:00`), -7));
}

async function loadCachedStockBars(stockCode, startDate) {
  if (!stockCode) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (b.trade_date) b.trade_date,b.open,b.high,b.low,b.close,b.volume AS vol,b.amount
       FROM market.daily_bars b
       JOIN core.instruments i ON i.instrument_id=b.instrument_id
       JOIN ops.data_sources ds ON ds.source_id=b.source_id
      WHERE i.canonical_code=$1 AND b.trade_date >= $2::date AND ds.source_code='tushare'
      ORDER BY b.trade_date DESC,b.ingested_at DESC`,
    [stockCode, startDate]
  );
  return rows;
}

async function loadCachedStockValuations(stockCode, startDate) {
  if (!stockCode) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (v.trade_date) v.trade_date,v.pe_static AS pe,v.pe_ttm,v.pb,
            v.dividend_yield_ttm * 100 AS dv_ttm,v.total_market_cap / 10000 AS total_mv,
            v.circulating_market_cap / 10000 AS circ_mv
       FROM market.daily_valuations v
       JOIN core.instruments i ON i.instrument_id=v.instrument_id
       JOIN ops.data_sources ds ON ds.source_id=v.source_id
      WHERE i.canonical_code=$1 AND v.trade_date >= $2::date AND ds.source_code='tushare'
      ORDER BY v.trade_date DESC,v.ingested_at DESC`,
    [stockCode, startDate]
  );
  return rows;
}

async function loadCachedAnalysisHistory(tsCode, startDate) {
  const { rows: profileRows } = await pool.query(
    `SELECT p.raw_payload,s.canonical_code AS stock_code
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i ON i.instrument_id=p.instrument_id
       LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.canonical_code=$1`,
    [tsCode]
  );
  const stockCode = profileRows[0] && profileRows[0].stock_code;
  const [{ rows: metricRows }, stockDaily] = await Promise.all([
    pool.query(
      `SELECT m.trade_date,m.close,m.conversion_value,m.conversion_premium_pct,m.bond_value,
              m.bond_premium_pct,m.raw_payload
         FROM market.convertible_bond_daily_metrics m
         JOIN core.instruments i ON i.instrument_id=m.instrument_id
        WHERE i.canonical_code=$1 AND m.trade_date >= $2::date
        ORDER BY m.trade_date DESC`,
      [tsCode, startDate]
    ),
    loadCachedStockBars(stockCode, startDate),
  ]);
  const bondDaily = metricRows.map(row => Object.assign({}, row.raw_payload || {}, {
    trade_date: isoDate(row.trade_date),
    close: finite(row.close),
    cb_value: finite(row.conversion_value),
    cb_over_rate: finite(row.conversion_premium_pct),
    bond_value: finite(row.bond_value),
    bond_over_rate: finite(row.bond_premium_pct),
  }));
  return {
    profile: profileRows[0] && profileRows[0].raw_payload,
    stockCode,
    bondDaily,
    stockDaily,
  };
}

// P1 整改：本地水位查询，刷新时不再从上市日起重复拉取全部历史
// 财务报表最新报告期（fundamental.financial_reports），无则返回 null（首次全量回退上市日）
async function latestStockFinancialEnd(stockTsCode) {
  if (!stockTsCode) return null;
  const { rows } = await pool.query(
    `SELECT max(fr.period_end) AS report_end_date
       FROM fundamental.financial_reports fr
       JOIN core.company_instruments ci ON ci.company_id = fr.company_id
       JOIN core.instruments i ON i.instrument_id = ci.instrument_id
      WHERE i.canonical_code = $1`, [stockTsCode]
  );
  return rows[0] && rows[0].report_end_date || null;
}

// 公告相关已持久化资料的最新日期（下修提示/转股价变动/评级），作为公告搜索水位
async function latestAnnouncementBaseline(tsCode) {
  if (!tsCode) return null;
  const { rows } = await pool.query(
    `SELECT max(d) AS event_date FROM (
       SELECT max(h.announced_at) AS d FROM analytics.convertible_bond_announcement_history h
         JOIN core.instruments i ON i.instrument_id = h.instrument_id
        WHERE i.canonical_code = $1 AND h.fact_type IN ('no_revision','price_change')
       UNION ALL
       SELECT max(rating_date) FROM fundamental.convertible_bond_ratings r
         JOIN core.instruments i ON i.instrument_id = r.instrument_id WHERE i.canonical_code = $1
     ) t`, [tsCode]
  );
  return rows[0] && rows[0].event_date || null;
}

async function latestRatingDate(tsCode) {
  const { rows } = await pool.query(
    `SELECT max(rating_date) AS rating_date FROM fundamental.convertible_bond_ratings r
       JOIN core.instruments i ON i.instrument_id = r.instrument_id WHERE i.canonical_code = $1`, [tsCode]
  );
  return rows[0] && rows[0].rating_date || null;
}

module.exports = {
  sourceIds,
  announcementSourceId,
  ensureInstrument,
  loadTrackedDelistedStocks,
  syncTrackedStockLifecycle,
  ensureStockUniverse,
  saveTerms,
  saveProfile,
  revisionEventDecision,
  announcementSourceKey,
  saveRevisionEvents,
  saveDailyBar,
  saveRatingHistory,
  backfillMissingRatings,
  savePriceChanges,
  saveCouponSchedule,
  saveFundHolding,
  reportPeriod,
  isFullReport,
  latestFullReport,
  pythonCandidates,
  runHoldingExtractor,
  extractReportFundHolding,
  runPriceHistoryExtractor,
  extractReportPriceHistory,
  runRatingExtractor,
  extractRatingOutlooks,
  saveRatingOutlooks,
  saveReportFundHolding,
  latestProspectus,
  runProspectusExtractor,
  extractProspectusDetails,
  runNoRevisionExtractor,
  extractNoRevisionPeriods,
  runPriceChangeExtractor,
  extractPriceChangeDetails,
  saveProspectusDetails,
  loadSafety,
  loadExtraData,
  latestFinancial,
  loadProspectusCache,
  loadNoRevisionCache,
  loadPriceChangeCache,
  loadRevisionEventCache,
  loadRatingSourceCache,
  saveStockValuation,
  saveFullStockMarketPartition,
  mergeDailyRows,
  incrementalStart,
  loadCachedStockBars,
  loadCachedStockValuations,
  loadCachedAnalysisHistory,
  latestStockFinancialEnd,
  latestAnnouncementBaseline,
  latestRatingDate,
};
