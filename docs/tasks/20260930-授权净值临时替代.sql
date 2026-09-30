-- 用户2026-09-30授权：仅填指定缺失日，以前面已有净值临时替代。
-- 缺失的前一交易日无记录时，退回更早已导入值；不使用未来日期，不覆盖已有值。
-- 每行明确标注 estimated/manual_carry_forward，不冒充券商真实净值。
BEGIN;
DO $$
DECLARE t record; a record; p nav_history%ROWTYPE; prior_trade text;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('招商证券账户','2026-07-03'),('华泰账户','2026-07-03'),
    ('招商证券账户','2026-07-06'),('华泰账户','2026-07-06'),
    ('招商证券账户','2026-07-07'),('华泰账户','2026-07-07'),
    ('招商证券账户','2026-08-12'),('招商证券账户','2026-08-13'),
    ('招商证券账户','2026-08-14')) AS v(account_name,date) ORDER BY date,account_name
  LOOP
    SELECT * INTO STRICT a FROM accounts ac WHERE ac.account_name=t.account_name
      AND EXISTS(SELECT 1 FROM nav_history n WHERE n.username=ac.username AND n.account_name=ac.account_name);
    IF EXISTS(SELECT 1 FROM nav_history n WHERE n.username=a.username AND n.account_name=a.account_name AND n.date=t.date) THEN CONTINUE; END IF;
    SELECT max(trade_date)::text INTO prior_trade FROM market.trade_calendar WHERE exchange='SSE' AND is_open=true AND trade_date<t.date::date;
    SELECT n.* INTO p FROM nav_history n WHERE n.username=a.username AND n.account_name=a.account_name AND n.date<t.date
      ORDER BY EXISTS(SELECT 1 FROM market.trade_calendar c WHERE c.exchange='SSE' AND c.is_open=true AND c.trade_date::text=n.date) DESC,n.date DESC LIMIT 1;
    IF p.date IS NULL OR p.nav IS NULL OR p.nav<=0 THEN RAISE EXCEPTION '缺少可替代净值：% %',t.account_name,t.date; END IF;
    INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,snapshot_at,hk_rate,
      cash_cny,market_value_cny,system_market_value_at_snapshot,broker_fx_rate,snapshot_source,source_priority,
      calc_status,diagnostics,is_locked)
    VALUES(a.username,a.account_name,a.id,t.date,p.nav,p.total_asset,p.invested,p.snapshot_at,p.hk_rate,
      p.cash_cny,p.market_value_cny,p.system_market_value_at_snapshot,p.broker_fx_rate,'manual_carry_forward',90,
      'estimated',jsonb_build_object('method','previous_available_nav','userAuthorized',true,
        'sourceDate',p.date,'requestedPriorTradeDate',prior_trade,'sourceNav',p.nav,
        'sourceSnapshotSource',p.snapshot_source,'originalSourceDate',COALESCE(p.diagnostics->>'originalSourceDate',p.date),
        'reason','缺少历史持仓基准；用户授权以前面已有净值临时替代，非当日真实估值'),true);
    UPDATE accounts SET nav_version=COALESCE(nav_version,0)+1 WHERE id=a.id;
  END LOOP;
END $$;
COMMIT;
