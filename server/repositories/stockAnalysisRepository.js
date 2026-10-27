// 股票分析数据仓储（批次2，从 stockAnalysis 与 routes/stockAnalysis 迁入的 SQL）。
// 合同：方法签名 method(params, tx)；tx 缺省使用连接池（单语句或只读批量）。
// 只做 SQL 读写：不判断新鲜度、不选外部来源、不做金融计算。
const { pool } = require('../db');

const REPORT_TABLES = {
  income: 'stock_income_statements',
  balancesheet: 'stock_balance_sheets',
  cashflow: 'stock_cashflow_statements',
};

function versionKey(row) {
  return [row.end_date || '', row.report_type || '', row.f_ann_date || row.ann_date || '', row.update_flag || '', row.div_proc || '', row.ex_date || row.pay_date || ''].join('|');
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---- 写入：采集落库 ----

async function saveMetadata(params, tx) {
  const runner = tx || pool;
  const row = params.row || {};
  await runner.query(
    `INSERT INTO stock_analysis_stocks (ts_code,symbol,name,industry,market,list_date,data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (ts_code) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,
       industry=EXCLUDED.industry,market=EXCLUDED.market,list_date=EXCLUDED.list_date,
       data=EXCLUDED.data,fetched_at=now()`,
    [row.ts_code, row.symbol || String(row.ts_code || '').slice(0, 6), row.name || '', row.industry || '', row.market || '', row.list_date || null, JSON.stringify(row)],
  );
}

async function saveReports(params, tx) {
  const runner = tx || pool;
  const table = REPORT_TABLES[params.kind];
  if (!table) throw new Error('未知财报类型');
  for (const row of params.rows || []) {
    if (!row.end_date) continue;
    await runner.query(
      `INSERT INTO ${table}
       (ts_code,version_key,end_date,ann_date,f_ann_date,report_type,comp_type,update_flag,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
      [params.tsCode, versionKey(row), row.end_date, row.ann_date || null, row.f_ann_date || null,
        row.report_type || null, row.comp_type || null, row.update_flag || null, JSON.stringify(row)],
    );
  }
}

async function saveAux(params, tx) {
  const runner = tx || pool;
  const table = params.table;
  const allowed = new Set(['stock_financial_indicators', 'stock_dividends', 'stock_forecasts']);
  if (!allowed.has(table)) throw new Error('未知辅助数据表');
  for (const row of params.rows || []) {
    if (table === 'stock_financial_indicators' && !row.end_date) continue;
    const common = [params.tsCode, versionKey(row), row.end_date || null, row.ann_date || null];
    if (table === 'stock_dividends') {
      await runner.query(
        `INSERT INTO stock_dividends (ts_code,version_key,end_date,ann_date,ex_date,pay_date,div_proc,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
        [...common, row.ex_date || null, row.pay_date || null, row.div_proc || null, JSON.stringify(row)],
      );
    } else {
      await runner.query(
        `INSERT INTO ${table} (ts_code,version_key,end_date,ann_date,data)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
        [...common, JSON.stringify(row)],
      );
    }
  }
}

async function saveValuations(params, tx) {
  const runner = tx || pool;
  const daily = new Map((params.dailyRows || []).map(r => [r.trade_date, r]));
  const basic = new Map((params.basicRows || []).map(r => [r.trade_date, r]));
  const factors = new Map((params.factorRows || []).map(r => [r.trade_date, r]));
  const dates = new Set([...daily.keys(), ...basic.keys(), ...factors.keys()]);
  for (const tradeDate of dates) {
    const d = daily.get(tradeDate) || {}, b = basic.get(tradeDate) || {}, a = factors.get(tradeDate) || {};
    await runner.query(
      `INSERT INTO stock_daily_valuations
       (ts_code,trade_date,close,adj_factor,pe,pe_ttm,pb,dv_ttm,total_share,total_mv,float_share,free_share,circ_mv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ts_code,trade_date) DO UPDATE SET
       close=COALESCE(EXCLUDED.close,stock_daily_valuations.close),
       adj_factor=COALESCE(EXCLUDED.adj_factor,stock_daily_valuations.adj_factor),
       pe=EXCLUDED.pe,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dv_ttm=EXCLUDED.dv_ttm,
       total_share=COALESCE(EXCLUDED.total_share,stock_daily_valuations.total_share),
       total_mv=COALESCE(EXCLUDED.total_mv,stock_daily_valuations.total_mv),
       float_share=COALESCE(EXCLUDED.float_share,stock_daily_valuations.float_share),
       free_share=COALESCE(EXCLUDED.free_share,stock_daily_valuations.free_share),
       circ_mv=COALESCE(EXCLUDED.circ_mv,stock_daily_valuations.circ_mv),fetched_at=now()`,
      [params.tsCode, tradeDate, finite(d.close), finite(a.adj_factor), finite(b.pe), finite(b.pe_ttm), finite(b.pb),
        finite(b.dv_ttm), finite(b.total_share), finite(b.total_mv), finite(b.float_share), finite(b.free_share), finite(b.circ_mv)],
    );
  }
}

async function setSyncState(params, tx) {
  const runner = tx || pool;
  await runner.query(
    `INSERT INTO stock_data_sync_state (ts_code,dataset,last_success_date,last_attempt_at,last_error)
     VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (ts_code,dataset) DO UPDATE SET
       last_success_date=COALESCE(EXCLUDED.last_success_date,stock_data_sync_state.last_success_date),
       last_attempt_at=now(),last_error=EXCLUDED.last_error,updated_at=now()`,
    [params.tsCode, params.dataset, params.successDate || null, params.error || ''],
  );
}

// ---- 读取：分析输入、增量水位 ----

async function readInstrumentMeta(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT canonical_code ts_code,name,market,to_char(list_date,'YYYYMMDD') list_date,raw_data
       FROM core.instruments WHERE canonical_code=$1`,
    [params.tsCode],
  );
  return rows[0] || null;
}

async function readEventCursor(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT to_char(c.last_success_date,'YYYYMMDD') last_success_date,c.last_error FROM ops.sync_cursors c
       JOIN core.instruments i ON i.instrument_id=c.instrument_id
      WHERE i.canonical_code=$1 AND c.dataset_code='events'
      ORDER BY c.last_success_date DESC NULLS LAST LIMIT 1`,
    [params.tsCode],
  );
  return rows[0] || null;
}

async function upsertEventCursor(params, tx) {
  const runner = tx || pool;
  await runner.query(
    `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
     SELECT i.instrument_id,ci.company_id,i.instrument_id||':'||ci.company_id,'events',$2,now(),''
       FROM core.instruments i JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id WHERE i.canonical_code=$1
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_attempt_at=now(),last_error='',updated_at=now()`,
    [params.tsCode, params.isoToday],
  );
}

// 分析输入：元数据、四类报表、分红、预告、估值序列、官方事件。
async function loadAnalysisInputs(params, tx) {
  const runner = tx || pool;
  const tsCode = params.tsCode;
  const [meta, income, balance, cashflow, indicators, dividends, forecasts, valuations, events] = await Promise.all([
    runner.query(`SELECT i.canonical_code ts_code,i.name,i.market,to_char(i.list_date,'YYYYMMDD') list_date,
      COALESCE(n.industry_name,'') industry,i.raw_data data FROM core.instruments i
      JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id
      LEFT JOIN core.company_industry_memberships m ON m.company_id=ci.company_id AND m.is_current
      LEFT JOIN core.industry_nodes n ON n.industry_node_id=m.industry_node_id WHERE i.canonical_code=$1 LIMIT 1`, [tsCode]),
    runner.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='income'`, [tsCode]),
    runner.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='balance'`, [tsCode]),
    runner.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='cashflow'`, [tsCode]),
    runner.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='indicator'`, [tsCode]),
    runner.query(`SELECT a.raw_payload data FROM fundamental.corporate_actions a JOIN core.instruments i ON i.instrument_id=a.instrument_id WHERE i.canonical_code=$1 AND a.action_type='dividend'`, [tsCode]),
    runner.query(`SELECT g.raw_payload data FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1`, [tsCode]),
    runner.query(`SELECT to_char(v.trade_date,'YYYYMMDD') trade_date,b.close,a.adj_factor,v.pe_static pe,v.pe_ttm,v.pb,v.dividend_yield_ttm*100 dv_ttm,
      s.total_shares/10000 total_share,v.total_market_cap/10000 total_mv,s.circulating_shares/10000 float_share,s.free_float_shares/10000 free_share,v.circulating_market_cap/10000 circ_mv
      FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id
      LEFT JOIN market.daily_bars b ON b.instrument_id=v.instrument_id AND b.trade_date=v.trade_date AND b.source_id=v.source_id
      LEFT JOIN market.adjustment_factors a ON a.instrument_id=v.instrument_id AND a.trade_date=v.trade_date AND a.source_id=v.source_id
      LEFT JOIN LATERAL (SELECT * FROM market.share_capital_history s WHERE s.instrument_id=v.instrument_id AND s.effective_date<=v.trade_date ORDER BY s.effective_date DESC LIMIT 1) s ON true
      WHERE i.canonical_code=$1 ORDER BY v.trade_date`, [tsCode]),
    runner.query(`SELECT ds.source_code source,to_char(e.event_date,'YYYYMMDD') event_date,e.title,d.url,e.event_type category,e.is_official
      FROM event.company_events e JOIN ops.data_sources ds ON ds.source_id=e.source_id LEFT JOIN event.documents d ON d.document_id=e.document_id
      JOIN core.company_instruments ci ON ci.company_id=e.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id
      WHERE i.canonical_code=$1 AND e.is_official=true AND e.event_date>=CURRENT_DATE-interval '1 year' ORDER BY e.event_date DESC LIMIT 200`, [tsCode]),
  ]);
  return {
    meta: meta.rows[0], income: income.rows.map(r => r.data), balance: balance.rows.map(r => r.data),
    cashflow: cashflow.rows.map(r => r.data), indicators: indicators.rows.map(r => r.data),
    dividends: dividends.rows.map(r => r.data), forecasts: forecasts.rows.map(r => r.data), valuations: valuations.rows, events: events.rows,
  };
}

async function latestDividendEndDate(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT MAX(end_date) AS d FROM stock_dividends WHERE ts_code=$1', [params.tsCode]);
  return rows[0] && rows[0].d ? String(rows[0].d).replace(/-/g, '') : '';
}

async function latestForecastAnnDate(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT MAX(ann_date) AS d FROM stock_forecasts WHERE ts_code=$1', [params.tsCode]);
  return rows[0] && rows[0].d ? String(rows[0].d).replace(/-/g, '') : '';
}

// ---- 自选股（routes/stockAnalysis 原 SQL） ----

async function listWatchlist(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT ts_code,name,created_at FROM stock_watchlist WHERE username=$1 ORDER BY created_at',
    [params.username],
  );
  return rows;
}

async function insertWatchlist(params, tx) {
  const runner = tx || pool;
  return runner.query(
    `INSERT INTO stock_watchlist (username,ts_code,name) VALUES ($1,$2,'')
     ON CONFLICT (username,ts_code) DO NOTHING`,
    [params.username, params.tsCode],
  );
}

async function updateWatchlistName(params, tx) {
  const runner = tx || pool;
  await runner.query('UPDATE stock_watchlist SET name=$3 WHERE username=$1 AND ts_code=$2', [params.username, params.tsCode, params.name || '']);
}

async function deleteWatchlist(params, tx) {
  const runner = tx || pool;
  await runner.query('DELETE FROM stock_watchlist WHERE username=$1 AND ts_code=$2', [params.username, params.tsCode]);
}

// ---- 读取：主档缓存、兼容视图、覆盖度标记 ----

async function readUnifiedSummary(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT stock_name AS name, industry FROM public.stock_unified WHERE stock_code=$1', [params.tsCode]);
  return rows[0] || null;
}

async function readInstrumentRawData(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT raw_data FROM core.instruments WHERE canonical_code=$1', [params.tsCode]);
  return rows[0] ? rows[0].raw_data : null;
}

// 覆盖度标记：是否已有行情/指标/三表，以及最早行情日期。
async function readCoverageFlags(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(`SELECT
    EXISTS(SELECT 1 FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id WHERE i.canonical_code=$1) has_daily,
    (SELECT min(to_char(v.trade_date,'YYYYMMDD')) FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id WHERE i.canonical_code=$1) first_daily,
    EXISTS(SELECT 1 FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='indicator') has_indicator,
    EXISTS(SELECT 1 FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='income') has_reports`, [params.tsCode]);
  return rows[0] || {};
}

// 最新股票分析快照（含 instrument_id，供后续水位查询使用）。
async function readLatestSnapshot(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(`SELECT s.payload,s.created_at,s.formula_bundle_version,s.source_watermark,i.instrument_id FROM core.instruments i
    JOIN analytics.analysis_snapshots s ON s.instrument_id=i.instrument_id
    WHERE i.canonical_code=$1 AND s.snapshot_type='stock_analysis'
    ORDER BY s.as_of_date DESC,s.created_at DESC LIMIT 1`, [params.tsCode]);
  return rows[0] || null;
}

async function readSnapshotFreshnessInputs(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT
        (SELECT max(trade_date) FROM market.daily_valuations WHERE instrument_id=$1) AS trade_date,
        (SELECT max(period_end) FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id WHERE ci.instrument_id=$1) AS financial_end,
        (SELECT max(announced_at) FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id WHERE ci.instrument_id=$1) AS financial_ann,
        (SELECT max(announced_at) FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend') AS dividend_ann,
        (SELECT max(ex_date) FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend') AS dividend_ex,
        (SELECT max(announced_at) FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id WHERE ci.instrument_id=$1) AS guidance_ann,
        (SELECT max(period_end) FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id WHERE ci.instrument_id=$1) AS guidance_end,
        (SELECT n.industry_name FROM core.industry_nodes n JOIN core.company_industry_memberships m ON m.industry_node_id=n.industry_node_id JOIN core.company_instruments ci ON ci.company_id=m.company_id WHERE ci.instrument_id=$1 AND m.is_current LIMIT 1) AS industry_name,
        (SELECT c.controller_name FROM core.company_controllers c WHERE c.company_id=(SELECT ci.company_id FROM core.company_instruments ci WHERE ci.instrument_id=$1 LIMIT 1) AND c.is_current=true ORDER BY c.announced_at DESC LIMIT 1) AS controller_name,
        (SELECT max(event_date) FROM event.company_events e JOIN core.company_instruments ci ON ci.company_id=e.company_id WHERE ci.instrument_id=$1 AND e.is_official=true) AS event_date`,
    [params.instrumentId],
  );
  return rows[0] || {};
}

