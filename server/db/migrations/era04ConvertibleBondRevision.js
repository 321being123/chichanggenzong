// 可转债下修与动因（090-115、132-133，含下修最新状态视图重建函数）
// R-6 拆分自 ../migrations.js（2026-10-21）：本文件只放迁移函数体；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('../connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('../util');
const { seedBrokers } = require('../brokers');
const { migrateAccountsTable } = require('../accounts');
const { toNumber, normalizeMigrationDate, normalizeMigrationTimestamp, normalizeMigrationStockCode, scale100m } = require('./helpers');

// ========== 090：可转债下修监控基础数据与统一视图 =============
// 下修监控只面向交易所公开上市转债；定向/私募记录保留在标准主档中，
// 由下游公开上市转债范围统一排除，避免破坏历史追溯。
async function migration090ConvertibleBondRevisionMonitor() {
  await pool.query(`
    BEGIN;
    SELECT pg_advisory_xact_lock(904091);
    ALTER TABLE fundamental.convertible_bond_terms
      ADD COLUMN IF NOT EXISTS revision_direction TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS comparison_operator TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'partial',
      ADD COLUMN IF NOT EXISTS parser_version TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS net_asset_floor_applicable BOOLEAN NOT NULL DEFAULT false;

    CREATE INDEX IF NOT EXISTS idx_cb_terms_reset_valid
      ON fundamental.convertible_bond_terms(instrument_id,effective_from DESC)
      WHERE term_type='reset' AND parse_status='complete';

    CREATE TABLE IF NOT EXISTS event.convertible_bond_revision_events (
      event_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'trigger_notice','proposal','meeting_notice','meeting_approved','meeting_rejected','terminated','implemented'
      )),
      announced_at DATE NOT NULL,
      meeting_date DATE,
      record_date DATE,
      effective_date DATE,
      price_before NUMERIC(24,8),
      proposed_price NUMERIC(24,8),
      revision_floor_price NUMERIC(24,8),
      price_after NUMERIC(24,8),
      reached_floor BOOLEAN,
      summary TEXT NOT NULL DEFAULT '',
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      document_id BIGINT REFERENCES event.documents(document_id) ON DELETE SET NULL,
      source_key TEXT NOT NULL,
      source_number TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      parse_status TEXT NOT NULL DEFAULT 'partial' CHECK (parse_status IN ('complete','partial','failed')),
      parser_version TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,source_key)
    );
    ALTER TABLE event.convertible_bond_revision_events
      ADD COLUMN IF NOT EXISTS source_number TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_cb_revision_events_instrument_date
      ON event.convertible_bond_revision_events(instrument_id,announced_at DESC,event_id DESC);
    CREATE INDEX IF NOT EXISTS idx_cb_revision_events_type_date
      ON event.convertible_bond_revision_events(event_type,announced_at DESC);
    COMMIT;
  `);

  const { parseWindow, parseTriggerRatio, hasNetAssetFloorClause } = require('../../services/convertibleBondAnalysis');
  const { rows: terms } = await pool.query(
    `SELECT term_id,term_type,clause_text FROM fundamental.convertible_bond_terms`
  );
  for (const term of terms) {
    const clause = String(term.clause_text || '');
    const compact = clause.replace(/\s+/g, '');
    const direction = term.term_type === 'reset'
      ? (/(向上修正|上修)/.test(compact) && !/(向下修正|下修)/.test(compact) ? 'up' : 'down') : '';
    const window = parseWindow(clause, term.term_type);
    const ratio = parseTriggerRatio(clause);
    const parseStatus = term.term_type === 'reset' && direction === 'up'
      ? 'failed' : (ratio != null && window.observation_days > 0 && window.required_days > 0 && window.required_days <= window.observation_days ? 'complete' : 'partial');
    const comparison = term.term_type === 'call' ? 'gte' : term.term_type === 'reset' || term.term_type === 'put' ? 'lt' : '';
    const netAsset = hasNetAssetFloorClause(compact);
    await pool.query(
      `UPDATE fundamental.convertible_bond_terms
          SET revision_direction=$2,comparison_operator=$3,parse_status=$4,parser_version='terms-v2',
              net_asset_floor_applicable=$5,observation_days=$6,required_days=$7
        WHERE term_id=$1`,
      [term.term_id, direction, comparison, parseStatus, netAsset, window.observation_days, window.required_days]
    );
  }

  await rebuildConvertibleBondRevisionLatestView();
}

