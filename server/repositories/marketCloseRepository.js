const { pool } = require('../db/connection');

// 自 server/jobs/marketClose.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
// 收盘幂等的判定依据必须是“已确认的终盘价”，不能只看当天有没有任意一条记录：
// 盘中候选或遗留未核验价存在时，收盘任务仍需重新取价并升级。
async function select_daily_prices(params, client = pool) {
  // market 必须一起返回：缺口判定与幂等跳过都按「市场 + 代码」的身份，
  // 缺了市场就只能按代码判断，同形证券（A 股 000001 / 港股 00001）会互相顶替。
  return client.query(
    `SELECT code, market, quality, is_final FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3`,
    params
  );
}

// 已发布的共享日线（market.daily_bars）：终盘核验先读这里，命中就不再外采。
// 只按「证券 + 日期 + 来源名」取行是不够的：同一张表里既有可转债同步写入的腾讯实时报价，
// 也有全市场日线，光看来源名无法区分。这里把行级证据（口径/终盘/质量）与
// 该交易日 position_close_bars 分区状态一起取回，由调用方用统一判据裁决，不在此处自行认定。
async function select_published_daily_bar(params, client = pool) {
  return client.query(
    `SELECT b.close::float8 AS close, s.source_code,
            b.price_adjust, b.bar_status, b.quality_status,
            p.status AS partition_status, p.is_stale AS partition_is_stale,
            p.diagnostics AS partition_diagnostics
       FROM market.daily_bars b
       JOIN core.instruments i ON i.instrument_id = b.instrument_id
       JOIN ops.data_sources s ON s.source_id = b.source_id
       LEFT JOIN ops.dataset_partitions p
         ON p.dataset_code = $4 AND p.scope_key = COALESCE(i.market, 'CN') AND p.partition_key = b.trade_date
      WHERE upper(i.canonical_code) = upper($1) AND b.trade_date = $2::date
        AND s.source_code = ANY($3::text[])
      ORDER BY s.priority ASC, b.ingested_at DESC`,
    params
  );
}

// 外采到的不复权终盘日线写回共享日线事实：只放在本次任务内存里，下一次任务或重试会重复外采。
// 入库同时留证据（供应商、口径、核验方式），口径/终盘/质量三列必须显式标注，
// 否则这一行在读取端仍然不构成证据。来源未登记（例如 tencent_day）由调用方先映射到已登记来源。
async function upsert_daily_bar_evidence(params, client = pool) {
  return client.query(
    `WITH inst AS (SELECT instrument_id FROM core.instruments WHERE upper(canonical_code)=upper($1)),
          src AS (SELECT source_id FROM ops.data_sources WHERE source_code=$4)
     INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close,price_adjust,bar_status,quality_status,bar_evidence,ingested_at)
     SELECT inst.instrument_id,$2::date,src.source_id,$3,'none','terminal','passed',$5::jsonb,now()
       FROM inst CROSS JOIN src
     ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE
        SET close=EXCLUDED.close,price_adjust=EXCLUDED.price_adjust,bar_status=EXCLUDED.bar_status,
            quality_status=EXCLUDED.quality_status,bar_evidence=EXCLUDED.bar_evidence,ingested_at=now()
     RETURNING instrument_id`,
    params
  );
}

// 某交易日某市场某品种已核验的日线只数：分区行数必须来自实际证据行，
// 不能凭“本次采到了几条”自报，也不能用 A 股行证明可转债/基金覆盖。
async function count_position_close_bars(params, client = pool) {
  return client.query(
    `SELECT COUNT(*)::int AS row_count
       FROM market.daily_bars b JOIN core.instruments i ON i.instrument_id=b.instrument_id
      WHERE b.trade_date=$1::date AND i.market=$2
        AND b.bar_status='terminal' AND b.price_adjust='none' AND b.quality_status='passed'
        AND ($3::text IS NULL OR (
          ($3='stock' AND i.asset_class IN ('stock','equity')
            AND regexp_replace(i.canonical_code,'\\D','','g') !~ '^(11|12)\\d{4}$'
            AND regexp_replace(i.canonical_code,'\\D','','g') !~ '^(5|15|16|17|180|181|184)')
          OR ($3='bond' AND (i.asset_class='convertible_bond'
            OR regexp_replace(i.canonical_code,'\\D','','g') ~ '^(11|12)\\d{4}$'))
          OR ($3='fund' AND regexp_replace(i.canonical_code,'\\D','','g') ~ '^(5|15|16|17|180|181|184)')
          OR ($3='hk_stock' AND (upper(i.market)='HK' OR i.canonical_code ~ '\\.HK$'))
        ))`,
    params
  );
}

