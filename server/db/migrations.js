// 迁移注册表与迁移引擎（R-6 拆分后）：迁移函数体按域放在 ./migrations/ 各模块，
// 本文件只负责①注册执行顺序（MIGRATIONS，顺序=语义契约，禁止重排）②迁移引擎③对外导出面。
// 拆分于 2026-10-21（审查 R-6）：单文件 7,858 行是合并冲突热点；拆分后函数体零改动。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');
const { seedBrokers } = require('./brokers');
const { migrateAccountsTable } = require('./accounts');

const M = Object.assign({},
  require('./migrations/era01CoreSchema'),
  require('./migrations/era02PlatformOps'),
  require('./migrations/era03ConvertibleBond'),
  require('./migrations/era04ConvertibleBondRevision'),
  require('./migrations/era05DataIdentity'),
  require('./migrations/era06ChannelsAnalytics'),
  require('./migrations/era07Feedback'),
  require('./migrations/era08Notifications'),
);

const MIGRATIONS = [
  { version: '001_init', up: M.migration001Init },
  { version: '002_bond_safety_snapshots', up: M.migration002BondSafetySnapshots },
  { version: '003_market_data_cache', up: M.migration003MarketDataCache },
  { version: '004_bond_safety_financial_cache', up: M.migration004BondSafetyFinancialCache },
  { version: '005_stock_analysis', up: M.migration005StockAnalysis },
  { version: '006_stock_analysis_overview', up: M.migration006StockAnalysisOverview },
  { version: '007_financial_data_architecture', up: M.migration007FinancialDataArchitecture },
  { version: '008_drop_legacy_stock_analysis_tables', up: M.migration008DropLegacyStockAnalysisTables },
  { version: '009_valuation_data_quality', up: M.migration009ValuationDataQuality },
  { version: '010_convertible_bond_analysis', up: M.migration010ConvertibleBondAnalysis },
  { version: '011_ipo_tracking_storage', up: M.migration011IpoTrackingStorage },
  { version: '012_knowledge_articles', up: M.migration012KnowledgeArticles },
  { version: '013_knowledge_permission', up: M.migration013KnowledgePermission },
  { version: '014_nested_comments', up: M.migration014NestedComments },
  { version: '015_comment_author', up: M.migration015CommentAuthor },
  { version: '016_article_author_nullable', up: M.migration016ArticleAuthorNullable },
  { version: '017_knowledge_constraints', up: M.migration017KnowledgeConstraints },
  { version: '018_seed_default_categories', up: M.migration018SeedDefaultCategories },
  { version: '019_knowledge_constraints_verify', up: M.migration019KnowledgeConstraintsVerify },
  { version: '020_knowledge_category_ownership', up: M.migration020KnowledgeCategoryOwnership },
  { version: '021_convertible_bond_cycle', up: M.migration021ConvertibleBondCycle },
  { version: '022_convertible_bond_valuation', up: M.migration022ConvertibleBondValuation },
  { version: '023_valuation_constraints', up: M.migration023ValuationConstraints },
  { version: '024_valuation_alert_reentry', up: M.migration024ValuationAlertReentry },
  { version: '025_market_volatility', up: M.migration025MarketVolatility },
  { version: '026_index_valuation_history', up: M.migration026IndexValuationHistory },
  { version: '027_article_sort_order', up: M.migration027ArticleSortOrder },
  { version: '028_article_global_sort_order', up: M.migration028ArticleGlobalSortOrder },
  { version: '029_market_cycle_metrics', up: M.migration029MarketCycleMetrics },
  { version: '030_market_cycle_home_setting', up: M.migration030MarketCycleHomeSetting },
  { version: '031_bond_unified', up: M.migration031BondUnified },
  { version: '032_bond_safety_structured', up: M.migration032BondSafetyStructured },
  { version: '033_stock_unified', up: M.migration033StockUnified },
  { version: '034_bond_profile_list_date', up: M.migration034BondProfileListDate },
  { version: '035_bond_unified_stk_fallback', up: M.migration035BondUnifiedStkFallback },
  { version: '036_position_comparison', up: M.migration036PositionComparison },
  { version: '037_backfill_position_instrument_ids', up: M.migration037BackfillPositionInstrumentIds },
  { version: '038_data_architecture_cleanup', up: M.migration038DataArchitectureCleanup },
  { version: '039_account_hk_rate_updated_at', up: M.migration039AccountHkRateUpdatedAt },
  { version: '040_nav_history_backup', up: M.migration040NavHistoryBackup },
  { version: '041_account_data_source', up: M.migration041AccountDataSource },
  { version: '042_trade_fields', up: M.migration042TradeFields },
  { version: '043_position_cost', up: M.migration043PositionCost },
  { version: '044_nav_cash_boundary', up: M.migration044NavCashBoundary },
  { version: '045_nav_snapshot_at', up: M.migration045NavSnapshotAt },
  { version: '046_position_events', up: M.migration046PositionEvents },
  { version: '047_account_id_fk', up: M.migration047AccountId },
  { version: '048_tighten_account_ledger', up: M.migration048TightenAccountLedger },
  { version: '049_session_revocation', up: M.migration049SessionRevocation },
  { version: '050_capability_permissions', up: M.migration050CapabilityPermissions },
  { version: '051_audit_result_metadata', up: M.migration051AuditResultMetadata },
  { version: '052_nav_history_hk_rate', up: M.migration052NavHistoryHkRate },
  { version: '053_index_baseline_settled', up: M.migration053IndexBaselineSettled },
  { version: '054_arbitrage_cases', up: M.migration054ArbitrageCases },
  { version: '055_arbitrage_parser_accuracy', up: M.migration055ArbitrageParserAccuracy },
  { version: '056_global_fx_rate_source', up: M.migration056GlobalFxRateSource },
  { version: '057_ipo_history_sync', up: M.migration057IpoHistorySync },
  { version: '058_convertible_bond_issue_unified', up: M.migration058ConvertibleBondIssueUnified },
  { version: '059_ipo_reports_schema', up: M.migration059IpoReportsSchema },
  { version: '060_sse_listing_announcement_source', up: M.migration060SseListingAnnouncementSource },
  { version: '061_job_orchestration', up: M.migration061JobOrchestration },
  { version: '062_alert_delivery_retry', up: M.migration062AlertDeliveryRetry },
  { version: '063_alert_sending_status', up: M.migration063AlertSendingStatus },
  { version: '064_alert_sending_started_at', up: M.migration064AlertSendingStartedAt },
  { version: '065_alert_recovery_attempts', up: M.migration065AlertRecoveryAttempts },
  { version: '066_arbitrage_parse_retry', up: M.migration066ArbitrageParseRetry },
  { version: '067_job_request_payload', up: M.migration067JobRequestPayload },
  { version: '068_ipo_bond_liquidity_calibration', up: M.migration068IpoBondLiquidityCalibration },
  { version: '069_normalize_daily_price_dates', up: M.migration069NormalizeDailyPriceDates },
  { version: '070_remove_duplicate_legacy_price_dates', up: M.migration070RemoveDuplicateLegacyPriceDates },
  { version: '071_deduplicate_instrument_events', up: M.migration071DeduplicateInstrumentEvents },
  { version: '072_authoritative_nav_import_anchor', up: M.migration072AuthoritativeNavImportAnchor },
  { version: '073_nav_attribution_integrity', up: M.migration073NavAttributionIntegrity },
  { version: '074_backfill_legacy_hkd_settlement', up: M.migration074BackfillLegacyHkdSettlement },
  { version: '075_job_execution_protection', up: M.migration075JobExecutionProtection },
  { version: '076_external_call_protection', up: M.migration076ExternalCallProtection },
  { version: '077_convertible_bond_list_metrics', up: M.migration077ConvertibleBondListMetrics },
  { version: '078_external_circuits', up: M.migration078ExternalCircuits },
  { version: '079_convertible_bond_redemption', up: M.migration079ConvertibleBondRedemption },
  { version: '080_convertible_bond_redemption_quality', up: M.migration080ConvertibleBondRedemptionQuality },
  { version: '081_convertible_bond_redemption_unified_status', up: M.migration081ConvertibleBondRedemptionUnifiedStatus },
  { version: '082_stock_suspension_calendar', up: M.migration082StockSuspensionCalendar },
  { version: '083_convertible_bond_call_lifecycle', up: M.migration083ConvertibleBondCallLifecycle },
  { version: '084_convertible_bond_call_lifecycle_current_date', up: M.migration084ConvertibleBondCallLifecycleCurrentDate },
  { version: '085_convertible_bond_waive_announcement_status', up: M.migration085ConvertibleBondWaiveAnnouncementStatus },
  { version: '086_convertible_bond_announcement_history_view', up: M.migration086ConvertibleBondAnnouncementHistoryView },
  { version: '087_convertible_bond_waive_same_day_validity', up: M.migration087ConvertibleBondWaiveSameDayValidity },
  { version: '088_convertible_bond_call_date_fallback', up: M.migration088ConvertibleBondCallDateFallback },
  { version: '089_convertible_bond_call_formula_publication', up: M.migration089ConvertibleBondCallFormulaPublication },
  { version: '090_convertible_bond_revision_monitor', up: M.migration090ConvertibleBondRevisionMonitor },
  { version: '091_convertible_bond_revision_listed_only', up: M.migration091ConvertibleBondRevisionListedOnly },
  { version: '092_convertible_bond_revision_view_lean', up: M.migration092ConvertibleBondRevisionViewLean },
  { version: '093_convertible_bond_revision_term_parser', up: M.migration093ConvertibleBondRevisionTermParser },
  { version: '094_convertible_bond_revision_proposal_expiry', up: M.migration094ConvertibleBondRevisionProposalExpiry },
  { version: '095_convertible_bond_revision_symbolic_lock', up: M.migration095ConvertibleBondRevisionSymbolicLock },
  { version: '096_convertible_bond_revision_implemented_backfill', up: M.migration096ConvertibleBondRevisionImplementedBackfill },
  { version: '097_convertible_bond_revision_no_revision_cleanup', up: M.migration097ConvertibleBondRevisionNoRevisionCleanup },
  { version: '098_convertible_bond_revision_calendar_date_fix', up: M.migration098ConvertibleBondRevisionCalendarDateFix },
  { version: '099_convertible_bond_revision_body_evidence_cleanup', up: M.migration099ConvertibleBondRevisionBodyEvidenceCleanup },
  { version: '100_convertible_bond_revision_rolling_remaining_days', up: M.migration100ConvertibleBondRevisionRollingRemainingDays },
  { version: '101_convertible_bond_revision_status_parity', up: M.migration101ConvertibleBondRevisionStatusParity },
  { version: '102_convertible_bond_revision_quality_gate_fix', up: M.migration102ConvertibleBondRevisionQualityGateFix },
  { version: '103_convertible_bond_revision_no_revision_evidence', up: M.migration103ConvertibleBondRevisionNoRevisionEvidence },
  { version: '104_convertible_bond_revision_implemented_lock_evidence', up: M.migration104ConvertibleBondRevisionImplementedLockEvidence },
  { version: '105_convertible_bond_revision_net_asset_floor', up: M.migration105ConvertibleBondRevisionNetAssetFloor },
  { version: '106_convertible_bond_revision_net_asset_floor_view_fix', up: M.migration106ConvertibleBondRevisionNetAssetFloorViewFix },
  { version: '107_convertible_bond_revision_net_asset_floor_same_day', up: M.migration107ConvertibleBondRevisionNetAssetFloorSameDay },
  { version: '108_convertible_bond_announcement_sources', up: M.migration108ConvertibleBondAnnouncementSources },
  { version: '109_convertible_bond_revision_net_asset_floor_phrase', up: M.migration109ConvertibleBondRevisionNetAssetFloorPhrase },
  { version: '110_background_alert_runtime_governance', up: M.migration110BackgroundAlertRuntimeGovernance },
  { version: '111_convertible_bond_revision_motive', up: M.migration111ConvertibleBondRevisionMotive },
  { version: '112_convertible_bond_revision_motive_integrity', up: M.migration112ConvertibleBondRevisionMotiveIntegrity },
  { version: '113_convertible_bond_revision_cycle_fields', up: M.migration113ConvertibleBondRevisionCycleFields },
  { version: '114_convertible_bond_holder_governance_index', up: M.migration114ConvertibleBondHolderGovernanceIndex },
  { version: '115_convertible_bond_revision_motive_backtest', up: M.migration115ConvertibleBondRevisionMotiveBacktest },
  { version: '116_index_instrument_identifiers', up: M.migration116IndexInstrumentIdentifiers },
  { version: '117_dataset_partitions', up: M.migration117DatasetPartitions },
  { version: '118_instrument_merge_candidates', up: M.migration118InstrumentMergeCandidates },
  { version: '119_normalize_dividend_yield_unit', up: M.migration119NormalizeDividendYieldUnit },
  { version: '120_repair_legacy_dividend_yield_unit', up: M.migration120RepairLegacyDividendYieldUnit },
  { version: '121_backfill_dataset_partitions', up: M.migration121BackfillDatasetPartitions },
  { version: '122_normalize_legacy_stock_identity', up: M.migration122NormalizeLegacyStockIdentity },
  { version: '123_backfill_stock_company_relations', up: M.migration123BackfillStockCompanyRelations },
  { version: '124_external_call_budget_function', up: M.migration124ExternalCallBudgetFunction },
  { version: '125_consolidate_instrument_masters', up: M.migration125ConsolidateInstrumentMasters },
  { version: '126_normalize_stock_code_suffix', up: M.migration126NormalizeStockCodeSuffix },
  { version: '127_source_endpoint_policies', up: M.migration127SourceEndpointPolicies },
  { version: '128_tushare_dual_account_policy', up: M.migration128TushareDualAccountPolicy },
  { version: '129_tushare_dual_account_policy_repair', up: M.migration129TushareDualAccountPolicyRepair },
  { version: '130_tushare_vip_backup_minute_limit', up: M.migration130TushareVipBackupMinuteLimit },
  { version: '131_ipo_sector_exposure_calibration', up: M.migration131IpoSectorExposureCalibration },
  { version: '132_convertible_bond_revision_decision_timeline', up: M.migration132ConvertibleBondRevisionDecisionTimeline },
  { version: '133_convertible_bond_revision_legacy_false_facts', up: M.migration133ConvertibleBondRevisionLegacyFalseFacts },
  { version: '134_company_financial_incremental_sync', up: M.migration134CompanyFinancialIncrementalSync },
  { version: '135_exchange_rate_budget_recovery', up: M.migration135ExchangeRateBudgetRecovery },
  { version: '136_convertible_bond_redemption_status_parity', up: M.migration136ConvertibleBondRedemptionStatusParity },
  { version: '137_convertible_bond_exchange_announcement_unlimited', up: M.migration137ConvertibleBondExchangeAnnouncementUnlimited },
  { version: '138_site_analytics', up: M.migration138SiteAnalytics },
  { version: '139_site_analytics_429', up: M.migration139SiteAnalytics429 },
  { version: '140_ipo_instrument_identity', up: M.migration140IpoInstrumentIdentity },
  { version: '141_backfill_ipo_identity_gaps', up: M.migration141BackfillIpoIdentityGaps },
  { version: '142_hong_kong_ipo_facts', up: M.migration142HongKongIpoFacts },
  { version: '143_market_scoped_numeric_identity', up: M.migration143MarketScopedNumericIdentity },
  { version: '144_hk_ipo_p0_audit', up: M.migration144HkIpoP0Audit },
  { version: '145_cninfo_unlimited_daily_budget', up: M.migration145CninfoUnlimitedDailyBudget },
  { version: '146_convertible_bond_data_status_constraint', up: M.migration146ConvertibleBondDataStatusConstraint },
  { version: '147_convertible_bond_call_announcement_precedence', up: M.migration147ConvertibleBondCallAnnouncementPrecedence },
  { version: '148_hk_ipo_market_signals', up: M.migration148HkIpoMarketSignals },
  { version: '149_hk_ipo_chinese_aliases', up: M.migration149HkIpoChineseAliases },
  { version: '150_hk_ipo_vbkr_fallback', up: M.migration150HkIpoVbkrFallback },
  { version: '151_alert_scope_and_cninfo_backoff', up: M.migration151AlertScopeAndCninfoBackoff },
  { version: '152_convertible_bond_call_evidence_and_lock_state', up: M.migration152ConvertibleBondCallEvidenceAndLockState },
  { version: '153_convertible_bond_call_pre_conversion_status', up: M.migration153ConvertibleBondCallPreConversionStatus },
  { version: '154_ipo_exchange_prospectus_sources', up: M.migration154IpoExchangeProspectusSources },
  { version: '155_agnes_vision_model', up: M.migration155AgnesVisionModel },
  { version: '156_endpoint_only_internal_limits', up: M.migration156EndpointOnlyInternalLimits },
  { version: '157_alert_reconciliation_and_partial_partitions', up: M.migration157AlertReconciliationAndPartialPartitions },
  { version: '158_realtime_exchange_rate_policy', up: M.migration158RealtimeExchangeRatePolicy },
  { version: '159_verified_limits_and_recoverable_circuits', up: M.migration159VerifiedLimitsAndRecoverableCircuits },
  { version: '160_rate_limit_recovery_backoff', up: M.migration160RateLimitRecoveryBackoff },
  { version: '161_hk_ipo_market_snapshot_timeline', up: M.migration161HkIpoMarketSnapshotTimeline },
  { version: '162_hk_ipo_x_public_source', up: M.migration162HkIpoXPublicSource },
  { version: '163_arbitrage_seen_cases', up: M.migration163ArbitrageSeenCases },
  { version: '164_cash_flow_contract', up: () => require('./cashIncomeMigration').migrateCashFlowContract(pool) },
  { version: '165_cash_flow_date_precision', up: () => require('./cashIncomeMigration').migrateCashFlowDatePrecision(pool) },
    { version: '166_cash_income_policy', up: () => require('./cashIncomeMigration').migrateCashIncomePolicy(pool) },
    { version: '167_cash_income_sources', up: () => require('./cashIncomeMigration').migrateCashIncomeSources(pool) },
  { version: '168_call_event_kind_semantics', up: M.migration168CallEventKindSemantics },
  { version: '169_instrument_name_cleanup', up: M.migration169InstrumentNameCleanup },
  { version: '170_feedback_module', up: M.migration170FeedbackModule },
  { version: '171_feedback_release_rollback', up: M.migration171FeedbackReleaseRollback },
  { version: '172_notification_center', up: M.migration172NotificationCenter },
  { version: '173_notification_recipient_identity', up: M.migration173NotificationRecipientIdentity },
  { version: '174_trades_amount_guard_trigger', up: () => require('./migrations/era02bTradesAmountGuard').migration174TradesAmountGuard(pool) },
];

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// 执行单个迁移步骤；单步失败记录日志，下次启动会重试（SQL 均幂等可重跑）
async function runMigration(up, version) {
  try {
    await up();
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
  } catch (e) {
    console.warn('[migrate] 步骤', version, '执行失败，下次启动将重试:', e.message);
    throw e;
  }
}

