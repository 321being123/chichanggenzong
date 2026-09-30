-- 用户2026-10-01明确要求：未披露不作为缺项告警，北交所行业PE仅记录。
-- 仅给已核验两份官方询价公告保存待披露证据，不填写PE、不修改其他字段。
BEGIN;
WITH reviews AS (
 SELECT item->>'code' code,item-'code' state FROM jsonb_array_elements($review$[{"code":"001381","status":"not_disclosed","verified":true,"document_url":"https://static.cninfo.com.cn/finalpage/2026-09-30/1225588416.PDF","content_hash":"ace193023be2ea8c81df9e719848df489d428b010c5995cda3a14a9570292847","disclosure_due":"2026-10-16","retry_after":"2026-10-16","reason":"official_announcement_future_disclosure","evidence":"发行人和主承销商将在2026年10月16日（T-1日）刊登的《发行公告》中披露下列信息：（1）同行业上市公司二级市场平均市盈率"},{"code":"301718","status":"not_disclosed","verified":true,"document_url":"https://static.cninfo.com.cn/finalpage/2026-09-23/1225577468.PDF","content_hash":"599461d64e02cd1f5a92f2fadaa05d67ce10ed2eed23702cb2df3b71b768147f","disclosure_due":"2026-10-08","retry_after":"2026-10-08","reason":"official_announcement_future_disclosure","evidence":"发行人和保荐人（主承销商）将在2026年10月8日（T-1日）刊登的《发行公告》中披露下列信息：（1）同行业上市公司二级市场平均市盈率"}]$review$::jsonb) item
), changed AS (
 UPDATE public.ipo_history p
 SET data_quality_status=jsonb_set(COALESCE(p.data_quality_status,'{}'::jsonb),'{field_states}',
 COALESCE(p.data_quality_status->'field_states','{}'::jsonb)||jsonb_build_object('industry_pe',r.state)),
 source_payload=COALESCE(p.source_payload,'{}'::jsonb)||jsonb_build_object('industry_pe_disclosure_review',r.state||jsonb_build_object('actor','Codex','reviewed_at',now())),
 updated_at=to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS')
 FROM reviews r WHERE p.security_code=r.code AND p.market_code='CN' AND p.industry_pe IS NULL
 RETURNING p.security_code
)
INSERT INTO admin_audit_log(actor,action,target,detail,result,metadata,created_at)
SELECT 'Codex','ipo.industry_pe_disclosure_policy',security_code,'官方原文明确后续披露时间；保留缺值，不作为当前告警来源','success','{}'::jsonb,now() FROM changed;
COMMIT;
-- 发布后通过原update_quality仅刷新以上2只及PE缺值北交所股票；其他字段告警规则不变。