// 终盘分区的覆盖对账：目标证券 = 本任务当天已确认账户日价 ∪ 当前持仓中属于该品种的证券，
// 覆盖证券 = 该市场该日已落库的合格终盘日线。
// 只统计已确认日价会把"连账户日价都没确认（终盘候选未转正）"的证券漏出分母，
// 分母偏小就会把未补齐的分区判成覆盖完整。持仓并集补上这部分；历史补跑时持仓已变，
// 已确认日价那一份仍保留，避免只依赖当前持仓。这里只做计数，不写任何事实。
async function count_close_bar_coverage(params, client = pool) {
  return client.query(
    `WITH scoped AS (
       SELECT regexp_replace(code,'\\D','','g') AS num
         FROM daily_prices
        WHERE date=$1::text AND upper(market)=upper($2)
          AND quality='confirmed' AND is_final=true
          AND code IS NOT NULL AND code <> ''
          AND ($4::text[] IS NULL OR username = ANY($4::text[]))
       UNION ALL
       SELECT regexp_replace(code,'\\D','','g') AS num
         FROM positions
        WHERE code IS NOT NULL AND code <> '' AND quantity::float8 > 0
          AND ($4::text[] IS NULL OR username = ANY($4::text[]))
     ), target AS (
       SELECT DISTINCT num FROM scoped
        WHERE (
          (upper($2)='HK' AND num ~ '^\\d{5}$')
          OR (upper($2)<>'HK' AND $3::text='stock' AND num ~ '^\\d{6}$'
            AND num !~ '^(11|12)\\d{4}$' AND num !~ '^(5|15|16|17|180|181|184)')
          OR (upper($2)<>'HK' AND $3::text='bond' AND num ~ '^(11|12)\\d{4}$')
          OR (upper($2)<>'HK' AND $3::text='fund' AND num ~ '^(5|15|16|17|180|181|184)')
          OR (upper($2)<>'HK' AND $3::text IS NULL AND num ~ '^\\d{6}$')
        )
     ), covered AS (
       SELECT DISTINCT regexp_replace(i.canonical_code,'\\D','','g') AS num
         FROM market.daily_bars b JOIN core.instruments i ON i.instrument_id=b.instrument_id
        WHERE b.trade_date=$1::date AND upper(i.market)=upper($2)
          AND b.bar_status='terminal' AND b.price_adjust='none' AND b.quality_status='passed'
     )
     SELECT (SELECT COUNT(*)::int FROM target) AS expected_count,
            (SELECT COUNT(*)::int FROM target t
              WHERE EXISTS (SELECT 1 FROM covered c WHERE c.num=t.num)) AS covered_count`,
    params
  );
}

async function select_position_close_partition(params, client = pool) {
  return client.query(
    `SELECT diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=$1 AND scope_key=$2 AND partition_key=$3::date
      LIMIT 1`,
    params,
  );
}

async function select_positions(params, client = pool) {
  return client.query(`SELECT code FROM positions WHERE code IS NOT NULL AND code <> ''`);
}

async function select_accounts(params, client = pool) {
  return client.query(`SELECT username, account_name FROM accounts ORDER BY username, created_at`);
}

async function select_daily_prices_1(params, client = pool) {
  return client.query(`SELECT MIN(date)::text AS first_date FROM daily_prices WHERE username=$1 AND account_name=$2`, params);
}

// 补漏的“已覆盖”必须精确到证券：只返回日期会漏掉“当天部分证券缺价”的情况，
// 因此这里返回「日期 + 市场 + 代码」，由上层按账户持仓逐只核对缺口。
// market 缺了就只能按裸代码核对，同形证券（A 股 000001 / 港股 00001）会互相顶替。
async function select_daily_prices_2(params, client = pool) {
  return client.query(
    `SELECT DISTINCT date::text AS date, market, code FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND date BETWEEN $3 AND $4
        AND quality = 'confirmed' AND is_final = true`,
    params
  );
}

