'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');
const repo = require('../repositories/classroomRepository');
const precheckService = require('./classroomPrecheckService');
const sseHub = require('./classroomSseHub');
const { buildDemoScenario } = require('../domain/classroomDemoScenario');
const {
  INITIAL_CASH_CENTS,
  bucketPe,
  bucketPb,
  buildRoundOpenCatalog,
  computeRoundMarketSettlement,
  computeMemberRoundOpening,
  validateAllocations,
  settleMemberRound,
  rankOfficialSettlements,
  computeLateReferenceRank,
  projectAssetsForViewer,
} = require('../domain/classroomRules');

function createHttpError(status, message, extra = null) {
  const err = new Error(message);
  err.status = status;
  if (extra) err.extra = extra;
  return err;
}

function generateClassroomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function buildScenarioFromRealPrecheck({ precheck, startYear, totalRounds }) {
  const cbCal = precheck.cbCalibration || {};
  const rounds = [];
  for (let i = 0; i < totalRounds; i++) {
    const roundNo = i + 1;
    const calendarYear = startYear + i;
    const bondRet = precheck.bondReturnsByYear ? precheck.bondReturnsByYear[calendarYear] : null;
    if (bondRet == null || !Number.isFinite(Number(bondRet))) {
      throw createHttpError(400, `缺少 ${calendarYear} 年十年期国债财富净值回报`);
    }
    const stocks = precheck.stockReports.map((sr, idx) => {
      const y = sr.years[i];
      return {
        assetId: `stk_${idx}`,
        industryName: sr.industryName,
        alias: `${sr.industryName} ${String.fromCharCode(65 + (idx % 3))}`,
        canonicalCode: sr.canonicalCode,
        stockName: sr.stockName || sr.canonicalCode,
        marketCap: y.marketCap,
        peTtm: y.peTtm,
        pb: y.pb,
        returnRate: y.returnRate,
      };
    });
    // 真实场次第 11 轮起默认每行业第 1 只正股对应 1 只模拟可转债（使用校准参数）
    const convertibleBonds = roundNo >= 11
      ? [0, 3, 6, 9].map((stockIdx, cbIdx) => ({
        assetId: `cb_${cbIdx}`,
        alias: `${stocks[stockIdx].industryName}转债`,
        canonicalCode: `SIM_CB_${cbIdx + 1}`,
        stockName: `${stocks[stockIdx].stockName}模拟转债`,
        industryName: stocks[stockIdx].industryName,
        underlyingAssetId: stocks[stockIdx].assetId,
        conversionPrice: 100,
        couponRate: Number(cbCal.couponRate || 0.015),
        discountRate: Number(cbCal.discountRate || 0.032),
        volatility: Number(cbCal.volatility || 0.28),
        bucketParams: cbCal.buckets || null,
      }))
      : [];
    rounds.push({
      roundNo,
      calendarYear,
      bondReturnRate: Number(bondRet),
      stocks,
      convertibleBonds,
    });
  }
  return {
    schemaVersion: 1,
    mode: 'real',
    dataLabel: '真实历史市场快照（已通过预检）',
    cbModelVersion: cbCal.modelVersion || 'cb_model_v1_calibrated',
    cbCalibration: cbCal,
    bondSeriesSource: precheck.bondIndexCode || 'chinabond_7_10y_wealth',
    startYear,
    endYear: startYear + totalRounds - 1,
    totalRounds,
    rounds,
  };
}

async function generateQrPayload(joinUrl) {
  try {
    return await QRCode.toDataURL(joinUrl, { margin: 1, width: 240 });
  } catch (e) {
    return null;
  }
}

async function prepareScenarioAndSummary({
  mode = 'demo',
  startYear = 2011,
  industries = null,
  demoVariant = 'fixed',
  demoSeed = null,
}) {
  const cleanMode = mode === 'real' ? 'real' : 'demo';
  const totalRounds = 15;
  const startYearNum = Number(startYear);
  const endYear = startYearNum + totalRounds - 1;

  if (cleanMode === 'demo') {
    const useRandom = demoVariant === 'random';
    const resolvedSeed = useRandom
      ? (demoSeed != null && String(demoSeed).trim() !== '' ? String(demoSeed).trim() : crypto.randomBytes(6).toString('hex'))
      : null;
    const scenarioSnapshot = buildDemoScenario({
      startYear: startYearNum,
      totalRounds,
      demoVariant: useRandom ? 'random' : 'fixed',
      seed: resolvedSeed,
    });
    const precheckSummary = {
      pass: true,
      mode: 'demo',
      demoVariant: scenarioSnapshot.demoVariant,
      demoSeed: scenarioSnapshot.demoSeed,
      demoGeneratorVersion: scenarioSnapshot.demoGeneratorVersion,
      dataLabel: scenarioSnapshot.dataLabel,
    };
    return {
      cleanMode,
      startYearNum,
      endYear,
      totalRounds,
      dataVersion: 'demo',
      scenarioSnapshot,
      precheckSummary,
      precheck: null,
    };
  }

  const precheck = await precheckService.runRealPrecheck({
    industries: industries || [],
    startYear: startYearNum,
    totalRounds,
  });
  if (!precheck.pass) {
    throw createHttpError(400, `真实场次数据预检未通过：${precheck.blockers.join('；')}`, { precheck });
  }
  const scenarioSnapshot = buildScenarioFromRealPrecheck({
    precheck,
    startYear: startYearNum,
    totalRounds,
  });
  scenarioSnapshot.taxonomy = precheck.taxonomy || 'SW2021';
  scenarioSnapshot.survivorBiasNotice = precheck.survivorBiasNotice || precheckService.SURVIVOR_BIAS_NOTICE;
  const precheckSummary = {
    pass: true,
    mode: 'real',
    taxonomy: scenarioSnapshot.taxonomy,
    survivorBiasNotice: scenarioSnapshot.survivorBiasNotice,
    dataVersion: precheck.dataVersion || '',
    yellowCount: precheck.yellowCount,
    redCount: precheck.redCount,
  };
  return {
    cleanMode,
    startYearNum,
    endYear,
    totalRounds,
    dataVersion: precheck.dataVersion || '',
    scenarioSnapshot,
    precheckSummary,
    precheck,
  };
}