async function rebuildConvertibleBondRevisionLatestView() {
  await pool.query(`
    BEGIN;
    SELECT pg_advisory_xact_lock(904091);
    DROP VIEW IF EXISTS analytics.convertible_bond_revision_latest;
    CREATE VIEW analytics.convertible_bond_revision_latest AS
    WITH market_date AS (
      SELECT MAX(trade_date)::date AS trade_date FROM market.convertible_bond_daily_metrics
    ), latest_market AS MATERIALIZED (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,trade_date,close,conversion_value,conversion_premium_pct
        FROM market.convertible_bond_daily_metrics
       WHERE trade_date=(SELECT trade_date FROM market_date)
       ORDER BY instrument_id,source_id DESC
    )
    SELECT i.instrument_id,i.canonical_code AS ts_code,split_part(i.canonical_code,'.',1) AS security_code,
           i.name AS bond_name,p.stock_instrument_id,s.canonical_code AS stock_code,s.name AS stock_name,
           p.current_conv_price,p.remain_size,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date,
           iss.issue_type,md.trade_date,md.close AS bond_close,md.conversion_value,md.conversion_premium_pct,
           sb.trade_date AS stock_trade_date,sb.close AS stock_close,sv.pb AS stock_pb,
           CASE WHEN t.net_asset_floor_applicable AND sb.trade_date = sv.trade_date
                      AND sb.close > 0 AND sv.pb > 0
                THEN sb.close / sv.pb END AS net_asset_floor_value,
           CASE WHEN tr.calculated_status='floor_blocked' THEN true
                WHEN t.net_asset_floor_applicable AND p.current_conv_price > 0
                      AND sb.trade_date = sv.trade_date
                      AND sb.close > 0 AND sv.pb > 0
                THEN p.current_conv_price <= sb.close / sv.pb END AS net_asset_floor_blocked,
           t.term_id,t.trigger_ratio,t.observation_days,t.required_days,t.clause_text AS reset_clause,
           t.revision_direction,t.comparison_operator,t.parse_status AS term_parse_status,t.parser_version AS term_parser_version,
           t.net_asset_floor_applicable,t.effective_from AS term_effective_from,
           tr.trigger_price,tr.close_price,tr.matched_days,tr.required_days AS trigger_required_days,
           tr.observation_days AS trigger_observation_days,tr.minimum_future_days,tr.calculated_status,tr.formula_version,tr.diagnostics,
           tr.data_status,tr.calculated_at,nr.announced_at AS no_revision_announced_at,
           nr.valid_until AS no_revision_valid_until,nr.next_eligible_date,nr.summary AS no_revision_summary,
           ev.event_id,ev.event_type AS official_event_type,ev.announced_at AS official_announced_at,
           ev.meeting_date,ev.record_date,ev.effective_date,ev.price_before,ev.proposed_price,
           ev.revision_floor_price,ev.price_after,ev.reached_floor,ev.summary AS official_summary,
           ev.source_url AS official_source_url,ev.source_number AS official_source_number,ev.title AS official_title,ev.parse_status AS official_parse_status,
           ev.parser_version AS official_parser_version,ev.document_id AS official_document_id,
           CASE WHEN tr.close_price IS NOT NULL AND tr.trigger_price > 0
                THEN tr.close_price / tr.trigger_price - 1 END AS distance_to_trigger_pct,
           CASE
             -- 集思录只把最近 3 个交易日的已实施/未通过事件置顶；历史事件保留详情，但恢复数学计数。
             WHEN ev.event_type='implemented'
              AND (nr.announced_at IS NULL OR ev.announced_at >= nr.announced_at)
              AND (SELECT COUNT(*) FROM market.trade_calendar tc_event
                     WHERE tc_event.exchange='SSE' AND tc_event.is_open
                       AND tc_event.trade_date > ev.announced_at
                       AND tc_event.trade_date <= md.trade_date) < 3 THEN 'implemented'
             WHEN ev.event_type='meeting_approved'
              AND (nr.announced_at IS NULL OR ev.announced_at > nr.announced_at) THEN 'approved'
             WHEN ev.event_type='meeting_notice'
              AND (nr.announced_at IS NULL OR ev.announced_at > nr.announced_at) THEN 'meeting_pending'
             -- 董事会提议通常应在一个月内进入股东会流程；超过 30 个自然日仍无后续公告，
             -- 不再作为“当前待处理”展示，避免把历史提议累计到今天。
             WHEN ev.event_type='proposal'
              AND (nr.announced_at IS NULL OR ev.announced_at > nr.announced_at)
              AND ev.announced_at >= (md.trade_date - INTERVAL '30 days') THEN 'proposed'
             WHEN ev.event_type IN ('meeting_rejected','terminated')
              AND (nr.announced_at IS NULL OR ev.announced_at > nr.announced_at)
              AND (SELECT COUNT(*) FROM market.trade_calendar tc_event
                     WHERE tc_event.exchange='SSE' AND tc_event.is_open
                       AND tc_event.trade_date > ev.announced_at
                       AND tc_event.trade_date <= md.trade_date) < 3 THEN 'terminated'
             -- 新的不下修事实优先于旧的提议/表决事件；旧解析器带出的未来日期
             -- 在 v7 重解析完成前只能标记不完整，不能继续伪装成锁定期。
             WHEN nr.announced_at IS NOT NULL
              AND nr.announced_at >= COALESCE(ev.announced_at, DATE '0001-01-01')
              AND nr.parser_version IS DISTINCT FROM '7'
              AND NOT nr.lock_declared
              AND nr.next_eligible_date IS NOT NULL THEN 'incomplete'
             WHEN nr.announced_at IS NOT NULL
              AND nr.announced_at >= COALESCE(ev.announced_at, DATE '0001-01-01')
              AND ((nr.next_eligible_date IS NOT NULL
                    AND nr.next_eligible_date > COALESCE(tr.trade_date,(SELECT trade_date FROM market_date),CURRENT_DATE))
                   OR (nr.next_eligible_date IS NULL AND nr.lock_declared)) THEN 'locked'
             -- 明确不下修但新版解析尚未完成时，禁止继续沿用旧窗口计数。
             WHEN nr.announced_at IS NOT NULL
              AND nr.next_eligible_date IS NULL
              AND (nr.parser_version IS DISTINCT FROM '7'
                   OR NOT (COALESCE(nr.no_revision_evidence,false) OR COALESCE(nr.lock_declared,false))) THEN 'incomplete'
             WHEN (nr.next_eligible_date IS NOT NULL AND nr.next_eligible_date > COALESCE(tr.trade_date,(SELECT trade_date FROM market_date),CURRENT_DATE))
               OR (nr.next_eligible_date IS NULL AND nr.lock_declared) THEN 'locked'
             WHEN t.parse_status <> 'complete' OR tr.data_status <> 'complete' OR tr.trade_date IS NULL THEN 'incomplete'
             -- 当前转股价已不高于募集说明书约定的每股净资产，继续累计数学触发日
             -- 没有可执行意义；保留进度明细，但从“已满足待公告/接近触发”中排除。
             WHEN tr.calculated_status='floor_blocked' THEN 'floor_blocked'
             WHEN tr.calculated_status IN ('met','tracking')
              AND t.net_asset_floor_applicable
              AND p.current_conv_price > 0 AND sb.trade_date = sv.trade_date
              AND sb.close > 0 AND sv.pb > 0
              AND p.current_conv_price <= sb.close / sv.pb THEN 'floor_blocked'
             WHEN tr.calculated_status='met' THEN 'met_pending'
             WHEN tr.calculated_status='tracking' AND GREATEST(tr.required_days-tr.matched_days,0) BETWEEN 1 AND 5 THEN 'near'
             WHEN tr.calculated_status='tracking' THEN 'tracking'
             ELSE 'incomplete'
           END AS business_status,
           CASE WHEN tr.required_days IS NOT NULL AND tr.matched_days IS NOT NULL
               THEN GREATEST(tr.required_days-tr.matched_days,0) END AS remaining_days,
           CASE WHEN tr.required_days IS NOT NULL AND tr.matched_days IS NOT NULL
               THEN COALESCE(tr.minimum_future_days,GREATEST(tr.required_days-tr.matched_days,0)) END AS rolling_remaining_days
      FROM latest_market md
      JOIN core.instruments i ON i.instrument_id=md.instrument_id
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      LEFT JOIN LATERAL (
        SELECT max(last_trade_date) AS last_trade_date,
               max(COALESCE(last_conversion_date,last_trade_date)) AS last_conversion_date
          FROM event.convertible_bond_call_events ce
         WHERE ce.instrument_id=i.instrument_id
           AND ce.event_type IN ('exercise','implementation','completion')
      ) call_stop ON true
      LEFT JOIN LATERAL (
        SELECT term_id,trigger_ratio,observation_days,required_days,clause_text,
               revision_direction,comparison_operator,parse_status,parser_version,
               net_asset_floor_applicable,effective_from
          FROM fundamental.convertible_bond_terms
         WHERE instrument_id=i.instrument_id AND term_type='reset'
         ORDER BY effective_from DESC,term_id DESC LIMIT 1
      ) t ON true
      LEFT JOIN LATERAL (
        SELECT trade_date,trigger_price,close_price,matched_days,required_days,
               observation_days,minimum_future_days,status AS calculated_status,formula_version,diagnostics,data_status,calculated_at
          FROM analytics.convertible_bond_trigger_daily
         WHERE instrument_id=i.instrument_id AND trigger_type='reset' AND formula_version='reset-v2'
         ORDER BY trade_date DESC,calculated_at DESC LIMIT 1
      ) tr ON true
      LEFT JOIN LATERAL (
        SELECT announced_at,valid_until,
               COALESCE((SELECT MIN(tc.trade_date)
                           FROM market.trade_calendar tc
                          WHERE tc.exchange='SSE' AND tc.is_open
                            AND nr0.next_eligible_date >= (SELECT MIN(tc0.trade_date)
                                                            FROM market.trade_calendar tc0
                                                           WHERE tc0.exchange='SSE' AND tc0.is_open)
                            AND tc.trade_date >= nr0.next_eligible_date), nr0.next_eligible_date) AS next_eligible_date,
               summary,COALESCE((raw_payload->>'parser_version'),'') AS parser_version,
               COALESCE((raw_payload->>'lock_declared')::boolean,false) AS lock_declared,
               COALESCE((raw_payload->>'no_revision_evidence')::boolean,false) AS no_revision_evidence
          FROM fundamental.convertible_bond_no_revision_history nr0
         WHERE nr0.instrument_id=i.instrument_id
         ORDER BY nr0.announced_at DESC,nr0.history_id DESC LIMIT 1
      ) nr ON true
      LEFT JOIN LATERAL (
        SELECT event_id,event_type,announced_at,meeting_date,record_date,effective_date,
               price_before,proposed_price,revision_floor_price,price_after,reached_floor,summary,
               source_url,source_number,title,parse_status,parser_version,document_id
         FROM event.convertible_bond_revision_events
         WHERE instrument_id=i.instrument_id
           AND announced_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
         ORDER BY announced_at DESC,event_id DESC LIMIT 1
      ) ev ON true
      LEFT JOIN LATERAL (
        SELECT trade_date,close
          FROM market.daily_bars
         WHERE instrument_id=p.stock_instrument_id AND trade_date <= md.trade_date AND close > 0
         ORDER BY trade_date DESC,source_id DESC LIMIT 1
      ) sb ON true
      LEFT JOIN LATERAL (
        SELECT trade_date,pb
          FROM market.daily_valuations
         WHERE instrument_id=p.stock_instrument_id AND trade_date <= md.trade_date
         ORDER BY trade_date DESC,source_id DESC LIMIT 1
      ) sv ON true
     WHERE i.asset_class='convertible_bond'
       AND i.status='listed'
       AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
       AND (i.list_date IS NULL OR i.list_date <= md.trade_date)
       AND (i.delist_date IS NULL OR i.delist_date > md.trade_date)
       AND (COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) IS NULL
            OR COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) > CURRENT_DATE)
       AND (p.maturity_date IS NULL OR p.maturity_date >= md.trade_date)
       AND (p.conv_end_date IS NULL OR p.conv_end_date >= md.trade_date)
       AND (p.conv_stop_date IS NULL OR p.conv_stop_date > md.trade_date);
    COMMIT;
  `);
}

