// 170：意见反馈与版本发布闭环（2026-10-23）
// 契约见 docs/意见反馈与版本发布闭环研发方案_20261023.md 第五节。
// 归属：主体/回复/附件/业务处理历史放 public；发布运行与核对明细放 ops（运维批次职责）。
// 本文件只建表、约束与索引；执行顺序以 ../migrations.js 的 MIGRATIONS 注册表为准，禁止在本文件内重排。
const { pool } = require('../connection');

// 2026-10-23 生产部署实录：PostgreSQL 的 CREATE SCHEMA IF NOT EXISTS 会先检查
// 【库级】CREATE 权限再看模式是否存在——生产迁移账号只有模式内建表权限、没有
// 库级 CREATE，于是 ops 已存在仍报 "permission denied for database portfolio"。
// 因此模式缺失时才建（本地/测试为超级用户可建；生产模式早已存在则完全不发这条语句）。
async function ensureSchema(name) {
  const { rows } = await pool.query(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [name]
  );
  if (!rows[0]) await pool.query('CREATE SCHEMA ' + name);
}

async function migration170FeedbackModule() {
  await ensureSchema('ops');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.feedbacks (
      id BIGSERIAL PRIMARY KEY,
      author_username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
      author_nickname_snapshot TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('bug','improvement','feature')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      page_path TEXT NOT NULL DEFAULT '',
      submitted_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','needs_info','accepted','in_progress','implemented','duplicate','declined')),
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
      moderation TEXT NOT NULL DEFAULT 'normal' CHECK (moderation IN ('normal','hidden')),
      moderation_reason TEXT NOT NULL DEFAULT '',
      withdrawn_at TIMESTAMPTZ,
      duplicate_of BIGINT REFERENCES public.feedbacks(id) ON DELETE SET NULL,
      implemented_version TEXT,
      implemented_release_sha TEXT,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      client_request_id TEXT,
      request_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT feedbacks_title_len CHECK (char_length(title) BETWEEN 1 AND 100),
      CONSTRAINT feedbacks_desc_len CHECK (char_length(description) BETWEEN 1 AND 5000),
      CONSTRAINT feedbacks_page_path_len CHECK (char_length(page_path) <= 1000),
      CONSTRAINT feedbacks_no_self_duplicate CHECK (duplicate_of IS NULL OR duplicate_of <> id),
      CONSTRAINT feedbacks_duplicate_pairing CHECK (
        (status = 'duplicate' AND duplicate_of IS NOT NULL) OR (status <> 'duplicate' AND duplicate_of IS NULL)
      ),
      CONSTRAINT feedbacks_implemented_pairing CHECK (
        (status = 'implemented' AND implemented_version IS NOT NULL AND implemented_release_sha IS NOT NULL)
        OR (status <> 'implemented' AND implemented_version IS NULL AND implemented_release_sha IS NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_feedbacks_author_request
      ON public.feedbacks(author_username, client_request_id)
      WHERE author_username IS NOT NULL AND client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_feedbacks_author_created ON public.feedbacks(author_username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedbacks_public_created
      ON public.feedbacks(created_at DESC)
      WHERE visibility = 'public' AND moderation = 'normal' AND withdrawn_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_feedbacks_status_created ON public.feedbacks(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedbacks_updated ON public.feedbacks(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feedbacks_implemented_version
      ON public.feedbacks(implemented_version)
      WHERE status = 'implemented';

    CREATE TABLE IF NOT EXISTS public.feedback_comments (
      id BIGSERIAL PRIMARY KEY,
      feedback_id BIGINT NOT NULL REFERENCES public.feedbacks(id) ON DELETE CASCADE,
      author_username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
      author_nickname_snapshot TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      is_official BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      hidden_at TIMESTAMPTZ,
      hidden_reason TEXT NOT NULL DEFAULT '',
      client_request_id TEXT,
      request_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT feedback_comments_content_len CHECK (char_length(content) BETWEEN 1 AND 2000)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_comments_author_request
      ON public.feedback_comments(author_username, client_request_id)
      WHERE author_username IS NOT NULL AND client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_feedback_comments_feedback_time
      ON public.feedback_comments(feedback_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS public.feedback_attachments (
      id BIGSERIAL PRIMARY KEY,
      feedback_id BIGINT NOT NULL REFERENCES public.feedbacks(id) ON DELETE CASCADE,
      uploader_username TEXT REFERENCES public.users(username) ON DELETE SET NULL,
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
      sha256 TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
      height INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
      compression_version TEXT NOT NULL DEFAULT 'webp-v1',
      client_request_id TEXT,
      request_hash TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      removed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_attachments_request
      ON public.feedback_attachments(feedback_id, client_request_id, sort_order)
      WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_feedback_attachments_feedback_order
      ON public.feedback_attachments(feedback_id, sort_order ASC);

    CREATE TABLE IF NOT EXISTS public.feedback_events (
      id BIGSERIAL PRIMARY KEY,
      feedback_id BIGINT NOT NULL REFERENCES public.feedbacks(id) ON DELETE CASCADE,
      actor_username TEXT,
      actor_source TEXT NOT NULL DEFAULT 'user' CHECK (actor_source IN ('user','admin','release','system')),
      event_type TEXT NOT NULL,
      status_from TEXT,
      status_to TEXT,
      summary TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      revision BIGINT NOT NULL DEFAULT 0,
      release_run_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_events_feedback_time
      ON public.feedback_events(feedback_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS ops.feedback_release_runs (
      id BIGSERIAL PRIMARY KEY,
      deployment_id UUID NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('production')),
      release_sha TEXT NOT NULL,
      app_version TEXT NOT NULL,
      base_deployed_sha TEXT NOT NULL DEFAULT '',
      manifest_hash TEXT NOT NULL DEFAULT '',
      review_policy_version TEXT NOT NULL DEFAULT '2026-10-23',
      snapshot_at TIMESTAMPTZ,
      snapshot_count INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
      snapshot_complete BOOLEAN NOT NULL DEFAULT false,
      owner TEXT NOT NULL DEFAULT '',
      prepare_status TEXT NOT NULL DEFAULT 'draft' CHECK (prepare_status IN ('draft','prepared','frozen')),
      verify_status TEXT NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','passed','failed')),
      apply_status TEXT NOT NULL DEFAULT 'pending' CHECK (apply_status IN ('pending','partial','applied','failed','rolled_back')),
      verify_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT feedback_release_runs_env_deployment UNIQUE (environment, deployment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_release_runs_sha ON ops.feedback_release_runs(release_sha);

    CREATE TABLE IF NOT EXISTS ops.feedback_release_items (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES ops.feedback_release_runs(id) ON DELETE CASCADE,
      feedback_id BIGINT NOT NULL,
      expected_revision BIGINT NOT NULL,
      expected_status TEXT NOT NULL,
      conclusion TEXT NOT NULL DEFAULT 'pending' CHECK (conclusion IN ('pending','solved','partial','unrelated','needs_review')),
      implementation_commit TEXT NOT NULL DEFAULT '',
      evidence_summary TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL DEFAULT '',
      apply_status TEXT NOT NULL DEFAULT 'pending' CHECK (apply_status IN ('pending','applied','skipped','conflict','failed','rolled_back')),
      apply_error TEXT NOT NULL DEFAULT '',
      revision_before BIGINT,
      revision_after BIGINT,
      applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT feedback_release_items_run_feedback UNIQUE (run_id, feedback_id)
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_release_items_feedback
      ON ops.feedback_release_items(feedback_id, run_id DESC);
  `);
}

// 171：反馈发布回滚状态（2026-10-23 验收 A-04）
// 已执行过 170 的存量库补带 'rolled_back' 终态；新库由 170 建好，本步幂等跳过。
async function migration171FeedbackReleaseRollback() {
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'feedback_release_runs_apply_status_check'
           AND conrelid = 'ops.feedback_release_runs'::regclass
      ) THEN
        ALTER TABLE ops.feedback_release_runs DROP CONSTRAINT feedback_release_runs_apply_status_check;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'feedback_release_items_apply_status_check'
           AND conrelid = 'ops.feedback_release_items'::regclass
      ) THEN
        ALTER TABLE ops.feedback_release_items DROP CONSTRAINT feedback_release_items_apply_status_check;
      END IF;
    END $$;

    ALTER TABLE ops.feedback_release_runs
      ADD CONSTRAINT feedback_release_runs_apply_status_check
      CHECK (apply_status IN ('pending','partial','applied','failed','rolled_back'));

    ALTER TABLE ops.feedback_release_items
      ADD CONSTRAINT feedback_release_items_apply_status_check
      CHECK (apply_status IN ('pending','applied','skipped','conflict','failed','rolled_back'));
  `);
}

module.exports = { migration170FeedbackModule, migration171FeedbackReleaseRollback };
