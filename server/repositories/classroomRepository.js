'use strict';

const { pool } = require('../db/connection');

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 在 REPEATABLE READ READ ONLY 事务中执行只读查询，确保预检事实与数据版本来自同一一致快照。
 */
async function withReadOnlySnapshot(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

function q(client) {
  return client || pool;
}

// 建场选项的共享基础事实：一次快照内取数据版本与转债校准样本，
// 供「可用窗口」逐窗口复用，避免每个候选窗口重复全表扫描。
async function fetchCreationWindowBase({ startDate, endDate }, client) {
  const dataVersion = await fetchFactsDataVersion({ startDate, endDate }, client);
  const [cbStats, cbBuckets] = await Promise.all([
    fetchCbCalibrationSampleStats(client),
    fetchCbCalibrationBuckets(client),
  ]);
  return { dataVersion, cbStats, cbBuckets };
}

// ---------- 只读市场事实查询（用于建场预检与真实剧本构建）----------

async function fetchCnOpenTradeDates(startDate, endDate, client) {
  const { rows } = await q(client).query(
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date
     FROM market.trade_calendar
     WHERE exchange = 'SSE'
       AND is_open = TRUE
       AND trade_date >= $1::date
       AND trade_date <= $2::date
     ORDER BY trade_date ASC`,
    [startDate, endDate]
  );
  return rows.map((r) => r.trade_date);
}

async function fetchInstrumentsByCodes(codes, client) {
  if (!codes || codes.length === 0) return [];
  const { rows } = await q(client).query(
    `SELECT i.instrument_id, i.canonical_code, i.name, i.market, i.asset_class,
            to_char(i.list_date, 'YYYY-MM-DD') AS list_date,
            to_char(i.delist_date, 'YYYY-MM-DD') AS delist_date,
            i.status,
            sw.industry_node_id,
            COALESCE(sw.industry_code, '') AS industry_code,
            COALESCE(sw.industry_name, '') AS sw_industry_name,
            COALESCE(sw.taxonomy_code, '') AS taxonomy_code
     FROM core.instruments i
     LEFT JOIN core.company_instruments ci
       ON ci.instrument_id = i.instrument_id AND ci.relation_type = 'issued_by'
     LEFT JOIN LATERAL (
       SELECT n.industry_node_id, n.industry_code, n.industry_name, t.taxonomy_code
       FROM core.company_industry_memberships cim
       JOIN core.industry_nodes n
         ON n.industry_node_id = cim.industry_node_id
       JOIN core.industry_taxonomies t
         ON t.taxonomy_id = n.taxonomy_id AND t.taxonomy_code = 'SW2021'
       WHERE cim.company_id = ci.company_id AND cim.is_current = TRUE
       ORDER BY n.industry_node_id ASC
       LIMIT 1
     ) sw ON TRUE
     WHERE i.canonical_code = ANY($1::text[])
       AND i.market = 'CN'
       AND i.asset_class = 'stock'`,
    [codes]
  );
  return rows;
}

async function fetchDailyBarsWithAdj(instrumentIds, startDate, endDate, client) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await q(client).query(
    `SELECT b.instrument_id,
            to_char(b.trade_date, 'YYYY-MM-DD') AS trade_date,
            b.close::text AS close,
            b.price_adjust,
            b.bar_status,
            b.quality_status,
            af.adj_factor::text AS adj_factor
     FROM market.daily_bars b
     LEFT JOIN market.adjustment_factors af
       ON af.instrument_id = b.instrument_id AND af.trade_date = b.trade_date
     WHERE b.instrument_id = ANY($1::bigint[])
       AND b.trade_date >= $2::date
       AND b.trade_date <= $3::date
     ORDER BY b.instrument_id, b.trade_date ASC`,
    [instrumentIds, startDate, endDate]
  );
  return rows;
}

async function fetchSuspensions(instrumentIds, startDate, endDate, client) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await q(client).query(
    `SELECT instrument_id,
            to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
            suspend_type,
            suspend_reason
     FROM market.stock_suspend_calendar
     WHERE instrument_id = ANY($1::bigint[])
       AND trade_date >= $2::date
       AND trade_date <= $3::date`,
    [instrumentIds, startDate, endDate]
  );
  return rows;
}

async function fetchDailyValuations(instrumentIds, startDate, endDate, client) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await q(client).query(
    `SELECT instrument_id,
            to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
            pe_ttm::text AS pe_ttm,
            pb::text AS pb,
            total_market_cap::text AS total_market_cap
     FROM market.daily_valuations
     WHERE instrument_id = ANY($1::bigint[])
       AND trade_date >= $2::date
       AND trade_date <= $3::date
     ORDER BY instrument_id, trade_date ASC`,
    [instrumentIds, startDate, endDate]
  );
  return rows;
}

async function fetchBondWealthIndexCoverage(startDate, endDate, client) {
  const { rows } = await q(client).query(
    `SELECT index_code,
            COUNT(*)::int AS cnt,
            to_char(MIN(trade_date), 'YYYY-MM-DD') AS min_date,
            to_char(MAX(trade_date), 'YYYY-MM-DD') AS max_date
     FROM market.index_valuation_history
     WHERE index_code IN ('CBA00601', 'CN10Y_WEALTH', 'CHINABOND_7_10Y_WEALTH')
       AND trade_date >= $1::date
       AND trade_date <= $2::date
     GROUP BY index_code`,
    [startDate, endDate]
  );
  return rows;
}

async function fetchBondWealthIndexSeries(startDate, endDate, client) {
  const { rows } = await q(client).query(
    `SELECT index_code,
            to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
            close::text AS close
     FROM market.index_valuation_history
     WHERE index_code IN ('CBA00601', 'CN10Y_WEALTH', 'CHINABOND_7_10Y_WEALTH')
       AND trade_date >= $1::date
       AND trade_date <= $2::date
       AND close IS NOT NULL
       AND close > 0
     ORDER BY index_code, trade_date ASC`,
    [startDate, endDate]
  );
  return rows;
}

async function fetchSovereignYieldCount(startDate, endDate, client) {
  const { rows } = await q(client).query(
    `SELECT COUNT(*)::int AS cnt,
            to_char(MIN(trade_date), 'YYYY-MM-DD') AS min_date,
            to_char(MAX(trade_date), 'YYYY-MM-DD') AS max_date
     FROM market.sovereign_yield_daily
     WHERE market_code = 'CN' AND tenor_years = 10
       AND trade_date >= $1::date AND trade_date <= $2::date`,
    [startDate, endDate]
  );
  return rows[0] || { cnt: 0, min_date: null, max_date: null };
}

async function fetchCbCalibrationSampleStats(client) {
  const { rows } = await q(client).query(
    `SELECT COUNT(*)::int AS cnt,
            COUNT(DISTINCT instrument_id)::int AS cb_count,
            to_char(MIN(trade_date), 'YYYY-MM-DD') AS min_date,
            to_char(MAX(trade_date), 'YYYY-MM-DD') AS max_date,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY conversion_premium_pct) FILTER (WHERE conversion_premium_pct IS NOT NULL AND conversion_premium_pct > -50 AND conversion_premium_pct < 300) AS median_premium_pct,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY bond_premium_pct) FILTER (WHERE bond_premium_pct IS NOT NULL AND bond_premium_pct > -20 AND bond_premium_pct < 200) AS median_bond_premium_pct
     FROM market.convertible_bond_daily_metrics`
  );
  return rows[0] || { cnt: 0, cb_count: 0, min_date: null, max_date: null, median_premium_pct: null, median_bond_premium_pct: null };
}

async function fetchCbCalibrationBuckets(client) {
  const { rows } = await q(client).query(
    `WITH base AS (
       SELECT m.instrument_id,
              m.conversion_value,
              m.conversion_premium_pct,
              m.bond_premium_pct,
              CASE
                WHEN bu.maturity_date IS NOT NULL THEN (bu.maturity_date - m.trade_date)::numeric / 365.25
                WHEN (m.raw_payload->>'remain_years') ~ '^\\d+(?:\\.\\d+)?$' THEN (m.raw_payload->>'remain_years')::numeric
                ELSE NULL
              END AS remain_years
       FROM market.convertible_bond_daily_metrics m
       LEFT JOIN public.bond_unified bu ON bu.instrument_id = m.instrument_id
       WHERE m.conversion_value IS NOT NULL
         AND m.conversion_value > 0
         AND m.conversion_premium_pct IS NOT NULL
         AND m.conversion_premium_pct > -50
         AND m.conversion_premium_pct < 300
     ),
     bucketed AS (
       SELECT instrument_id,
              conversion_premium_pct,
              bond_premium_pct,
              CASE
                WHEN remain_years <= 2 THEN 'short'
                WHEN remain_years <= 4 THEN 'mid'
                ELSE 'long'
              END AS tenor_bucket,
              CASE
                WHEN conversion_value < 90 THEN 'otm'
                WHEN conversion_value <= 115 THEN 'atm'
                ELSE 'itm'
              END AS moneyness_bucket
       FROM base
       WHERE remain_years IS NOT NULL AND remain_years > 0
     )
     SELECT tenor_bucket,
            moneyness_bucket,
            COUNT(*)::int AS cnt,
            COUNT(*) FILTER (WHERE conversion_premium_pct IS NOT NULL AND conversion_premium_pct > -50 AND conversion_premium_pct < 300)::int AS premium_cnt,
            COUNT(*) FILTER (WHERE bond_premium_pct IS NOT NULL AND bond_premium_pct > -20 AND bond_premium_pct < 200)::int AS bond_premium_cnt,
            COUNT(DISTINCT instrument_id)::int AS cb_count,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY conversion_premium_pct) FILTER (WHERE conversion_premium_pct IS NOT NULL AND conversion_premium_pct > -50 AND conversion_premium_pct < 300) AS median_premium_pct,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY bond_premium_pct) FILTER (WHERE bond_premium_pct IS NOT NULL AND bond_premium_pct > -20 AND bond_premium_pct < 200) AS median_bond_premium_pct
     FROM bucketed
     GROUP BY tenor_bucket, moneyness_bucket
     ORDER BY tenor_bucket, moneyness_bucket`
  );
  return rows;
}

// ---------- 沙盘场次、轮次、成员、草稿、提交、结算 ----------

async function insertClassroom(client, data) {
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_classrooms (
       classroom_code, title, mode, blind_mode, identity_revealed, status,
       current_round, state_version, initial_cash_cents, start_year, end_year,
       total_rounds, created_by_subject_id, created_by_username,
       scenario_snapshot, precheck_summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      data.classroomCode,
      data.title,
      data.mode,
      data.blindMode,
      Boolean(data.identityRevealed),
      data.status || 'pending',
      data.currentRound || 1,
      1,
      data.initialCashCents,
      data.startYear,
      data.endYear,
      data.totalRounds || 15,
      data.createdBySubjectId,
      data.createdByUsername,
      JSON.stringify(data.scenarioSnapshot),
      JSON.stringify(data.precheckSummary || {}),
    ]
  );
  return rows[0];
}

async function findClassroomById(id, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_classrooms WHERE classroom_id = $1',
    [id]
  );
  return rows[0] || null;
}

async function findClassroomByIdForUpdate(client, id) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_classrooms WHERE classroom_id = $1 FOR UPDATE',
    [id]
  );
  return rows[0] || null;
}

async function findClassroomByCode(code, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_classrooms WHERE classroom_code = $1',
    [String(code || '').trim().toUpperCase()]
  );
  return rows[0] || null;
}

async function listClassroomsForAdmin({ page = 1, pageSize = 100 } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 100));
  const offset = (safePage - 1) * safeSize;
  const [{ rows: countRows }, { rows }] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM public.classroom_classrooms'),
    pool.query(
      `SELECT c.classroom_id, c.classroom_code, c.title, c.mode, c.blind_mode,
              c.identity_revealed, c.status, c.current_round, c.state_version,
              c.start_year, c.end_year, c.total_rounds, c.created_at, c.completed_at,
              COUNT(m.member_id)::int AS member_count
       FROM public.classroom_classrooms c
       LEFT JOIN public.classroom_members m ON m.classroom_id = c.classroom_id
       GROUP BY c.classroom_id
       ORDER BY c.created_at DESC, c.classroom_id DESC
       LIMIT $1 OFFSET $2`,
      [safeSize, offset]
    ),
  ]);
  const total = Number(countRows[0]?.total || 0);
  return {
    items: rows,
    total,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil(total / safeSize)),
  };
}

async function listClassroomsForSubject(subjectId) {
  const { rows } = await pool.query(
    `SELECT c.classroom_id, c.classroom_code, c.title, c.mode, c.blind_mode,
            c.identity_revealed, c.status, c.current_round, c.state_version,
            c.start_year, c.end_year, c.total_rounds, c.initial_cash_cents,
            c.created_at, c.completed_at,
            m.member_id, m.display_nickname, m.first_eligible_round, m.joined_at,
            (
              SELECT s.ending_total_cents
              FROM public.classroom_settlements s
              WHERE s.classroom_id = c.classroom_id AND s.member_id = m.member_id
              ORDER BY s.round_no DESC
              LIMIT 1
            ) AS latest_ending_total_cents,
            (
              SELECT s.round_no
              FROM public.classroom_settlements s
              WHERE s.classroom_id = c.classroom_id AND s.member_id = m.member_id
              ORDER BY s.round_no DESC
              LIMIT 1
            ) AS latest_settled_round
     FROM public.classroom_members m
     JOIN public.classroom_classrooms c ON c.classroom_id = m.classroom_id
     WHERE m.subject_id = $1
     ORDER BY m.joined_at DESC`,
    [String(subjectId)]
  );
  return rows;
}

async function updateClassroomState(client, classroomId, fields) {
  const sets = ['updated_at = now()'];
  const vals = [];
  let idx = 1;
  if (fields.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(fields.status); }
  if (fields.currentRound !== undefined) { sets.push(`current_round = $${idx++}`); vals.push(fields.currentRound); }
  if (fields.stateVersion !== undefined) { sets.push(`state_version = $${idx++}`); vals.push(fields.stateVersion); }
  if (fields.identityRevealed !== undefined) { sets.push(`identity_revealed = $${idx++}`); vals.push(fields.identityRevealed); }
  if (fields.completedAt !== undefined) { sets.push(`completed_at = $${idx++}`); vals.push(fields.completedAt); }
  vals.push(classroomId);
  const { rows } = await q(client).query(
    `UPDATE public.classroom_classrooms SET ${sets.join(', ')} WHERE classroom_id = $${idx} RETURNING *`,
    vals
  );
  return rows[0];
}

async function deleteClassroom(client, classroomId) {
  const { rows } = await q(client).query(
    `DELETE FROM public.classroom_classrooms WHERE classroom_id = $1 RETURNING classroom_id, classroom_code, title`,
    [classroomId]
  );
  return rows[0] || null;
}

async function insertRound(client, data) {
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_rounds (
       classroom_id, round_no, calendar_year, status, state_version, open_market_snapshot
     ) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      data.classroomId,
      data.roundNo,
      data.calendarYear,
      data.status || 'configuring',
      1,
      JSON.stringify(data.openMarketSnapshot),
    ]
  );
  return rows[0];
}

async function findRound(classroomId, roundNo, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_rounds WHERE classroom_id = $1 AND round_no = $2',
    [classroomId, roundNo]
  );
  return rows[0] || null;
}

async function findRoundForUpdate(client, classroomId, roundNo) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_rounds WHERE classroom_id = $1 AND round_no = $2 FOR UPDATE',
    [classroomId, roundNo]
  );
  return rows[0] || null;
}

async function listRounds(classroomId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_rounds WHERE classroom_id = $1 ORDER BY round_no ASC',
    [classroomId]
  );
  return rows;
}

async function updateRoundState(client, roundId, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;
  if (fields.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(fields.status); }
  if (fields.stateVersion !== undefined) { sets.push(`state_version = $${idx++}`); vals.push(fields.stateVersion); }
  if (fields.settledMarketSnapshot !== undefined) { sets.push(`settled_market_snapshot = $${idx++}`); vals.push(JSON.stringify(fields.settledMarketSnapshot)); }
  if (fields.lockedAt !== undefined) { sets.push(`locked_at = $${idx++}`); vals.push(fields.lockedAt); }
  if (fields.revealedAt !== undefined) { sets.push(`revealed_at = $${idx++}`); vals.push(fields.revealedAt); }
  if (fields.lockedParticipantCount !== undefined) { sets.push(`locked_participant_count = $${idx++}`); vals.push(fields.lockedParticipantCount); }
  if (fields.lockedSubmittedCount !== undefined) { sets.push(`locked_submitted_count = $${idx++}`); vals.push(fields.lockedSubmittedCount); }
  vals.push(roundId);
  const { rows } = await q(client).query(
    `UPDATE public.classroom_rounds SET ${sets.join(', ')} WHERE round_id = $${idx} RETURNING *`,
    vals
  );
  return rows[0];
}

async function findMemberBySubject(classroomId, subjectId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_members WHERE classroom_id = $1 AND subject_id = $2',
    [classroomId, String(subjectId)]
  );
  return rows[0] || null;
}

async function findMemberById(classroomId, memberId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_members WHERE classroom_id = $1 AND member_id = $2',
    [classroomId, memberId]
  );
  return rows[0] || null;
}

async function listMembers(classroomId, client) {
  const { rows } = await q(client).query(
    'SELECT * FROM public.classroom_members WHERE classroom_id = $1 ORDER BY member_id ASC',
    [classroomId]
  );
  return rows;
}

async function listNicknames(classroomId, client) {
  const { rows } = await q(client).query(
    'SELECT display_nickname FROM public.classroom_members WHERE classroom_id = $1',
    [classroomId]
  );
  return rows.map((r) => r.display_nickname);
}

async function insertMember(client, data) {
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_members (
       classroom_id, subject_id, username, classroom_nickname, display_nickname, first_eligible_round
     ) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      data.classroomId,
      String(data.subjectId),
      data.username,
      data.classroomNickname,
      data.displayNickname,
      data.firstEligibleRound,
    ]
  );
  return rows[0];
}

async function updateMemberNickname(classroomId, memberId, displayNickname, isMasked) {
  const { rows } = await pool.query(
    `UPDATE public.classroom_members
     SET display_nickname = $1, is_nickname_masked = $2
     WHERE classroom_id = $3 AND member_id = $4
     RETURNING *`,
    [displayNickname, Boolean(isMasked), classroomId, memberId]
  );
  return rows[0] || null;
}

async function updateMemberNote(classroomId, memberId, note) {
  const { rows } = await pool.query(
    `UPDATE public.classroom_members
     SET after_class_note = $1, after_class_note_updated_at = now()
     WHERE classroom_id = $2 AND member_id = $3
     RETURNING after_class_note, after_class_note_updated_at`,
    [String(note || ''), classroomId, memberId]
  );
  return rows[0] || null;
}

async function findMemberRoundState(classroomId, roundNo, memberId, client) {
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_member_round_states
     WHERE classroom_id = $1 AND round_no = $2 AND member_id = $3`,
    [classroomId, roundNo, memberId]
  );
  return rows[0] || null;
}

