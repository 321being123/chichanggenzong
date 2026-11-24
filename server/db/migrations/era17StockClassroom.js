// 210：股市模拟沙盘（教学课堂）独立账本与场次状态表。
// 与真实账户/持仓表完全隔离，所有金额以人民币分（BIGINT）存储。
async function ensureSchema(pool, name) {
  const { rows } = await pool.query(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
    [name]
  );
  if (!rows[0]) await pool.query(`CREATE SCHEMA ${name}`);
}

async function migration210StockClassroom(pool) {
  await pool.query(`

    CREATE TABLE IF NOT EXISTS public.classroom_classrooms (
      classroom_id BIGSERIAL PRIMARY KEY,
      classroom_code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('real', 'demo')),
      blind_mode BOOLEAN NOT NULL DEFAULT TRUE,
      identity_revealed BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'configuring', 'locked', 'revealed', 'completed')),
      current_round SMALLINT NOT NULL DEFAULT 1 CHECK (current_round BETWEEN 1 AND 15),
      state_version BIGINT NOT NULL DEFAULT 1,
      initial_cash_cents BIGINT NOT NULL DEFAULT 100000000 CHECK (initial_cash_cents > 0),
      start_year SMALLINT NOT NULL,
      end_year SMALLINT NOT NULL,
      total_rounds SMALLINT NOT NULL DEFAULT 15 CHECK (total_rounds = 15),
      created_by_subject_id TEXT NOT NULL,
      created_by_username TEXT NOT NULL,
      scenario_snapshot JSONB NOT NULL,
      precheck_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS public.classroom_rounds (
      round_id BIGSERIAL PRIMARY KEY,
      classroom_id BIGINT NOT NULL REFERENCES public.classroom_classrooms(classroom_id) ON DELETE CASCADE,
      round_no SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 15),
      calendar_year SMALLINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'configuring', 'locked', 'revealed')),
      state_version BIGINT NOT NULL DEFAULT 1,
      open_market_snapshot JSONB NOT NULL,
      settled_market_snapshot JSONB,
      locked_at TIMESTAMPTZ,
      revealed_at TIMESTAMPTZ,
      locked_participant_count INTEGER NOT NULL DEFAULT 0,
      locked_submitted_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (classroom_id, round_no)
    );

    CREATE TABLE IF NOT EXISTS public.classroom_members (
      member_id BIGSERIAL PRIMARY KEY,
      classroom_id BIGINT NOT NULL REFERENCES public.classroom_classrooms(classroom_id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL,
      username TEXT NOT NULL,
      classroom_nickname TEXT NOT NULL,
      display_nickname TEXT NOT NULL,
      is_nickname_masked BOOLEAN NOT NULL DEFAULT FALSE,
      first_eligible_round SMALLINT NOT NULL CHECK (first_eligible_round BETWEEN 1 AND 16),
      after_class_note TEXT NOT NULL DEFAULT '',
      after_class_note_updated_at TIMESTAMPTZ,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (classroom_id, subject_id),
      UNIQUE (classroom_id, display_nickname)
    );
    CREATE INDEX IF NOT EXISTS ix_classroom_members_subject_id
      ON public.classroom_members (subject_id, joined_at DESC);

    CREATE TABLE IF NOT EXISTS public.classroom_member_round_states (
      id BIGSERIAL PRIMARY KEY,
      classroom_id BIGINT NOT NULL REFERENCES public.classroom_classrooms(classroom_id) ON DELETE CASCADE,
      round_no SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 15),
      member_id BIGINT NOT NULL REFERENCES public.classroom_members(member_id) ON DELETE CASCADE,
      opening_total_cents BIGINT NOT NULL CHECK (opening_total_cents >= 0),
      default_allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
      default_cash_cents BIGINT NOT NULL CHECK (default_cash_cents >= 0),
      liquidation_events JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (classroom_id, round_no, member_id)
    );

    CREATE TABLE IF NOT EXISTS public.classroom_drafts (
      draft_id BIGSERIAL PRIMARY KEY,
      classroom_id BIGINT NOT NULL REFERENCES public.classroom_classrooms(classroom_id) ON DELETE CASCADE,
      round_no SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 15),
      member_id BIGINT NOT NULL REFERENCES public.classroom_members(member_id) ON DELETE CASCADE,
      allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
      draft_version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (classroom_id, round_no, member_id)
    );

    CREATE TABLE IF NOT EXISTS public.classroom_submissions (
      submission_id BIGSERIAL PRIMARY KEY,
      classroom_id BIGINT NOT NULL REFERENCES public.classroom_classrooms(classroom_id) ON DELETE CASCADE,
      round_no SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 15),
      member_id BIGINT NOT NULL REFERENCES public.classroom_members(member_id) ON DELETE CASCADE,
      allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
      cash_cents BIGINT NOT NULL CHECK (cash_cents >= 0),
      total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
      client_request_id TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      is_latest BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE (classroom_id, round_no, member_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS ix_classroom_submissions_latest
      ON public.classroom_submissions (classroom_id, round_no, member_id)
      WHERE is_latest = TRUE;

    CREATE TABLE IF NOT EXISTS public.classroom_settlements (
      settlement_id BIGSERIAL PRIMARY KEY,
      classroom_id BIGINT NOT NULL REFERENCES public.classroom_classrooms(classroom_id) ON DELETE CASCADE,
      round_no SMALLINT NOT NULL CHECK (round_no BETWEEN 1 AND 15),
      member_id BIGINT NOT NULL REFERENCES public.classroom_members(member_id) ON DELETE CASCADE,
      participation_type TEXT NOT NULL CHECK (participation_type IN ('submitted', 'carried_over', 'late_backfill')),
      is_official_ranked BOOLEAN NOT NULL DEFAULT TRUE,
      opening_total_cents BIGINT NOT NULL CHECK (opening_total_cents >= 0),
      ending_total_cents BIGINT NOT NULL CHECK (ending_total_cents >= 0),
      round_pnl_cents BIGINT NOT NULL,
      ending_cash_cents BIGINT NOT NULL CHECK (ending_cash_cents >= 0),
      item_details JSONB NOT NULL DEFAULT '[]'::jsonb,
      official_rank INTEGER,
      reference_rank INTEGER,
      official_participant_count INTEGER NOT NULL DEFAULT 0,
      settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (classroom_id, round_no, member_id)
    );
    CREATE INDEX IF NOT EXISTS ix_classroom_settlements_round_rank
      ON public.classroom_settlements (classroom_id, round_no, is_official_ranked, ending_total_cents DESC);
  `);
}

// 211：股市模拟沙盘建场预览快照与幂等确认表。
async function migration211StockClassroomPreview(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.classroom_creation_previews (
      preview_id TEXT PRIMARY KEY,
      admin_subject_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('real', 'demo')),
      start_year SMALLINT NOT NULL,
      data_version TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL,
      confirmed_classroom_id BIGINT REFERENCES public.classroom_classrooms(classroom_id) ON DELETE SET NULL,
      confirm_request_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ix_classroom_creation_previews_admin
      ON public.classroom_creation_previews (admin_subject_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_classroom_creation_previews_confirm_req
      ON public.classroom_creation_previews (admin_subject_id, confirm_request_id)
      WHERE confirm_request_id IS NOT NULL;
  `);
}

module.exports = {
  migration210StockClassroom,
  migration211StockClassroomPreview,
};