async function persistClassroomWithRound1(client, {
  adminUser,
  cleanTitle,
  cleanMode,
  blindMode,
  startYearNum,
  endYear,
  totalRounds,
  scenarioSnapshot,
  precheckSummary,
}) {
  const r1Meta = scenarioSnapshot.rounds[0];
  const r1Open = buildRoundOpenCatalog(r1Meta, null, null);
  let classroomCode = generateClassroomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const dup = await repo.findClassroomByCode(classroomCode, client);
    if (!dup) break;
    classroomCode = generateClassroomCode();
  }
  const classroom = await repo.insertClassroom(client, {
    classroomCode,
    title: cleanTitle,
    mode: cleanMode,
    blindMode: Boolean(blindMode),
    identityRevealed: false,
    status: 'pending',
    currentRound: 1,
    initialCashCents: INITIAL_CASH_CENTS,
    startYear: startYearNum,
    endYear,
    totalRounds,
    createdBySubjectId: adminUser.subject_identity,
    createdByUsername: adminUser.username,
    scenarioSnapshot,
    precheckSummary,
  });
  await repo.insertRound(client, {
    classroomId: classroom.classroom_id,
    roundNo: 1,
    calendarYear: r1Meta.calendarYear,
    status: 'pending',
    openMarketSnapshot: r1Open,
  });
  return classroom;
}

async function buildClassroomResponse(classroom, origin = '', extra = {}) {
  const joinPath = `/classroom.html?code=${classroom.classroom_code}`;
  const joinUrl = origin ? `${origin.replace(/\/$/, '')}${joinPath}` : joinPath;
  const qrDataUrl = await generateQrPayload(joinUrl);
  return {
    classroom: summarizeClassroom(classroom),
    joinPath,
    joinUrl,
    qrDataUrl,
    ...extra,
  };
}