async function upsertMemberRoundState(client, data) {
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_member_round_states (
       classroom_id, round_no, member_id, opening_total_cents,
       default_allocations, default_cash_cents, liquidation_events
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (classroom_id, round_no, member_id) DO NOTHING
     RETURNING *`,
    [
      data.classroomId,
      data.roundNo,
      data.memberId,
      data.openingTotalCents,
      JSON.stringify(data.defaultAllocations || {}),
      data.defaultCashCents,
      JSON.stringify(data.liquidationEvents || []),
    ]
  );
  if (rows[0]) return rows[0];
  return findMemberRoundState(data.classroomId, data.roundNo, data.memberId, client);
}

async function findDraft(classroomId, roundNo, memberId, client) {
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_drafts
     WHERE classroom_id = $1 AND round_no = $2 AND member_id = $3`,
    [classroomId, roundNo, memberId]
  );
  return rows[0] || null;
}

async function saveDraftWithVersion(client, { classroomId, roundNo, memberId, allocations, expectedVersion }) {
  const existing = await q(client).query(
    `SELECT * FROM public.classroom_drafts
     WHERE classroom_id = $1 AND round_no = $2 AND member_id = $3
     FOR UPDATE`,
    [classroomId, roundNo, memberId]
  );
  if (existing.rows.length === 0) {
    if (expectedVersion !== 0 && expectedVersion !== null && expectedVersion !== undefined) {
      return { conflict: true, current: null };
    }
    const ins = await q(client).query(
      `INSERT INTO public.classroom_drafts (classroom_id, round_no, member_id, allocations, draft_version)
       VALUES ($1,$2,$3,$4,1) RETURNING *`,
      [classroomId, roundNo, memberId, JSON.stringify(allocations)]
    );
    return { conflict: false, draft: ins.rows[0] };
  }
  const cur = existing.rows[0];
  if (Number(expectedVersion) !== Number(cur.draft_version)) {
    return { conflict: true, current: cur };
  }
  const upd = await q(client).query(
    `UPDATE public.classroom_drafts
     SET allocations = $1, draft_version = draft_version + 1, updated_at = now()
     WHERE draft_id = $2
     RETURNING *`,
    [JSON.stringify(allocations), cur.draft_id]
  );
  return { conflict: false, draft: upd.rows[0] };
}

