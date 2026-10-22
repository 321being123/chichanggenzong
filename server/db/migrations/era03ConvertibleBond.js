// 可转债发行/强赎/存续（058、077、079-089、136-137、146-147、152-153、168）
// R-6 拆分自 ../migrations.js（2026-10-21）：本文件只放迁移函数体；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('../connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('../util');
const { seedBrokers } = require('../brokers');
const { migrateAccountsTable } = require('../accounts');
const { toNumber, normalizeMigrationDate, normalizeMigrationTimestamp, normalizeMigrationStockCode, scale100m } = require('./helpers');

// ========== 058：打新与可转债统一数据层直接切换 ==========
// 发行事实、证券生命周期事件、上市表现分别落表；bond_history 只在本迁移内作为一次性输入。
async function migration058ConvertibleBondIssueUnified() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fundamental.convertible_bond_issuance (
        instrument_id BIGINT PRIMARY KEY REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
        issue_type TEXT,
        issue_price_yuan NUMERIC(20,8),
        issue_size_100m_yuan NUMERIC(20,8),
        shareholder_allotment_ratio_yuan_per_share NUMERIC(20,8),
        online_size_100m_yuan NUMERIC(20,8),
        offline_size_100m_yuan NUMERIC(20,8),
        online_purchase_accounts_10k NUMERIC(20,8),
        shareholder_allotment_quantity NUMERIC(30,4),
        source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
        source_updated_at TIMESTAMPTZ,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_cb_issuance_source_updated
        ON fundamental.convertible_bond_issuance(source_updated_at DESC);

      CREATE TABLE IF NOT EXISTS event.instrument_events (
        event_id BIGSERIAL PRIMARY KEY,
        instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'issue_announcement','shareholder_record','online_subscription',
          'result_announcement','listing'
        )),
        event_date DATE NOT NULL,
        source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
        document_id BIGINT NULL REFERENCES event.documents(document_id),
        source_key TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_updated_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS idx_instrument_events_date
        ON event.instrument_events(instrument_id, event_date DESC);
      CREATE INDEX IF NOT EXISTS idx_instrument_events_type_date
        ON event.instrument_events(event_type, event_date);

      CREATE TABLE IF NOT EXISTS analytics.convertible_bond_listing_performance (
        instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
        listing_date DATE NOT NULL,
        observation_date DATE NOT NULL,
        measurement_type TEXT NOT NULL CHECK (measurement_type = 'first_non_limit_day'),
        close_price NUMERIC(24,8),
        return_pct NUMERIC(20,8),
        formula_version TEXT NOT NULL,
        source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (instrument_id, measurement_type, formula_version)
      );
      CREATE INDEX IF NOT EXISTS idx_cb_listing_performance_date
        ON analytics.convertible_bond_listing_performance(listing_date DESC);

      ALTER TABLE predictions ADD COLUMN IF NOT EXISTS instrument_id BIGINT
        REFERENCES core.instruments(instrument_id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_predictions_instrument
        ON predictions(instrument_id, pred_date DESC);
    `);

    const sourceResult = await client.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`
    );
    if (!sourceResult.rows[0]) throw new Error('缺少 tushare 数据源');
    const tushareSourceId = sourceResult.rows[0].source_id;

    // 旧表可能由迁移 031 建成空壳，也可能由日报脚本建成完整表。
    const oldTable = await client.query(`
      SELECT to_regclass('public.bond_history') AS name
    `);
    if (oldTable.rows[0].name) {
      for (const [column, type] of [
        ['security_name', 'TEXT'], ['listing_date', 'TEXT'], ['first_day_return', 'REAL'], ['updated_at', 'TEXT'],
        ['ann_date', 'TEXT'], ['res_ann_date', 'TEXT'], ['issue_size', 'REAL'], ['issue_type', 'TEXT'],
        ['rating', 'TEXT'], ['shd_ration_ratio', 'REAL'], ['issue_price', 'REAL'],
        ['shd_ration_record_date', 'TEXT'], ['onl_date', 'TEXT'], ['onl_size', 'REAL'],
        ['onl_pch_num', 'REAL'], ['offl_size', 'REAL'], ['shd_ration_size', 'REAL'], ['conv_price', 'REAL'],
        ['stk_code', 'TEXT'], ['stk_name', 'TEXT']
      ]) {
        await client.query(`ALTER TABLE public.bond_history ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      }
      const legacyAudit = await client.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE security_code !~ '^[0-9]{6}$')::int AS invalid_codes,
               COUNT(*) FILTER (WHERE NULLIF(stk_code,'') IS NOT NULL)::int AS stock_codes,
               COUNT(*) FILTER (WHERE NULLIF(issue_size::text,'') IS NOT NULL)::int AS issue_sizes,
               COUNT(*) FILTER (WHERE NULLIF(ann_date,'') IS NOT NULL OR NULLIF(res_ann_date,'') IS NOT NULL
                                  OR NULLIF(shd_ration_record_date,'') IS NOT NULL OR NULLIF(onl_date,'') IS NOT NULL)::int AS event_rows,
               COUNT(*) FILTER (WHERE first_day_return IS NOT NULL)::int AS performance_rows
          FROM public.bond_history`);
      if (legacyAudit.rows[0].invalid_codes > 0) {
        throw new Error(`bond_history 存在 ${legacyAudit.rows[0].invalid_codes} 条非法可转债代码，停止删除旧表`);
      }
      const oldRows = await client.query(`
        SELECT * FROM public.bond_history
        WHERE security_code ~ '^[0-9]{6}$'
        ORDER BY security_code
      `);
      for (const row of oldRows.rows) {
        const code = String(row.security_code);
        const canonicalCode = /^12/.test(code) ? `${code}.SZ` : `${code}.SH`;
        const instrument = await client.query(`
          INSERT INTO core.instruments(canonical_code,name,asset_class,market,list_date,status,raw_data)
          VALUES($1,$2,'convertible_bond','CN',$3::date,
                 CASE WHEN $3::date IS NULL THEN 'announced'
                      WHEN $3::date <= CURRENT_DATE THEN 'listed' ELSE 'pending_listing' END,
                 $4::jsonb)
          ON CONFLICT(canonical_code) DO UPDATE SET
            name=COALESCE(NULLIF(core.instruments.name,''),EXCLUDED.name),
            list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),
            updated_at=now()
          RETURNING instrument_id
        `, [canonicalCode, row.security_name || code, normalizeMigrationDate(row.listing_date), JSON.stringify(row)]);
        const instrumentId = instrument.rows[0].instrument_id;

        let stockId = null;
        const stockCode = normalizeMigrationStockCode(row.stk_code);
        if (stockCode) {
          const stock = await client.query(`
            INSERT INTO core.instruments(canonical_code,name,asset_class,market)
            VALUES($1,$2,'stock','CN')
            ON CONFLICT(canonical_code) DO UPDATE SET
              name=COALESCE(NULLIF(core.instruments.name,''),EXCLUDED.name),updated_at=now()
            RETURNING instrument_id
          `, [stockCode, row.stk_name || stockCode]);
          stockId = stock.rows[0].instrument_id;
          await client.query(
            `UPDATE fundamental.convertible_bond_profiles
                SET stock_instrument_id=COALESCE(stock_instrument_id,$1),updated_at=now()
              WHERE instrument_id=$2`, [stockId, instrumentId]
          );
        }

        await client.query(`
          INSERT INTO fundamental.convertible_bond_profiles
            (instrument_id,stock_instrument_id,bond_short_name,current_conv_price,issue_size,newest_rating,list_date,source_id,raw_payload)
          VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb)
          ON CONFLICT(instrument_id) DO UPDATE SET
            stock_instrument_id=COALESCE(fundamental.convertible_bond_profiles.stock_instrument_id,EXCLUDED.stock_instrument_id),
            bond_short_name=COALESCE(NULLIF(fundamental.convertible_bond_profiles.bond_short_name,''),EXCLUDED.bond_short_name),
            current_conv_price=COALESCE(fundamental.convertible_bond_profiles.current_conv_price,EXCLUDED.current_conv_price),
            issue_size=COALESCE(fundamental.convertible_bond_profiles.issue_size,EXCLUDED.issue_size),
            newest_rating=COALESCE(NULLIF(fundamental.convertible_bond_profiles.newest_rating,''),EXCLUDED.newest_rating),
            list_date=COALESCE(fundamental.convertible_bond_profiles.list_date,EXCLUDED.list_date),
            raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload,
            updated_at=now()
        `, [instrumentId, stockId, row.security_name || code, toNumber(row.conv_price), toNumber(row.issue_size) == null ? null : toNumber(row.issue_size) * 100000000,
          row.rating || '', normalizeMigrationDate(row.listing_date), tushareSourceId, JSON.stringify(row)]);

        const updatedAt = normalizeMigrationTimestamp(row.updated_at);
        await client.query(`
          INSERT INTO fundamental.convertible_bond_issuance
            (instrument_id,issue_type,issue_price_yuan,issue_size_100m_yuan,
             shareholder_allotment_ratio_yuan_per_share,online_size_100m_yuan,
             offline_size_100m_yuan,online_purchase_accounts_10k,
             shareholder_allotment_quantity,source_id,source_updated_at,raw_payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
          ON CONFLICT(instrument_id) DO UPDATE SET
            issue_type=COALESCE(EXCLUDED.issue_type, fundamental.convertible_bond_issuance.issue_type),
            issue_price_yuan=COALESCE(EXCLUDED.issue_price_yuan, fundamental.convertible_bond_issuance.issue_price_yuan),
            issue_size_100m_yuan=COALESCE(EXCLUDED.issue_size_100m_yuan, fundamental.convertible_bond_issuance.issue_size_100m_yuan),
            shareholder_allotment_ratio_yuan_per_share=COALESCE(EXCLUDED.shareholder_allotment_ratio_yuan_per_share, fundamental.convertible_bond_issuance.shareholder_allotment_ratio_yuan_per_share),
            online_size_100m_yuan=COALESCE(EXCLUDED.online_size_100m_yuan, fundamental.convertible_bond_issuance.online_size_100m_yuan),
            offline_size_100m_yuan=COALESCE(EXCLUDED.offline_size_100m_yuan, fundamental.convertible_bond_issuance.offline_size_100m_yuan),
            online_purchase_accounts_10k=COALESCE(EXCLUDED.online_purchase_accounts_10k, fundamental.convertible_bond_issuance.online_purchase_accounts_10k),
            shareholder_allotment_quantity=COALESCE(EXCLUDED.shareholder_allotment_quantity, fundamental.convertible_bond_issuance.shareholder_allotment_quantity),
            source_updated_at=COALESCE(EXCLUDED.source_updated_at, fundamental.convertible_bond_issuance.source_updated_at),
            raw_payload=fundamental.convertible_bond_issuance.raw_payload || EXCLUDED.raw_payload,
            updated_at=now()
        `, [instrumentId, row.issue_type || null, toNumber(row.issue_price), toNumber(row.issue_size),
          toNumber(row.shd_ration_ratio), toNumber(row.onl_size), toNumber(row.offl_size),
          toNumber(row.onl_pch_num), toNumber(row.shd_ration_size), tushareSourceId,
          updatedAt, JSON.stringify(row)]);

        const events = [
          ['issue_announcement', row.ann_date],
          ['shareholder_record', row.shd_ration_record_date],
          ['online_subscription', row.onl_date],
          ['result_announcement', row.res_ann_date],
          ['listing', row.listing_date],
        ];
        for (const [eventType, date] of events) {
          const eventDate = normalizeMigrationDate(date);
          if (!eventDate) continue;
          await client.query(`
            INSERT INTO event.instrument_events
              (instrument_id,event_type,event_date,source_id,source_key,details,source_updated_at)
            VALUES($1,$2,$3::date,$4,$5,$6::jsonb,$7)
            ON CONFLICT(source_id,source_key) DO UPDATE SET
              instrument_id=EXCLUDED.instrument_id,event_date=EXCLUDED.event_date,
              details=EXCLUDED.details,source_updated_at=EXCLUDED.source_updated_at,updated_at=now()
          `, [instrumentId, eventType, eventDate, tushareSourceId,
            `tushare:cb_issue:${code}:${eventType}:${eventDate}`, JSON.stringify(row), updatedAt]);
        }

        const listingDate = normalizeMigrationDate(row.listing_date);
        const returnPct = toNumber(row.first_day_return);
        if (listingDate && returnPct != null) {
          await client.query(`
            INSERT INTO analytics.convertible_bond_listing_performance
              (instrument_id,listing_date,observation_date,measurement_type,close_price,return_pct,formula_version,source_id,raw_payload)
            VALUES($1,$2::date,$2::date,'first_non_limit_day',100 * (1 + $3::numeric / 100),$3::numeric,'legacy_bond_history_v1',$4,$5::jsonb)
            ON CONFLICT(instrument_id,measurement_type,formula_version) DO UPDATE SET
              listing_date=EXCLUDED.listing_date,observation_date=EXCLUDED.observation_date,
              close_price=EXCLUDED.close_price,return_pct=EXCLUDED.return_pct,
              raw_payload=EXCLUDED.raw_payload,calculated_at=now()
          `, [instrumentId, listingDate, returnPct, tushareSourceId, JSON.stringify(row)]);
        }
      }
      const coverage = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM public.bond_history) AS old_total,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
            WHERE i.asset_class='convertible_bond') AS instrument_total,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
             JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
            WHERE (NULLIF(bh.issue_type,'') IS NULL OR NULLIF(iss.issue_type,'') IS NOT NULL)
              AND (bh.issue_price IS NULL OR iss.issue_price_yuan IS NOT NULL)
              AND (bh.issue_size IS NULL OR iss.issue_size_100m_yuan IS NOT NULL)
              AND (bh.shd_ration_ratio IS NULL OR iss.shareholder_allotment_ratio_yuan_per_share IS NOT NULL)
              AND (bh.onl_size IS NULL OR iss.online_size_100m_yuan IS NOT NULL)
              AND (bh.offl_size IS NULL OR iss.offline_size_100m_yuan IS NOT NULL)
              AND (bh.onl_pch_num IS NULL OR iss.online_purchase_accounts_10k IS NOT NULL)
              AND (bh.shd_ration_size IS NULL OR iss.shareholder_allotment_quantity IS NOT NULL)) AS issuance_covered,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
             JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
             WHERE NULLIF(bh.stk_code,'') IS NULL OR p.stock_instrument_id IS NOT NULL) AS stock_covered,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
            WHERE (NULLIF(bh.ann_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='issue_announcement'
                   ))
              AND (NULLIF(bh.shd_ration_record_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='shareholder_record'
                   ))
              AND (NULLIF(bh.onl_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='online_subscription'
                   ))
              AND (NULLIF(bh.res_ann_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='result_announcement'
                   ))
              AND (NULLIF(bh.listing_date,'') IS NULL OR EXISTS (
                     SELECT 1 FROM event.instrument_events e
                      WHERE e.instrument_id=i.instrument_id AND e.event_type='listing'
                   ))) AS issue_event_covered,
          (SELECT COUNT(*) FROM public.bond_history bh JOIN core.instruments i
             ON i.canonical_code = CASE WHEN bh.security_code LIKE '12%' THEN bh.security_code || '.SZ' ELSE bh.security_code || '.SH' END
             LEFT JOIN analytics.convertible_bond_listing_performance lp ON lp.instrument_id=i.instrument_id
            WHERE bh.first_day_return IS NULL OR lp.measurement_type='first_non_limit_day') AS performance_covered
      `);
      const c = coverage.rows[0];
      if (Number(c.old_total) !== Number(c.instrument_total)) throw new Error('旧债代码未 100% 映射到 instrument_id，停止删除旧表');
      if (Number(c.old_total) !== Number(c.issuance_covered)) throw new Error('旧债发行事实未 100% 覆盖，停止删除旧表');
      if (Number(c.old_total) !== Number(c.stock_covered)) throw new Error('旧债正股关联未 100% 覆盖，停止删除旧表');
      if (Number(c.old_total) !== Number(c.issue_event_covered)) throw new Error('旧债发行公告事件未 100% 覆盖，停止删除旧表');
      if (Number(c.old_total) !== Number(c.performance_covered)) throw new Error('旧债上市表现未 100% 覆盖，停止删除旧表');
    }

    const unresolved = await client.query(`
      SELECT p.id,p.type,p.code
        FROM predictions p
        LEFT JOIN core.instruments i
          ON i.canonical_code = CASE
               WHEN p.code ~ '^\\d{6}\\.(SH|SZ)$' THEN p.code
               WHEN p.code ~ '^(10|11|110|111|113|118)' THEN p.code || '.SH'
               ELSE p.code || '.SZ' END
       WHERE p.type='bond' AND p.instrument_id IS NULL AND i.instrument_id IS NULL
    `);
    if (unresolved.rows.length) {
      throw new Error(`存在无法映射到 instrument_id 的可转债预测：${unresolved.rows.slice(0, 10).map(r => r.code).join(',')}`);
    }
    await client.query(`
      UPDATE predictions p
         SET instrument_id=i.instrument_id,updated_at=COALESCE(p.updated_at,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
        FROM core.instruments i
       WHERE p.type='bond' AND p.instrument_id IS NULL
         AND i.canonical_code = CASE
           WHEN p.code ~ '^\\d{6}\\.(SH|SZ)$' THEN p.code
           WHEN p.code ~ '^(10|11|110|111|113|118)' THEN p.code || '.SH'
           ELSE p.code || '.SZ' END
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname='chk_predictions_bond_instrument'
            AND conrelid='predictions'::regclass
        ) THEN
          ALTER TABLE predictions ADD CONSTRAINT chk_predictions_bond_instrument
            CHECK (type <> 'bond' OR instrument_id IS NOT NULL) NOT VALID;
        END IF;
      END $$;
    `);

    await client.query(`
      DROP VIEW IF EXISTS public.bond_unified CASCADE;
      CREATE VIEW public.bond_unified AS
      SELECT
        i.instrument_id,
        i.canonical_code AS bond_code,
        split_part(i.canonical_code, '.', 1) AS security_code,
        i.name AS bond_name,
        COALESCE(ev.listing_date::date, i.list_date) AS listing_date,
        i.delist_date,
        i.status,
        p.bond_full_name,
        p.stock_instrument_id,
        p.issue_size,
        p.remain_size,
        p.par_value,
        p.first_conv_price,
        p.current_conv_price AS conv_price,
        p.value_date,
        p.maturity_date,
        p.conv_start_date,
        p.conv_end_date,
        p.conv_stop_date,
        p.coupon_rate,
        p.issue_rating,
        p.newest_rating AS rating,
        p.rating_company,
        p.guarantor,
        p.guarantee_type,
        p.fundraising_purpose,
        p.cb_type,
        p.maturity_call_price,
        iss.issue_type,
        iss.issue_size_100m_yuan,
        iss.shareholder_allotment_ratio_yuan_per_share AS shd_ration_ratio,
        iss.online_size_100m_yuan AS onl_size,
        iss.offline_size_100m_yuan AS offl_size,
        iss.online_purchase_accounts_10k AS onl_pch_num,
        iss.shareholder_allotment_quantity AS shd_ration_size,
        iss.issue_price_yuan AS bh_issue_price,
        ev.ann_date,
        ev.res_ann_date,
        ev.shd_ration_record_date,
        ev.onl_date,
        perf.first_day_return,
        s.canonical_code AS stock_code,
        COALESCE(s.name, '') AS stock_name,
        COALESCE(p.newest_rating, p.issue_rating) AS display_rating,
        p.current_conv_price AS display_conv_price,
        COALESCE(iss.issue_size_100m_yuan, p.issue_size / 100000000.0) AS display_issue_size
      FROM core.instruments i
      LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      LEFT JOIN LATERAL (
        SELECT
          MAX(event_date) FILTER (WHERE event_type='issue_announcement')::text AS ann_date,
          MAX(event_date) FILTER (WHERE event_type='result_announcement')::text AS res_ann_date,
          MAX(event_date) FILTER (WHERE event_type='shareholder_record')::text AS shd_ration_record_date,
          MAX(event_date) FILTER (WHERE event_type='online_subscription')::text AS onl_date,
          MAX(event_date) FILTER (WHERE event_type='listing')::text AS listing_date
        FROM event.instrument_events e WHERE e.instrument_id=i.instrument_id
      ) ev ON true
      LEFT JOIN LATERAL (
        SELECT return_pct AS first_day_return
          FROM analytics.convertible_bond_listing_performance lp
         WHERE lp.instrument_id=i.instrument_id AND lp.measurement_type='first_non_limit_day'
         ORDER BY lp.calculated_at DESC LIMIT 1
      ) perf ON true
      WHERE i.asset_class='convertible_bond';
    `);

    const oldExists = await client.query(`SELECT to_regclass('public.bond_history') AS name`);
    if (oldExists.rows[0].name) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ops.legacy_bond_history_20260812 AS
        SELECT * FROM public.bond_history WHERE false
      `);
      const oldCount = await client.query(`SELECT COUNT(*)::int AS n FROM public.bond_history`);
      const archiveCount = await client.query(`SELECT COUNT(*)::int AS n FROM ops.legacy_bond_history_20260812`);
      const oldTotal = oldCount.rows[0].n;
      const archivedTotal = archiveCount.rows[0].n;
      if (archivedTotal !== 0 && archivedTotal !== oldTotal) {
        throw new Error(`旧 bond_history 归档不完整：旧表 ${oldTotal} 行，归档表 ${archivedTotal} 行，停止删除旧表`);
      }
      if (archivedTotal === 0 && oldTotal > 0) {
        await client.query(`INSERT INTO ops.legacy_bond_history_20260812 SELECT * FROM public.bond_history`);
      }
      const verifiedArchive = await client.query(`SELECT COUNT(*)::int AS n FROM ops.legacy_bond_history_20260812`);
      if (verifiedArchive.rows[0].n !== oldTotal) {
        throw new Error(`旧 bond_history 归档校验失败：期望 ${oldTotal} 行，实际 ${verifiedArchive.rows[0].n} 行，停止删除旧表`);
      }
      await client.query(`DROP TABLE public.bond_history`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ========== 077：上市可转债列表每日派生指标 ==========
async function migration077ConvertibleBondListMetrics() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics.convertible_bond_list_metrics_daily (
      trade_date DATE NOT NULL,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      formula_version TEXT NOT NULL,
      theoretical_option_value NUMERIC(20,6),
      theoretical_value NUMERIC(20,6),
      theoretical_deviation_pct NUMERIC(20,8),
      stock_volatility NUMERIC(20,8),
      call_trigger_price NUMERIC(20,6),
      bond_market_cap_ratio NUMERIC(20,10),
      asset_liability_ratio NUMERIC(20,10),
      fund_holding_ratio NUMERIC(20,10),
      turnover_rate NUMERIC(20,10),
      maturity_yield_pre_tax NUMERIC(20,10),
      earliest_put_trigger_date DATE,
      earliest_put_remaining_years NUMERIC(20,8),
      expected_put_payment_date DATE,
      put_yield_pre_tax NUMERIC(20,10),
      put_yield_after_tax NUMERIC(20,10),
      double_low NUMERIC(20,6),
      financial_period_end DATE,
      fund_report_date DATE,
      input_hash TEXT,
      data_status TEXT NOT NULL DEFAULT 'partial',
      diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (trade_date, instrument_id, formula_version)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_list_metrics_date
      ON analytics.convertible_bond_list_metrics_daily(trade_date DESC);
    CREATE INDEX IF NOT EXISTS idx_cb_list_metrics_instrument
      ON analytics.convertible_bond_list_metrics_daily(instrument_id, trade_date DESC);
  `);
}

// ========== 079：可转债强赎统一状态与官方事件 ==========
// 强赎进度统一写入 trigger_daily；官方公告单独保存，页面及其他模块只读 latest 视图。
async function migration079ConvertibleBondRedemption() {
  await pool.query(`
    INSERT INTO ops.data_sources(source_code,source_name,source_type,priority)
    VALUES ('convertible_bond_redemption_announcements','可转债强赎公告','official',5)
    ON CONFLICT(source_code) DO UPDATE SET
      source_name=EXCLUDED.source_name,source_type=EXCLUDED.source_type,priority=EXCLUDED.priority;

    CREATE TABLE IF NOT EXISTS event.convertible_bond_call_events (
      event_id BIGSERIAL PRIMARY KEY,
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('warning','exercise','waive','implementation','completion')),
      announced_at DATE NOT NULL,
      no_call_until DATE,
      redemption_record_date DATE,
      last_trade_date DATE,
      last_conversion_date DATE,
      redemption_price NUMERIC(20,8),
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      document_id BIGINT REFERENCES event.documents(document_id) ON DELETE SET NULL,
      source_key TEXT NOT NULL,
      source_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      parse_status TEXT NOT NULL DEFAULT 'partial' CHECK (parse_status IN ('complete','partial','failed')),
      parser_version TEXT NOT NULL DEFAULT '1',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(source_id,source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cb_call_events_instrument_date
      ON event.convertible_bond_call_events(instrument_id,announced_at DESC,event_id DESC);
    CREATE INDEX IF NOT EXISTS idx_cb_call_events_type_date
      ON event.convertible_bond_call_events(event_type,announced_at DESC);

    ALTER TABLE analytics.convertible_bond_trigger_daily
      ADD COLUMN IF NOT EXISTS data_status TEXT NOT NULL DEFAULT 'complete';
    CREATE INDEX IF NOT EXISTS idx_cb_trigger_call_latest
      ON analytics.convertible_bond_trigger_daily(instrument_id,trigger_type,trade_date DESC,calculated_at DESC);
  `);

  await pool.query(`
    DROP VIEW IF EXISTS analytics.convertible_bond_call_latest CASCADE;
    CREATE VIEW analytics.convertible_bond_call_latest AS
    WITH latest_trigger AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,trade_date,trigger_price,close_price,matched_days,required_days,
             observation_days,status AS calculated_status,formula_version,diagnostics,
             data_status,calculated_at
        FROM analytics.convertible_bond_trigger_daily
       WHERE trigger_type='call'
       ORDER BY instrument_id,trade_date DESC,calculated_at DESC
    ),
    latest_term AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,trigger_ratio,observation_days AS term_observation_days,
             required_days AS term_required_days,clause_text,term_id
        FROM fundamental.convertible_bond_terms
       WHERE term_type='call'
         AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
       ORDER BY instrument_id,effective_from DESC,term_id DESC
    ),
    latest_event AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,event_id,event_type,announced_at,no_call_until,
             redemption_record_date,last_trade_date,last_conversion_date,
             redemption_price,document_id,source_url,title,parse_status,
             parser_version,details
        FROM event.convertible_bond_call_events
       ORDER BY instrument_id,announced_at DESC,event_id DESC
    )
    SELECT i.instrument_id,
           i.canonical_code AS ts_code,
           split_part(i.canonical_code,'.',1) AS security_code,
           i.name AS bond_name,
           p.stock_instrument_id,
           s.canonical_code AS stock_code,
           s.name AS stock_name,
           p.current_conv_price AS current_conv_price,
           lterm.trigger_ratio,
           COALESCE(lt.trigger_price,
             CASE WHEN lterm.trigger_ratio IS NOT NULL AND p.current_conv_price IS NOT NULL
                  THEN p.current_conv_price * lterm.trigger_ratio END) AS trigger_price,
           lt.close_price AS stock_close,
           CASE WHEN COALESCE(lt.trigger_price,
                    CASE WHEN lterm.trigger_ratio IS NOT NULL AND p.current_conv_price IS NOT NULL
                         THEN p.current_conv_price * lterm.trigger_ratio END) > 0
                     AND lt.close_price IS NOT NULL
                THEN lt.close_price / COALESCE(lt.trigger_price,
                    CASE WHEN lterm.trigger_ratio IS NOT NULL AND p.current_conv_price IS NOT NULL
                         THEN p.current_conv_price * lterm.trigger_ratio END) - 1 END AS distance_to_trigger_pct,
           lt.trade_date,lt.matched_days,lt.required_days,lt.observation_days,
           CASE WHEN lt.required_days IS NOT NULL AND lt.matched_days IS NOT NULL
                THEN GREATEST(lt.required_days - lt.matched_days,0) END AS remaining_days,
           lt.calculated_status,lt.formula_version,lt.diagnostics,lt.data_status,lt.calculated_at,
           le.event_id,le.event_type AS official_status,le.announced_at,le.no_call_until,
           le.redemption_record_date,le.last_trade_date,le.last_conversion_date,
           le.redemption_price,le.document_id,le.source_url,le.title AS announcement_title,
           le.parse_status AS announcement_parse_status,le.parser_version AS announcement_parser_version,
           le.details AS announcement_details,
           CASE
             WHEN le.event_type='completion' THEN 'completed'
             WHEN le.event_type IN ('exercise','implementation') THEN 'announced'
             WHEN le.event_type='waive' AND (le.no_call_until IS NULL OR le.no_call_until >= COALESCE(lt.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN lt.calculated_status='met' THEN 'met_pending'
             WHEN lt.calculated_status='tracking' AND lt.required_days - lt.matched_days BETWEEN 1 AND 5 THEN 'near'
             WHEN lt.calculated_status='tracking' THEN 'tracking'
             WHEN lt.calculated_status='not_active' THEN 'inactive'
             ELSE 'incomplete'
           END AS business_status,
           p.remain_size,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date
      FROM core.instruments i
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      LEFT JOIN latest_trigger lt ON lt.instrument_id=i.instrument_id
      LEFT JOIN latest_term lterm ON lterm.instrument_id=i.instrument_id
      LEFT JOIN latest_event le ON le.instrument_id=i.instrument_id
     WHERE i.asset_class='convertible_bond';
  `);

  // 统一债券视图继续保持原列契约，只将官方已知的停止转股日纳入有效生命周期。
  await pool.query(`
    DROP VIEW IF EXISTS public.bond_unified CASCADE;
    CREATE VIEW public.bond_unified AS
    SELECT
      i.instrument_id,
      i.canonical_code AS bond_code,
      split_part(i.canonical_code, '.', 1) AS security_code,
      i.name AS bond_name,
      COALESCE(ev.listing_date::date, i.list_date) AS listing_date,
      i.delist_date,
      i.status,
      p.bond_full_name,
      p.stock_instrument_id,
      p.issue_size,
      p.remain_size,
      p.par_value,
      p.first_conv_price,
      p.current_conv_price AS conv_price,
      p.value_date,
      p.maturity_date,
      p.conv_start_date,
      p.conv_end_date,
      CASE
        WHEN p.conv_stop_date IS NULL THEN call_stop.last_conversion_date
        WHEN call_stop.last_conversion_date IS NULL THEN p.conv_stop_date
        ELSE LEAST(p.conv_stop_date,call_stop.last_conversion_date)
      END AS conv_stop_date,
      p.coupon_rate,
      p.issue_rating,
      p.newest_rating AS rating,
      p.rating_company,
      p.guarantor,
      p.guarantee_type,
      p.fundraising_purpose,
      p.cb_type,
      p.maturity_call_price,
      iss.issue_type,
      iss.issue_size_100m_yuan,
      iss.shareholder_allotment_ratio_yuan_per_share AS shd_ration_ratio,
      iss.online_size_100m_yuan AS onl_size,
      iss.offline_size_100m_yuan AS offl_size,
      iss.online_purchase_accounts_10k AS onl_pch_num,
      iss.shareholder_allotment_quantity AS shd_ration_size,
      iss.issue_price_yuan AS bh_issue_price,
      ev.ann_date,
      ev.res_ann_date,
      ev.shd_ration_record_date,
      ev.onl_date,
      perf.first_day_return,
      s.canonical_code AS stock_code,
      COALESCE(s.name, '') AS stock_name,
      COALESCE(p.newest_rating, p.issue_rating) AS display_rating,
      p.current_conv_price AS display_conv_price,
      COALESCE(iss.issue_size_100m_yuan, p.issue_size / 100000000.0) AS display_issue_size
    FROM core.instruments i
    LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
    LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
    LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
    LEFT JOIN LATERAL (
      SELECT
        MAX(event_date) FILTER (WHERE event_type='issue_announcement')::text AS ann_date,
        MAX(event_date) FILTER (WHERE event_type='result_announcement')::text AS res_ann_date,
        MAX(event_date) FILTER (WHERE event_type='shareholder_record')::text AS shd_ration_record_date,
        MAX(event_date) FILTER (WHERE event_type='online_subscription')::text AS onl_date,
        MAX(event_date) FILTER (WHERE event_type='listing')::text AS listing_date
      FROM event.instrument_events e WHERE e.instrument_id=i.instrument_id
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT MIN(COALESCE(last_conversion_date,last_trade_date)) AS last_conversion_date
        FROM event.convertible_bond_call_events ce
       WHERE ce.instrument_id=i.instrument_id
         AND ce.event_type IN ('exercise','implementation','completion')
    ) call_stop ON true
    LEFT JOIN LATERAL (
      SELECT return_pct AS first_day_return
        FROM analytics.convertible_bond_listing_performance lp
       WHERE lp.instrument_id=i.instrument_id AND lp.measurement_type='first_non_limit_day'
       ORDER BY lp.calculated_at DESC LIMIT 1
    ) perf ON true
   WHERE i.asset_class='convertible_bond';
  `);
}

// ========== 080：强赎计算交易日历与数据质量 ==========
// 强赎窗口必须使用真实交易日；同时保留上游交易日原始记录，供补数、审计和其他模块复用。
async function migration080ConvertibleBondRedemptionQuality() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.trade_calendar (
      exchange TEXT NOT NULL,
      trade_date DATE NOT NULL,
      is_open BOOLEAN NOT NULL,
      source_code TEXT NOT NULL DEFAULT 'tushare',
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (exchange, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_market_trade_calendar_open_date
      ON market.trade_calendar(exchange, trade_date DESC) WHERE is_open;
  `);
}