async function createCreationPreview({
  adminUser,
  title,
  mode = 'demo',
  blindMode = true,
  startYear = 2011,
  industries = null,
  demoVariant = 'fixed',
  demoSeed = null,
}) {
  const isBlind = Boolean(blindMode);
  const cleanMode = mode === 'real' ? 'real' : 'demo';
  const startYearNum = Number(startYear);
  const cleanTitle = String(title || '').trim()
    || (isBlind ? '股市模拟沙盘课堂' : `股市模拟沙盘 ${startYearNum}-${startYearNum + 14}`);

  if (cleanMode === 'real') {
    const precheck = await precheckService.runRealPrecheck({
      industries: industries || [],
      startYear: startYearNum,
      totalRounds: 15,
    });
    if (!precheck.pass) {
      return {
        previewId: null,
        pass: false,
        mode: 'real',
        startYear: startYearNum,
        endYear: startYearNum + 14,
        blockers: precheck.blockers,
        precheck,
      };
    }
  }

  const prepared = await prepareScenarioAndSummary({
    mode: cleanMode,
    startYear: startYearNum,
    industries,
    demoVariant,
    demoSeed,
  });

  const previewId = `prv_${crypto.randomBytes(12).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const payload = {
    title: cleanTitle,
    mode: prepared.cleanMode,
    blindMode: isBlind,
    startYear: prepared.startYearNum,
    endYear: prepared.endYear,
    totalRounds: prepared.totalRounds,
    industries: cleanMode === 'real' ? (industries || []) : prepared.scenarioSnapshot.industries,
    demoVariant: prepared.scenarioSnapshot.demoVariant || null,
    demoSeed: prepared.scenarioSnapshot.demoSeed || null,
    demoGeneratorVersion: prepared.scenarioSnapshot.demoGeneratorVersion || null,
    scenarioSnapshot: prepared.scenarioSnapshot,
    precheckSummary: prepared.precheckSummary,
  };

  await repo.insertCreationPreview(null, {
    previewId,
    adminSubjectId: adminUser.subject_identity,
    mode: prepared.cleanMode,
    startYear: prepared.startYearNum,
    dataVersion: prepared.dataVersion,
    payload,
    expiresAt,
  });

  return {
    previewId,
    pass: true,
    mode: prepared.cleanMode,
    blindMode: isBlind,
    title: cleanTitle,
    startYear: prepared.startYearNum,
    endYear: prepared.endYear,
    dataVersion: prepared.dataVersion,
    expiresAt,
    taxonomy: prepared.scenarioSnapshot.taxonomy || 'SW2021',
    survivorBiasNotice: prepared.scenarioSnapshot.survivorBiasNotice || precheckService.SURVIVOR_BIAS_NOTICE,
    demoVariant: payload.demoVariant,
    demoSeed: payload.demoSeed,
    demoGeneratorVersion: payload.demoGeneratorVersion,
    precheck: prepared.precheck,
    industriesPreview: prepared.scenarioSnapshot.industries || null,
  };
}

async function confirmCreationPreview({ adminUser, previewId, confirmRequestId = null, origin = '' }) {
  if (!previewId) {
    throw createHttpError(400, '缺少建场预览标识 previewId');
  }

  const cleanConfirmId = confirmRequestId ? String(confirmRequestId).trim() : null;
  const result = await repo.withTransaction(async (client) => {
    if (cleanConfirmId) {
      const existingByReq = await repo.findCreationPreviewByConfirmRequest(adminUser.subject_identity, cleanConfirmId, client);
      if (existingByReq && existingByReq.confirmed_classroom_id) {
        const cls = await repo.findClassroomById(existingByReq.confirmed_classroom_id, client);
        if (cls) return { classroom: cls, idempotentReplay: true, needsRefresh: false };
      }
    }

    const preview = await repo.findCreationPreviewById(previewId, client, { forUpdate: true });
    if (!preview) throw createHttpError(404, '建场预览不存在，请重新预览');
    if (preview.admin_subject_id !== adminUser.subject_identity) {
      throw createHttpError(403, '无权确认他人的建场预览');
    }
    if (preview.confirmed_classroom_id) {
      const cls = await repo.findClassroomById(preview.confirmed_classroom_id, client);
      if (cls) return { classroom: cls, idempotentReplay: true, needsRefresh: false };
    }

    const expired = new Date(preview.expires_at).getTime() <= Date.now();
    let dataChanged = false;
    const p = preview.payload || {};
    if (preview.mode === 'real') {
      const startDate = `${Number(preview.start_year) - 1}-12-01`;
      const endDate = `${Number(preview.start_year) + 14}-12-31`;
      const currentVersion = await repo.fetchFactsDataVersion({ startDate, endDate }, client);
      if (currentVersion !== preview.data_version) {
        dataChanged = true;
      }
    }

    if (expired || dataChanged) {
      return {
        needsRefresh: true,
        reason: dataChanged ? '底层行情或行业数据已更新' : '建场预览已过期',
        payload: p,
      };
    }

    const classroom = await persistClassroomWithRound1(client, {
      adminUser,
      cleanTitle: p.title,
      cleanMode: preview.mode,
      blindMode: p.blindMode,
      startYearNum: Number(preview.start_year),
      endYear: Number(p.endYear || (Number(preview.start_year) + 14)),
      totalRounds: Number(p.totalRounds || 15),
      scenarioSnapshot: p.scenarioSnapshot,
      precheckSummary: p.precheckSummary,
    });
    await repo.markCreationPreviewConfirmed(client, previewId, classroom.classroom_id, cleanConfirmId);
    return { classroom, idempotentReplay: false, needsRefresh: false };
  });

  if (result.needsRefresh) {
    const p = result.payload || {};
    const newPreview = await createCreationPreview({
      adminUser,
      title: p.title,
      mode: p.mode,
      blindMode: p.blindMode,
      startYear: p.startYear,
      industries: p.industries,
      demoVariant: p.demoVariant || 'fixed',
      demoSeed: p.demoSeed || null,
    });
    throw createHttpError(409, `${result.reason}，已按同一组合重新校验，请确认新预览`, {
      code: 'PREVIEW_REFRESH_REQUIRED',
      newPreview,
    });
  }

  return buildClassroomResponse(result.classroom, origin, {
    idempotentReplay: result.idempotentReplay,
  });
}

async function createClassroom({
  adminUser,
  title,
  mode = 'demo',
  blindMode = true,
  startYear = 2011,
  industries = null,
  demoVariant = 'fixed',
  demoSeed = null,
  previewId = null,
  confirmRequestId = null,
  origin = '',
}) {
  if (previewId) {
    return confirmCreationPreview({ adminUser, previewId, confirmRequestId, origin });
  }
  const isBlind = Boolean(blindMode);
  const startYearNum = Number(startYear);
  const cleanTitle = String(title || '').trim()
    || (isBlind ? '股市模拟沙盘课堂' : `股市模拟沙盘 ${startYearNum}-${startYearNum + 14}`);
  const prepared = await prepareScenarioAndSummary({
    mode,
    startYear: startYearNum,
    industries,
    demoVariant,
    demoSeed,
  });

  const created = await repo.withTransaction((client) => persistClassroomWithRound1(client, {
    adminUser,
    cleanTitle,
    cleanMode: prepared.cleanMode,
    blindMode: isBlind,
    startYearNum: prepared.startYearNum,
    endYear: prepared.endYear,
    totalRounds: prepared.totalRounds,
    scenarioSnapshot: prepared.scenarioSnapshot,
    precheckSummary: prepared.precheckSummary,
  }));

  return buildClassroomResponse(created, origin);
}

function summarizeClassroom(c, { blindActive = false } = {}) {
  return {
    classroomId: Number(c.classroom_id),
    classroomCode: c.classroom_code,
    title: c.title,
    mode: c.mode,
    blindMode: Boolean(c.blind_mode),
    identityRevealed: Boolean(c.identity_revealed),
    status: c.status,
    currentRound: Number(c.current_round),
    stateVersion: Number(c.state_version),
    initialCashCents: Number(c.initial_cash_cents),
    startYear: blindActive ? null : Number(c.start_year),
    endYear: blindActive ? null : Number(c.end_year),
    totalRounds: Number(c.total_rounds),
    dataLabel: c.scenario_snapshot && c.scenario_snapshot.dataLabel ? c.scenario_snapshot.dataLabel : '',
    createdAt: c.created_at,
    completedAt: c.completed_at,
  };
}

async function resolveByCode(code) {
  const c = await repo.findClassroomByCode(code);
  if (!c) throw createHttpError(404, '未找到对应场次');
  const blindActive = Boolean(c.blind_mode) && !Boolean(c.identity_revealed);
  return summarizeClassroom(c, { blindActive });
}

async function listMyClassrooms(subjectId) {
  const rows = await repo.listClassroomsForSubject(subjectId);
  return rows.map((r) => ({
    classroomId: Number(r.classroom_id),
    classroomCode: r.classroom_code,
    title: r.title,
    mode: r.mode,
    status: r.status,
    currentRound: Number(r.current_round),
    totalRounds: Number(r.total_rounds),
    displayNickname: r.display_nickname,
    firstEligibleRound: Number(r.first_eligible_round),
    latestSettledRound: r.latest_settled_round == null ? null : Number(r.latest_settled_round),
    latestEndingTotalCents: r.latest_ending_total_cents == null ? Number(r.initial_cash_cents) : Number(r.latest_ending_total_cents),
    initialCashCents: Number(r.initial_cash_cents),
    joinedAt: r.joined_at,
    completedAt: r.completed_at,
  }));
}

async function ensureMemberRoundStateInTx(client, classroom, round, member) {
  const roundNo = Number(round.round_no);
  const existing = await repo.findMemberRoundState(classroom.classroom_id, roundNo, member.member_id, client);
  if (existing) return existing;

  let prevSettlement = null;
  if (roundNo > Number(member.first_eligible_round) && roundNo > 1) {
    const settlements = await repo.listMemberSettlements(classroom.classroom_id, member.member_id, client);
    prevSettlement = settlements.find((s) => Number(s.round_no) === roundNo - 1) || null;
  }

  const opening = computeMemberRoundOpening({
    prevSettlement,
    openSnapshot: round.open_market_snapshot,
    initialCashCents: Number(classroom.initial_cash_cents),
  });

  return repo.upsertMemberRoundState(client, {
    classroomId: classroom.classroom_id,
    roundNo,
    memberId: member.member_id,
    openingTotalCents: opening.openingTotalCents,
    defaultAllocations: opening.defaultAllocations,
    defaultCashCents: opening.defaultCashCents,
    liquidationEvents: opening.liquidationEvents,
  });
}

function allocateUniqueNickname(desired, existingSet) {
  const base = String(desired || '').trim().slice(0, 24) || '学员';
  if (!existingSet.has(base)) {
    return { displayNickname: base, adjusted: false };
  }
  let suffix = 2;
  while (existingSet.has(`${base}#${suffix}`)) {
    suffix++;
  }
  return { displayNickname: `${base}#${suffix}`, adjusted: true };
}