async function findSubmissionByRequestId(client, classroomId, roundNo, memberId, clientRequestId) {
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_submissions
     WHERE classroom_id = $1 AND round_no = $2 AND member_id = $3 AND client_request_id = $4`,
    [classroomId, roundNo, memberId, clientRequestId]
  );
  return rows[0] || null;
}

async function findLatestSubmission(classroomId, roundNo, memberId, client) {
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_submissions
     WHERE classroom_id = $1 AND round_no = $2 AND member_id = $3 AND is_latest = TRUE
     ORDER BY submission_id DESC LIMIT 1`,
    [classroomId, roundNo, memberId]
  );
  return rows[0] || null;
}

async function listLatestSubmissions(classroomId, roundNo, client) {
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_submissions
     WHERE classroom_id = $1 AND round_no = $2 AND is_latest = TRUE`,
    [classroomId, roundNo]
  );
  return rows;
}

async function insertSubmission(client, data) {
  await q(client).query(
    `UPDATE public.classroom_submissions
     SET is_latest = FALSE
     WHERE classroom_id = $1 AND round_no = $2 AND member_id = $3 AND is_latest = TRUE`,
    [data.classroomId, data.roundNo, data.memberId]
  );
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_submissions (
       classroom_id, round_no, member_id, allocations, cash_cents, total_cents, client_request_id, is_latest
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
     RETURNING *`,
    [
      data.classroomId,
      data.roundNo,
      data.memberId,
      JSON.stringify(data.allocations),
      data.cashCents,
      data.totalCents,
      data.clientRequestId,
    ]
  );
  return rows[0];
}

