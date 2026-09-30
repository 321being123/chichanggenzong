-- 用户2026-10-01明确授权告警清除、长裕行业PE按最新官方发布时间确认补入。
-- 只修改603407行业PE；无行业推算，无历史预测回放。重复执行不写入。
-- 原v9解析器读取共享PDF缓存得到33.10；证据保存原文位置、基准日和文件/正文哈希。
BEGIN;
WITH old AS (
 SELECT security_code, industry_pe, source_payload
 FROM public.ipo_history
 WHERE market_code='CN' AND security_code='603407' AND industry_pe IS NULL
 AND source_payload #>> '{historical_enrichment,industry_pe_diagnostic,status}'='conflict'
 FOR UPDATE
), changed AS (
 UPDATE public.ipo_history p
 SET industry_pe=33.10,
 source_payload=jsonb_set(COALESCE(p.source_payload,'{}'::jsonb),'{historical_enrichment}',
 COALESCE(p.source_payload->'historical_enrichment','{}'::jsonb)
 || $facts${"industry_pe":33.1,"industry_pe_as_of":"2026-04-22","industry_pe_source":"sse","industry_pe_evidence":{"snippet":"根据国家统计局《国民经济行业分类》（GB/T4754-2017），发行人所属\n行业为化学原料和化学制品制造业（C26），截至2026年4月22日（T-3日），\n中证指数有限公司发布的化学原料和化学制品制造业（C26）最近一个月平均\n静态市盈率为33.10倍","start":1555,"end":1683,"classification_system":"national_economic_industry","classification_version":"GB/T 4754-2017","classification_code":"C26","industry":null,"classification_basis":"公司股东净利润除以本次发行前总股本计\n算）；\n2、20.69倍（每股收益按照2025年度经会计师事务所依据中国会计准则审\n计的扣除非经常性损益后归属于母公司股东净利润除以本次发行前总股本计\n算）；\n3、22.68倍（每股收益按照2025年度经会计师事务所依据中国会计准则审\n计的扣除非经常性损益前归属于母公司股东净利润除以本次发行后总股本计\n算）；\n4、23.00倍（每股收益按照2025年度经会计师事务所依据中国会计准则审\n计的扣除非经常性损益后归属于母公司股东净利润除以本次发行后总股本计\n算）。\n根据国家统计局《国民经济行业分类》（GB/T4754-2017），发行人所属\n行业为化学原料和化学制品制造业（C26），截至2026年4月22日（T-3日），\n中证指数有限公司发布的化学原料和化学制品制造业（C26）最近一个月平均\n静态市盈率为33.10","classification_basis_start":1304,"classification_basis_end":1682,"as_of":"2026-04-22","value":33.1,"source":"sse","document_role":"listing_announcement","document_date":"2026-05-08","document_url":"https://big5.sse.com.cn/site/cht/www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-05-08/603407_20260508_VMOL.pdf","content_hash":"eb748c4b3834943c778b650688c5110b9e46e52e1fb6b0477f1fe481ceaefa8e","document_sha256":"08074c9ff7cbd94902895f2256c37f2b49265ca996d3d3782bea9b323ad7553c","parser_version":"ipo-issuance-facts-v9","text_extraction_version":"pymupdf-page-text-join-v1"},"industry_pe_diagnostic":{"status":"value","value":33.1,"as_of":"2026-04-22","snippet":"根据国家统计局《国民经济行业分类》（GB/T4754-2017），发行人所属\n行业为化学原料和化学制品制造业（C26），截至2026年4月22日（T-3日），\n中证指数有限公司发布的化学原料和化学制品制造业（C26）最近一个月平均\n静态市盈率为33.10倍","start":1555,"end":1683,"classification_system":"national_economic_industry","classification_version":"GB/T 4754-2017","classification_code":"C26","industry":null,"classification_basis":"公司股东净利润除以本次发行前总股本计\n算）；\n2、20.69倍（每股收益按照2025年度经会计师事务所依据中国会计准则审\n计的扣除非经常性损益后归属于母公司股东净利润除以本次发行前总股本计\n算）；\n3、22.68倍（每股收益按照2025年度经会计师事务所依据中国会计准则审\n计的扣除非经常性损益前归属于母公司股东净利润除以本次发行后总股本计\n算）；\n4、23.00倍（每股收益按照2025年度经会计师事务所依据中国会计准则审\n计的扣除非经常性损益后归属于母公司股东净利润除以本次发行后总股本计\n算）。\n根据国家统计局《国民经济行业分类》（GB/T4754-2017），发行人所属\n行业为化学原料和化学制品制造业（C26），截至2026年4月22日（T-3日），\n中证指数有限公司发布的化学原料和化学制品制造业（C26）最近一个月平均\n静态市盈率为33.10","classification_basis_start":1304,"classification_basis_end":1682,"source":"sse","document_role":"listing_announcement","document_date":"2026-05-08","document_url":"https://big5.sse.com.cn/site/cht/www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-05-08/603407_20260508_VMOL.pdf","content_hash":"eb748c4b3834943c778b650688c5110b9e46e52e1fb6b0477f1fe481ceaefa8e","document_sha256":"08074c9ff7cbd94902895f2256c37f2b49265ca996d3d3782bea9b323ad7553c","parser_version":"ipo-issuance-facts-v9","text_extraction_version":"pymupdf-page-text-join-v1","reason":"用户要求按最新官方发布时间选择；2026-05-08上市公告书再次明确33.10，4月24日发行公告摘要33.94与正文33.10不一致；保留旧冲突证据"}}$facts$::jsonb
 || jsonb_build_object('industry_pe_resolution_history',
 COALESCE(p.source_payload #> '{historical_enrichment,industry_pe_resolution_history}','[]'::jsonb)
 || jsonb_build_array(jsonb_build_object(
 'actor','Codex','reason','用户要求按最新官方时间选择',
 'previous_value',old.industry_pe,
 'previous_diagnostic',old.source_payload #> '{historical_enrichment,industry_pe_diagnostic}',
 'selected_value',33.10,'selected_document_date','2026-05-08',
 'selected_document_url','https://big5.sse.com.cn/site/cht/www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-05-08/603407_20260508_VMOL.pdf',
 'resolved_at',now())))),
 updated_at=to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS')
 FROM old WHERE p.market_code='CN' AND p.security_code=old.security_code
 RETURNING p.security_code,p.industry_pe
)
INSERT INTO admin_audit_log(actor,action,target,detail,result,metadata,created_at)
SELECT 'Codex','ipo.industry_pe_manual_resolution',security_code,
 '最新2026-05-08官方上市公告书确认33.10；保留4月24日摘要和正文冲突证据',
 'success',jsonb_build_object('value',industry_pe,'document_date','2026-05-08',
 'as_of','2026-04-22','document_url','https://big5.sse.com.cn/site/cht/www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-05-08/603407_20260508_VMOL.pdf'),now() FROM changed;
COMMIT;
-- 执行后调用原ipo_history_sync.update_quality，仅only_codes=['603407']，不联网。