async function runMigrations() {
  // Web 与 Worker 会并行启动；迁移函数使用连接池，必须用独立会话锁住整个迁移序列，
  // 否则两个进程可能同时创建同一唯一索引或重复执行同一迁移。
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock(904000)');
    await ensureMigrationsTable();
    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      console.log('[migrate] 执行升级步骤', m.version);
      await runMigration(m.up, m.version);
    }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(904000)').catch(() => {});
    lockClient.release();
  }
}

async function assertSchemaReady() {
  const latest = MIGRATIONS[MIGRATIONS.length - 1];
  if (!latest) throw new Error('未定义数据库迁移版本');
  const table = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
  if (!table.rows[0] || !table.rows[0].name) throw new Error('数据库迁移表不存在，请先使用迁移账号执行迁移');
  const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [latest.version]);
  if (applied.rowCount === 0) throw new Error(`数据库未完成最新迁移 ${latest.version}，请先使用迁移账号执行迁移`);
}

// 兼容旧调用点（server/app.js、server/worker.js、test-integration.js）：语义不变，改走版本化迁移
async function initSchema() {
  if (process.env.DISABLE_RUNTIME_MIGRATIONS === '1') {
    await assertSchemaReady();
    return;
  }
  await runMigrations();
}

async function migrateFromJson() {
  const usersPath = path.join(DATA_DIR, '__users__.json');
  if (!fs.existsSync(usersPath)) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');
  if (rows[0].cnt > 0) return;
  try {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    for (const [u, v] of Object.entries(users)) {
      await pool.query(
        'INSERT INTO users (username, password, accounts) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING',
        [u, v.password, JSON.stringify(v.accounts || [])]
      );
      for (const acct of (v.accounts || [])) {
        const fp = path.join(DATA_DIR, `${u.replace(/[^a-zA-Z0-9@._-]/g, '_')}__${acct.replace(/[^a-zA-Z0-9一-龥_-]/g, '_')}.json`);
        try {
          const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          await pool.query(
            'INSERT INTO account_data (username, account_name, data) VALUES ($1,$2,$3) ON CONFLICT (username, account_name) DO NOTHING',
            [u, acct, JSON.stringify(d)]
          );
        } catch (e) {}
      }
    }
    const bakDir = path.join(DATA_DIR, 'json_backup_' + Date.now());
    fs.mkdirSync(bakDir, { recursive: true });
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.json') && f !== '__users__.json' && !f.startsWith('json_backup')) {
        try { fs.cpSync(path.join(DATA_DIR, f), path.join(bakDir, f)); } catch (e) {}
      }
    }
    console.log('已从 JSON 迁移到数据库');
  } catch (e) { console.error('JSON 迁移失败:', e.message); }
}

