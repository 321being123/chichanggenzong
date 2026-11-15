// 195/196：文章评论通知与个人提醒偏好（2026-11-15）
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.13 节。
// 本文件只做纯增量：扩展既有通知四表的类型约束、给收件人补主体快照、新增评论请求幂等表与偏好表。
// 不建平行通知表、不建第二套队列或调度器；原 feedback/system 通知与后台群发不受影响。
const { pool } = require('../connection');

// 195：通知类型扩到 comment（文章评论/回复/@），目标类型扩到 article_comment；
// 收件人补不可复用主体快照 recipient_subject_id（与 username 一起判定「是不是同一个账号实例」）。
async function migration195CommentNotification() {
  await pool.query(`
    -- type 即前端分类：feedback（反馈完成）/ system（后台群发）/ comment（文章评论互动）
    ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
      CHECK (type IN ('feedback','system','comment'));

    ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_target_kind_check;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_target_kind_check
      CHECK (target_kind IN ('none','feedback','notification','article_comment'));

    -- 评论通知的目标是具体评论：失效按评论定位，列表/详情按服务端注册表生成站内地址
    CREATE INDEX IF NOT EXISTS idx_notifications_comment_target
      ON public.notifications(target_id)
      WHERE target_kind = 'article_comment';

    -- 收件人主体快照：历史行保持空值（不回填成同名新账号），新评论通知一律写入
    ALTER TABLE public.notification_recipients
      ADD COLUMN IF NOT EXISTS recipient_subject_id UUID;

    CREATE INDEX IF NOT EXISTS idx_notification_recipients_subject
      ON public.notification_recipients(recipient_subject_id, id DESC)
      WHERE recipient_subject_id IS NOT NULL;

    -- 评论请求幂等：网络结果未知时客户端保留原请求标识重试；同标识同摘要返回原评论，不同摘要 409。
    -- 只负责请求幂等，不是第二套评论或通知事实。
    CREATE TABLE IF NOT EXISTS public.article_comment_requests (
      id BIGSERIAL PRIMARY KEY,
      subject_id UUID NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL DEFAULT '',
      comment_id INTEGER REFERENCES public.article_comments(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT article_comment_requests_request_id_len
        CHECK (char_length(client_request_id) BETWEEN 1 AND 64),
      CONSTRAINT article_comment_requests_subject_request UNIQUE (subject_id, client_request_id)
    );
  `);
}

// 196：个人提醒偏好（四项独立开关），按账号主体单行存储。
// 主键挂 users.subject_id：删号即随外键清理，同名重注册不会继承上一个人的设置。
async function migration196NotificationPreferences() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.notification_preferences (
      subject_id UUID PRIMARY KEY REFERENCES public.users(subject_id) ON DELETE CASCADE,
      article_comment BOOLEAN NOT NULL DEFAULT TRUE,
      comment_reply BOOLEAN NOT NULL DEFAULT TRUE,
      comment_mention BOOLEAN NOT NULL DEFAULT TRUE,
      feedback_implemented BOOLEAN NOT NULL DEFAULT TRUE,
      version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { migration195CommentNotification, migration196NotificationPreferences };