async function insertSettlement(client, data) {
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_settlements (
       classroom_id, round_no, member_id, participation_type, is_official_ranked,
       opening_total_cents, ending_total_cents, round_pnl_cents, ending_cash_cents,
       item_details, official_rank, reference_rank, official_participant_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (classroom_id, round_no, member_id) DO NOTHING
     RETURNING *`,
    [
      data.classroomId,
      data.roundNo,
      data.memberId,
      data.participationType,
      Boolean(data.isOfficialRanked),
      data.openingTotalCents,
      data.endingTotalCents,
      data.roundPnlCents,
      data.endingCashCents,
      JSON.stringify(data.itemDetails || []),
      data.officialRank == null ? null : data.officialRank,
      data.referenceRank == null ? null : data.referenceRank,
      data.officialParticipantCount || 0,
    ]
  );
  return rows[0] || null;
}

async function listMemberSettlements(classroomId, memberId, client) {
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_settlements
     WHERE classroom_id = $1 AND member_id = $2
     ORDER BY round_no ASC`,
    [classroomId, memberId]
  );
  return rows;
}

async function listRoundSettlements(classroomId, roundNo, client) {
  const { rows } = await q(client).query(
    `SELECT s.*, m.display_nickname, m.classroom_nickname, m.is_nickname_masked, m.username
     FROM public.classroom_settlements s
     JOIN public.classroom_members m ON m.member_id = s.member_id
     WHERE s.classroom_id = $1 AND s.round_no = $2
     ORDER BY s.is_official_ranked DESC, COALESCE(s.official_rank, 999999) ASC, s.ending_total_cents DESC, s.member_id ASC`,
    [classroomId, roundNo]
  );
  return rows;
}