// 2026-08-03 架构整改（报告 3.4/阶段二）：迁移只能执行一次。
// - 存量 account_data 已由迁移 041 置 data_source_version=2（视为已归档），本函数对它们直接跳过，
//   即使 JSON 里还有旧业务数组也不再回灌 → 已删除的数据不可能被 /migrate-json 重新导入。
// - 仅 data_source_version<2 的账户（新库/人工确认需补录的账户）才会被合并，合并后置 2。
async function migrateToStructured() {
  const { rows } = await pool.query('SELECT username, account_name, data, data_source_version FROM account_data WHERE data_source_version < 2');
  if (rows.length === 0) return { ok: true, migrated: 0, skippedArchived: true };
  let migrated = 0;
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch (e) { continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // 账户级事务（六轮验收）：一账户全部写入成功才提交，失败整体回滚，杜绝半迁移
      // 不可变账户主键（新写入必须带 account_id；账户不存在则先建）
      const acctId = require('crypto').createHash('sha256').update(r.username + '\n' + r.account_name).digest('hex');
      await client.query(
        'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, fee_settings, version, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO NOTHING',
        [acctId, r.username, r.account_name, (typeof d.cashBase === 'number' ? d.cashBase : 0), (typeof d.hkRate === 'number' && d.hkRate > 0 ? d.hkRate : 0.868), (d.feeSettings && typeof d.feeSettings === 'object' ? JSON.stringify(d.feeSettings) : null)]
      );
      for (const p of (d.positions || [])) {
        await client.query(
          'INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id, username, account_name) DO NOTHING',
          [p.id, r.username, r.account_name, acctId, p.code || '', p.name || '', p.price || 0, p.quantity || 0, p.cost || 0, p.type || '', p.subtype || '', p.note || '']
        );
      }
      for (const t of (d.trades || [])) {
        // ⚠️ 六轮验收修复：券商期初导入交易（note 含"导出导入"）保留"成本金额"，
        //    数据库金额约束要求 buy 的 amount=price×quantity（NOT VALID 也拦新写入）→
        //    期初导入的 direction 必须转成 'open'（期初建仓，金额约束豁免、不产生现金）。
        //    真实成交（非导入）amount 与 price×quantity 严重不符 → 按 price×quantity 修正。
        const rawAmount = (typeof t.amount === 'number' && isFinite(t.amount) ? t.amount : (t.price || 0) * (t.quantity || 0));
        const isSnapshotImport = (String(t.note || '').indexOf('导出导入') !== -1);
        const direction = isSnapshotImport ? 'open' : (t.direction || 'buy');
        const amount = isSnapshotImport ? rawAmount
          : Math.abs(rawAmount - (t.price || 0) * (t.quantity || 0)) > 0.02
            ? Math.round((t.price || 0) * (t.quantity || 0) * 100) / 100 : rawAmount;
        const tradeDate = t.trade_date || String(t.date || '').slice(0, 10);
        const executedAt = t.executed_at || (String(t.date || '').length > 10 ? t.date : (t.created_at || t.date || ''));
        await client.query(
          'INSERT INTO trades (id, username, account_name, account_id, date, created_at, trade_date, executed_at, import_batch_id, code, name, direction, price, quantity, amount, type, subtype, note, commission, stamp_tax, transfer_fee, other_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (id, username, account_name) DO NOTHING',
          [t.id, r.username, r.account_name, acctId, t.date || '', t.created_at || '', tradeDate, executedAt, t.import_batch_id || null, t.code || '', t.name || '', direction, t.price || 0, t.quantity || 0, amount, t.type || '', t.subtype || '', t.note || '', t.commission || 0, t.stamp_tax || 0, t.transfer_fee || 0, t.other_fee || 0]
        );
      }
      for (const n of (d.navHistory || [])) {
        await client.query(
          'INSERT INTO nav_history (username, account_name, account_id, date, nav, total_asset, invested, snapshot_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (username, account_name, date) DO NOTHING',
          [r.username, r.account_name, acctId, n.date || '', n.nav || 1.0, n.totalAsset || 0, (n.invested == null ? null : n.invested), n.snapshot_at || null]
        );
      }
      for (const c of (d.cashFlows || [])) {
        await client.query(
          'INSERT INTO cash_flows (id, username, account_name, account_id, date, created_at, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id, username, account_name) DO NOTHING',
          [c.id || uid(), r.username, r.account_name, acctId, c.date || '', c.created_at || '', c.amount || 0, c.note || '']
        );
      }
      // 合并成功 → 置迁移标记并提交（事务内）
      await client.query('UPDATE account_data SET data_source_version=2, structured_migrated_at=now() WHERE username=$1 AND account_name=$2', [r.username, r.account_name]);
      await client.query('COMMIT');
      migrated++;
    } catch (e) {
      await client.query('ROLLBACK'); // 失败整体回滚：已写入的账户/持仓/交易全部撤销，无半迁移
      console.error('迁移账户失败 ' + r.username + '/' + r.account_name + ':', e.message);
    } finally {
      client.release();
    }
  }
  console.log('已按需合并 JSON → 结构化表（幂等，已迁移账户不再回灌）');
  return { ok: true, migrated: migrated, skippedArchived: false };
}

module.exports = {
  MIGRATIONS,
  ...M,
  ensureMigrationsTable,
  runMigration,
  runMigrations,
  assertSchemaReady,
  initSchema,
  migrateFromJson,
  migrateToStructured,
};
