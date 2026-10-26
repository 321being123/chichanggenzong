// 172：统一站内通知（2026-10-25）
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第十四节。
// 归属：通知内容/收件人/批次/操作幂等四表属 public 用户业务；调度槽位仍归 ops。
// 本文件只建表、约束与索引；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool } = require('../connection');

// 生产迁移账号只有模式内建表权限、没有库级 CREATE：模式缺失时才建（同 era07）。
async function ensureSchema(name) {
  const { rows } = await pool.query(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [name]
  );
  if (!rows[0]) await pool.query('CREATE SCHEMA ' + name);
}

async function migration172NotificationCenter() {
  await ensureSchema('ops');
  await pool.query(`
    -- 通知内容：一条业务事件对应一条通知，跨模块共用同一收件箱
    CREATE TABLE IF NOT EXISTS public.notifications (
      id BIGSERIAL PRIMARY KEY,
      -- type 即前端分类：feedback（反馈完成）/ system（后台群发）
      type TEXT NOT NULL CHECK (type IN ('feedback','system')),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      target_kind TEXT NOT NULL DEFAULT 'none' CHECK (target_kind IN ('none','feedback','notification')),
      target_id TEXT NOT NULL DEFAULT '',
      feedback_id BIGINT REFERENCES public.feedbacks(id) ON DELETE SET NULL,
      release_run_id BIGINT,
      dedupe_key TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      invalidated_at TIMESTAMPTZ,
      invalidation_reason TEXT NOT NULL DEFAULT '',
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notifications_title_len CHECK (char_length(title) BETWEEN 1 AND 120),
      CONSTRAINT notifications_body_len CHECK (char_length(body) <= 2000),
      CONSTRAINT notifications_dedupe_key_len CHECK (char_length(dedupe_key) BETWEEN 1 AND 200)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
      ON public.notifications(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_notifications_type_created
      ON public.notifications(type, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_feedback
      ON public.notifications(feedback_id) WHERE feedback_id IS NOT NULL;

    -- 收件人：兼作群发名单与投递进度，不另建受众表
    CREATE TABLE IF NOT EXISTS public.notification_recipients (
      id BIGSERIAL PRIMARY KEY,
      notification_id BIGINT NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
      -- 稳定槽位键：反馈固定 feedback_author；群发为不含用户名的账号摘要，确认后不重建
      recipient_slot_key TEXT NOT NULL,
      recipient_username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','skipped','failed')),
      read_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      skip_reason TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      last_scan_round INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notification_recipients_slot UNIQUE (notification_id, recipient_slot_key),
      -- 已读必须已投递（delivered 是终态，不会再回退）
      CONSTRAINT notification_recipients_read_after_delivery
        CHECK (read_at IS NULL OR status = 'delivered'),
      CONSTRAINT notification_recipients_slot_key_len
        CHECK (char_length(recipient_slot_key) BETWEEN 1 AND 80)
    );

    -- 本人收件箱：只读已投递，按收件 ID 稳定倒序分页
    CREATE INDEX IF NOT EXISTS idx_notification_recipients_inbox
      ON public.notification_recipients(recipient_username, id DESC)
      WHERE status = 'delivered';
    -- 未读数局部索引：只覆盖 delivered 且未读
    CREATE INDEX IF NOT EXISTS idx_notification_recipients_unread
      ON public.notification_recipients(recipient_username)
      WHERE status = 'delivered' AND read_at IS NULL;
    -- 批次扫描：按通知 + 状态顺序推进游标
    CREATE INDEX IF NOT EXISTS idx_notification_recipients_scan
      ON public.notification_recipients(notification_id, status, id);

    -- 发送批次：一个通知最多一个批次，确认后内容与名单冻结
    CREATE TABLE IF NOT EXISTS public.notification_batches (
      id BIGSERIAL PRIMARY KEY,
      notification_id BIGINT NOT NULL UNIQUE REFERENCES public.notifications(id) ON DELETE CASCADE,
      creator_username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
      audience_mode TEXT NOT NULL CHECK (audience_mode IN ('all','selected','filter')),
      filter_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_audience_hash TEXT NOT NULL DEFAULT '',
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','queued','running','partial','completed','cancelled')),
      dispatch_slot_id BIGINT UNIQUE REFERENCES ops.job_schedule_slots(slot_id) ON DELETE SET NULL,
      dispatch_generation INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_generation >= 0),
      scan_round INTEGER NOT NULL DEFAULT 0 CHECK (scan_round >= 0),
      cursor TEXT,
      snapshot_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
      delivered_count INTEGER NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
      skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
      failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
      pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
      remaining_count INTEGER NOT NULL DEFAULT 0 CHECK (remaining_count >= 0),
      next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- queued/running/partial 必须有调度槽位，确认同事务建立
      CONSTRAINT notification_batches_slot_pairing CHECK (
        status = 'draft' OR status = 'cancelled' OR dispatch_slot_id IS NOT NULL
      )
    );

    CREATE INDEX IF NOT EXISTS idx_notification_batches_status
      ON public.notification_batches(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_notification_batches_creator
      ON public.notification_batches(creator_username, created_at DESC);

    -- 操作幂等：逐操作保存请求摘要与原返回，不能只用审计或 JSONB 操作历史替代
    CREATE TABLE IF NOT EXISTS public.notification_operations (
      id BIGSERIAL PRIMARY KEY,
      batch_id BIGINT REFERENCES public.notification_batches(id) ON DELETE CASCADE,
      actor_username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
      operation TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL DEFAULT '',
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notification_operations_operation_len CHECK (char_length(operation) BETWEEN 1 AND 32),
      CONSTRAINT notification_operations_request_id_len CHECK (char_length(client_request_id) BETWEEN 1 AND 64)
    );

    -- 已知批次：批次＋操作＋请求标识唯一
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_operations_batch
      ON public.notification_operations(batch_id, operation, client_request_id)
      WHERE batch_id IS NOT NULL;
    -- 首次 preview 无批次号：按操作者＋操作＋请求标识局部唯一
    CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_operations_preview
      ON public.notification_operations(actor_username, operation, client_request_id)
      WHERE batch_id IS NULL;

    -- 执行令牌：每次领取唯一，接管时更换；旧执行不得续租、改状态或写收件进度
    ALTER TABLE ops.job_schedule_slots ADD COLUMN IF NOT EXISTS execution_token TEXT;
  `);
}

// 173：收件人账号身份（2026-10-25 验收反例）
// 契约见原方案 14.6「不可绑定同名新账号」：仅靠用户名无法区分「删号后同名重注册」，
// 预览到插入名单之间删号重注册会让通知投给新账号。收件人额外保存账号不可复用身份，
// 投递前比对不一致即 skipped/account_replaced。
async function migration173NotificationRecipientIdentity() {
  await pool.query(`
    ALTER TABLE public.notification_recipients
      ADD COLUMN IF NOT EXISTS recipient_identity TEXT NOT NULL DEFAULT '';

    -- 存量待投递/失败记录按当前账号建立身份（已删号记录 recipient_username 为空，保持空值）
    UPDATE public.notification_recipients r
       SET recipient_identity = COALESCE(extract(epoch FROM u.created_at)::text, '')
      FROM public.users u
     WHERE u.username = r.recipient_username
       AND r.recipient_identity = ''
       AND r.status IN ('pending','failed');
  `);
}

module.exports = { migration172NotificationCenter, migration173NotificationRecipientIdentity };