async function listClassroomRevealedSettlements(classroomId, client) {
  const { rows } = await q(client).query(
    `SELECT s.*, m.display_nickname, m.classroom_nickname, m.is_nickname_masked, m.username
     FROM public.classroom_settlements s
     JOIN public.classroom_members m ON m.member_id = s.member_id
     JOIN public.classroom_rounds r ON r.classroom_id = s.classroom_id AND r.round_no = s.round_no
     WHERE s.classroom_id = $1 AND r.status = 'revealed'
     ORDER BY s.round_no ASC, s.is_official_ranked DESC, COALESCE(s.official_rank, 999999) ASC, s.ending_total_cents DESC, s.member_id ASC`,
    [classroomId]
  );
  return rows;
}

// ---------- 行业树、候选股筛选、数据版本指纹与建场预览 ----------

async function fetchAvailableSseYears(client) {
  const { rows } = await q(client).query(
    `SELECT EXTRACT(YEAR FROM trade_date)::int AS year,
            COUNT(*)::int AS cnt,
            to_char(MIN(trade_date), 'YYYY-MM-DD') AS first_date,
            to_char(MAX(trade_date), 'YYYY-MM-DD') AS last_date
     FROM market.trade_calendar
     WHERE exchange = 'SSE' AND is_open = TRUE
     GROUP BY EXTRACT(YEAR FROM trade_date)
     ORDER BY year ASC`
  );
  return rows;
}