// 账户当前持有的证券（补漏要按账户、市场、证券、交易日逐只核对）。
async function select_position_scope(params, client = pool) {
  return client.query(
    `SELECT code, subtype FROM positions
      WHERE username=$1 AND account_name=$2 AND quantity::float8 > 0`,
    params
  );
}

// 共享日线缺口（ops.market_close_bar_gaps）：账户日价与共享日线是两个独立事实，
// 前者已确认不代表后者已落库。缺口必须落库，重跑才能在不重取账户日价的前提下继续补齐。
// 同一「任务标签 + 日线代码 + 交易日」只留一条，重复失败只累加尝试次数与原因。
async function upsert_bar_gap(params, client = pool) {
  return client.query(
    `INSERT INTO ops.market_close_bar_gaps(job_label,market,code,ts_code,kind,trade_date,price,reason,detail)
     VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9::jsonb)
     ON CONFLICT(job_label,ts_code,trade_date) DO UPDATE SET
       market=EXCLUDED.market,code=EXCLUDED.code,kind=EXCLUDED.kind,price=EXCLUDED.price,
       reason=EXCLUDED.reason,detail=EXCLUDED.detail,attempts=ops.market_close_bar_gaps.attempts+1,
       last_attempt_at=now(),resolved_at=NULL
     RETURNING gap_id`,
    params
  );
}

async function resolve_bar_gap(params, client = pool) {
  return client.query(
    `UPDATE ops.market_close_bar_gaps SET resolved_at=now(), last_attempt_at=now(), reason=''
      WHERE job_label=$1 AND ts_code=$2 AND trade_date=$3::date AND resolved_at IS NULL`,
    params
  );
}

async function select_open_bar_gaps(params, client = pool) {
  return client.query(
    `SELECT code, ts_code, kind, market, price::float8 AS price, reason, attempts
       FROM ops.market_close_bar_gaps
      WHERE job_label=$1 AND trade_date=$2::date AND resolved_at IS NULL
      ORDER BY gap_id`,
    params
  );
}

async function count_open_bar_gaps(params, client = pool) {
  return client.query(
    `SELECT COUNT(*)::int AS open_gaps FROM ops.market_close_bar_gaps
      WHERE job_label=$1 AND trade_date=$2::date AND resolved_at IS NULL`,
    params
  );
}

// 缺口重建：账户日价证据里已经写明"这条终盘证据没写回共享日线"（terminalPersisted=false）。
// 缺口表写不进去时，这份证据就是唯一可恢复的事实来源，因此每次运行都要据此重建缺口，
// 否则一旦登记失败，状态就再也找不回来（重跑只会看到"账户已确认"而误判完成）。
// 只取当天该市场已确认的日价行；是否仍缺共享日线由调用方按日线表再核一次。
async function select_unsynced_bar_evidence(params, client = pool) {
  return client.query(
    `SELECT DISTINCT code,
            COALESCE(evidence->>'terminalTsCode','') AS ts_code,
            COALESCE(evidence->>'terminalKind','') AS kind
       FROM daily_prices
      WHERE date=$1::text AND market=$2 AND quality='confirmed' AND is_final=true
        AND evidence->>'terminalPersisted' = 'false'
      ORDER BY code`,
    params
  );
}

// 某证券某交易日是否已有合格（不复权终盘、质量通过）的共享日线证据行。
async function count_terminal_daily_bars(params, client = pool) {
  return client.query(
    `SELECT COUNT(*)::int AS bars
       FROM market.daily_bars b JOIN core.instruments i ON i.instrument_id=b.instrument_id
      WHERE upper(i.canonical_code)=upper($1) AND b.trade_date=$2::date
        AND b.bar_status='terminal' AND b.price_adjust='none' AND b.quality_status='passed'`,
    params
  );
}

module.exports = {
  select_daily_prices,
  select_published_daily_bar,
  upsert_daily_bar_evidence,
  count_position_close_bars, count_close_bar_coverage, select_position_close_partition,
  upsert_bar_gap,
  resolve_bar_gap,
  select_open_bar_gaps,
  count_open_bar_gaps,
  select_unsynced_bar_evidence,
  count_terminal_daily_bars,
  select_position_scope,
  select_positions,
  select_accounts,
  select_daily_prices_1,
  select_daily_prices_2,
};