async function listUserStockRows(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT ts_code,MAX(name) AS name,BOOL_OR(source='watchlist') AS watchlisted,BOOL_OR(source='position') AS held FROM (
       SELECT w.ts_code,w.name,'watchlist'::text AS source FROM stock_watchlist w WHERE w.username=$1
       UNION ALL
       SELECT CASE WHEN p.code ~ '^6' THEN p.code||'.SH' WHEN p.code ~ '^(4|8|92)' THEN p.code||'.BJ' ELSE p.code||'.SZ' END,
              MAX(p.name),'position'::text FROM positions p
        WHERE p.username=$1 AND p.code ~ '^[0-9]{6}$' AND p.code !~ '^(110|111|113|118|123|127|128)'
        GROUP BY p.code
     ) u GROUP BY ts_code ORDER BY held DESC,name,ts_code`,
    [params.username],
  );
  return rows;
}

module.exports = {
  deleteWatchlist,
  insertWatchlist,
  latestDividendEndDate,
  latestForecastAnnDate,
  listUserStockRows,
  listWatchlist,
  loadAnalysisInputs,
  readCoverageFlags,
  readEventCursor,
  readInstrumentMeta,
  readInstrumentRawData,
  readLatestSnapshot,
  readSnapshotFreshnessInputs,
  readUnifiedSummary,
  saveAux,
  saveMetadata,
  saveReports,
  saveValuations,
  setSyncState,
  updateWatchlistName,
  upsertEventCursor,
};
