-- 修正港股私有化案件的要约人(offeror)字段：原值均为PDF开头法律声明文本碎片
UPDATE event.arbitrage_cases SET offeror = CASE
    WHEN case_id IN (1,2,18,56,58,59,65,101) THEN '新奧天然氣股份有限公司'
    WHEN case_id = 19 THEN '虹圖投資有限公司'
    WHEN case_id = 34 THEN '滙豐控股有限公司'
    WHEN case_id = 78 THEN 'Triple Arch Limited'
    WHEN case_id = 109 THEN 'ASIA PACIFIC PROMOTION LIMITED'
    WHEN case_id = 110 THEN 'Honeylink Agents Limited'
    WHEN case_id = 122 THEN '國泰海通金融控股有限公司'
    ELSE offeror
END
WHERE strategy_type = 'hk_privatisation';