// ========== 081：强赎状态与条款窗口统一修复 ==========
// 强赎页面、上市列表和股债分析全部读取同一状态视图；同时修复历史条款中把“到期后五个交易日”
// 误识别为强赎窗口的问题，避免出现 observation_days=5、required_days=30 的反向数据。
async function migration081ConvertibleBondRedemptionUnifiedStatus() {
  const { parseWindow } = require('../../services/convertibleBondAnalysis');
  const { rows: terms } = await pool.query(
    `SELECT term_id,clause_text
       FROM fundamental.convertible_bond_terms
      WHERE term_type='call'`
  );
  for (const term of terms) {
    const window = parseWindow(term.clause_text);
    if (!(window.observation_days > 0 && window.required_days > 0)) continue;
    await pool.query(
      `UPDATE fundamental.convertible_bond_terms
          SET observation_days=$2,required_days=$3
        WHERE term_id=$1`,
      [term.term_id, window.observation_days, window.required_days]
    );
  }

  const { rows: rawView } = await pool.query(
    `SELECT 1 FROM pg_views WHERE schemaname='analytics' AND viewname='convertible_bond_call_latest_raw'`
  );
  if (!rawView.length) {
    await pool.query('ALTER VIEW analytics.convertible_bond_call_latest RENAME TO convertible_bond_call_latest_raw');
  }
  await pool.query('DROP VIEW IF EXISTS analytics.convertible_bond_call_latest');
  await pool.query(`
    CREATE VIEW analytics.convertible_bond_call_latest AS
    SELECT r.instrument_id,r.ts_code,r.security_code,r.bond_name,r.stock_instrument_id,
           r.stock_code,r.stock_name,r.current_conv_price,r.trigger_ratio,r.trigger_price,
           r.stock_close,r.distance_to_trigger_pct,r.trade_date,r.matched_days,r.required_days,
           r.observation_days,r.remaining_days,r.calculated_status,r.formula_version,r.diagnostics,
           r.data_status,r.calculated_at,r.event_id,r.official_status,r.announced_at,r.no_call_until,
           r.redemption_record_date,r.last_trade_date,r.last_conversion_date,r.redemption_price,
           r.document_id,r.source_url,r.announcement_title,r.announcement_parse_status,
           r.announcement_parser_version,r.announcement_details,
           CASE
             WHEN r.official_status='completion' THEN 'completed'
             WHEN r.official_status IN ('exercise','implementation') THEN 'announced'
             WHEN r.official_status='waive'
                  AND (r.no_call_until IS NULL OR r.no_call_until >= COALESCE(r.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN r.data_status <> 'complete' THEN 'incomplete'
             WHEN r.maturity_date IS NOT NULL
                  AND r.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days') THEN 'maturity_near'
             WHEN r.calculated_status='met' THEN 'met_pending'
             WHEN r.calculated_status='tracking' AND r.required_days-r.matched_days BETWEEN 1 AND 5 THEN 'near'
             WHEN r.calculated_status='tracking' THEN 'tracking'
             WHEN r.calculated_status='not_active' THEN 'inactive'
             ELSE 'incomplete'
           END AS business_status,
           r.remain_size,r.maturity_date,r.conv_start_date,r.conv_end_date,r.conv_stop_date
      FROM analytics.convertible_bond_call_latest_raw r;
  `);
}