async function joinClassroom({ classroomId, authUser, nickname }) {
  return repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');

    const existing = await repo.findMemberBySubject(classroom.classroom_id, authUser.subject_identity, client);
    const blindActive = Boolean(classroom.blind_mode) && !Boolean(classroom.identity_revealed);
    if (existing) {
      return {
        alreadyJoined: true,
        nicknameAdjusted: false,
        member: formatMember(existing),
        classroom: summarizeClassroom(classroom, { blindActive }),
      };
    }

    if (classroom.status === 'completed') {
      throw createHttpError(403, '该场次已完成，已关闭新学员入场');
    }

    const cleanDesired = String(nickname || '').trim();
    if (!cleanDesired) {
      throw createHttpError(400, '请填写课堂昵称');
    }

    const existingNicknames = new Set(await repo.listNicknames(classroom.classroom_id, client));
    const { displayNickname, adjusted } = allocateUniqueNickname(cleanDesired, existingNicknames);

    const curRound = Number(classroom.current_round);
    const firstEligibleRound = (classroom.status === 'pending' || classroom.status === 'configuring')
      ? curRound
      : curRound + 1;

    const member = await repo.insertMember(client, {
      classroomId: classroom.classroom_id,
      subjectId: authUser.subject_identity,
      username: authUser.username,
      classroomNickname: cleanDesired,
      displayNickname,
      firstEligibleRound,
    });

    // 为已揭晓轮次（roundNo < firstEligibleRound）补记「迟到补录｜全现金」
    const rounds = await repo.listRounds(classroom.classroom_id, client);
    for (const r of rounds) {
      if (r.status === 'revealed' && Number(r.round_no) < firstEligibleRound) {
        const roundSettlements = await repo.listRoundSettlements(classroom.classroom_id, r.round_no, client);
        const officialTotals = roundSettlements
          .filter((s) => s.is_official_ranked)
          .map((s) => Number(s.ending_total_cents));
        const refRank = computeLateReferenceRank(officialTotals, Number(classroom.initial_cash_cents));
        await repo.insertSettlement(client, {
          classroomId: classroom.classroom_id,
          roundNo: Number(r.round_no),
          memberId: member.member_id,
          participationType: 'late_backfill',
          isOfficialRanked: false,
          openingTotalCents: Number(classroom.initial_cash_cents),
          endingTotalCents: Number(classroom.initial_cash_cents),
          roundPnlCents: 0,
          endingCashCents: Number(classroom.initial_cash_cents),
          itemDetails: [],
          officialRank: null,
          referenceRank: refRank,
          officialParticipantCount: officialTotals.length,
        });
      }
    }

    // 若当前轮正在配置中且已具备参排资格，初始化期初状态
    if (classroom.status === 'configuring' && firstEligibleRound === curRound) {
      const round = rounds.find((r) => Number(r.round_no) === curRound);
      if (round) {
        await ensureMemberRoundStateInTx(client, classroom, round, member);
      }
    }

    return {
      alreadyJoined: false,
      nicknameAdjusted: adjusted,
      member: formatMember(member),
      classroom: summarizeClassroom(classroom, { blindActive }),
    };
  });
}

function formatMember(m) {
  return {
    memberId: Number(m.member_id),
    classroomId: Number(m.classroom_id),
    displayNickname: m.display_nickname,
    classroomNickname: m.classroom_nickname,
    isNicknameMasked: Boolean(m.is_nickname_masked),
    firstEligibleRound: Number(m.first_eligible_round),
    joinedAt: m.joined_at,
  };
}

async function getStudentState({ classroomId, authUser }) {
  const classroom = await repo.findClassroomById(classroomId);
  if (!classroom) throw createHttpError(404, '场次不存在');

  const blindActive = Boolean(classroom.blind_mode) && !Boolean(classroom.identity_revealed);
  const member = await repo.findMemberBySubject(classroom.classroom_id, authUser.subject_identity);
  if (!member) {
    return {
      joined: false,
      classroom: summarizeClassroom(classroom, { blindActive }),
    };
  }

  const curRoundNo = Number(classroom.current_round);
  const round = await repo.findRound(classroom.classroom_id, curRoundNo);
  const settlements = await repo.listMemberSettlements(classroom.classroom_id, member.member_id);
  const latestSettled = settlements.length ? settlements[settlements.length - 1] : null;

  const isRevealed = round.status === 'revealed';
  const eligibleThisRound = Number(member.first_eligible_round) <= curRoundNo;

  let roundState = null;
  if (eligibleThisRound) {
    roundState = await repo.withTransaction((client) => ensureMemberRoundStateInTx(client, classroom, round, member));
  }

  const draft = await repo.findDraft(classroom.classroom_id, curRoundNo, member.member_id);
  const submission = await repo.findLatestSubmission(classroom.classroom_id, curRoundNo, member.member_id);
  const currentRoundSettlement = settlements.find((s) => Number(s.round_no) === curRoundNo) || null;

  const openSnap = round.open_market_snapshot;
  const settledSnap = isRevealed ? round.settled_market_snapshot : null;

  const assets = projectAssetsForViewer({
    openSnapshot: openSnap,
    settledMarket: settledSnap,
    blindActive,
    isRevealed,
  });

  // 榜单仅在已揭晓时返回（盲玩只暴露 displayNickname 与金额/名次）
  let leaderboard = null;
  if (isRevealed) {
    const rSettlements = await repo.listRoundSettlements(classroom.classroom_id, curRoundNo);
    leaderboard = rSettlements
      .filter((s) => s.is_official_ranked)
      .map((s) => ({
        memberId: Number(s.member_id),
        displayNickname: s.display_nickname,
        rank: Number(s.official_rank),
        endingTotalCents: Number(s.ending_total_cents),
        roundPnlCents: Number(s.round_pnl_cents),
        isMe: Number(s.member_id) === Number(member.member_id),
      }));
  }

  return {
    joined: true,
    classroom: summarizeClassroom(classroom, { blindActive }),
    member: formatMember(member),
    eligibleThisRound,
    round: {
      roundNo: curRoundNo,
      status: round.status,
      stateVersion: Number(round.state_version),
      calendarYear: blindActive ? null : Number(round.calendar_year),
      marketHeaderTitle: openSnap.marketHeaderTitle,
      showIndexLevel: Boolean(openSnap.showIndexLevel),
      indexOpenLevel: openSnap.showIndexLevel ? openSnap.indexOpenLevel : null,
      indexEndLevel: (isRevealed && openSnap.showIndexLevel && settledSnap) ? settledSnap.indexEndLevel : null,
      indexReturn: (isRevealed && openSnap.showIndexLevel && settledSnap) ? settledSnap.indexReturn : null,
      marketPeDisplay: blindActive ? bucketPe(openSnap.marketPeValue) : openSnap.marketPeDisplay,
      marketPbDisplay: blindActive ? bucketPb(openSnap.marketPbValue) : openSnap.marketPbDisplay,
      assets,
    },
    account: {
      openingTotalCents: roundState ? Number(roundState.opening_total_cents) : Number(classroom.initial_cash_cents),
      defaultAllocations: roundState ? roundState.default_allocations : {},
      defaultCashCents: roundState ? Number(roundState.default_cash_cents) : Number(classroom.initial_cash_cents),
      liquidationEvents: roundState ? (roundState.liquidation_events || []) : [],
      latestSettledRound: latestSettled ? Number(latestSettled.round_no) : null,
      latestRank: latestSettled ? (latestSettled.official_rank || latestSettled.reference_rank) : null,
      latestRankIsReference: latestSettled ? !latestSettled.is_official_ranked : false,
      latestParticipantCount: latestSettled ? Number(latestSettled.official_participant_count) : 0,
    },
    draft: draft
      ? {
        allocations: draft.allocations,
        draftVersion: Number(draft.draft_version),
        updatedAt: draft.updated_at,
      }
      : null,
    submission: submission
      ? {
        allocations: submission.allocations,
        cashCents: Number(submission.cash_cents),
        totalCents: Number(submission.total_cents),
        submittedAt: submission.submitted_at,
      }
      : null,
    currentRoundSettlement: currentRoundSettlement ? formatSettlement(currentRoundSettlement) : null,
    leaderboard,
  };
}