async function fetchSw2021IndustryTree(client) {
  const { rows } = await q(client).query(
    `SELECT n.industry_node_id, n.parent_id, n.industry_code, n.industry_name, n.level
     FROM core.industry_nodes n
     JOIN core.industry_taxonomies t ON t.taxonomy_id = n.taxonomy_id
     WHERE t.taxonomy_code = 'SW2021'
     ORDER BY n.industry_node_id ASC`
  );
  return rows;
}

async function fetchCnStockCandidatesForWindow({ firstTradeDate, lastTradeDate }, client) {
  const { rows } = await q(client).query(
    `SELECT i.instrument_id,
            i.canonical_code,
            i.name,
            to_char(i.list_date, 'YYYY-MM-DD') AS list_date,
            to_char(i.delist_date, 'YYYY-MM-DD') AS delist_date,
            i.status,
            sw.industry_node_id
     FROM core.instruments i
     LEFT JOIN core.company_instruments ci
       ON ci.instrument_id = i.instrument_id AND ci.relation_type = 'issued_by'
     LEFT JOIN LATERAL (
       SELECT cim.industry_node_id
       FROM core.company_industry_memberships cim
       JOIN core.industry_nodes n ON n.industry_node_id = cim.industry_node_id
       JOIN core.industry_taxonomies t ON t.taxonomy_id = n.taxonomy_id AND t.taxonomy_code = 'SW2021'
       WHERE cim.company_id = ci.company_id AND cim.is_current = TRUE
     ) sw ON TRUE
     WHERE i.market = 'CN'
       AND i.asset_class = 'stock'
       AND i.list_date IS NOT NULL
       AND i.list_date <= $1::date
       AND (i.delist_date IS NULL OR i.delist_date > $2::date)
     ORDER BY i.instrument_id ASC`,
    [firstTradeDate, lastTradeDate]
  );
  return rows;
}

