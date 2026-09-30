-- 用户授权“其他继续解决”；生产已于2026-10-01执行，留存可复核的同条件SQL。
-- 官方配发摘要：Stock code 6802 / Dealings commencement date September 30, 2026。
-- 原Runner槽1239919同时取得2026-09-30首日行情。不用于预计日期替代实际日期。
BEGIN;
WITH changed AS (
  UPDATE public.ipo_history
     SET listing_at='2026-09-30 00:00:00+08'::timestamptz,
         listing_date='2026-09-30', ipo_date='2026-09-30', ipo_status='listed',
         source_payload=COALESCE(source_payload,'{}'::jsonb) || jsonb_build_object(
           'manual_listing_correction', jsonb_build_object(
             'date','2026-09-30',
             'url','https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0929/2026092901927.pdf',
             'contentSha256','1effec82502ada9db2610af74b729214f0b63ba087d90d914535a39fe0d2343a',
             'text','Stock code 6802 Stock short name CAMSENSE Dealings commencement date September 30, 2026',
             'reason','官方配发公告及原Runner取得的2026-09-30首日行情交叉核验',
             'actor','Codex')),
         updated_at=to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS')
   WHERE security_code='06802.HK' AND market_code='HK' AND listing_at IS NULL
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(source_documents) d
        WHERE d->>'url'='https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0929/2026092901927.pdf'
          AND d->>'contentSha256'='1effec82502ada9db2610af74b729214f0b63ba087d90d914535a39fe0d2343a')
   RETURNING security_code,source_payload->'manual_listing_correction' AS evidence
)
INSERT INTO admin_audit_log(actor,action,target,detail,result,metadata,created_at)
SELECT 'Codex','ipo.official_listing_correction',security_code,
       '官方配发公告及原Runner首日行情交叉核验','success',evidence,now()
  FROM changed;
COMMIT;
-- 执行后通过原recomputeHkIpoCompleteness仅核验06802.HK；生产实测complete=1/missing=0。