function formatSettlement(s) {
  return {
    roundNo: Number(s.round_no),
    participationType: s.participation_type,
    isOfficialRanked: Boolean(s.is_official_ranked),
    openingTotalCents: Number(s.opening_total_cents),
    endingTotalCents: Number(s.ending_total_cents),
    roundPnlCents: Number(s.round_pnl_cents),
    endingCashCents: Number(s.ending_cash_cents),
    itemDetails: s.item_details || [],
    officialRank: s.official_rank == null ? null : Number(s.official_rank),
    referenceRank: s.reference_rank == null ? null : Number(s.reference_rank),
    officialParticipantCount: Number(s.official_participant_count || 0),
    settledAt: s.settled_at,
  };
}

async function saveDraft({ classroomId, roundNo, authUser, allocations, expectedVersion }) {
  return repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomById(classroomId, client);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (classroom.status === 'completed') {
      throw createHttpError(409, '场次已关闭，无法修改草稿');
    }
    if (Number(classroom.current_round) !== Number(roundNo)) {
      throw createHttpError(409, '只能保存当前轮次的草稿');
    }
    const round = await repo.findRound(classroomId, roundNo, client);
    if (!round || round.status === 'revealed') {
      throw createHttpError(409, '本轮已揭晓，无法修改草稿');
    }
    const member = await repo.findMemberBySubject(classroomId, authUser.subject_identity, client);
    if (!member) throw createHttpError(403, '请先加入本场次');
    if (Number(member.first_eligible_round) > Number(roundNo)) {
      throw createHttpError(403, '您将在下一轮开放后参排');
    }

    const roundState = await ensureMemberRoundStateInTx(client, classroom, round, member);
    const check = validateAllocations({
      rawAllocations: allocations,
      openSnapshot: round.open_market_snapshot,
      openingTotalCents: Number(roundState.opening_total_cents),
    });
    if (!check.ok) {
      throw createHttpError(400, check.error);
    }

    const res = await repo.saveDraftWithVersion(client, {
      classroomId,
      roundNo,
      memberId: member.member_id,
      allocations: check.allocations,
      expectedVersion: expectedVersion == null ? 0 : Number(expectedVersion),
    });

    if (res.conflict) {
      throw createHttpError(409, '服务端已有更新的草稿版本', {
        conflict: true,
        serverVersion: res.current ? Number(res.current.draft_version) : 0,
        serverAllocations: res.current ? res.current.allocations : {},
        serverUpdatedAt: res.current ? res.current.updated_at : null,
      });
    }

    return {
      draftVersion: Number(res.draft.draft_version),
      allocations: res.draft.allocations,
      updatedAt: res.draft.updated_at,
      roundLocked: round.status === 'locked',
    };
  });
}

async function submitAllocation({ classroomId, roundNo, authUser, allocations, clientRequestId }) {
  const reqId = String(clientRequestId || '').trim();
  if (!reqId) throw createHttpError(400, '缺少提交幂等标识 clientRequestId');

  return repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (classroom.status === 'completed') {
      throw createHttpError(409, '场次已关闭，无法提交配置');
    }
    if (Number(classroom.current_round) !== Number(roundNo)) {
      throw createHttpError(409, '当前不在该轮次');
    }

    const round = await repo.findRoundForUpdate(client, classroomId, roundNo);
    const member = await repo.findMemberBySubject(classroomId, authUser.subject_identity, client);
    if (!member) throw createHttpError(403, '请先加入本场次');

    const dup = await repo.findSubmissionByRequestId(client, classroomId, roundNo, member.member_id, reqId);
    if (dup) {
      return {
        idempotent: true,
        submission: {
          allocations: dup.allocations,
          cashCents: Number(dup.cash_cents),
          totalCents: Number(dup.total_cents),
          submittedAt: dup.submitted_at,
        },
      };
    }

    if (!round || round.status !== 'configuring') {
      throw createHttpError(409, round && round.status === 'locked' ? '本轮已锁单，无法提交' : '本轮当前未开放配置');
    }
    if (Number(member.first_eligible_round) > Number(roundNo)) {
      throw createHttpError(403, '您将在下一轮开放后参排');
    }

    const roundState = await ensureMemberRoundStateInTx(client, classroom, round, member);
    const openingTotalCents = Number(roundState.opening_total_cents);
    const check = validateAllocations({
      rawAllocations: allocations,
      openSnapshot: round.open_market_snapshot,
      openingTotalCents,
    });
    if (!check.ok) {
      throw createHttpError(400, check.error);
    }

    const sub = await repo.insertSubmission(client, {
      classroomId,
      roundNo,
      memberId: member.member_id,
      allocations: check.allocations,
      cashCents: check.cashCents,
      totalCents: openingTotalCents,
      clientRequestId: reqId,
    });

    return {
      idempotent: false,
      submission: {
        allocations: sub.allocations,
        cashCents: Number(sub.cash_cents),
        totalCents: Number(sub.total_cents),
        submittedAt: sub.submitted_at,
      },
    };
  });
}

// ---------- 教师控场事务 ----------

async function openRound({ classroomId, roundNo, expectedStateVersion }) {
  const result = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (expectedStateVersion != null && Number(classroom.state_version) !== Number(expectedStateVersion)) {
      throw createHttpError(409, '场次状态已变化，请刷新后重试');
    }

    const targetRound = Number(roundNo);
    const curRound = Number(classroom.current_round);

    let round;
    if (classroom.status === 'pending' && targetRound === 1 && curRound === 1) {
      round = await repo.findRoundForUpdate(client, classroomId, 1);
      round = await repo.updateRoundState(client, round.round_id, {
        status: 'configuring',
        stateVersion: Number(round.state_version) + 1,
      });
    } else if (classroom.status === 'revealed' && targetRound === curRound + 1 && targetRound <= Number(classroom.total_rounds)) {
      const prevRound = await repo.findRound(classroomId, curRound, client);
      const roundMeta = classroom.scenario_snapshot.rounds[targetRound - 1];
      const prevCbStates = prevRound.settled_market_snapshot ? prevRound.settled_market_snapshot.cbResults : null;
      const openSnapshot = buildRoundOpenCatalog(roundMeta, prevRound.settled_market_snapshot, prevCbStates);
      round = await repo.insertRound(client, {
        classroomId,
        roundNo: targetRound,
        calendarYear: roundMeta.calendarYear,
        status: 'configuring',
        openMarketSnapshot: openSnapshot,
      });
    } else {
      throw createHttpError(409, '当前状态不允许开放该轮配置');
    }

    // 开放本轮前，为所有具备参排资格的学员幂等生成期初快照（含暂停策略转现金）
    const members = await repo.listMembers(classroomId, client);
    for (const m of members) {
      if (Number(m.first_eligible_round) <= targetRound) {
        await ensureMemberRoundStateInTx(client, classroom, round, m);
      }
    }

    const nextVer = Number(classroom.state_version) + 1;
    const updatedClassroom = await repo.updateClassroomState(client, classroomId, {
      status: 'configuring',
      currentRound: targetRound,
      stateVersion: nextVer,
    });

    return { classroom: updatedClassroom, round };
  });

  sseHub.broadcastStateChange(classroomId, {
    roundNo: result.round.round_no,
    stateVersion: result.classroom.state_version,
    status: result.classroom.status,
  });

  return summarizeClassroom(result.classroom);
}

