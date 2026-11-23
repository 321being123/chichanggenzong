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

function q(client) {
  return client || pool;
}

// ---------- 只读市场事实查询（用于建场预检与真实剧本构建）----------

async function fetchCnOpenTradeDates(startDate, endDate) {
  const { rows } = await pool.query(
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

async function fetchInstrumentsByCodes(codes) {
  if (!codes || codes.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT i.instrument_id, i.canonical_code, i.name, i.market, i.asset_class,
            to_char(i.list_date, 'YYYY-MM-DD') AS list_date,
            to_char(i.delist_date, 'YYYY-MM-DD') AS delist_date,
            i.status,
            n.industry_node_id,
            COALESCE(n.industry_code, '') AS industry_code,
            COALESCE(n.industry_name, '') AS sw_industry_name,
            COALESCE(t.taxonomy_code, '') AS taxonomy_code
     FROM core.instruments i
     LEFT JOIN core.company_instruments ci
       ON ci.instrument_id = i.instrument_id AND ci.relation_type = 'issued_by'
     LEFT JOIN core.company_industry_memberships cim
       ON cim.company_id = ci.company_id AND cim.is_current = TRUE
     LEFT JOIN core.industry_nodes n
       ON n.industry_node_id = cim.industry_node_id
     LEFT JOIN core.industry_taxonomies t
       ON t.taxonomy_id = n.taxonomy_id AND t.taxonomy_code = 'SW2021'
     WHERE i.canonical_code = ANY($1::text[])
       AND i.market = 'CN'
       AND i.asset_class = 'stock'`,
    [codes]
  );
  return rows;
}

async function fetchDailyBarsWithAdj(instrumentIds, startDate, endDate) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await pool.query(
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

async function fetchSuspensions(instrumentIds, startDate, endDate) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await pool.query(
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

async function fetchDailyValuations(instrumentIds, startDate, endDate) {
  if (!instrumentIds || instrumentIds.length === 0) return [];
  const { rows } = await pool.query(
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

async function fetchBondWealthIndexCoverage(startDate, endDate) {
  const { rows } = await pool.query(
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

async function fetchBondWealthIndexSeries(startDate, endDate) {
  const { rows } = await pool.query(
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

async function fetchSovereignYieldCount(startDate, endDate) {
  const { rows } = await pool.query(
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

async function fetchCbCalibrationSampleStats() {
  const { rows } = await pool.query(
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

async function fetchCbCalibrationBuckets() {
  const { rows } = await pool.query(
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

async function listClassroomsForAdmin() {
  const { rows } = await pool.query(
    `SELECT c.classroom_id, c.classroom_code, c.title, c.mode, c.blind_mode,
            c.identity_revealed, c.status, c.current_round, c.state_version,
            c.start_year, c.end_year, c.total_rounds, c.created_at, c.completed_at,
            COUNT(m.member_id)::int AS member_count
     FROM public.classroom_classrooms c
     LEFT JOIN public.classroom_members m ON m.classroom_id = c.classroom_id
     GROUP BY c.classroom_id
     ORDER BY c.created_at DESC
     LIMIT 100`
  );
  return rows;
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

module.exports = {
  withTransaction,
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
  insertClassroom,
  findClassroomById,
  findClassroomByIdForUpdate,
  findClassroomByCode,
  listClassroomsForAdmin,
  listClassroomsForSubject,
  updateClassroomState,
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
};