async function fetchCnCalendarSummaryByYear(startYear, endYear, client) {
  const { rows } = await q(client).query(
    `WITH yrs AS (
       SELECT generate_series($1::int, $2::int) AS yr
     ),
     stats AS (
       SELECT EXTRACT(YEAR FROM trade_date)::int AS yr,
              COUNT(*)::int AS total_rows,
              COUNT(*) FILTER (WHERE is_open = TRUE)::int AS open_rows,
              COUNT(*) FILTER (WHERE is_open = FALSE)::int AS closed_rows,
              to_char(MIN(trade_date) FILTER (WHERE is_open = TRUE), 'YYYY-MM-DD') AS first_open_date,
              to_char(MAX(trade_date) FILTER (WHERE is_open = TRUE), 'YYYY-MM-DD') AS last_open_date
       FROM market.trade_calendar
       WHERE exchange = 'SSE'
         AND trade_date >= make_date($1::int, 1, 1)
         AND trade_date <= make_date($2::int, 12, 31)
       GROUP BY EXTRACT(YEAR FROM trade_date)
     )
     SELECT y.yr AS year,
            COALESCE(s.total_rows, 0)::int AS total_rows,
            COALESCE(s.open_rows, 0)::int AS open_rows,
            COALESCE(s.closed_rows, 0)::int AS closed_rows,
            s.first_open_date,
            s.last_open_date,
            (
              SELECT COUNT(*)::int
              FROM generate_series(make_date(y.yr, 1, 4), COALESCE(s.first_open_date::date - 1, make_date(y.yr, 1, 15)), '1 day'::interval) d
              WHERE EXTRACT(ISODOW FROM d) <= 5
                AND NOT EXISTS (
                  SELECT 1 FROM market.trade_calendar tc
                  WHERE tc.exchange = 'SSE' AND tc.trade_date = d::date
                )
            ) AS missing_head_weekdays,
            (
              SELECT COUNT(*)::int
              FROM generate_series(COALESCE(s.last_open_date::date + 1, make_date(y.yr, 12, 20)), make_date(y.yr, 12, 31), '1 day'::interval) d
              WHERE EXTRACT(ISODOW FROM d) <= 5
                AND NOT EXISTS (
                  SELECT 1 FROM market.trade_calendar tc
                  WHERE tc.exchange = 'SSE' AND tc.trade_date = d::date
                )
            ) AS missing_tail_weekdays
     FROM yrs y
     LEFT JOIN stats s ON s.yr = y.yr
     ORDER BY y.yr ASC`,
    [startYear, endYear]
  );
  return rows;
}

async function fetchFactsDataVersion({ startDate, endDate }, client) {
  const { rows } = await q(client).query(
    `SELECT
       (SELECT COUNT(*)::text || ':' || COALESCE(MAX(trade_date)::text, '') || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || trade_date::text || ':' || COALESCE(close::text, ''), 0))::text, '0')
        FROM market.daily_bars WHERE trade_date >= $1::date AND trade_date <= $2::date) AS bars_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(MAX(trade_date)::text, '') || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || trade_date::text || ':' || COALESCE(adj_factor::text, ''), 0))::text, '0')
        FROM market.adjustment_factors WHERE trade_date >= $1::date AND trade_date <= $2::date) AS adj_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(MAX(trade_date)::text, '') || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || trade_date::text || ':' || COALESCE(pe_ttm::text, '') || ':' || COALESCE(pb::text, '') || ':' || COALESCE(total_market_cap::text, ''), 0))::text, '0')
        FROM market.daily_valuations WHERE trade_date >= $1::date AND trade_date <= $2::date) AS val_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(MAX(trade_date)::text, '') || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || trade_date::text || ':' || COALESCE(suspend_type, '') || ':' || COALESCE(suspend_reason, ''), 0))::text, '0')
        FROM market.stock_suspend_calendar WHERE trade_date >= $1::date AND trade_date <= $2::date) AS susp_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(MAX(trade_date)::text, '') || ':' || COALESCE(SUM(hashtextextended(index_code || ':' || trade_date::text || ':' || COALESCE(close::text, ''), 0))::text, '0')
        FROM market.index_valuation_history WHERE index_code IN ('CBA00601', 'CN10Y_WEALTH', 'CHINABOND_7_10Y_WEALTH') AND trade_date >= $1::date AND trade_date <= $2::date) AS bond_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(trade_date::text || ':' || is_open::text, 0))::text, '0')
        FROM market.trade_calendar WHERE exchange = 'SSE' AND trade_date >= $1::date AND trade_date <= $2::date) AS cal_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || trade_date::text || ':' || COALESCE(conversion_value::text, '') || ':' || COALESCE(conversion_premium_pct::text, '') || ':' || COALESCE(bond_premium_pct::text, '') || ':' || COALESCE(raw_payload->>'remain_years', ''), 0))::text, '0')
        FROM market.convertible_bond_daily_metrics) AS cb_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || COALESCE(maturity_date::text, ''), 0))::text, '0')
        FROM public.bond_unified) AS bu_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(instrument_id::text || ':' || canonical_code || ':' || COALESCE(list_date::text, '') || ':' || COALESCE(delist_date::text, '') || ':' || COALESCE(status, ''), 0))::text, '0') || ':' || COALESCE(MAX(updated_at)::text, '')
        FROM core.instruments WHERE market = 'CN' AND asset_class = 'stock') AS inst_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(ci.company_id::text || ':' || ci.instrument_id::text || ':' || ci.relation_type || ':' || COALESCE(ci.valid_from::text, '') || ':' || COALESCE(ci.valid_to::text, ''), 0))::text, '0')
        FROM core.company_instruments ci
        JOIN core.instruments i ON i.instrument_id = ci.instrument_id
        WHERE i.market = 'CN' AND i.asset_class = 'stock') AS ci_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(company_id::text || ':' || industry_node_id::text, 0))::text, '0') || ':' || COALESCE(MAX(created_at)::text, '')
        FROM core.company_industry_memberships WHERE is_current = TRUE) AS ind_v,
       (SELECT COUNT(*)::text || ':' || COALESCE(SUM(hashtextextended(n.industry_node_id::text || ':' || COALESCE(n.parent_id::text, '') || ':' || COALESCE(n.level::text, '') || ':' || COALESCE(n.industry_code, '') || ':' || COALESCE(n.industry_name, ''), 0))::text, '0')
        FROM core.industry_nodes n
        JOIN core.industry_taxonomies t ON t.taxonomy_id = n.taxonomy_id
        WHERE t.taxonomy_code = 'SW2021') AS tree_v`,
    [startDate, endDate]
  );
  const r = rows[0] || {};
  return [r.bars_v, r.adj_v, r.val_v, r.susp_v, r.bond_v, r.cal_v, r.cb_v, r.bu_v, r.inst_v, r.ci_v, r.ind_v, r.tree_v].join('|');
}