async function lockRound({ classroomId, roundNo, expectedStateVersion }) {
  const result = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (expectedStateVersion != null && Number(classroom.state_version) !== Number(expectedStateVersion)) {
      throw createHttpError(409, '场次状态已变化，请刷新后重试');
    }
    if (Number(classroom.current_round) !== Number(roundNo) || classroom.status !== 'configuring') {
      throw createHttpError(409, '只有配置中的当前轮次可以锁单');
    }

    const round = await repo.findRoundForUpdate(client, classroomId, roundNo);
    const members = await repo.listMembers(classroomId, client);
    const eligibleMembers = members.filter((m) => Number(m.first_eligible_round) <= Number(roundNo));
    const subs = await repo.listLatestSubmissions(classroomId, roundNo, client);
    const subMemberIds = new Set(subs.map((s) => Number(s.member_id)));
    const submittedCount = eligibleMembers.filter((m) => subMemberIds.has(Number(m.member_id))).length;

    const updatedRound = await repo.updateRoundState(client, round.round_id, {
      status: 'locked',
      stateVersion: Number(round.state_version) + 1,
      lockedAt: new Date(),
      lockedParticipantCount: eligibleMembers.length,
      lockedSubmittedCount: submittedCount,
    });

    const nextVer = Number(classroom.state_version) + 1;
    const updatedClassroom = await repo.updateClassroomState(client, classroomId, {
      status: 'locked',
      stateVersion: nextVer,
    });

    return { classroom: updatedClassroom, round: updatedRound };
  });

  sseHub.broadcastStateChange(classroomId, {
    roundNo: result.round.round_no,
    stateVersion: result.classroom.state_version,
    status: result.classroom.status,
  });

  return summarizeClassroom(result.classroom);
}

async function unlockRound({ classroomId, roundNo, expectedStateVersion }) {
  const result = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (expectedStateVersion != null && Number(classroom.state_version) !== Number(expectedStateVersion)) {
      throw createHttpError(409, '场次状态已变化，请刷新后重试');
    }
    if (Number(classroom.current_round) !== Number(roundNo) || classroom.status !== 'locked') {
      throw createHttpError(409, '只有已锁单且未揭晓的轮次可以解锁');
    }

    const round = await repo.findRoundForUpdate(client, classroomId, roundNo);
    if (round.status !== 'locked') {
      throw createHttpError(409, '已揭晓的轮次无法解锁');
    }

    const updatedRound = await repo.updateRoundState(client, round.round_id, {
      status: 'configuring',
      stateVersion: Number(round.state_version) + 1,
    });

    const nextVer = Number(classroom.state_version) + 1;
    const updatedClassroom = await repo.updateClassroomState(client, classroomId, {
      status: 'configuring',
      stateVersion: nextVer,
    });

    return { classroom: updatedClassroom, round: updatedRound };
  });

  sseHub.broadcastStateChange(classroomId, {
    roundNo: result.round.round_no,
    stateVersion: result.classroom.state_version,
    status: result.classroom.status,
  });

  return summarizeClassroom(result.classroom);
}

async function revealRound({ classroomId, roundNo, expectedStateVersion }) {
  const result = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');

    const round = await repo.findRoundForUpdate(client, classroomId, roundNo);
    if (!round) throw createHttpError(404, '轮次不存在');

    // 重复揭晓幂等返回已落库结果，每轮只结算一次
    if (round.status === 'revealed') {
      return { classroom, round, alreadyRevealed: true };
    }

    if (expectedStateVersion != null && Number(classroom.state_version) !== Number(expectedStateVersion)) {
      throw createHttpError(409, '场次状态已变化，请刷新后重试');
    }
    if (Number(classroom.current_round) !== Number(roundNo) || round.status !== 'locked') {
      throw createHttpError(409, '只有已锁单的当前轮次可以揭晓结算');
    }

    const roundMeta = classroom.scenario_snapshot.rounds[Number(roundNo) - 1];
    const settledMarket = computeRoundMarketSettlement(round.open_market_snapshot, roundMeta);

    const members = await repo.listMembers(classroomId, client);
    const eligibleMembers = members.filter((m) => Number(m.first_eligible_round) <= Number(roundNo));
    const subs = await repo.listLatestSubmissions(classroomId, roundNo, client);
    const subByMember = new Map(subs.map((s) => [Number(s.member_id), s]));

    const memberSettlementPayloads = [];
    for (const m of eligibleMembers) {
      const state = await ensureMemberRoundStateInTx(client, classroom, round, m);
      const sub = subByMember.get(Number(m.member_id));
      const allocations = sub ? sub.allocations : state.default_allocations;
      const participationType = sub ? 'submitted' : 'carried_over';
      const settled = settleMemberRound({
        openingTotalCents: Number(state.opening_total_cents),
        allocations,
        openSnapshot: round.open_market_snapshot,
        settledMarket,
      });
      memberSettlementPayloads.push({
        memberId: Number(m.member_id),
        participationType,
        ...settled,
      });
    }

    const ranked = rankOfficialSettlements(memberSettlementPayloads);
    for (const item of ranked) {
      await repo.insertSettlement(client, {
        classroomId,
        roundNo: Number(roundNo),
        memberId: item.memberId,
        participationType: item.participationType,
        isOfficialRanked: true,
        openingTotalCents: item.openingTotalCents,
        endingTotalCents: item.endingTotalCents,
        roundPnlCents: item.roundPnlCents,
        endingCashCents: item.endingCashCents,
        itemDetails: item.itemDetails,
        officialRank: item.officialRank,
        referenceRank: null,
        officialParticipantCount: item.officialParticipantCount,
      });
    }

    const updatedRound = await repo.updateRoundState(client, round.round_id, {
      status: 'revealed',
      stateVersion: Number(round.state_version) + 1,
      settledMarketSnapshot: settledMarket,
      revealedAt: new Date(),
    });

    const isLastRound = Number(roundNo) === Number(classroom.total_rounds);
    const nextVer = Number(classroom.state_version) + 1;
    const updatedClassroom = await repo.updateClassroomState(client, classroomId, {
      status: isLastRound ? 'completed' : 'revealed',
      stateVersion: nextVer,
      completedAt: isLastRound ? new Date() : undefined,
    });

    return { classroom: updatedClassroom, round: updatedRound, alreadyRevealed: false };
  });

  if (!result.alreadyRevealed) {
    sseHub.broadcastStateChange(classroomId, {
      roundNo: result.round.round_no,
      stateVersion: result.classroom.state_version,
      status: result.classroom.status,
    });
  }

  return summarizeClassroom(result.classroom);
}