// ========== 091：下修监控仅保留当前交易日在市转债 =============
async function migration091ConvertibleBondRevisionListedOnly() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 092：下修监控视图轻量化 =============
// 以最新交易日行情为驱动，按单券索引读取条款、进度和公告，避免展开无关的强赎/上市表现全量视图。
async function migration092ConvertibleBondRevisionViewLean() {
  // 092 在 100 之前执行；旧生产库尚未有该列，先补齐再重建视图。
  await pool.query(`
    ALTER TABLE analytics.convertible_bond_trigger_daily
      ADD COLUMN IF NOT EXISTS minimum_future_days INTEGER;
  `);
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 093：下修条款窗口解析补齐 =============
// 旧解析器只识别“至少有十五个交易日”，漏掉了同义的“有十五个交易日”写法。
// 直接重解析已落库条款，不重新请求外部公告或主档数据。
async function migration093ConvertibleBondRevisionTermParser() {
  const { parseWindow, parseTriggerRatio } = require('../../services/convertibleBondAnalysis');
  const { rows } = await pool.query(
    `SELECT term_id,clause_text,trigger_ratio,revision_direction
       FROM fundamental.convertible_bond_terms
      WHERE term_type='reset'`
  );
  for (const term of rows) {
    const clause = String(term.clause_text || '');
    const window = parseWindow(clause, 'reset');
    const ratio = parseTriggerRatio(clause) ?? term.trigger_ratio;
    const compact = clause.replace(/\s+/g, '');
    const upwardOnly = /向上修正/.test(compact) && !/(向下修正|下修)/.test(compact);
    const parseStatus = upwardOnly ? 'failed'
      : (ratio != null && window.observation_days > 0 && window.required_days > 0
        && window.required_days <= window.observation_days ? 'complete' : 'partial');
    await pool.query(
      `UPDATE fundamental.convertible_bond_terms
          SET trigger_ratio=$2,observation_days=$3,required_days=$4,parse_status=$5,parser_version='terms-v3'
        WHERE term_id=$1`,
      [term.term_id, ratio, window.observation_days, window.required_days, parseStatus]
    );
  }
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 094：下修提议有效期 =============
// 只把最近 30 个自然日内且尚无后续事件的董事会提议标为“待处理”，
// 历史提议回落到实时触发计算，避免与集思录等外部看板重复累计。
async function migration094ConvertibleBondRevisionProposalExpiry() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 095：无固定日期的不下修锁定 =============
// “锁定至某次董事会召开日”没有可直接落库的 next_eligible_date，视图仍须展示为锁定。
async function migration095ConvertibleBondRevisionSymbolicLock() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 096：下修实施事件按官方价格变动事实回填 =============
// 历史公告标题未包含“实施/生效”时，旧分类器会把已经落库的官方转股价变动
// 留成提议或完全没有事件，导致页面继续显示“待公告”。价格变动事实已经过
// 官方公告解析，作为幂等回填依据；已有同日事件先升级为 implemented，缺失的再补建。
async function migration096ConvertibleBondRevisionImplementedBackfill() {
  await pool.query(`
    BEGIN;
    SELECT pg_advisory_xact_lock(904096);
    UPDATE event.convertible_bond_revision_events e
       SET event_type='implemented',
           effective_date=COALESCE(pc.change_date,e.effective_date),
           price_before=COALESCE(pc.price_before,e.price_before),
           price_after=COALESCE(pc.price_after,e.price_after),
           summary=COALESCE(NULLIF(pc.reason,''),e.summary),
           updated_at=now()
      FROM fundamental.convertible_bond_price_changes pc
     WHERE pc.instrument_id=e.instrument_id
       AND pc.publish_date=e.announced_at
       AND e.event_type IN ('proposal','trigger_notice','meeting_notice')
       AND pc.price_after IS NOT NULL
       AND pc.reason ~ '(向下修正|下修)'
       AND pc.reason !~ '(不向下修正|不下修|预计|提示|提议|议案)';

    INSERT INTO event.convertible_bond_revision_events
      (instrument_id,event_type,announced_at,effective_date,price_before,price_after,
       summary,source_id,source_key,source_number,source_url,title,parse_status,
       parser_version,details,raw_payload)
    SELECT pc.instrument_id,'implemented',pc.publish_date,pc.change_date,
           pc.price_before,pc.price_after,COALESCE(NULLIF(pc.reason,''),'官方转股价下修'),
           pc.source_id,
           'revision:backfill-price-change:'||pc.instrument_id||':'||pc.publish_date||':'||pc.change_date,
           COALESCE(pc.raw_payload->>'source_number',''),
           COALESCE(pc.raw_payload->>'url',''),
           COALESCE(pc.raw_payload->>'title',pc.reason,'官方转股价下修'),
           'complete','revision-v2',
           jsonb_build_object('backfilled_from','fundamental.convertible_bond_price_changes'),
           pc.raw_payload
      FROM fundamental.convertible_bond_price_changes pc
     WHERE pc.publish_date IS NOT NULL
       AND pc.price_after IS NOT NULL
       AND pc.reason ~ '(向下修正|下修)'
       AND pc.reason !~ '(不向下修正|不下修|预计|提示|提议|议案)'
       AND NOT EXISTS (
         SELECT 1 FROM event.convertible_bond_revision_events e
          WHERE e.instrument_id=pc.instrument_id
            AND e.announced_at=pc.publish_date
            AND e.event_type='implemented'
       )
    ON CONFLICT(source_id,source_key) DO UPDATE SET
      event_type=EXCLUDED.event_type,
      effective_date=COALESCE(EXCLUDED.effective_date,event.convertible_bond_revision_events.effective_date),
      price_before=COALESCE(EXCLUDED.price_before,event.convertible_bond_revision_events.price_before),
      price_after=COALESCE(EXCLUDED.price_after,event.convertible_bond_revision_events.price_after),
      summary=EXCLUDED.summary,title=EXCLUDED.title,raw_payload=EXCLUDED.raw_payload,updated_at=now();
    COMMIT;
  `);
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 097：清理误写入的不下修锁定记录 =============
// 旧版正文解析会把普通权益分派/已实施下修公告写入 no_revision_history，
// 造成重新起算日被错误延后。只有公告标题明确“不向下修正/不下修/不修正”
// 才能作为下修锁定事实，其余记录删除后由公告同步按新解析器重新补齐。
async function migration097ConvertibleBondRevisionNoRevisionCleanup() {
  await pool.query(`
    DELETE FROM fundamental.convertible_bond_no_revision_history
     WHERE summary !~ '(不向下修正|不下修|不修正)';
  `);
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 098：交易日历不足时保留原始重新起算日 =============
// 日历只保留近期窗口时，不能用窗口最早交易日替换更早的真实日期；否则所有
// 历史记录会被伪造为同一个起算日，造成重算窗口和集思录对照同时漂移。
async function migration098ConvertibleBondRevisionCalendarDateFix() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 099：清理正文误识别的普通停牌记录 =============
// 权益分派公告同样包含停牌/复牌日期，旧正文解析未校验“不下修”证据，
// 会把这些日期误写成下修锁定期。保留标题明确不下修或新版解析有正文证据的记录。
async function migration099ConvertibleBondRevisionBodyEvidenceCleanup() {
  await pool.query(`
    DELETE FROM fundamental.convertible_bond_no_revision_history
     WHERE summary !~ '(不向下修正|不下修|不修正)'
       AND COALESCE((raw_payload->'body_reparse'->>'no_revision_evidence')::boolean,false)=false;
  `);
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 100：下修滚动窗口最少未来交易日 =============
// required_days - matched_days 只适用于静态计数；滚动观察窗口推进后，旧达标日会退出，
// 因此把“最少还需几天”按未来连续达标日模拟并落库，供页面和接口统一使用。
async function migration100ConvertibleBondRevisionRollingRemainingDays() {
  await pool.query(`
    ALTER TABLE analytics.convertible_bond_trigger_daily
      ADD COLUMN IF NOT EXISTS minimum_future_days INTEGER;
  `);
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 101：下修状态与集思录口径对齐 =============
// 已实施/未通过事件仅在最近 3 个交易日置顶；历史事件回到数学计数。
// 同时把未完成的新版本“不下修”解析标记为 incomplete，避免继续累计旧窗口。
async function migration101ConvertibleBondRevisionStatusParity() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 102：下修解析质量门槛修正 =============
// 仅对“没有下一次日期且解析版本/正文证据缺失”的记录置为 incomplete；
// 已有有效下一次日期的历史旧版本仍按原有锁定日期参与计算。
async function migration102ConvertibleBondRevisionQualityGateFix() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 103：明确不下修但未承诺期限的公告 =============
// 新版解析器确认正文明确“不下修”即可作为有效事实；没有锁定期限时继续使用
// 数学窗口，不再把该券误报为数据不完整。旧版本记录仍保持质量门槛，等待重解析。
async function migration103ConvertibleBondRevisionNoRevisionEvidence() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 104：实施公告正文锁定期口径 =============
// 实施公告正文也可能规定一段时间内不得再次下修；正文证据或锁定期任一成立
// 即视为解析完成，避免已落库的实施事件被错误标记为待解析/数学状态。
async function migration104ConvertibleBondRevisionImplementedLockEvidence() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 105：下修净资产底线限制 =============
// 转股价已经不高于募集说明书约定的每股净资产时，数学触发不再代表可执行下修。
async function migration105ConvertibleBondRevisionNetAssetFloor() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 106：下修净资产底线状态视图补强 =============
// 兼容迁移 105 已执行的数据库，确保视图同时识别已落库的 floor_blocked 计算状态。
async function migration106ConvertibleBondRevisionNetAssetFloorViewFix() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 107：下修净资产底线同日口径 =============
// 正股收盘价与 PB 必须来自同一交易日，避免行情或估值水位错位导致误判。
async function migration107ConvertibleBondRevisionNetAssetFloorSameDay() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 108：可转债公告交易所来源登记 =============
// 公告事实保留实际命中的交易所来源，巨潮和可选 Tushare 仅作为备源。
async function migration108ConvertibleBondAnnouncementSources() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES
      ('sse','上交所公告','official',5),
      ('szse','深交所公告','official',5)
    ON CONFLICT(source_code) DO UPDATE SET
      source_name=EXCLUDED.source_name,
      source_type=EXCLUDED.source_type,
      priority=EXCLUDED.priority;
  `);
}

// ========== 109：下修净资产底线条款同义表达补齐 =============
// “价格不低于最近一期经审计的每股净资产”与“不得低于每股净资产”含义相同；
// 旧正则漏掉前者，导致太能转债等转债没有进入净资产底线保护。
async function migration109ConvertibleBondRevisionNetAssetFloorPhrase() {
  const { hasNetAssetFloorClause } = require('../../services/convertibleBondAnalysis');
  const { rows } = await pool.query(
    `SELECT term_id,clause_text FROM fundamental.convertible_bond_terms WHERE term_type='reset'`
  );
  for (const term of rows) {
    await pool.query(
      `UPDATE fundamental.convertible_bond_terms SET net_asset_floor_applicable=$2 WHERE term_id=$1`,
      [term.term_id, hasNetAssetFloorClause(term.clause_text)]
    );
  }
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 110：后台告警与运行状态治理 =============
// 熔断探测使用带所有者的租约，任务状态区分“等待外部来源恢复”，并清理已废弃的全局逾期告警。
async function migration110BackgroundAlertRuntimeGovernance() {
  await pool.query(`
    ALTER TABLE ops.external_circuits ADD COLUMN IF NOT EXISTS probe_owner TEXT;
    ALTER TABLE ops.external_circuits ADD COLUMN IF NOT EXISTS probe_token TEXT;
    ALTER TABLE ops.external_circuits ADD COLUMN IF NOT EXISTS probe_lease_until TIMESTAMPTZ;
    UPDATE ops.external_circuits
       SET probe_lease_until=COALESCE(probe_lease_until, COALESCE(updated_at, opened_at) + interval '5 minutes')
     WHERE probe_in_flight=true AND probe_lease_until IS NULL;

    ALTER TABLE ops.job_schedule_slots DROP CONSTRAINT IF EXISTS job_schedule_slots_status_check;
    ALTER TABLE ops.job_schedule_slots
      ADD CONSTRAINT job_schedule_slots_status_check
      CHECK (status IN ('pending','running','succeeded','degraded','failed','blocked','skipped','waiting_external'));

    UPDATE ops.alert_notifications
       SET status='resolved', resolved_at=COALESCE(resolved_at, now()), updated_at=now()
     WHERE alert_key='worker:overdue-slots' AND status NOT IN ('resolved','acknowledged');
  `);
}

// ========== 111：可转债下修动机评分数据层 =============
// 持有人、质押和评分均采用事实快照/版本化结果；空响应不覆盖旧数据，评分详情可复现。
async function migration111ConvertibleBondRevisionMotive() {
  await pool.query(`
    BEGIN;
    SELECT pg_advisory_xact_lock(904111);

    CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_holder_positions (
      position_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      report_date DATE NOT NULL,
      announced_at DATE,
      holder_rank INTEGER,
      holder_name TEXT NOT NULL DEFAULT '',
      holder_name_normalized TEXT NOT NULL DEFAULT '',
      holder_type TEXT NOT NULL DEFAULT 'other',
      hold_amount NUMERIC(30,4),
      hold_ratio NUMERIC(20,10),
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      source_key TEXT NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_holder_positions_latest
      ON fundamental.convertible_bond_holder_positions(instrument_id,report_date DESC,holder_rank);

    CREATE TABLE IF NOT EXISTS event.convertible_bond_holder_change_events (
      holder_change_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      announced_at DATE NOT NULL,
      holder_name TEXT NOT NULL DEFAULT '',
      holder_name_normalized TEXT NOT NULL DEFAULT '',
      change_type TEXT NOT NULL DEFAULT 'unknown',
      change_amount NUMERIC(30,4),
      change_ratio NUMERIC(20,10),
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      source_key TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_holder_change_events_latest
      ON event.convertible_bond_holder_change_events(instrument_id,announced_at DESC);

    CREATE TABLE IF NOT EXISTS fundamental.company_pledge_snapshots (
      pledge_id BIGSERIAL PRIMARY KEY,
      company_id BIGINT NOT NULL REFERENCES core.companies(company_id) ON DELETE CASCADE,
      as_of_date DATE NOT NULL,
      announced_at DATE,
      pledge_ratio NUMERIC(20,10),
      pledged_shares NUMERIC(30,4),
      unpledged_shares NUMERIC(30,4),
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      source_key TEXT NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_company_pledge_snapshots_latest
      ON fundamental.company_pledge_snapshots(company_id,as_of_date DESC,announced_at DESC);

    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_revision_cycles (
      cycle_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      cycle_no INTEGER NOT NULL,
      cycle_start_date DATE,
      trigger_date DATE,
      proposal_date DATE,
      decision_date DATE,
      implementation_date DATE,
      outcome TEXT NOT NULL DEFAULT 'open',
      proposal_type TEXT NOT NULL DEFAULT '',
      no_revision BOOLEAN NOT NULL DEFAULT false,
      lock_until DATE,
      term_id BIGINT REFERENCES fundamental.convertible_bond_terms(term_id) ON DELETE SET NULL,
      cycle_version TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(instrument_id,cycle_no,cycle_version)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_revision_cycles_lookup
      ON analytics.convertible_bond_revision_cycles(instrument_id,cycle_start_date DESC,cycle_no DESC);

    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_revision_motive_daily (
      motive_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      model_version TEXT NOT NULL,
      motive_score NUMERIC(10,4),
      history_score NUMERIC(10,4),
      pressure_score NUMERIC(10,4),
      conversion_score NUMERIC(10,4),
      governance_score NUMERIC(10,4),
      market_score NUMERIC(10,4),
      maturity_score NUMERIC(10,4),
      executability_status TEXT NOT NULL DEFAULT 'incomplete',
      estimated_floor_price NUMERIC(24,8),
      estimated_space NUMERIC(20,10),
      estimated_post_conversion_value NUMERIC(24,8),
      estimated_value_uplift NUMERIC(24,8),
      safety_level TEXT NOT NULL DEFAULT '',
      motive_level TEXT NOT NULL DEFAULT 'unavailable',
      classification TEXT NOT NULL DEFAULT '',
      core_motives JSONB NOT NULL DEFAULT '[]'::jsonb,
      blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
      components JSONB NOT NULL DEFAULT '{}'::jsonb,
      input_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      input_data_date DATE,
      input_hash TEXT NOT NULL DEFAULT '',
      completeness_rate NUMERIC(10,6) NOT NULL DEFAULT 0,
      quality_status TEXT NOT NULL DEFAULT 'incomplete',
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(instrument_id,trade_date,model_version)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_revision_motive_latest
      ON analytics.convertible_bond_revision_motive_daily(instrument_id,trade_date DESC,calculated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cb_revision_motive_filter
      ON analytics.convertible_bond_revision_motive_daily(motive_level,executability_status,trade_date DESC);
    COMMIT;
  `);
}

// ========== 112：可转债下修动机评分数据完整性 =============
// 对已有 111 表做幂等增量升级，补齐单位换算后的字段、持有人变动前后值和评分范围约束。
async function migration112ConvertibleBondRevisionMotiveIntegrity() {
  await pool.query(`
    BEGIN;
    SELECT pg_advisory_xact_lock(904112);

    ALTER TABLE fundamental.convertible_bond_holder_positions
      ADD COLUMN IF NOT EXISTS is_controller_related BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE event.convertible_bond_holder_change_events
      ADD COLUMN IF NOT EXISTS before_amount NUMERIC(30,4),
      ADD COLUMN IF NOT EXISTS after_amount NUMERIC(30,4),
      ADD COLUMN IF NOT EXISTS before_ratio NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS after_ratio NUMERIC(20,10),
      ADD COLUMN IF NOT EXISTS is_cleared BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS change_start_date DATE,
      ADD COLUMN IF NOT EXISTS change_end_date DATE;

    ALTER TABLE fundamental.company_pledge_snapshots
      ADD COLUMN IF NOT EXISTS pledge_count INTEGER,
      ADD COLUMN IF NOT EXISTS total_shares NUMERIC(30,4);

    ALTER TABLE analytics.convertible_bond_revision_cycles
      ADD COLUMN IF NOT EXISTS first_match_date DATE,
      ADD COLUMN IF NOT EXISTS cycle_end_date DATE,
      ADD COLUMN IF NOT EXISTS short_label TEXT NOT NULL DEFAULT 'unknown';

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_cb_holder_change_type') THEN
        ALTER TABLE event.convertible_bond_holder_change_events
          ADD CONSTRAINT chk_cb_holder_change_type
          CHECK (change_type IN ('new','cleared','increase','decrease','unknown'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_cb_motive_score_ranges') THEN
        ALTER TABLE analytics.convertible_bond_revision_motive_daily
          ADD CONSTRAINT chk_cb_motive_score_ranges CHECK (
            (motive_score IS NULL OR motive_score BETWEEN 0 AND 100) AND
            (history_score IS NULL OR history_score BETWEEN 0 AND 25) AND
            (pressure_score IS NULL OR pressure_score BETWEEN 0 AND 30) AND
            (conversion_score IS NULL OR conversion_score BETWEEN 0 AND 20) AND
            (governance_score IS NULL OR governance_score BETWEEN 0 AND 15) AND
            (market_score IS NULL OR market_score BETWEEN 0 AND 10) AND
            (maturity_score IS NULL OR maturity_score BETWEEN 0 AND 100) AND
            completeness_rate BETWEEN 0 AND 1
          );
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_cb_holder_change_business_dates
      ON event.convertible_bond_holder_change_events(instrument_id,change_start_date,change_end_date);
    COMMIT;
  `);
}

// ========== 113：可转债下修周期字段补齐 =============
async function migration113ConvertibleBondRevisionCycleFields() {
  await pool.query(`
    ALTER TABLE analytics.convertible_bond_revision_cycles
      ADD COLUMN IF NOT EXISTS first_match_date DATE,
      ADD COLUMN IF NOT EXISTS cycle_end_date DATE,
      ADD COLUMN IF NOT EXISTS short_label TEXT NOT NULL DEFAULT 'unknown';
  `);
}

// ========== 114：可转债持有人治理检索索引 =============
async function migration114ConvertibleBondHolderGovernanceIndex() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cb_holder_positions_controller
      ON fundamental.convertible_bond_holder_positions(instrument_id,is_controller_related,report_date DESC);
  `);
}

// ========== 115：可转债下修动机回测结果 ==========
// 回测结果必须和模型版本、样本窗口绑定，未达标时由评分服务继续保持 unavailable。
async function migration115ConvertibleBondRevisionMotiveBacktest() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_revision_motive_backtests (
      backtest_id BIGSERIAL PRIMARY KEY,
      model_version TEXT NOT NULL,
      sample_start_date DATE NOT NULL,
      sample_end_date DATE NOT NULL,
      oos_start_date DATE,
      sample_count INTEGER NOT NULL DEFAULT 0,
      complete_count INTEGER NOT NULL DEFAULT 0,
      proposal_count INTEGER NOT NULL DEFAULT 0,
      baseline_proposal_rate NUMERIC(12,8),
      high_score_count INTEGER NOT NULL DEFAULT 0,
      high_score_proposal_rate NUMERIC(12,8),
      monotonic BOOLEAN NOT NULL DEFAULT false,
      net_return_after_cost NUMERIC(14,8),
      issuer_count INTEGER NOT NULL DEFAULT 0,
      oos_sample_count INTEGER NOT NULL DEFAULT 0,
      pass BOOLEAN NOT NULL DEFAULT false,
      blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(model_version,sample_start_date,sample_end_date)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_motive_backtest_latest
      ON analytics.convertible_bond_revision_motive_backtests(model_version,calculated_at DESC);
  `);
}

// ========== 132：可转债下修事实时间线优先级 =============
// 新的不下修事实必须覆盖旧提议/表决事件；同时重建视图让已落库的历史数据立即采用新口径。
async function migration132ConvertibleBondRevisionDecisionTimeline() {
  await rebuildConvertibleBondRevisionLatestView();
}

// ========== 133：清理旧解析器写入的无证据不下修事实 =============
// 普通权益分派/转股价调整公告不能仅因旧解析器写入过 no_revision_history 就继续影响状态。
// 保留标题明确不下修、正文已有证据或明确锁定期的记录，其余旧版本无证据记录清理后由官方源重建。
async function migration133ConvertibleBondRevisionLegacyFalseFacts() {
  await pool.query(`
    DELETE FROM fundamental.convertible_bond_no_revision_history
     WHERE summary !~ '(不向下修正|不下修|不修正)'
       AND COALESCE((raw_payload->>'no_revision_evidence')::boolean,false)=false
       AND COALESCE((raw_payload->>'lock_declared')::boolean,false)=false
       AND COALESCE(raw_payload->>'parser_version','') <> '7';
  `);
  await rebuildConvertibleBondRevisionLatestView();
}

module.exports = {
  migration090ConvertibleBondRevisionMonitor,
  rebuildConvertibleBondRevisionLatestView,
  migration091ConvertibleBondRevisionListedOnly,
  migration092ConvertibleBondRevisionViewLean,
  migration093ConvertibleBondRevisionTermParser,
  migration094ConvertibleBondRevisionProposalExpiry,
  migration095ConvertibleBondRevisionSymbolicLock,
  migration096ConvertibleBondRevisionImplementedBackfill,
  migration097ConvertibleBondRevisionNoRevisionCleanup,
  migration098ConvertibleBondRevisionCalendarDateFix,
  migration099ConvertibleBondRevisionBodyEvidenceCleanup,
  migration100ConvertibleBondRevisionRollingRemainingDays,
  migration101ConvertibleBondRevisionStatusParity,
  migration102ConvertibleBondRevisionQualityGateFix,
  migration103ConvertibleBondRevisionNoRevisionEvidence,
  migration104ConvertibleBondRevisionImplementedLockEvidence,
  migration105ConvertibleBondRevisionNetAssetFloor,
  migration106ConvertibleBondRevisionNetAssetFloorViewFix,
  migration107ConvertibleBondRevisionNetAssetFloorSameDay,
  migration108ConvertibleBondAnnouncementSources,
  migration109ConvertibleBondRevisionNetAssetFloorPhrase,
  migration110BackgroundAlertRuntimeGovernance,
  migration111ConvertibleBondRevisionMotive,
  migration112ConvertibleBondRevisionMotiveIntegrity,
  migration113ConvertibleBondRevisionCycleFields,
  migration114ConvertibleBondHolderGovernanceIndex,
  migration115ConvertibleBondRevisionMotiveBacktest,
  migration132ConvertibleBondRevisionDecisionTimeline,
  migration133ConvertibleBondRevisionLegacyFalseFacts,
};