// ========== 082：强赎窗口识别正股停牌日 ==========
// 正股停牌日没有收盘价，不属于行情漏数；单独落库供强赎计算和其他模块复用。
async function migration082StockSuspensionCalendar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market.stock_suspend_calendar (
      instrument_id BIGINT NOT NULL REFERENCES core.instruments(instrument_id) ON DELETE CASCADE,
      trade_date DATE NOT NULL,
      suspend_type TEXT NOT NULL DEFAULT 'S',
      suspend_reason TEXT,
      source_id SMALLINT NOT NULL REFERENCES ops.data_sources(source_id),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (instrument_id, trade_date, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_suspend_calendar_date
      ON market.stock_suspend_calendar(trade_date DESC, instrument_id);
  `);
}

// ========== 083：强赎实施后的债券生命周期 ==========
// 公告中的最后交易日已过去时，转债即从“在市”切换到“历史退市”，不再依赖 Tushare 较晚的摘牌日期。
async function migration083ConvertibleBondCallLifecycle() {
  await pool.query(`
    CREATE OR REPLACE VIEW public.bond_unified AS
    SELECT
      i.instrument_id,
      i.canonical_code AS bond_code,
      split_part(i.canonical_code, '.', 1) AS security_code,
      i.name AS bond_name,
      COALESCE(ev.listing_date::date, i.list_date) AS listing_date,
      i.delist_date,
      CASE
        WHEN i.status='delisted' THEN 'delisted'
        WHEN COALESCE(call_stop.last_trade_date, call_stop.last_conversion_date) IS NOT NULL
         AND COALESCE(call_stop.last_trade_date, call_stop.last_conversion_date)
             <= CURRENT_DATE
        THEN 'delisted'
        ELSE i.status
      END AS status,
      p.bond_full_name,
      p.stock_instrument_id,
      p.issue_size,
      p.remain_size,
      p.par_value,
      p.first_conv_price,
      p.current_conv_price AS conv_price,
      p.value_date,
      p.maturity_date,
      p.conv_start_date,
      p.conv_end_date,
      CASE
        WHEN p.conv_stop_date IS NULL THEN call_stop.last_conversion_date
        WHEN call_stop.last_conversion_date IS NULL THEN p.conv_stop_date
        ELSE LEAST(p.conv_stop_date,call_stop.last_conversion_date)
      END AS conv_stop_date,
      p.coupon_rate,
      p.issue_rating,
      p.newest_rating AS rating,
      p.rating_company,
      p.guarantor,
      p.guarantee_type,
      p.fundraising_purpose,
      p.cb_type,
      p.maturity_call_price,
      iss.issue_type,
      iss.issue_size_100m_yuan,
      iss.shareholder_allotment_ratio_yuan_per_share AS shd_ration_ratio,
      iss.online_size_100m_yuan AS onl_size,
      iss.offline_size_100m_yuan AS offl_size,
      iss.online_purchase_accounts_10k AS onl_pch_num,
      iss.shareholder_allotment_quantity AS shd_ration_size,
      iss.issue_price_yuan AS bh_issue_price,
      ev.ann_date,
      ev.res_ann_date,
      ev.shd_ration_record_date,
      ev.onl_date,
      perf.first_day_return,
      s.canonical_code AS stock_code,
      COALESCE(s.name, '') AS stock_name,
      COALESCE(p.newest_rating, p.issue_rating) AS display_rating,
      p.current_conv_price AS display_conv_price,
      COALESCE(iss.issue_size_100m_yuan, p.issue_size / 100000000.0) AS display_issue_size
    FROM core.instruments i
    LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
    LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
    LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
    LEFT JOIN LATERAL (
      SELECT
        MAX(event_date) FILTER (WHERE event_type='issue_announcement')::text AS ann_date,
        MAX(event_date) FILTER (WHERE event_type='result_announcement')::text AS res_ann_date,
        MAX(event_date) FILTER (WHERE event_type='shareholder_record')::text AS shd_ration_record_date,
        MAX(event_date) FILTER (WHERE event_type='online_subscription')::text AS onl_date,
        MAX(event_date) FILTER (WHERE event_type='listing')::text AS listing_date
      FROM event.instrument_events e WHERE e.instrument_id=i.instrument_id
    ) ev ON true
    LEFT JOIN LATERAL (
      SELECT MAX(last_trade_date) AS last_trade_date,
             MAX(COALESCE(last_conversion_date,last_trade_date)) AS last_conversion_date
        FROM event.convertible_bond_call_events ce
       WHERE ce.instrument_id=i.instrument_id
         AND ce.event_type IN ('exercise','implementation','completion')
    ) call_stop ON true
    LEFT JOIN LATERAL (
      SELECT return_pct AS first_day_return
        FROM analytics.convertible_bond_listing_performance lp
       WHERE lp.instrument_id=i.instrument_id AND lp.measurement_type='first_non_limit_day'
       ORDER BY lp.calculated_at DESC LIMIT 1
    ) perf ON true
   WHERE i.asset_class='convertible_bond';
  `);
}

// ========== 084：强赎生命周期按当前日生效 ==========
// 行情可能滞后一个交易日，但最后交易日已过时不能继续把转债当作在市标的。
async function migration084ConvertibleBondCallLifecycleCurrentDate() {
  await migration083ConvertibleBondCallLifecycle();
}

// ========== 085：不提前赎回公告状态修复 ==========
// 公告解析器偶尔会把公告日写入 no_call_until，导致最新的“不提前赎回”公告被误判为已过期，
// 进而又显示为“已满足待确认”。公告日不是截止日；在没有明确截止日时，应以最新公告为准。
async function migration085ConvertibleBondWaiveAnnouncementStatus() {
  await pool.query(`
    UPDATE event.convertible_bond_call_events
       SET no_call_until=NULL,updated_at=now()
     WHERE event_type='waive'
       AND no_call_until IS NOT NULL
       AND no_call_until <= announced_at;
  `);
  await pool.query(`
    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    SELECT r.instrument_id,r.ts_code,r.security_code,r.bond_name,r.stock_instrument_id,
           r.stock_code,r.stock_name,r.current_conv_price,r.trigger_ratio,r.trigger_price,
           r.stock_close,r.distance_to_trigger_pct,r.trade_date,r.matched_days,r.required_days,
           r.observation_days,r.remaining_days,r.calculated_status,r.formula_version,r.diagnostics,
           r.data_status,r.calculated_at,r.event_id,r.official_status,r.announced_at,r.no_call_until,
           r.redemption_record_date,r.last_trade_date,r.last_conversion_date,r.redemption_price,
           r.document_id,r.source_url,r.announcement_title,r.announcement_parse_status,
           r.announcement_parser_version,r.announcement_details,
           CASE
             WHEN r.official_status='completion' THEN 'completed'
             WHEN r.official_status IN ('exercise','implementation') THEN 'announced'
             WHEN r.official_status='waive'
                  AND (r.no_call_until IS NULL OR r.no_call_until >= COALESCE(r.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN r.data_status <> 'complete' THEN 'incomplete'
             WHEN r.maturity_date IS NOT NULL
                  AND r.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days') THEN 'maturity_near'
             WHEN r.calculated_status='met' THEN 'met_pending'
             WHEN r.calculated_status='tracking' AND r.required_days-r.matched_days BETWEEN 1 AND 5 THEN 'near'
             WHEN r.calculated_status='tracking' THEN 'tracking'
             WHEN r.calculated_status='not_active' THEN 'inactive'
             ELSE 'incomplete'
           END AS business_status,
           r.remain_size,r.maturity_date,r.conv_start_date,r.conv_end_date,r.conv_stop_date
      FROM analytics.convertible_bond_call_latest_raw r;
  `);
}

// ========== 086：可转债公告事实统一读取视图 ==========
// 强赎、不下修、转股价调整均已落库；股债分析只读此视图，不再临时抓取并重复解析公告。
async function migration086ConvertibleBondAnnouncementHistoryView() {
  await pool.query(`
    DROP VIEW IF EXISTS analytics.convertible_bond_announcement_history;
    CREATE VIEW analytics.convertible_bond_announcement_history AS
    SELECT event_id AS fact_id,instrument_id,'call'::text AS fact_type,event_type,
           announced_at,COALESCE(last_conversion_date,last_trade_date) AS effective_date,
           no_call_until AS valid_until,NULL::date AS next_eligible_date,
           NULL::numeric AS price_before,NULL::numeric AS price_after,title AS summary,
           source_id,document_id,source_url,parse_status AS parser_status,
           parser_version,raw_payload
      FROM event.convertible_bond_call_events
    UNION ALL
    SELECT history_id AS fact_id,instrument_id,'no_revision'::text AS fact_type,NULL::text AS event_type,
           announced_at,NULL::date AS effective_date,valid_until,next_eligible_date,
           NULL::numeric AS price_before,NULL::numeric AS price_after,summary,
           source_id,document_id,COALESCE(raw_payload->>'url',raw_payload->>'source_url') AS source_url,
           COALESCE(raw_payload->>'parser_status','complete') AS parser_status,
           COALESCE(raw_payload->>'parser_version','') AS parser_version,raw_payload
      FROM fundamental.convertible_bond_no_revision_history
    UNION ALL
    SELECT NULL::bigint AS fact_id,instrument_id,'price_change'::text AS fact_type,NULL::text AS event_type,
           publish_date AS announced_at,change_date AS effective_date,NULL::date AS valid_until,
           NULL::date AS next_eligible_date,price_before,price_after,reason AS summary,
           source_id,document_id,COALESCE(raw_payload->>'url',raw_payload->>'source_url') AS source_url,
           COALESCE(raw_payload->>'parser_status','complete') AS parser_status,
           COALESCE(raw_payload->>'price_change_parser_version','') AS parser_version,raw_payload
      FROM fundamental.convertible_bond_price_changes;
    CREATE INDEX IF NOT EXISTS idx_cb_no_revision_instrument_date
      ON fundamental.convertible_bond_no_revision_history(instrument_id,announced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cb_price_changes_instrument_date
      ON fundamental.convertible_bond_price_changes(instrument_id,change_date DESC);
  `);
}

// ========== 087：同日强赎公告有效期合并 ==========
// 公司公告与券商核查意见可能同日入库；同日以最长明确“不提前赎回”期限作为统一有效期。
async function migration087ConvertibleBondWaiveSameDayValidity() {
  await pool.query(`
    UPDATE event.convertible_bond_call_events e
       SET no_call_until=v.max_no_call_until,updated_at=now()
      FROM (
        SELECT instrument_id,announced_at,MAX(no_call_until) AS max_no_call_until
          FROM event.convertible_bond_call_events
         WHERE event_type='waive' AND no_call_until IS NOT NULL
         GROUP BY instrument_id,announced_at
      ) v
     WHERE e.instrument_id=v.instrument_id AND e.announced_at=v.announced_at
       AND e.event_type='waive' AND e.no_call_until IS DISTINCT FROM v.max_no_call_until;
  `);
}

// ========== 088：强赎日期事实回填 =============
// 最新提示公告偶尔只更新赎回进度、不重复列出日期；展示层仍应沿用同一转债历史公告中最近的明确日期。
async function migration088ConvertibleBondCallDateFallback() {
  await pool.query(`
    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    WITH event_dates AS (
      SELECT instrument_id,
             MAX(redemption_record_date) AS redemption_record_date,
             MAX(last_trade_date) AS last_trade_date,
             MAX(last_conversion_date) AS last_conversion_date,
             MAX(redemption_price) AS redemption_price
        FROM event.convertible_bond_call_events
       WHERE event_type IN ('exercise','implementation','completion')
       GROUP BY instrument_id
    )
    SELECT r.instrument_id,r.ts_code,r.security_code,r.bond_name,r.stock_instrument_id,
           r.stock_code,r.stock_name,r.current_conv_price,r.trigger_ratio,r.trigger_price,
           r.stock_close,r.distance_to_trigger_pct,r.trade_date,r.matched_days,r.required_days,
           r.observation_days,r.remaining_days,r.calculated_status,r.formula_version,r.diagnostics,
           r.data_status,r.calculated_at,r.event_id,r.official_status,r.announced_at,r.no_call_until,
           CASE WHEN r.official_status IN ('exercise','implementation','completion')
                THEN COALESCE(r.redemption_record_date,d.redemption_record_date)
                ELSE r.redemption_record_date END AS redemption_record_date,
           CASE WHEN r.official_status IN ('exercise','implementation','completion')
                THEN COALESCE(r.last_trade_date,d.last_trade_date)
                ELSE r.last_trade_date END AS last_trade_date,
           CASE WHEN r.official_status IN ('exercise','implementation','completion')
                THEN COALESCE(r.last_conversion_date,d.last_conversion_date)
                ELSE r.last_conversion_date END AS last_conversion_date,
           CASE WHEN r.official_status IN ('exercise','implementation','completion')
                THEN COALESCE(r.redemption_price,d.redemption_price)::numeric(20,8)
                ELSE r.redemption_price END AS redemption_price,
           r.document_id,r.source_url,r.announcement_title,r.announcement_parse_status,
           r.announcement_parser_version,r.announcement_details,r.business_status,
           r.remain_size,r.maturity_date,r.conv_start_date,r.conv_end_date,r.conv_stop_date
      FROM analytics.convertible_bond_call_latest_raw r
      LEFT JOIN event_dates d ON d.instrument_id=r.instrument_id;
  `);
}

// ========== 089：强赎状态按公式版本发布 =============
// 新版全市场计算完成前，旧的个券分析记录不能冒充新版强赎进度；保留证券和公告事实，
// 将旧公式的计算字段清空并标记为 incomplete，等待 call-v1 首次覆盖。
async function migration089ConvertibleBondCallFormulaPublication() {
  const { rows: current } = await pool.query(
    `SELECT 1 FROM pg_views WHERE schemaname='analytics' AND viewname='convertible_bond_call_latest'`
  );
  const { rows: legacy } = await pool.query(
    `SELECT 1 FROM pg_views WHERE schemaname='analytics' AND viewname='convertible_bond_call_latest_legacy'`
  );
  if (current.length && !legacy.length) {
    await pool.query('ALTER VIEW analytics.convertible_bond_call_latest RENAME TO convertible_bond_call_latest_legacy');
  }
  await pool.query(`
    DROP VIEW IF EXISTS analytics.convertible_bond_call_latest;
    CREATE VIEW analytics.convertible_bond_call_latest AS
    SELECT r.instrument_id,r.ts_code,r.security_code,r.bond_name,r.stock_instrument_id,
           r.stock_code,r.stock_name,r.current_conv_price,r.trigger_ratio,
           CASE WHEN r.formula_version='call-v1' THEN r.trigger_price END AS trigger_price,
           CASE WHEN r.formula_version='call-v1' THEN r.stock_close END AS stock_close,
           CASE WHEN r.formula_version='call-v1' THEN r.distance_to_trigger_pct END AS distance_to_trigger_pct,
           CASE WHEN r.formula_version='call-v1' THEN r.trade_date END AS trade_date,
           CASE WHEN r.formula_version='call-v1' THEN r.matched_days END AS matched_days,
           CASE WHEN r.formula_version='call-v1' THEN r.required_days END AS required_days,
           CASE WHEN r.formula_version='call-v1' THEN r.observation_days END AS observation_days,
           CASE WHEN r.formula_version='call-v1' THEN r.remaining_days END AS remaining_days,
           CASE WHEN r.formula_version='call-v1' THEN r.calculated_status ELSE 'unknown' END AS calculated_status,
           CASE WHEN r.formula_version='call-v1' THEN r.formula_version END AS formula_version,
           CASE WHEN r.formula_version='call-v1' THEN r.diagnostics ELSE jsonb_build_object('reason','formula_version_not_published') END AS diagnostics,
           CASE WHEN r.formula_version='call-v1' THEN r.data_status ELSE 'incomplete' END AS data_status,
           CASE WHEN r.formula_version='call-v1' THEN r.calculated_at END AS calculated_at,
           r.event_id,r.official_status,r.announced_at,r.no_call_until,
           r.redemption_record_date,r.last_trade_date,r.last_conversion_date,r.redemption_price,
           r.document_id,r.source_url,r.announcement_title,r.announcement_parse_status,
           r.announcement_parser_version,r.announcement_details,
           CASE
             WHEN r.official_status='completion' THEN 'completed'
             WHEN r.official_status IN ('exercise','implementation') THEN 'announced'
             WHEN r.official_status='waive'
                  AND (r.no_call_until IS NULL OR r.no_call_until >= COALESCE(r.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN r.formula_version='call-v1' THEN r.business_status
             ELSE 'incomplete'
           END AS business_status,
           r.remain_size,r.maturity_date,r.conv_start_date,r.conv_end_date,r.conv_stop_date
      FROM analytics.convertible_bond_call_latest_legacy r;
  `);
}

// ========== 136：可转债到期兑付临期状态与强赎公告状态对齐 =============
// 089 发布公式视图时沿用了旧状态字段，但遗漏了 081 的 maturity_near 派生逻辑；
// 这里在最终公开视图补回临期状态，且保留官方公告优先级。
async function migration136ConvertibleBondRedemptionStatusParity() {
  await pool.query(`
    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    SELECT r.instrument_id,r.ts_code,r.security_code,r.bond_name,r.stock_instrument_id,
           r.stock_code,r.stock_name,r.current_conv_price,r.trigger_ratio,
           CASE WHEN r.formula_version='call-v1' THEN r.trigger_price END AS trigger_price,
           CASE WHEN r.formula_version='call-v1' THEN r.stock_close END AS stock_close,
           CASE WHEN r.formula_version='call-v1' THEN r.distance_to_trigger_pct END AS distance_to_trigger_pct,
           CASE WHEN r.formula_version='call-v1' THEN r.trade_date END AS trade_date,
           CASE WHEN r.formula_version='call-v1' THEN r.matched_days END AS matched_days,
           CASE WHEN r.formula_version='call-v1' THEN r.required_days END AS required_days,
           CASE WHEN r.formula_version='call-v1' THEN r.observation_days END AS observation_days,
           CASE WHEN r.formula_version='call-v1' THEN r.remaining_days END AS remaining_days,
           CASE WHEN r.formula_version='call-v1' THEN r.calculated_status ELSE 'unknown' END AS calculated_status,
           CASE WHEN r.formula_version='call-v1' THEN r.formula_version END AS formula_version,
           CASE WHEN r.formula_version='call-v1' THEN r.diagnostics ELSE jsonb_build_object('reason','formula_version_not_published') END AS diagnostics,
           CASE WHEN r.formula_version='call-v1' THEN r.data_status ELSE 'incomplete' END AS data_status,
           CASE WHEN r.formula_version='call-v1' THEN r.calculated_at END AS calculated_at,
           r.event_id,r.official_status,r.announced_at,r.no_call_until,
           r.redemption_record_date,r.last_trade_date,r.last_conversion_date,r.redemption_price,
           r.document_id,r.source_url,r.announcement_title,r.announcement_parse_status,
           r.announcement_parser_version,r.announcement_details,
           CASE
             WHEN r.official_status='completion' THEN 'completed'
             WHEN r.official_status IN ('exercise','implementation') THEN 'announced'
             WHEN r.official_status='waive'
                  AND (r.no_call_until IS NULL OR r.no_call_until >= COALESCE(r.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN COALESCE(r.data_status,'incomplete') <> 'complete' THEN 'incomplete'
             WHEN r.maturity_date IS NOT NULL
                  AND r.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days')
                  THEN 'maturity_near'
             ELSE r.business_status
           END AS business_status,
           r.remain_size,r.maturity_date,r.conv_start_date,r.conv_end_date,r.conv_stop_date
      FROM analytics.convertible_bond_call_latest_legacy r;
  `);
}

// ========== 137：交易所公告取消内部调用预算 =============
// 上交所、深交所公告接口没有已知的官方分钟/日上限；此前的 60 次/分钟、2000 次/日
// 是本系统自行设置的保护线，会截断公告事实同步并制造重复告警。保留并发槽位，
// 仅取消内部分钟/日计数，真实 HTTP 异常仍由 Guard 处理。
async function migration137ConvertibleBondExchangeAnnouncementUnlimited() {
  await pool.query(`
    UPDATE ops.source_endpoint_policies p
       SET internal_per_minute_limit=NULL,
           internal_daily_limit=NULL,
           min_interval_ms=0,
           notes='交易所公告不使用本系统分钟/日预算；保留并发去重和真实上游异常处理',
           updated_at=now()
      FROM ops.data_sources ds
     WHERE p.source_id=ds.source_id
       AND ds.source_code IN ('sse','szse')
       AND p.api_name='*'
       AND p.credential_profile='anonymous';

    UPDATE ops.source_endpoint_runtime r
       SET next_allowed_at=NULL,
           updated_at=now()
      FROM ops.data_sources ds
     WHERE r.source_id=ds.source_id
       AND ds.source_code IN ('sse','szse');
  `);
}

// ========== 146：可转债派生数据状态边界 =============
// waived 是业务状态，不写入 data_status；数据状态只允许 complete/incomplete/pending，避免两套口径混计。
async function migration146ConvertibleBondDataStatusConstraint() {
  await pool.query(`
    ALTER TABLE analytics.convertible_bond_trigger_daily
      DROP CONSTRAINT IF EXISTS chk_cb_trigger_data_status;
    ALTER TABLE analytics.convertible_bond_trigger_daily
      ADD CONSTRAINT chk_cb_trigger_data_status
      CHECK (data_status IN ('complete','incomplete','pending'));
  `);
}

// ========== 147：可转债强赎公告状态优先级 =============
// warning 只是触发提示，不能覆盖已经公告的提前赎回或到期赎回；否则状态会从“已公告强赎”回退成数学进度“跟踪中”。
// 到期兑付/停止交易公告在同步层归入 implementation，与提前赎回公告统一展示为 announced。
async function migration147ConvertibleBondCallAnnouncementPrecedence() {
  await pool.query(`
    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    WITH latest_decision_event AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,event_id,event_type,announced_at,no_call_until,
             redemption_record_date,last_trade_date,last_conversion_date,
             redemption_price,document_id,source_url,title,parse_status,
             parser_version,details
        FROM event.convertible_bond_call_events
       WHERE event_type IN ('exercise','implementation','waive','completion')
       ORDER BY instrument_id,announced_at DESC,event_id DESC
    )
    SELECT r.instrument_id,r.ts_code,r.security_code,r.bond_name,r.stock_instrument_id,
           r.stock_code,r.stock_name,r.current_conv_price,r.trigger_ratio,
           CASE WHEN r.formula_version='call-v1' THEN r.trigger_price END AS trigger_price,
           CASE WHEN r.formula_version='call-v1' THEN r.stock_close END AS stock_close,
           CASE WHEN r.formula_version='call-v1' THEN r.distance_to_trigger_pct END AS distance_to_trigger_pct,
           CASE WHEN r.formula_version='call-v1' THEN r.trade_date END AS trade_date,
           CASE WHEN r.formula_version='call-v1' THEN r.matched_days END AS matched_days,
           CASE WHEN r.formula_version='call-v1' THEN r.required_days END AS required_days,
           CASE WHEN r.formula_version='call-v1' THEN r.observation_days END AS observation_days,
           CASE WHEN r.formula_version='call-v1' THEN r.remaining_days END AS remaining_days,
           CASE WHEN r.formula_version='call-v1' THEN r.calculated_status ELSE 'unknown' END AS calculated_status,
           CASE WHEN r.formula_version='call-v1' THEN r.formula_version END AS formula_version,
           CASE WHEN r.formula_version='call-v1' THEN r.diagnostics ELSE jsonb_build_object('reason','formula_version_not_published') END AS diagnostics,
           CASE WHEN r.formula_version='call-v1' THEN r.data_status ELSE 'incomplete' END AS data_status,
           CASE WHEN r.formula_version='call-v1' THEN r.calculated_at END AS calculated_at,
           COALESCE(e.event_id,r.event_id) AS event_id,
           COALESCE(e.event_type,r.official_status) AS official_status,
           COALESCE(e.announced_at,r.announced_at) AS announced_at,
           COALESCE(e.no_call_until,r.no_call_until) AS no_call_until,
           COALESCE(e.redemption_record_date,r.redemption_record_date) AS redemption_record_date,
           COALESCE(e.last_trade_date,r.last_trade_date) AS last_trade_date,
           COALESCE(e.last_conversion_date,r.last_conversion_date) AS last_conversion_date,
           COALESCE(e.redemption_price,r.redemption_price) AS redemption_price,
           COALESCE(e.document_id,r.document_id) AS document_id,
           COALESCE(e.source_url,r.source_url) AS source_url,
           COALESCE(e.title,r.announcement_title) AS announcement_title,
           COALESCE(e.parse_status,r.announcement_parse_status) AS announcement_parse_status,
           COALESCE(e.parser_version,r.announcement_parser_version) AS announcement_parser_version,
           COALESCE(e.details,r.announcement_details) AS announcement_details,
           CASE
             WHEN COALESCE(e.event_type,r.official_status)='completion' THEN 'completed'
             WHEN COALESCE(e.event_type,r.official_status) IN ('exercise','implementation') THEN 'announced'
             WHEN COALESCE(e.event_type,r.official_status)='waive'
                  AND (COALESCE(e.no_call_until,r.no_call_until) IS NULL
                       OR COALESCE(e.no_call_until,r.no_call_until) >= COALESCE(r.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN COALESCE(r.data_status,'incomplete') <> 'complete' THEN 'incomplete'
             WHEN r.maturity_date IS NOT NULL
                  AND r.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days')
                  THEN 'maturity_near'
             ELSE r.business_status
           END AS business_status,
           r.remain_size,r.maturity_date,r.conv_start_date,r.conv_end_date,r.conv_stop_date
      FROM analytics.convertible_bond_call_latest_legacy r
      LEFT JOIN latest_decision_event e ON e.instrument_id=r.instrument_id;
  `);
}

// ========== 152：强赎公告正文证据、解析水位与锁定期状态治理 =============
// 公告事实与数学触发进度分离：正式决定事件按公告日截断，锁定期只展示业务豁免，
// 解析不完整或交易日历未覆盖不得伪装成 tracking / met_pending。
async function migration152ConvertibleBondCallEvidenceAndLockState() {
  await pool.query(`
    ALTER TABLE event.convertible_bond_call_events
      ADD COLUMN IF NOT EXISTS decision_date DATE,
      ADD COLUMN IF NOT EXISTS lock_start_date DATE,
      ADD COLUMN IF NOT EXISTS validity_basis TEXT;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_cb_call_validity_basis') THEN
        ALTER TABLE event.convertible_bond_call_events ADD CONSTRAINT ck_cb_call_validity_basis
          CHECK (validity_basis IS NULL OR validity_basis IN
            ('explicit_range','explicit_count_start','duration_from_decision','through_maturity','manual','unknown'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_cb_call_decision_events
      ON event.convertible_bond_call_events(instrument_id,event_type,announced_at DESC,parser_version);

    DROP VIEW IF EXISTS analytics.convertible_bond_call_latest;
    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    WITH latest_decision_event AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,event_id,event_type,announced_at,decision_date,lock_start_date,no_call_until,validity_basis,
             redemption_record_date,last_trade_date,last_conversion_date,redemption_price,document_id,source_url,title,
             parse_status,parser_version,details
        FROM event.convertible_bond_call_events
       WHERE event_type IN ('exercise','implementation','waive','completion')
       ORDER BY instrument_id,announced_at DESC,event_id DESC
    ), event_state AS (
      SELECT r.*,
             e.event_id AS decision_event_id,e.event_type AS decision_event_type,e.announced_at AS decision_announced_at,
             e.decision_date,e.lock_start_date,e.no_call_until AS decision_no_call_until,e.validity_basis,
             e.redemption_record_date AS decision_redemption_record_date,e.last_trade_date AS decision_last_trade_date,
             e.last_conversion_date AS decision_last_conversion_date,e.redemption_price AS decision_redemption_price,
             e.document_id AS decision_document_id,e.source_url AS decision_source_url,e.title AS decision_title,
             e.parse_status AS decision_parse_status,e.parser_version AS decision_parser_version,e.details AS decision_details,
             COALESCE(e.no_call_until,
               CASE WHEN e.validity_basis='through_maturity' THEN r.maturity_date END) AS effective_no_call_until
        FROM analytics.convertible_bond_call_latest_legacy r
        LEFT JOIN latest_decision_event e ON e.instrument_id=r.instrument_id
    ), calendar_state AS (
      SELECT s.*, next_calendar.next_count_start_date,
             CASE
               WHEN s.decision_event_type <> 'waive' THEN 'not_applicable'
               WHEN s.effective_no_call_until IS NULL THEN 'not_covered'
               WHEN next_calendar.next_count_start_date IS NOT NULL THEN 'covered'
               ELSE 'not_covered'
             END AS derived_calendar_status
        FROM event_state s
        LEFT JOIN LATERAL (
          SELECT COALESCE(
                   CASE
                     WHEN s.decision_details->>'next_count_start_date' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
                      AND EXISTS (
                        SELECT 1 FROM market.trade_calendar explicit_tc
                         WHERE explicit_tc.exchange='SSE' AND explicit_tc.is_open
                           AND explicit_tc.trade_date=(s.decision_details->>'next_count_start_date')::date
                      )
                     THEN (s.decision_details->>'next_count_start_date')::date
                   END,
                   MIN(tc.trade_date)::date
                 ) AS next_count_start_date
            FROM market.trade_calendar tc
           WHERE tc.exchange='SSE' AND tc.is_open
             AND s.effective_no_call_until IS NOT NULL
             AND tc.trade_date > s.effective_no_call_until
        ) next_calendar ON true
    )
    SELECT s.instrument_id,s.ts_code,s.security_code,s.bond_name,s.stock_instrument_id,
           s.stock_code,s.stock_name,s.current_conv_price,s.trigger_ratio,
           CASE WHEN s.formula_version='call-v1' THEN s.trigger_price END AS trigger_price,
           CASE WHEN s.formula_version='call-v1' THEN s.stock_close END AS stock_close,
           CASE WHEN s.formula_version='call-v1' THEN s.distance_to_trigger_pct END AS distance_to_trigger_pct,
           CASE WHEN s.formula_version='call-v1' THEN s.trade_date END AS trade_date,
           CASE WHEN s.formula_version='call-v1' THEN s.matched_days END AS matched_days,
           CASE WHEN s.formula_version='call-v1' THEN s.required_days END AS required_days,
           CASE WHEN s.formula_version='call-v1' THEN s.observation_days END AS observation_days,
           CASE WHEN s.formula_version='call-v1' THEN s.remaining_days END AS remaining_days,
           CASE WHEN s.formula_version='call-v1' THEN s.calculated_status ELSE 'unknown' END AS calculated_status,
           CASE WHEN s.formula_version='call-v1' THEN s.formula_version END AS formula_version,
           CASE WHEN s.formula_version='call-v1' THEN s.diagnostics ELSE jsonb_build_object('reason','formula_version_not_published') END AS diagnostics,
           CASE WHEN s.formula_version='call-v1' THEN s.data_status ELSE 'incomplete' END AS data_status,
           CASE WHEN s.formula_version='call-v1' THEN s.calculated_at END AS calculated_at,
           COALESCE(s.decision_event_id,s.event_id) AS event_id,
           COALESCE(s.decision_event_type,s.official_status) AS official_status,
           COALESCE(s.decision_announced_at,s.announced_at) AS announced_at,
           s.effective_no_call_until AS no_call_until,
           COALESCE(s.decision_redemption_record_date,s.redemption_record_date) AS redemption_record_date,
           COALESCE(s.decision_last_trade_date,s.last_trade_date) AS last_trade_date,
           COALESCE(s.decision_last_conversion_date,s.last_conversion_date) AS last_conversion_date,
           COALESCE(s.decision_redemption_price,s.redemption_price) AS redemption_price,
           COALESCE(s.decision_document_id,s.document_id) AS document_id,
           COALESCE(s.decision_source_url,s.source_url) AS source_url,
           COALESCE(s.decision_title,s.announcement_title) AS announcement_title,
           COALESCE(s.decision_parse_status,s.announcement_parse_status) AS announcement_parse_status,
           COALESCE(s.decision_parser_version,s.announcement_parser_version) AS announcement_parser_version,
           COALESCE(s.decision_details,s.announcement_details) AS announcement_details,
           CASE
             WHEN COALESCE(s.decision_event_type,s.official_status)='completion' THEN 'completed'
             WHEN COALESCE(s.decision_event_type,s.official_status) IN ('exercise','implementation') THEN 'announced'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND (s.effective_no_call_until IS NULL OR s.effective_no_call_until >= COALESCE(s.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial') <> 'complete' THEN 'incomplete'
             WHEN COALESCE(s.data_status,'incomplete') <> 'complete' THEN 'incomplete'
             WHEN s.maturity_date IS NOT NULL
                  AND s.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days')
                  THEN 'maturity_near'
             ELSE s.business_status
           END AS business_status,
           s.remain_size,s.maturity_date,s.conv_start_date,s.conv_end_date,s.conv_stop_date,
           s.decision_date,s.lock_start_date,s.validity_basis,s.next_count_start_date,
           s.derived_calendar_status AS calendar_status,
           CASE
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial') <> 'complete'
                  AND s.effective_no_call_until IS NULL THEN '已公告不强赎，期限待确认'
             WHEN s.derived_calendar_status='not_covered'
                  AND s.effective_no_call_until IS NOT NULL
                  AND COALESCE(s.trade_date,CURRENT_DATE) > s.effective_no_call_until THEN '截止日后的交易日历尚未覆盖'
             ELSE NULL
           END AS data_quality_reason
      FROM calendar_state s;
  `);
}

// ========== 153：转股期前状态与部分公告质量门禁 =============
// 转股期开始前不应计算强赎触发进度；解析不完整的“行使/实施”事件也不能直接覆盖为已公告强赎。
async function migration153ConvertibleBondCallPreConversionStatus() {
  await pool.query(`
    UPDATE event.convertible_bond_call_events
       SET parse_status='failed',
           details=COALESCE(details,'{}'::jsonb)||jsonb_build_object(
             'quality_reason','non_bond_finance_redemption',
             'reclassified_at',CURRENT_DATE::text),
           updated_at=now()
     WHERE event_type IN ('exercise','implementation')
       AND title ~ '(现金管理|理财产品|结构性存款|闲置自有资金|委托理财)'
       AND title !~ '(可转债|转债|债券代码|最后交易日|最后转股日|赎回登记日|转股价|转股期)';

    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    WITH latest_decision_event AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,event_id,event_type,announced_at,decision_date,lock_start_date,no_call_until,validity_basis,
             redemption_record_date,last_trade_date,last_conversion_date,redemption_price,document_id,source_url,title,
             parse_status,parser_version,details
        FROM event.convertible_bond_call_events
       WHERE event_type IN ('exercise','implementation','waive','completion')
       ORDER BY instrument_id,announced_at DESC,event_id DESC
    ), event_state AS (
      SELECT r.*,
             e.event_id AS decision_event_id,e.event_type AS decision_event_type,e.announced_at AS decision_announced_at,
             e.decision_date,e.lock_start_date,e.no_call_until AS decision_no_call_until,e.validity_basis,
             e.redemption_record_date AS decision_redemption_record_date,e.last_trade_date AS decision_last_trade_date,
             e.last_conversion_date AS decision_last_conversion_date,e.redemption_price AS decision_redemption_price,
             e.document_id AS decision_document_id,e.source_url AS decision_source_url,e.title AS decision_title,
             e.parse_status AS decision_parse_status,e.parser_version AS decision_parser_version,e.details AS decision_details,
             COALESCE(e.no_call_until,
               CASE WHEN e.validity_basis='through_maturity' THEN r.maturity_date END) AS effective_no_call_until
        FROM analytics.convertible_bond_call_latest_legacy r
        LEFT JOIN latest_decision_event e ON e.instrument_id=r.instrument_id
    ), calendar_state AS (
      SELECT s.*, next_calendar.next_count_start_date,
             CASE
               WHEN s.decision_event_type <> 'waive' THEN 'not_applicable'
               WHEN s.effective_no_call_until IS NULL THEN 'not_covered'
               WHEN next_calendar.next_count_start_date IS NOT NULL THEN 'covered'
               ELSE 'not_covered'
             END AS derived_calendar_status
        FROM event_state s
        LEFT JOIN LATERAL (
          SELECT COALESCE(
                   CASE
                     WHEN s.decision_details->>'next_count_start_date' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
                      AND EXISTS (
                        SELECT 1 FROM market.trade_calendar explicit_tc
                         WHERE explicit_tc.exchange='SSE' AND explicit_tc.is_open
                           AND explicit_tc.trade_date=(s.decision_details->>'next_count_start_date')::date
                      )
                     THEN (s.decision_details->>'next_count_start_date')::date
                   END,
                   MIN(tc.trade_date)::date
                 ) AS next_count_start_date
            FROM market.trade_calendar tc
           WHERE tc.exchange='SSE' AND tc.is_open
             AND s.effective_no_call_until IS NOT NULL
             AND tc.trade_date > s.effective_no_call_until
        ) next_calendar ON true
    )
    SELECT s.instrument_id,s.ts_code,s.security_code,s.bond_name,s.stock_instrument_id,
           s.stock_code,s.stock_name,s.current_conv_price,s.trigger_ratio,
           CASE WHEN s.formula_version='call-v1' THEN s.trigger_price END AS trigger_price,
           CASE WHEN s.formula_version='call-v1' THEN s.stock_close END AS stock_close,
           CASE WHEN s.formula_version='call-v1' THEN s.distance_to_trigger_pct END AS distance_to_trigger_pct,
           CASE WHEN s.formula_version='call-v1' THEN s.trade_date END AS trade_date,
           CASE WHEN s.formula_version='call-v1' THEN s.matched_days END AS matched_days,
           CASE WHEN s.formula_version='call-v1' THEN s.required_days END AS required_days,
           CASE WHEN s.formula_version='call-v1' THEN s.observation_days END AS observation_days,
           CASE WHEN s.formula_version='call-v1' THEN s.remaining_days END AS remaining_days,
           CASE WHEN s.formula_version='call-v1' THEN s.calculated_status ELSE 'unknown' END AS calculated_status,
           CASE WHEN s.formula_version='call-v1' THEN s.formula_version END AS formula_version,
           CASE WHEN s.formula_version='call-v1' THEN
                  CASE WHEN s.conv_start_date IS NOT NULL AND COALESCE(s.trade_date,CURRENT_DATE) < s.conv_start_date
                       THEN COALESCE(s.diagnostics,'{}'::jsonb) || jsonb_build_object('pre_conversion',true,'conversion_start_date',s.conv_start_date)
                       ELSE s.diagnostics END
                ELSE jsonb_build_object('reason','formula_version_not_published') END AS diagnostics,
           CASE WHEN s.formula_version='call-v1' THEN s.data_status ELSE 'incomplete' END AS data_status,
           CASE WHEN s.formula_version='call-v1' THEN s.calculated_at END AS calculated_at,
           COALESCE(s.decision_event_id,s.event_id) AS event_id,
           COALESCE(s.decision_event_type,s.official_status) AS official_status,
           COALESCE(s.decision_announced_at,s.announced_at) AS announced_at,
           s.effective_no_call_until AS no_call_until,
           COALESCE(s.decision_redemption_record_date,s.redemption_record_date) AS redemption_record_date,
           COALESCE(s.decision_last_trade_date,s.last_trade_date) AS last_trade_date,
           COALESCE(s.decision_last_conversion_date,s.last_conversion_date) AS last_conversion_date,
           COALESCE(s.decision_redemption_price,s.redemption_price) AS redemption_price,
           COALESCE(s.decision_document_id,s.document_id) AS document_id,
           COALESCE(s.decision_source_url,s.source_url) AS source_url,
           COALESCE(s.decision_title,s.announcement_title) AS announcement_title,
           COALESCE(s.decision_parse_status,s.announcement_parse_status) AS announcement_parse_status,
           COALESCE(s.decision_parser_version,s.announcement_parser_version) AS announcement_parser_version,
           COALESCE(s.decision_details,s.announcement_details) AS announcement_details,
           CASE
             WHEN COALESCE(s.decision_event_type,s.official_status)='completion' THEN 'completed'
             WHEN s.conv_start_date IS NOT NULL AND COALESCE(s.trade_date,CURRENT_DATE) < s.conv_start_date THEN 'not_active'
             WHEN COALESCE(s.decision_event_type,s.official_status) IN ('exercise','implementation')
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial')='complete' THEN 'announced'
             WHEN COALESCE(s.decision_event_type,s.official_status) IN ('exercise','implementation') THEN 'incomplete'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND (s.effective_no_call_until IS NULL OR s.effective_no_call_until >= COALESCE(s.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial') <> 'complete' THEN 'incomplete'
             WHEN COALESCE(s.data_status,'incomplete') <> 'complete' THEN 'incomplete'
             WHEN s.maturity_date IS NOT NULL
                  AND s.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days')
                  THEN 'maturity_near'
             ELSE s.business_status
           END AS business_status,
           s.remain_size,s.maturity_date,s.conv_start_date,s.conv_end_date,s.conv_stop_date,
           s.decision_date,s.lock_start_date,s.validity_basis,s.next_count_start_date,
           s.derived_calendar_status AS calendar_status,
           CASE
             WHEN s.conv_start_date IS NOT NULL AND COALESCE(s.trade_date,CURRENT_DATE) < s.conv_start_date THEN '尚未进入转股期'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial') <> 'complete'
                  AND s.effective_no_call_until IS NULL THEN '已公告不强赎，期限待确认'
             WHEN s.derived_calendar_status='not_covered'
                  AND s.effective_no_call_until IS NOT NULL
                  AND COALESCE(s.trade_date,CURRENT_DATE) > s.effective_no_call_until THEN '截止日后的交易日历尚未覆盖'
             ELSE NULL
           END AS data_quality_reason
      FROM calendar_state s;
  `);
}

// 版本化迁移执行器：只跑 schema_migrations 里没有记录过的步骤
// ========== 168：到期兑付与提前强赎语义区分 ==========
// 强赎公告里“正常到期兑付”和“提前强赎”都曾被归入 announced 并提示“已公告强赎”。
// 按标题把三类语义（early 提前强赎 / maturity 正常到期 / unconfirmed 未确认）写入
// details.call_kind，并让状态视图输出 maturity_redeem / redemption_unconfirmed 独立状态，
// 页面提示不再把到期兑付叫成强赎（2026-10-21 审查 P-6）。
async function migration168CallEventKindSemantics() {
  const { classifyCallKind } = require('../../services/convertibleBondRedemptionSync');
  const { rows } = await pool.query(
    `SELECT event_id,event_type,title,details FROM event.convertible_bond_call_events
      WHERE event_type IN ('exercise','implementation','completion')`
  );
  for (const row of rows) {
    const kind = classifyCallKind(row.title, row.event_type);
    if (!kind) continue;
    const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details : {};
    if (details.call_kind === kind) continue;
    await pool.query(
      `UPDATE event.convertible_bond_call_events SET details=$2::jsonb,updated_at=now() WHERE event_id=$1`,
      [row.event_id, JSON.stringify({ ...details, call_kind: kind })]
    );
  }
  // 基于迁移153 的完整视图定义重建，只把 exercise/implementation 的 complete 分支按 call_kind 拆分；
  // 不得回退 147/152/153 的公告优先级、锁定期与转股期前状态逻辑。
  await pool.query(`
    CREATE OR REPLACE VIEW analytics.convertible_bond_call_latest AS
    WITH latest_decision_event AS (
      SELECT DISTINCT ON (instrument_id)
             instrument_id,event_id,event_type,announced_at,decision_date,lock_start_date,no_call_until,validity_basis,
             redemption_record_date,last_trade_date,last_conversion_date,redemption_price,document_id,source_url,title,
             parse_status,parser_version,details
        FROM event.convertible_bond_call_events
       WHERE event_type IN ('exercise','implementation','waive','completion')
       ORDER BY instrument_id,announced_at DESC,event_id DESC
    ), event_state AS (
      SELECT r.*,
             e.event_id AS decision_event_id,e.event_type AS decision_event_type,e.announced_at AS decision_announced_at,
             e.decision_date,e.lock_start_date,e.no_call_until AS decision_no_call_until,e.validity_basis,
             e.redemption_record_date AS decision_redemption_record_date,e.last_trade_date AS decision_last_trade_date,
             e.last_conversion_date AS decision_last_conversion_date,e.redemption_price AS decision_redemption_price,
             e.document_id AS decision_document_id,e.source_url AS decision_source_url,e.title AS decision_title,
             e.parse_status AS decision_parse_status,e.parser_version AS decision_parser_version,e.details AS decision_details,
             COALESCE(e.no_call_until,
               CASE WHEN e.validity_basis='through_maturity' THEN r.maturity_date END) AS effective_no_call_until
        FROM analytics.convertible_bond_call_latest_legacy r
        LEFT JOIN latest_decision_event e ON e.instrument_id=r.instrument_id
    ), calendar_state AS (
      SELECT s.*, next_calendar.next_count_start_date,
             CASE
               WHEN s.decision_event_type <> 'waive' THEN 'not_applicable'
               WHEN s.effective_no_call_until IS NULL THEN 'not_covered'
               WHEN next_calendar.next_count_start_date IS NOT NULL THEN 'covered'
               ELSE 'not_covered'
             END AS derived_calendar_status
        FROM event_state s
        LEFT JOIN LATERAL (
          SELECT COALESCE(
                   CASE
                     WHEN s.decision_details->>'next_count_start_date' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
                      AND EXISTS (
                        SELECT 1 FROM market.trade_calendar explicit_tc
                         WHERE explicit_tc.exchange='SSE' AND explicit_tc.is_open
                           AND explicit_tc.trade_date=(s.decision_details->>'next_count_start_date')::date
                      )
                     THEN (s.decision_details->>'next_count_start_date')::date
                   END,
                   MIN(tc.trade_date)::date
                 ) AS next_count_start_date
            FROM market.trade_calendar tc
           WHERE tc.exchange='SSE' AND tc.is_open
             AND s.effective_no_call_until IS NOT NULL
             AND tc.trade_date > s.effective_no_call_until
        ) next_calendar ON true
    )
    SELECT s.instrument_id,s.ts_code,s.security_code,s.bond_name,s.stock_instrument_id,
           s.stock_code,s.stock_name,s.current_conv_price,s.trigger_ratio,
           CASE WHEN s.formula_version='call-v1' THEN s.trigger_price END AS trigger_price,
           CASE WHEN s.formula_version='call-v1' THEN s.stock_close END AS stock_close,
           CASE WHEN s.formula_version='call-v1' THEN s.distance_to_trigger_pct END AS distance_to_trigger_pct,
           CASE WHEN s.formula_version='call-v1' THEN s.trade_date END AS trade_date,
           CASE WHEN s.formula_version='call-v1' THEN s.matched_days END AS matched_days,
           CASE WHEN s.formula_version='call-v1' THEN s.required_days END AS required_days,
           CASE WHEN s.formula_version='call-v1' THEN s.observation_days END AS observation_days,
           CASE WHEN s.formula_version='call-v1' THEN s.remaining_days END AS remaining_days,
           CASE WHEN s.formula_version='call-v1' THEN s.calculated_status ELSE 'unknown' END AS calculated_status,
           CASE WHEN s.formula_version='call-v1' THEN s.formula_version END AS formula_version,
           CASE WHEN s.formula_version='call-v1' THEN
                  CASE WHEN s.conv_start_date IS NOT NULL AND COALESCE(s.trade_date,CURRENT_DATE) < s.conv_start_date
                       THEN COALESCE(s.diagnostics,'{}'::jsonb) || jsonb_build_object('pre_conversion',true,'conversion_start_date',s.conv_start_date)
                       ELSE s.diagnostics END
                ELSE jsonb_build_object('reason','formula_version_not_published') END AS diagnostics,
           CASE WHEN s.formula_version='call-v1' THEN s.data_status ELSE 'incomplete' END AS data_status,
           CASE WHEN s.formula_version='call-v1' THEN s.calculated_at END AS calculated_at,
           COALESCE(s.decision_event_id,s.event_id) AS event_id,
           COALESCE(s.decision_event_type,s.official_status) AS official_status,
           COALESCE(s.decision_announced_at,s.announced_at) AS announced_at,
           s.effective_no_call_until AS no_call_until,
           COALESCE(s.decision_redemption_record_date,s.redemption_record_date) AS redemption_record_date,
           COALESCE(s.decision_last_trade_date,s.last_trade_date) AS last_trade_date,
           COALESCE(s.decision_last_conversion_date,s.last_conversion_date) AS last_conversion_date,
           COALESCE(s.decision_redemption_price,s.redemption_price) AS redemption_price,
           COALESCE(s.decision_document_id,s.document_id) AS document_id,
           COALESCE(s.decision_source_url,s.source_url) AS source_url,
           COALESCE(s.decision_title,s.announcement_title) AS announcement_title,
           COALESCE(s.decision_parse_status,s.announcement_parse_status) AS announcement_parse_status,
           COALESCE(s.decision_parser_version,s.announcement_parser_version) AS announcement_parser_version,
           COALESCE(s.decision_details,s.announcement_details) AS announcement_details,
           CASE
             WHEN COALESCE(s.decision_event_type,s.official_status)='completion' THEN 'completed'
             WHEN s.conv_start_date IS NOT NULL AND COALESCE(s.trade_date,CURRENT_DATE) < s.conv_start_date THEN 'not_active'
             WHEN COALESCE(s.decision_event_type,s.official_status) IN ('exercise','implementation')
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial')='complete'
                  THEN CASE COALESCE(s.decision_details,s.announcement_details)->>'call_kind'
                         WHEN 'maturity' THEN 'maturity_redeem'
                         WHEN 'unconfirmed' THEN 'redemption_unconfirmed'
                         ELSE 'announced'
                       END
             WHEN COALESCE(s.decision_event_type,s.official_status) IN ('exercise','implementation') THEN 'incomplete'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND (s.effective_no_call_until IS NULL OR s.effective_no_call_until >= COALESCE(s.trade_date,CURRENT_DATE)) THEN 'waived'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial') <> 'complete' THEN 'incomplete'
             WHEN COALESCE(s.data_status,'incomplete') <> 'complete' THEN 'incomplete'
             WHEN s.maturity_date IS NOT NULL
                  AND s.maturity_date <= ((SELECT COALESCE(MAX(trade_date),CURRENT_DATE)
                                             FROM market.convertible_bond_daily_metrics) + INTERVAL '30 days')
                  THEN 'maturity_near'
             ELSE s.business_status
           END AS business_status,
           s.remain_size,s.maturity_date,s.conv_start_date,s.conv_end_date,s.conv_stop_date,
           s.decision_date,s.lock_start_date,s.validity_basis,s.next_count_start_date,
           s.derived_calendar_status AS calendar_status,
           CASE
             WHEN s.conv_start_date IS NOT NULL AND COALESCE(s.trade_date,CURRENT_DATE) < s.conv_start_date THEN '尚未进入转股期'
             WHEN COALESCE(s.decision_event_type,s.official_status)='waive'
                  AND COALESCE(s.decision_parse_status,s.announcement_parse_status,'partial') <> 'complete'
                  AND s.effective_no_call_until IS NULL THEN '已公告不强赎，期限待确认'
             WHEN s.derived_calendar_status='not_covered'
                  AND s.effective_no_call_until IS NOT NULL
                  AND COALESCE(s.trade_date,CURRENT_DATE) > s.effective_no_call_until THEN '截止日后的交易日历尚未覆盖'
             ELSE NULL
           END AS data_quality_reason
      FROM calendar_state s;
  `);
}

module.exports = {
  migration058ConvertibleBondIssueUnified,
  migration077ConvertibleBondListMetrics,
  migration079ConvertibleBondRedemption,
  migration080ConvertibleBondRedemptionQuality,
  migration081ConvertibleBondRedemptionUnifiedStatus,
  migration082StockSuspensionCalendar,
  migration083ConvertibleBondCallLifecycle,
  migration084ConvertibleBondCallLifecycleCurrentDate,
  migration085ConvertibleBondWaiveAnnouncementStatus,
  migration086ConvertibleBondAnnouncementHistoryView,
  migration087ConvertibleBondWaiveSameDayValidity,
  migration088ConvertibleBondCallDateFallback,
  migration089ConvertibleBondCallFormulaPublication,
  migration136ConvertibleBondRedemptionStatusParity,
  migration137ConvertibleBondExchangeAnnouncementUnlimited,
  migration146ConvertibleBondDataStatusConstraint,
  migration147ConvertibleBondCallAnnouncementPrecedence,
  migration152ConvertibleBondCallEvidenceAndLockState,
  migration153ConvertibleBondCallPreConversionStatus,
  migration168CallEventKindSemantics,
};