async function revealIdentity({ classroomId }) {
  const result = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (classroom.identity_revealed) return classroom;
    return repo.updateClassroomState(client, classroomId, {
      identityRevealed: true,
      stateVersion: Number(classroom.state_version) + 1,
    });
  });

  sseHub.broadcastStateChange(classroomId, {
    roundNo: result.current_round,
    stateVersion: result.state_version,
    status: result.status,
  });

  return summarizeClassroom(result);
}

async function manageMemberNickname({ classroomId, memberId, displayNickname, isMasked }) {
  const clean = String(displayNickname || '').trim().slice(0, 32);
  if (!clean) throw createHttpError(400, '昵称不能为空');
  try {
    const updated = await repo.updateMemberNickname(classroomId, memberId, clean, Boolean(isMasked));
    if (!updated) throw createHttpError(404, '学员记录不存在');
    return formatMember(updated);
  } catch (e) {
    if (e && e.code === '23505') {
      throw createHttpError(409, '该场次内已存在相同显示昵称');
    }
    throw e;
  }
}

async function getTeacherState({ classroomId, origin = '' }) {
  const classroom = await repo.findClassroomById(classroomId);
  if (!classroom) throw createHttpError(404, '场次不存在');

  const curRoundNo = Number(classroom.current_round);
  const rounds = await repo.listRounds(classroomId);
  const currentRound = rounds.find((r) => Number(r.round_no) === curRoundNo);
  const members = await repo.listMembers(classroomId);
  const subs = await repo.listLatestSubmissions(classroomId, curRoundNo);
  const subByMember = new Map(subs.map((s) => [Number(s.member_id), s]));

  const participantRows = members.map((m) => {
    const eligible = Number(m.first_eligible_round) <= curRoundNo;
    const sub = subByMember.get(Number(m.member_id));
    let submitStatus = 'waiting_next_round';
    if (eligible) {
      if (sub) submitStatus = 'submitted';
      else if (currentRound.status === 'locked' || currentRound.status === 'revealed') submitStatus = 'carried_over';
      else submitStatus = 'pending';
    }
    return {
      memberId: Number(m.member_id),
      displayNickname: m.display_nickname,
      classroomNickname: m.classroom_nickname,
      isNicknameMasked: Boolean(m.is_nickname_masked),
      firstEligibleRound: Number(m.first_eligible_round),
      eligibleThisRound: eligible,
      submitStatus,
      submittedAt: sub ? sub.submitted_at : null,
    };
  });

  const eligibleCount = participantRows.filter((p) => p.eligibleThisRound).length;
  const submittedCount = participantRows.filter((p) => p.submitStatus === 'submitted').length;
  const unsubmittedCount = eligibleCount - submittedCount;

  // 教师管理端可看真实信息（blindActive: false）
  const assets = projectAssetsForViewer({
    openSnapshot: currentRound.open_market_snapshot,
    settledMarket: currentRound.status === 'revealed' ? currentRound.settled_market_snapshot : null,
    blindActive: false,
    isRevealed: currentRound.status === 'revealed',
  });

  const settlements = currentRound.status === 'revealed'
    ? (await repo.listRoundSettlements(classroomId, curRoundNo)).map((s) => ({
      memberId: Number(s.member_id),
      displayNickname: s.display_nickname,
      participationType: s.participation_type,
      isOfficialRanked: Boolean(s.is_official_ranked),
      officialRank: s.official_rank == null ? null : Number(s.official_rank),
      referenceRank: s.reference_rank == null ? null : Number(s.reference_rank),
      openingTotalCents: Number(s.opening_total_cents),
      endingTotalCents: Number(s.ending_total_cents),
      roundPnlCents: Number(s.round_pnl_cents),
      cumulativePnlCents: Number(s.ending_total_cents) - Number(classroom.initial_cash_cents),
    }))
    : [];

  const joinPath = `/classroom.html?code=${classroom.classroom_code}`;
  const joinUrl = origin ? `${origin.replace(/\/$/, '')}${joinPath}` : joinPath;
  const qrDataUrl = await generateQrPayload(joinUrl);

  return {
    classroom: summarizeClassroom(classroom),
    joinUrl,
    qrDataUrl,
    round: {
      roundNo: curRoundNo,
      calendarYear: Number(currentRound.calendar_year),
      status: currentRound.status,
      stateVersion: Number(currentRound.state_version),
      marketHeaderTitle: currentRound.open_market_snapshot.marketHeaderTitle,
      showIndexLevel: Boolean(currentRound.open_market_snapshot.showIndexLevel),
      indexOpenLevel: currentRound.open_market_snapshot.indexOpenLevel,
      indexEndLevel: currentRound.settled_market_snapshot ? currentRound.settled_market_snapshot.indexEndLevel : null,
      marketPeDisplay: currentRound.open_market_snapshot.marketPeDisplay,
      marketPbDisplay: currentRound.open_market_snapshot.marketPbDisplay,
      assets,
    },
    counts: {
      totalMembers: members.length,
      eligibleCount,
      submittedCount,
      unsubmittedCount,
    },
    participants: participantRows,
    settlements,
    settledRounds: rounds.filter((r) => r.status === 'revealed').map((r) => Number(r.round_no)),
  };
}

