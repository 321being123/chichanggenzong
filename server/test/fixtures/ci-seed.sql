-- CI 测试库最小业务种子（2026-11-02）
--
-- 为什么需要：run-all.js 用 `CREATE DATABASE portfolio_test TEMPLATE portfolio`
-- 复制业务库来建测试库，本地因此天然带样例数据；GitHub Actions 上是空库，
-- 于是依赖真实样本的回归必挂：
--   · stock-swap-atomic            → 需 601198.SH / 601995.SH 两只证券主档与 sse 来源
--   · bond-analysis-terminal-gap   → 需 110081.SH 的转债档案行
--   · company-financial-repository → 需一只「转债 + 正股 + 公司关联」样本
-- 本文件补齐这三类最小样本，让 CI 与本地测试库语义一致。
--
-- 约定：全部 ON CONFLICT DO NOTHING，可重复执行；不覆盖、不删除任何既有数据，
-- 因此对本地（业务库快照）执行也无副作用。

-- 交易所来源：迁移种子里只有 tushare/tencent/cninfo/eastmoney/xueqiu/guba/calculated，
-- 缺 sse/szse，而公告类回归按来源代码取 source_id。
INSERT INTO ops.data_sources(source_code,source_name,source_type,priority) VALUES
  ('sse','上海证券交易所','official',5),
  ('szse','深圳证券交易所','official',5)
ON CONFLICT(source_code) DO NOTHING;

-- 证券主档：两只换股标的（真实代码，语义与 stock-swap-atomic 一致）+ 一只正股
INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
VALUES
  ('601198.SH','东兴证券','stock','CN','SSE','CNY','listed'),
  ('601995.SH','中金公司','stock','CN','SSE','CNY','listed'),
  ('600000.SH','测试正股','stock','CN','SSE','CNY','listed')
ON CONFLICT(canonical_code) DO NOTHING;

-- 可转债主档：list_date 留空表示「尚未确知上市日」，
-- company-financial-repository 的待上市分支据此把它算进正股目标集合。
INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status,list_date)
VALUES ('110081.SH','测试转债','convertible_bond','CN','SSE','CNY','listed',NULL)
ON CONFLICT(canonical_code) DO NOTHING;

-- 转债档案：把转债挂到正股上（终态缺口回归读 raw_payload，正股目标查询读 stock_instrument_id）
INSERT INTO fundamental.convertible_bond_profiles(
  instrument_id,stock_instrument_id,bond_full_name,bond_short_name,cb_type,source_id,raw_payload,source_updated_at)
SELECT b.instrument_id, s.instrument_id,
       '测试正股股份有限公司公开发行可转换公司债券','测试转债','CB', ds.source_id,'{}'::jsonb, now()
  FROM core.instruments b
  JOIN core.instruments s ON s.canonical_code = '600000.SH'
  LEFT JOIN ops.data_sources ds ON ds.source_code = 'tushare'
 WHERE b.canonical_code = '110081.SH'
ON CONFLICT(instrument_id) DO NOTHING;

-- 公司与证券归属：company_instruments 是正股目标集合的必经 JOIN
INSERT INTO core.companies(legal_name,short_name) VALUES('测试正股股份有限公司','测试正股')
ON CONFLICT(country_code,legal_name) DO NOTHING;

INSERT INTO core.company_instruments(company_id,instrument_id,relation_type)
SELECT c.company_id, i.instrument_id, 'issued_by'
  FROM core.companies c
  CROSS JOIN core.instruments i
 WHERE c.legal_name = '测试正股股份有限公司'
   AND i.canonical_code = '600000.SH'
ON CONFLICT DO NOTHING;

-- 交易日历最小样本（2026-11-07 补：选股 V2 日/周周期与晨间补算回归）
-- 缺口背景：CI 是空库，没有 market.trade_calendar 行，于是
--   · resolvePeriodTarget 对本周得到 calendar_incomplete（不是 calendar_unavailable），
--     测试允许的 calendar_unavailable / no_session 都对不上；
--   · duePeriodicTargets 晨间分支（回看 20 天）拿不到上一已结束交易日，恒返回空。
-- 区间取「2026-11-06 往前 20 天 ～ 本周日」：既覆盖晨间补算的回看窗口，
-- 也覆盖当前周（W:2026-11-02）与上一周（W:2026-10-26）的完整性判定；
-- 工作日开市、周末休市（区间内无 2026 年法定假日）。
-- 1990 等远期季度刻意不补，仍用于验证「没有日历覆盖必须拒绝」。
INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code)
SELECT 'SSE', day::date, EXTRACT(ISODOW FROM day) < 6, 'tushare'
  FROM generate_series('2026-10-17'::date, '2026-11-08'::date, interval '1 day') AS day
ON CONFLICT(exchange,trade_date) DO NOTHING;