async function insertCreationPreview(client, { previewId, adminSubjectId, mode, startYear, dataVersion, payload, expiresAt }) {
  const { rows } = await q(client).query(
    `INSERT INTO public.classroom_creation_previews (
      preview_id, admin_subject_id, mode, start_year, data_version, payload, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
    RETURNING *`,
    [previewId, adminSubjectId, mode, startYear, dataVersion, JSON.stringify(payload), expiresAt]
  );
  return rows[0];
}

async function findCreationPreviewById(previewId, client, { forUpdate = false } = {}) {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_creation_previews WHERE preview_id = $1 ${lockSql}`,
    [previewId]
  );
  return rows[0] || null;
}

async function findCreationPreviewByConfirmRequest(adminSubjectId, confirmRequestId, client) {
  if (!confirmRequestId) return null;
  const { rows } = await q(client).query(
    `SELECT * FROM public.classroom_creation_previews
     WHERE admin_subject_id = $1 AND confirm_request_id = $2`,
    [adminSubjectId, confirmRequestId]
  );
  return rows[0] || null;
}

async function markCreationPreviewConfirmed(client, previewId, classroomId, confirmRequestId) {
  const { rows } = await q(client).query(
    `UPDATE public.classroom_creation_previews
     SET confirmed_classroom_id = $2,
         confirm_request_id = COALESCE($3, confirm_request_id)
     WHERE preview_id = $1
     RETURNING *`,
    [previewId, classroomId, confirmRequestId || null]
  );
  return rows[0] || null;
}

async function fetchSw2021MembershipsByInstrumentIds(instrumentIds, client) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await q(client).query(
    `SELECT ci.instrument_id, cim.industry_node_id
     FROM core.company_instruments ci
     JOIN core.company_industry_memberships cim
       ON cim.company_id = ci.company_id AND cim.is_current = TRUE
     JOIN core.industry_nodes n ON n.industry_node_id = cim.industry_node_id
     JOIN core.industry_taxonomies t ON t.taxonomy_id = n.taxonomy_id AND t.taxonomy_code = 'SW2021'
     WHERE ci.instrument_id = ANY($1::bigint[])
       AND ci.relation_type = 'issued_by'`,
    [instrumentIds]
  );
  return rows;
}

module.exports = {
  withTransaction,
  withReadOnlySnapshot,
  fetchCnOpenTradeDates,
  fetchInstrumentsByCodes,
  fetchDailyBarsWithAdj,
  fetchSuspensions,
  fetchDailyValuations,
  fetchBondWealthIndexCoverage,
  fetchBondWealthIndexSeries,
  fetchSovereignYieldCount,
  fetchCbCalibrationSampleStats,
  fetchCbCalibrationBuckets,
  fetchAvailableSseYears,
  fetchCnCalendarSummaryByYear,
  fetchSw2021IndustryTree,
  fetchSw2021MembershipsByInstrumentIds,
  fetchCnStockCandidatesForWindow,
  fetchFactsDataVersion,
  fetchCreationWindowBase,
  insertCreationPreview,
  findCreationPreviewById,
  findCreationPreviewByConfirmRequest,
  markCreationPreviewConfirmed,
  insertClassroom,
  findClassroomById,
  findClassroomByIdForUpdate,
  findClassroomByCode,
  listClassroomsForAdmin,
  listClassroomsForSubject,
  updateClassroomState,
  deleteClassroom,
  insertRound,
  findRound,
  findRoundForUpdate,
  listRounds,
  updateRoundState,
  findMemberBySubject,
  findMemberById,
  listMembers,
  listNicknames,
  insertMember,
  updateMemberNickname,
  updateMemberNote,
  findMemberRoundState,
  upsertMemberRoundState,
  findDraft,
  saveDraftWithVersion,
  findSubmissionByRequestId,
  findLatestSubmission,
  listLatestSubmissions,
  insertSubmission,
  insertSettlement,
  listMemberSettlements,
  listRoundSettlements,
  listClassroomRevealedSettlements,
};