async function getProjectorState({ classroomId, roundNo = null }) {
  const classroom = await repo.findClassroomById(classroomId);
  if (!classroom) throw createHttpError(404, '场次不存在');

  const targetRoundNo = roundNo ? Number(roundNo) : Number(classroom.current_round);
  const round = await repo.findRound(classroomId, targetRoundNo);
  if (!round) throw createHttpError(404, '轮次不存在');

  const blindActive = Boolean(classroom.blind_mode) && !Boolean(classroom.identity_revealed);
  const isRevealed = round.status === 'revealed';

  const assets = projectAssetsForViewer({
    openSnapshot: round.open_market_snapshot,
    settledMarket: isRevealed ? round.settled_market_snapshot : null,
    blindActive,
    isRevealed,
  });

  let prevRevealedRound = null;
  if (!isRevealed && targetRoundNo > 1) {
    const prevRound = await repo.findRound(classroomId, targetRoundNo - 1);
    if (prevRound && prevRound.status === 'revealed') {
      prevRevealedRound = {
        roundNo: targetRoundNo - 1,
        calendarYear: blindActive ? null : Number(prevRound.calendar_year),
        assets: projectAssetsForViewer({
          openSnapshot: prevRound.open_market_snapshot,
          settledMarket: prevRound.settled_market_snapshot,
          blindActive,
          isRevealed: true,
        }),
      };
    }
  }

  let leaderboard = [];
  if (isRevealed) {
    const rows = await repo.listRoundSettlements(classroomId, targetRoundNo);
    leaderboard = rows
      .filter((s) => s.is_official_ranked)
      .map((s) => ({
        displayNickname: s.display_nickname,
        rank: Number(s.official_rank),
        endingTotalCents: Number(s.ending_total_cents),
        roundPnlCents: Number(s.round_pnl_cents),
        cumulativePnlCents: Number(s.ending_total_cents) - Number(classroom.initial_cash_cents),
      }));
  }

  return {
    classroom: summarizeClassroom(classroom, { blindActive }),
    round: {
      roundNo: targetRoundNo,
      status: round.status,
      calendarYear: blindActive ? null : Number(round.calendar_year),
      marketHeaderTitle: round.open_market_snapshot.marketHeaderTitle,
      showIndexLevel: Boolean(round.open_market_snapshot.showIndexLevel),
      indexOpenLevel: round.open_market_snapshot.showIndexLevel ? round.open_market_snapshot.indexOpenLevel : null,
      indexEndLevel: (isRevealed && round.open_market_snapshot.showIndexLevel && round.settled_market_snapshot)
        ? round.settled_market_snapshot.indexEndLevel
        : null,
      marketPeDisplay: blindActive
        ? bucketPe(round.open_market_snapshot.marketPeValue)
        : round.open_market_snapshot.marketPeDisplay,
      marketPbDisplay: blindActive
        ? bucketPb(round.open_market_snapshot.marketPbValue)
        : round.open_market_snapshot.marketPbDisplay,
      assets,
    },
    prevRevealedRound,
    leaderboard,
  };
}

async function getMemberHistory({ classroomId, authUser }) {
  const classroom = await repo.findClassroomById(classroomId);
  if (!classroom) throw createHttpError(404, '场次不存在');
  const member = await repo.findMemberBySubject(classroomId, authUser.subject_identity);
  if (!member) throw createHttpError(403, '您尚未加入该场次');

  const blindActive = Boolean(classroom.blind_mode) && !Boolean(classroom.identity_revealed);
  const settlements = await repo.listMemberSettlements(classroomId, member.member_id);
  const rounds = await repo.listRounds(classroomId);
  const roundMap = new Map(rounds.map((r) => [Number(r.round_no), r]));

  return {
    classroom: summarizeClassroom(classroom, { blindActive }),
    member: formatMember(member),
    rounds: settlements.map((s) => {
      const r = roundMap.get(Number(s.round_no));
      return {
        ...formatSettlement(s),
        calendarYear: (!blindActive && r) ? Number(r.calendar_year) : null,
      };
    }),
  };
}

async function getMemberReport({ classroomId, authUser }) {
  const history = await getMemberHistory({ classroomId, authUser });
  const classroom = await repo.findClassroomById(classroomId);
  const member = await repo.findMemberBySubject(classroomId, authUser.subject_identity);

  const initialCashCents = Number(classroom.initial_cash_cents);
  const last = history.rounds.length ? history.rounds[history.rounds.length - 1] : null;
  const finalTotalCents = last ? last.endingTotalCents : initialCashCents;
  const totalPnlCents = finalTotalCents - initialCashCents;
  const totalReturnPct = Number(((totalPnlCents / initialCashCents) * 100).toFixed(2));

  return {
    classroom: history.classroom,
    member: history.member,
    ready: classroom.status === 'completed' || history.rounds.length === Number(classroom.total_rounds),
    summary: {
      initialCashCents,
      finalTotalCents,
      totalPnlCents,
      totalReturnPct,
    },
    rounds: history.rounds,
    afterClassNote: member.after_class_note || '',
    afterClassNoteUpdatedAt: member.after_class_note_updated_at || null,
  };
}

async function saveAfterClassNote({ classroomId, authUser, note }) {
  const classroom = await repo.findClassroomById(classroomId);
  if (!classroom) throw createHttpError(404, '场次不存在');
  const member = await repo.findMemberBySubject(classroomId, authUser.subject_identity);
  if (!member) throw createHttpError(403, '您尚未加入该场次');
  const updated = await repo.updateMemberNote(classroomId, member.member_id, note);
  return {
    afterClassNote: updated.after_class_note,
    afterClassNoteUpdatedAt: updated.after_class_note_updated_at,
  };
}

async function closeClassroom({ classroomId }) {
  const result = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    if (classroom.status === 'completed') {
      return { classroom, alreadyClosed: true };
    }
    const nextVer = Number(classroom.state_version) + 1;
    const updated = await repo.updateClassroomState(client, classroomId, {
      status: 'completed',
      stateVersion: nextVer,
      completedAt: classroom.completed_at || new Date(),
    });
    return { classroom: updated, alreadyClosed: false };
  });

  if (!result.alreadyClosed) {
    sseHub.broadcastStateChange(classroomId, {
      roundNo: result.classroom.current_round,
      stateVersion: result.classroom.state_version,
      status: result.classroom.status,
    });
  }

  return summarizeClassroom(result.classroom);
}

async function deleteClassroom({ classroomId }) {
  const deleted = await repo.withTransaction(async (client) => {
    const classroom = await repo.findClassroomByIdForUpdate(client, classroomId);
    if (!classroom) throw createHttpError(404, '场次不存在');
    return repo.deleteClassroom(client, classroomId);
  });
  return deleted;
}

module.exports = {
  createClassroom,
  createCreationPreview,
  confirmCreationPreview,
  closeClassroom,
  deleteClassroom,
  resolveByCode,
  listMyClassrooms,
  joinClassroom,
  getStudentState,
  saveDraft,
  submitAllocation,
  openRound,
  lockRound,
  unlockRound,
  revealRound,
  revealIdentity,
  manageMemberNickname,
  getTeacherState,
  getProjectorState,
  getMemberHistory,
  getMemberReport,
  saveAfterClassNote,
};
