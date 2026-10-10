const CoreDate = require('../../public/shared/core-date');

async function migrateCashFlowContract(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE cash_flows
      ADD COLUMN IF NOT EXISTS flow_type text NOT NULL DEFAULT 'external_transfer',
      ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed',
      ADD COLUMN IF NOT EXISTS settled_at timestamptz,
      ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CNY',
      ADD COLUMN IF NOT EXISTS original_amount numeric(24,6),
      ADD COLUMN IF NOT EXISTS amount_cny numeric(24,6),
      ADD COLUMN IF NOT EXISTS instrument_id bigint REFERENCES core.instruments(instrument_id),
      ADD COLUMN IF NOT EXISTS event_key text,
      ADD COLUMN IF NOT EXISTS anchor_date date,
      ADD COLUMN IF NOT EXISTS source_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'legacy',
      ADD COLUMN IF NOT EXISTS calculation_version text,
      ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
      ALTER TABLE cash_flows ADD CONSTRAINT cash_flow_type_check
        CHECK(flow_type IN ('external_transfer','dividend','dividend_tax','repo_interest','repo_fee'));
      ALTER TABLE cash_flows ADD CONSTRAINT cash_flow_origin_check CHECK(origin IN ('manual','imported','system'));
      ALTER TABLE cash_flows ADD CONSTRAINT cash_flow_status_check CHECK(status IN ('confirmed','estimated','revoked'));
      ALTER TABLE cash_flows ADD CONSTRAINT cash_flow_system_identity_check
        CHECK(origin <> 'system' OR (event_key IS NOT NULL AND anchor_date IS NOT NULL AND account_id IS NOT NULL));
      CREATE UNIQUE INDEX cash_flow_event_unique ON cash_flows(account_id,event_key,flow_type)
        WHERE event_key IS NOT NULL AND status <> 'revoked';
      CREATE INDEX cash_flow_account_date_idx ON cash_flows(account_id,date);
      CREATE TABLE cash_flow_revisions (
        revision_id bigserial PRIMARY KEY,
        account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        flow_id text NOT NULL, event_key text NOT NULL, revision integer NOT NULL,
        before_value jsonb, after_value jsonb, reason text NOT NULL,
        actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(account_id,flow_id,revision)
      );`);
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function migrateCashFlowDatePrecision(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE cash_flows IN ACCESS EXCLUSIVE MODE');
    const before = (await client.query('SELECT id,date::text,amount::numeric(24,6)::text FROM cash_flows ORDER BY username,account_name,id')).rows;
    const invalid = before.filter(r => !CoreDate.normalizeBusinessDate(r.date));
    if (invalid.length) throw new Error(`现金流水日期迁移阻断：${invalid.length} 条无效日期，须保留原值并定向核验`);
    await client.query(`ALTER TABLE cash_flows ALTER COLUMN date DROP DEFAULT;
      ALTER TABLE cash_flows ALTER COLUMN date TYPE date USING date::date,
      ALTER COLUMN amount TYPE numeric(24,6) USING amount::numeric(24,6)`);
    const after = (await client.query('SELECT id,date::text,amount::text FROM cash_flows ORDER BY username,account_name,id')).rows;
    if (before.length !== after.length || before.some((r,i) => r.id !== after[i].id || r.date !== after[i].date || r.amount !== after[i].amount)) {
      throw new Error('现金流水迁移前后行数、日期或金额不一致');
    }
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function migrateCashIncomePolicy(pool) {
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cash_income_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS cash_income_state jsonb NOT NULL DEFAULT '{}'::jsonb`);
}
async function migrateCashIncomeSources(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS market.repo_daily_rates (
    instrument_id bigint NOT NULL REFERENCES core.instruments(instrument_id), trade_date date NOT NULL,
    source_id smallint NOT NULL REFERENCES ops.data_sources(source_id), tenor_days integer NOT NULL CHECK(tenor_days>0),
    weighted_annual_rate numeric(18,10) NOT NULL,close_annual_rate numeric(18,10) NOT NULL,
    unit text NOT NULL CHECK(unit='annual_decimal'),source_revision text NOT NULL,
    raw_record_id bigint REFERENCES ops.raw_records(raw_record_id),quality_status text NOT NULL CHECK(quality_status IN ('passed','rejected')),
    ingested_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(instrument_id,trade_date,source_id),
    CHECK(weighted_annual_rate::text NOT IN ('NaN','Infinity','-Infinity')),
    CHECK(close_annual_rate::text NOT IN ('NaN','Infinity','-Infinity')));
    CREATE INDEX IF NOT EXISTS repo_daily_date ON market.repo_daily_rates(trade_date);
    CREATE TABLE IF NOT EXISTS account_cash_income_pending (
      account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,pending_key text NOT NULL,
      code text,event_key text,reason text NOT NULL,state text NOT NULL CHECK(state IN ('pending','resolved','excluded_by_user','source_blocked')),
      first_seen_at timestamptz NOT NULL DEFAULT now(),last_attempt_at timestamptz NOT NULL DEFAULT now(),next_attempt_at timestamptz,
      resolved_at timestamptz,input_version integer,evidence jsonb NOT NULL DEFAULT '{}',user_reason text,
      PRIMARY KEY(account_id,pending_key));
    CREATE TABLE IF NOT EXISTS account_cash_income_pending_audit (
      id bigserial PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      pending_key text NOT NULL,before_value jsonb,after_value jsonb NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO ops.source_endpoint_policies(source_id,api_name,credential_profile,max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,official_doc_url,notes)
      SELECT source_id,'repo_daily',p.profile,1,0,2000,30000,'preserve_last_success','https://tushare.pro/document/2?doc_id=256',
      '官方2000积分；weight/close百分数转年化小数；内部额度为空'
      FROM ops.data_sources CROSS JOIN (VALUES('primary'),('backup')) p(profile) WHERE source_code IN ('tushare','tushare_backup')
      ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING;`);
}
module.exports = { migrateCashFlowContract, migrateCashFlowDatePrecision, migrateCashIncomePolicy,migrateCashIncomeSources };
