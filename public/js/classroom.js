(function () {
  'use strict';

  const api = window.classroomApi;
  const P = window.classroomPresenter;

  const state = {
    me: null,
    accountIdentity: '',
    isAdmin: false,
    activeTab: 'lobby', // lobby | student | history | teacher | projector
    classroomId: null,
    pendingJoinClassroom: null,
    studentData: null,
    draftAllocations: {},
    draftVersion: 0,
    syncStatus: 'idle', // idle | saved_local | synced | submitted | sync_failed | conflict
    conflictInfo: null,
    isSubmitting: false,
    stateSeq: 0,
    lastKnownStateVersion: 0,
    sse: null,
    pollTimer: null,
    draftSyncTimer: null,
    teacherClassroomId: null,
    teacherClassrooms: [],
    teacherPage: 1,
    teacherTotal: 0,
    teacherTotalPages: 1,
    teacherDetailSeq: 0,
    teacherData: null,
    projectorRoundNo: null,
    sheet: {
      open: false,
      assetId: null,
      capCents: 0,
      maxWan: 0,
      selectedWan: 0,
      wheelDirty: false,
      dragStartY: 0,
      dragStartOffset: 0,
      currentOffset: 0,
      dragging: false,
    },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeText(v) {
    return String(v == null ? '' : v);
  }

  function setVisible(id, visible) {
    const el = $(id);
    if (el) el.hidden = !visible;
  }

  function showBanner(msg) {
    const el = $('cr-banner');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  async function confirmDialog(message, options) {
    if (typeof window.projectConfirm === 'function') {
      return window.projectConfirm(message, options);
    }
    return window.confirm(message);
  }

  function renderTabs() {
    const nav = $('cr-main-tabs');
    if (!nav) return;
    nav.textContent = '';
    const tabs = [{ id: 'lobby', label: '课堂列表 / 我的历史' }];
    if (state.classroomId && state.studentData && state.studentData.joined) {
      tabs.push({ id: 'student', label: '本轮配置' });
      tabs.push({ id: 'history', label: '投资历史与报告' });
    }
    if (state.isAdmin) {
      tabs.push({ id: 'teacher', label: '教师控制台' });
      if (state.teacherClassroomId) {
        tabs.push({ id: 'projector', label: '课堂投屏' });
      }
    }
    tabs.forEach(function (t) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'classroom-tab' + (state.activeTab === t.id ? ' active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', function () {
        switchTab(t.id);
      });
      nav.appendChild(btn);
    });
  }

  function switchTab(tabId) {
    state.activeTab = tabId;
    renderTabs();
    setVisible('view-lobby', tabId === 'lobby');
    setVisible('view-join-prompt', tabId === 'join-prompt');
    setVisible('view-student', tabId === 'student');
    setVisible('view-history', tabId === 'history');
    setVisible('view-teacher', tabId === 'teacher');
    setVisible('view-projector', tabId === 'projector');

    if (tabId === 'lobby') loadLobby();
    if (tabId === 'student') refreshStudentState();
    if (tabId === 'history') loadHistoryAndReport();
    if (tabId === 'teacher') loadTeacherConsole();
    if (tabId === 'projector') loadProjectorView();
  }

  async function init() {
    try {
      const me = await api.getMe();
      if (!me || !me.username) {
        window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      state.me = me;
      state.accountIdentity = me.accountIdentity || me.username;
      state.isAdmin = me.role === 'admin';
      window.username = me.username;
      window.accountIdentity = state.accountIdentity;
      const badge = $('cr-user-badge');
      if (badge) badge.textContent = (me.nickname || me.username) + (state.isAdmin ? ' · 教师/管理员' : ' · 学员');

      bindEvents();

      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const cid = params.get('classroomId');
      const view = params.get('view');

      if (code) {
        await handleJoinByCode(code);
      } else if (cid) {
        state.classroomId = Number(cid);
        await enterClassroom(state.classroomId);
      } else if (view === 'teacher' && state.isAdmin) {
        switchTab('teacher');
      } else {
        switchTab('lobby');
      }
    } catch (e) {
      showBanner('初始化失败：' + (e && e.message ? e.message : '请刷新重试'));
    }
  }

  function bindEvents() {
    $('join-code-btn').addEventListener('click', function () {
      const code = $('join-code-input').value.trim();
      if (code) handleJoinByCode(code);
    });
    $('join-confirm-btn').addEventListener('click', confirmJoinClassroom);
    $('join-cancel-btn').addEventListener('click', function () { switchTab('lobby'); });

    $('btn-clear-all').addEventListener('click', function () {
      applyQuickWholeAction('clear');
    });
    $('btn-restore-open').addEventListener('click', function () {
      applyQuickWholeAction('restore');
    });
    $('btn-save-draft').addEventListener('click', function () {
      syncDraftToServer(true);
    });
    $('btn-submit-round').addEventListener('click', submitCurrentRound);
    $('btn-save-note').addEventListener('click', saveNote);

    if ($('btn-teacher-create')) {
      $('btn-teacher-create').addEventListener('click', createClassroomFromTeacher);
    }
    if ($('btn-teacher-preview')) {
      $('btn-teacher-preview').addEventListener('click', previewClassroomFromTeacher);
    }
    if ($('btn-teacher-confirm')) {
      $('btn-teacher-confirm').addEventListener('click', confirmClassroomFromPreview);
    }
    if ($('teacher-new-mode')) {
      $('teacher-new-mode').addEventListener('change', function () {
        invalidateTeacherPreview();
        syncTeacherModeUi();
      });
    }
    if ($('teacher-demo-variant')) {
      $('teacher-demo-variant').addEventListener('change', function () {
        invalidateTeacherPreview();
        syncTeacherModeUi();
      });
    }
    if ($('teacher-demo-seed')) {
      $('teacher-demo-seed').addEventListener('input', invalidateTeacherPreview);
    }
    if ($('teacher-start-year')) {
      $('teacher-start-year').addEventListener('input', function () {
        invalidateTeacherPreview();
        syncTeacherYearRange();
      });
    }
    if ($('btn-teacher-precheck')) {
      $('btn-teacher-precheck').addEventListener('click', runTeacherPrecheck);
    }
    if ($('btn-teacher-load-options')) {
      $('btn-teacher-load-options').addEventListener('click', function () { loadTeacherCreationOptions(false); });
    }
    if ($('btn-teacher-random-year')) {
      $('btn-teacher-random-year').addEventListener('click', pickRandomAvailableYear);
    }
    if ($('btn-teacher-sample-all')) {
      $('btn-teacher-sample-all').addEventListener('click', function () { sampleTeacherSelection(null, false); });
    }
    if ($('btn-teacher-sample-next')) {
      $('btn-teacher-sample-next').addEventListener('click', function () { sampleTeacherSelection(null, true); });
    }
    initTeacherIndustryRows();
    syncTeacherModeUi();
    syncTeacherYearRange();

    // 底部面板事件
    $('sheet-close-btn').addEventListener('click', closeAllocSheet);
    $('sheet-cancel-btn').addEventListener('click', closeAllocSheet);
    $('sheet-confirm-btn').addEventListener('click', confirmAllocSheet);
    $('sheet-btn-zero').addEventListener('click', function () { setSheetCents(0); });
    $('sheet-btn-25').addEventListener('click', function () {
      setSheetCents(P.computePercentCapCents(state.sheet.capCents, 25));
    });
    $('sheet-btn-50').addEventListener('click', function () {
      setSheetCents(P.computePercentCapCents(state.sheet.capCents, 50));
    });
    $('sheet-btn-max').addEventListener('click', function () {
      setSheetCents(state.sheet.capCents);
    });
    $('sheet-amount-input').addEventListener('input', function () {
      state.sheet.wheelDirty = false;
      $('sheet-error').textContent = '';
    });
    $('alloc-sheet').addEventListener('click', function (e) {
      if (e.target === $('alloc-sheet')) closeAllocSheet();
    });

    document.addEventListener('keydown', function (e) {
      if (!state.sheet.open) return;
      if (e.key === 'Escape') closeAllocSheet();
      if (e.key === 'Enter') confirmAllocSheet();
    });

    bindWheelGestures();

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.classroomId && state.activeTab === 'student') {
        refreshStudentState();
      }
    });
    window.addEventListener('online', function () {
      if (state.classroomId && state.activeTab === 'student') {
        refreshStudentState();
        if (state.syncStatus === 'saved_local' || state.syncStatus === 'sync_failed') {
          syncDraftToServer(false);
        }
      }
    });
  }

  // ---------- 课堂列表与扫码进场 ----------

  async function loadLobby() {
    const wrap = $('my-classrooms-list');
    wrap.textContent = '加载中...';
    try {
      const data = await api.listMyClassrooms();
      const items = data.items || [];
      wrap.textContent = '';
      if (!items.length) {
        const p = document.createElement('p');
        p.textContent = '暂无参加记录，可输入场次代码或扫描课堂二维码加入。';
        wrap.appendChild(p);
        return;
      }
      items.forEach(function (it) {
        const card = document.createElement('div');
        card.className = 'classroom-card';
        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.textContent = it.title + '（' + it.classroomCode + '）';
        const meta = document.createElement('div');
        meta.className = 'stat-sub';
        meta.textContent = '昵称：' + it.displayNickname +
          ' ｜ 第 ' + it.currentRound + '/' + it.totalRounds + ' 轮' +
          ' ｜ 最新总资产：' + P.centsToWanDisplay(it.latestEndingTotalCents) + ' 万元';
        const btnRow = document.createElement('div');
        btnRow.className = 'classroom-btn-group cr-mt-10';
        const enterBtn = document.createElement('button');
        enterBtn.type = 'button';
        enterBtn.className = 'cr-btn cr-btn-primary';
        enterBtn.textContent = it.status === 'completed' ? '查看结课报告' : '进入课堂';
        enterBtn.addEventListener('click', function () {
          state.classroomId = it.classroomId;
          if (it.status === 'completed') {
            enterClassroom(it.classroomId, 'history');
          } else {
            enterClassroom(it.classroomId, 'student');
          }
        });
        btnRow.appendChild(enterBtn);
        card.appendChild(title);
        card.appendChild(meta);
        card.appendChild(btnRow);
        wrap.appendChild(card);
      });
    } catch (e) {
      wrap.textContent = '加载失败：' + e.message;
    }
  }

  async function handleJoinByCode(code) {
    showBanner('');
    try {
      const res = await api.resolveByCode(code);
      const c = res.classroom;
      state.classroomId = c.classroomId;
      const st = await api.getStudentState(c.classroomId);
      if (st.joined) {
        await enterClassroom(c.classroomId, c.status === 'completed' ? 'history' : 'student');
        return;
      }
      if (c.status === 'completed') {
        showBanner('该场次已完成，已关闭新学员入场。');
        switchTab('lobby');
        return;
      }
      state.pendingJoinClassroom = c;
      $('join-prompt-title').textContent = '加入课堂：' + c.title;
      $('join-prompt-desc').textContent = '场次代码：' + c.classroomCode +
        (c.mode === 'demo' ? '（演示场次·教学示例数据）' : '') +
        '。首次加入请填写课堂昵称：';
      $('join-nickname-input').value = state.me.nickname || '';
      $('join-error').textContent = '';
      switchTab('join-prompt');
    } catch (e) {
      showBanner('无法进入场次：' + e.message);
      switchTab('lobby');
    }
  }

  async function confirmJoinClassroom() {
    const c = state.pendingJoinClassroom;
    if (!c) return;
    const nick = $('join-nickname-input').value.trim();
    if (!nick) {
      $('join-error').textContent = '请填写课堂昵称';
      return;
    }
    try {
      const res = await api.joinClassroom(c.classroomId, nick);
      if (res.nicknameAdjusted) {
        showBanner('场内已有同名昵称，系统已为您分配显示昵称：' + res.member.displayNickname);
      }
      state.classroomId = c.classroomId;
      await enterClassroom(c.classroomId, 'student');
    } catch (e) {
      $('join-error').textContent = e.message;
    }
  }

  async function enterClassroom(classroomId, targetTab) {
    state.classroomId = classroomId;
    connectSse(classroomId);
    await refreshStudentState();
    switchTab(targetTab || 'student');
  }

  // ---------- SSE + 兜底轮询 ----------

  function connectSse(classroomId) {
    disconnectSse();
    const es = api.openEventStream(classroomId);
    if (!es) {
      startFallbackPolling();
      return;
    }
    state.sse = es;
    es.addEventListener('connected', function () {
      stopFallbackPolling();
    });
    es.addEventListener('state_change', function (ev) {
      stopFallbackPolling();
      try {
        const payload = JSON.parse(ev.data || '{}');
        if (Number(payload.stateVersion) > state.lastKnownStateVersion) {
          refreshStudentState();
        }
      } catch (e) {
        refreshStudentState();
      }
    });
    es.onerror = function () {
      startFallbackPolling();
    };
  }

  function disconnectSse() {
    if (state.sse) {
      try { state.sse.close(); } catch (e) {}
      state.sse = null;
    }
    stopFallbackPolling();
  }

  function startFallbackPolling() {
    if (state.pollTimer) return;
    function scheduleNext() {
      const jitter = Math.floor(Math.random() * 1500);
      state.pollTimer = setTimeout(async function () {
        state.pollTimer = null;
        if (!document.hidden && navigator.onLine && state.classroomId && state.activeTab === 'student') {
          await refreshStudentState();
        }
        if (!state.sse || state.sse.readyState !== 1) {
          scheduleNext();
        }
      }, 5000 + jitter);
    }
    scheduleNext();
  }

  function stopFallbackPolling() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ---------- 学员端状态与渲染 ----------

  async function refreshStudentState() {
    if (!state.classroomId) return;
    const seq = ++state.stateSeq;
    try {
      const data = await api.getStudentState(state.classroomId);
      if (seq !== state.stateSeq) return; // 丢弃乱序/过期响应
      state.studentData = data;
      if (!data.joined) return;
      state.lastKnownStateVersion = data.classroom.stateVersion;

      // 恢复草稿（按 accountIdentity + classroomId + roundNo 隔离，保留原始 baseVersion 防止覆盖新版本）
      const rNo = data.round.roundNo;
      const local = P.readLocalDraft(window.localStorage, state.accountIdentity, state.classroomId, rNo);
      const resolved = P.resolveInitialDraftState({
        localDraft: local,
        serverDraft: data.draft,
        serverSubmission: data.submission,
        defaultAllocations: data.account.defaultAllocations,
      });
      state.draftAllocations = resolved.draftAllocations;
      state.draftVersion = resolved.draftVersion;
      state.syncStatus = resolved.syncStatus;
      state.conflictInfo = resolved.conflictInfo;

      renderTabs();
      if (state.activeTab === 'student') renderStudentView();
    } catch (e) {
      showBanner('状态刷新失败：' + e.message);
    }
  }

  function isCurrentConfigSubmitted() {
    const d = state.studentData;
    if (!d || !d.submission || !d.submission.allocations) return false;
    return P.canonicalizeAllocationsJson(state.draftAllocations) ===
      P.canonicalizeAllocationsJson(d.submission.allocations);
  }

  function updateStudentSubmitButton() {
    const btn = $('btn-submit-round');
    if (!btn) return;
    const d = state.studentData;
    const canConfigure = Boolean(d && d.joined && d.eligibleThisRound && d.round && d.round.status === 'configuring');
    const submittedMatch = isCurrentConfigSubmitted();
    btn.disabled = !canConfigure || state.isSubmitting || submittedMatch;
    btn.textContent = state.isSubmitting ? '提交中...' : (submittedMatch ? '已提交' : '正式提交');
  }

  function updateSyncPill() {
    const pill = $('sync-status-pill');
    if (!pill) return;
    pill.className = 'sync-pill';
    const effective = isCurrentConfigSubmitted()
      ? 'submitted'
      : (state.syncStatus === 'submitted' ? 'synced' : state.syncStatus);
    if (effective === 'saved_local') pill.textContent = '已保存到本机';
    else if (effective === 'synced') { pill.textContent = '已同步'; pill.classList.add('ok'); }
    else if (effective === 'submitted') { pill.textContent = '已提交'; pill.classList.add('ok'); }
    else if (effective === 'sync_failed') { pill.textContent = '同步失败（已保留本机）'; pill.classList.add('error'); }
    else if (effective === 'conflict') { pill.textContent = '草稿版本冲突'; pill.classList.add('error'); }
    else pill.textContent = '期初默认配置';
  }

  function renderStudentView() {
    const d = state.studentData;
    if (!d || !d.joined) return;
    const c = d.classroom;
    const r = d.round;
    const acct = d.account;

    $('cr-page-title').textContent = c.title + ' · 第 ' + r.roundNo + '/' + c.totalRounds + ' 轮';

    const openingCents = acct.openingTotalCents;
    const allocSum = P.computeAllocatedSumCents(state.draftAllocations);
    const cashCents = Math.max(0, openingCents - allocSum);

    const grid = $('student-summary-grid');
    grid.textContent = '';

    const rankText = acct.latestRank == null
      ? '待结算'
      : (acct.latestRankIsReference
        ? ('参考第 ' + acct.latestRank + ' 名 / ' + acct.latestParticipantCount + ' 人')
        : ('第 ' + acct.latestRank + ' 名 / ' + acct.latestParticipantCount + ' 人'));

    const mktText = r.showIndexLevel
      ? (Number(r.indexOpenLevel).toFixed(2) + (r.indexEndLevel != null ? (' → ' + Number(r.indexEndLevel).toFixed(2)) : ''))
      : ('PE ' + r.marketPeDisplay + ' / PB ' + r.marketPbDisplay);
    const mktSub = r.showIndexLevel ? ('PE ' + r.marketPeDisplay + ' / PB ' + r.marketPbDisplay) : (c.mode === 'demo' ? '教学示例数据' : '市场估值');

    const boxes = [
      { label: '本轮期初总资产', value: P.centsToWanDisplay(openingCents) + ' 万', sub: '昵称：' + d.member.displayNickname },
      { label: '剩余现金', value: P.centsToWanDisplay(cashCents) + ' 万', sub: '未分配自动计入现金' },
      { label: '最近已结算排名', value: rankText, sub: acct.latestSettledRound ? ('第 ' + acct.latestSettledRound + ' 轮') : '首轮结算前' },
      { label: r.marketHeaderTitle, value: mktText, sub: mktSub },
    ];
    boxes.forEach(function (b) {
      const box = document.createElement('div');
      box.className = 'stat-box';
      const l = document.createElement('div'); l.className = 'stat-label'; l.textContent = b.label;
      const v = document.createElement('div'); v.className = 'stat-value'; v.textContent = b.value;
      const s = document.createElement('div'); s.className = 'stat-sub'; s.textContent = b.sub;
      box.appendChild(l); box.appendChild(v); box.appendChild(s);
      grid.appendChild(box);
    });

    // 状态横幅与按钮可用性
    const canConfigure = d.eligibleThisRound && r.status === 'configuring';
    const hasSubmitted = Boolean(d.submission && d.submission.allocations);
    const isSubmittedMatch = isCurrentConfigSubmitted();
    $('btn-clear-all').disabled = !canConfigure;
    $('btn-restore-open').disabled = !canConfigure;
    $('btn-save-draft').disabled = !d.eligibleThisRound || r.status === 'revealed';
    updateStudentSubmitButton();

    if (!d.eligibleThisRound) {
      showBanner('您是在本轮锁单/揭晓后加入的，请等待第 ' + (r.roundNo + 1) + ' 轮开放配置后参排。');
    } else if (r.status === 'pending') {
      showBanner('本轮尚未开放配置，请等待教师开盘。');
    } else if (r.status === 'locked') {
      showBanner('本轮已锁单，有效提交已冻结；若需修改请等待教师解锁。');
    } else if (r.status === 'revealed') {
      showBanner('本轮已揭晓并完成结算！' + (r.roundNo < c.totalRounds ? '请等待教师开启下一轮。' : '全部 15 轮已结束，可前往「投资历史与报告」查看结课报告。'));
    } else if (isSubmittedMatch) {
      showBanner('已提交成功，当前配置已作为本轮有效提交；修改投资配置后可重新提交。');
    } else if (hasSubmitted) {
      showBanner('投资配置已修改，请点击「正式提交」以更新本轮有效提交。');
    } else {
      showBanner(c.mode === 'demo' ? '当前为演示场次（教学示例数据），可自由配置并点击「正式提交」。' : '');
    }

    // 暂停策略转现金提示
    const liqBox = $('student-liquidation-box');
    if (acct.liquidationEvents && acct.liquidationEvents.length) {
      liqBox.hidden = false;
      liqBox.textContent = '本轮开盘前，因策略暂停已自动转入现金：' + acct.liquidationEvents.map(function (ev) {
        return ev.alias + ' ' + P.centsToWanDisplay(ev.amountCents) + ' 万元（' + ev.reason + '）';
      }).join('；');
    } else {
      liqBox.hidden = true;
    }

    // 冲突提示
    renderConflictBox();
    updateSyncPill();

    // 渲染资产配置表
    const isRevealed = r.status === 'revealed';
    $('th-round-return').hidden = !isRevealed;
    const tbody = $('student-alloc-tbody');
    tbody.textContent = '';

    (r.assets || []).forEach(function (a) {
      const tr = document.createElement('tr');
      if (a.assetType === 'bond') tr.className = 'row-bond';
      if (a.paused) tr.className += ' row-paused';

      const tdInd = document.createElement('td');
      tdInd.textContent = a.industryName;

      const tdName = document.createElement('td');
      tdName.textContent = a.alias;
      if (a.stockName) {
        const nameSub = document.createElement('div');
        nameSub.className = 'stat-sub';
        nameSub.textContent = a.stockName + (a.canonicalCode ? (' ' + a.canonicalCode) : '');
        tdName.appendChild(nameSub);
      }
      if (a.paused && a.pauseReason) {
        const span = document.createElement('div');
        span.className = 'stat-sub';
        span.textContent = '暂停：' + a.pauseReason;
        tdName.appendChild(span);
      }
      if (a.assetType === 'cb' && a.cbInfo) {
        const span = document.createElement('div');
        span.className = 'stat-sub';
        span.textContent = '期初价 ' + a.cbInfo.openPrice + ' ｜ 转股价值 ' + a.cbInfo.conversionValue + ' ｜ 溢价 ' + a.cbInfo.premiumPct + '% ｜ 剩 ' + a.cbInfo.remainingYears + ' 年';
        tdName.appendChild(span);
      }

      const tdPe = document.createElement('td');
      tdPe.textContent = a.peDisplay || '—';

      const tdPb = document.createElement('td');
      tdPb.textContent = a.pbDisplay || '—';

      const tdAlloc = document.createElement('td');
      const curCents = Number(state.draftAllocations[a.assetId] || 0);
      const cellBtn = document.createElement('button');
      cellBtn.type = 'button';
      cellBtn.className = 'alloc-cell-btn' + (curCents > 0 ? ' has-value' : '');
      cellBtn.textContent = P.centsToWanDisplay(curCents);
      cellBtn.disabled = !canConfigure || a.paused;
      cellBtn.addEventListener('click', function () {
        openAllocSheet(a);
      });
      tdAlloc.appendChild(cellBtn);

      tr.appendChild(tdInd);
      tr.appendChild(tdName);
      tr.appendChild(tdPe);
      tr.appendChild(tdPb);
      tr.appendChild(tdAlloc);

      if (isRevealed) {
        const tdRet = document.createElement('td');
        const retVal = a.returnRate;
        tdRet.textContent = P.formatReturnPct(retVal);
        if (retVal > 0) tdRet.className = 'ret-pos';
        else if (retVal < 0) tdRet.className = 'ret-neg';
        tr.appendChild(tdRet);
      }

      tbody.appendChild(tr);
    });

    // 策略成分说明（第 8 轮起）
    const stratCard = $('student-strategy-details');
    const stratAssets = (r.assets || []).filter(function (a) { return a.assetType === 'strategy'; });
    if (stratAssets.length) {
      stratCard.hidden = false;
      stratCard.textContent = '';
      const h = document.createElement('h3');
      h.textContent = '策略基金当轮成分（期初估值选样）';
      stratCard.appendChild(h);
      stratAssets.forEach(function (sa) {
        const p = document.createElement('p');
        p.className = 'stat-sub';
        if (sa.paused) {
          p.textContent = sa.alias + '：' + sa.pauseReason;
        } else {
          p.textContent = sa.alias + '：' + (sa.constituents || []).map(function (c) {
            return c.alias + '（' + c.weightPct + '%，' + c.metricDisplay + '）';
          }).join('、');
        }
        stratCard.appendChild(p);
      });
    } else {
      stratCard.hidden = true;
    }

    // 揭晓后展示本轮正式榜单
    const lbCard = $('student-leaderboard-card');
    if (isRevealed && d.leaderboard) {
      lbCard.hidden = false;
      lbCard.textContent = '';
      const h = document.createElement('h3');
      h.textContent = '第 ' + r.roundNo + ' 轮正式排名';
      lbCard.appendChild(h);
      const wrap = document.createElement('div');
      wrap.className = 'classroom-table-wrap';
      const tbl = document.createElement('table');
      tbl.className = 'classroom-table';
      tbl.innerHTML = '<thead><tr><th>名次</th><th>课堂昵称</th><th>期末总资产（万元）</th><th>本轮盈亏（万元）</th></tr></thead>';
      const tb = document.createElement('tbody');
      d.leaderboard.forEach(function (row) {
        const tr = document.createElement('tr');
        if (row.isMe) tr.style.fontWeight = '700';
        const td1 = document.createElement('td'); td1.textContent = String(row.rank);
        const td2 = document.createElement('td'); td2.textContent = row.displayNickname + (row.isMe ? '（我）' : '');
        const td3 = document.createElement('td'); td3.textContent = P.centsToWanDisplay(row.endingTotalCents);
        const td4 = document.createElement('td'); td4.textContent = P.centsToWanDisplay(row.roundPnlCents);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      wrap.appendChild(tbl);
      lbCard.appendChild(wrap);
    } else {
      lbCard.hidden = true;
    }
  }

  function renderConflictBox() {
    const box = $('student-conflict-box');
    if (!state.conflictInfo) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = '检测到另一设备已保存更新草稿（服务端版本 v' + state.conflictInfo.serverVersion + '）。请选择保留方式： ';
    const keepLocalBtn = document.createElement('button');
    keepLocalBtn.type = 'button';
    keepLocalBtn.className = 'cr-btn';
    keepLocalBtn.textContent = '保留本机修改并覆盖';
    keepLocalBtn.addEventListener('click', function () {
      state.draftVersion = state.conflictInfo.serverVersion;
      state.conflictInfo = null;
      syncDraftToServer(true);
    });
    const useServerBtn = document.createElement('button');
    useServerBtn.type = 'button';
    useServerBtn.className = 'cr-btn';
    useServerBtn.textContent = '采用服务端版本';
    useServerBtn.addEventListener('click', function () {
      state.draftAllocations = Object.assign({}, state.conflictInfo.serverAllocations || {});
      state.draftVersion = state.conflictInfo.serverVersion;
      state.conflictInfo = null;
      state.syncStatus = 'synced';
      P.writeLocalDraft(window.localStorage, state.accountIdentity, state.classroomId, state.studentData.round.roundNo, {
        allocations: state.draftAllocations,
        baseVersion: state.draftVersion,
        dirty: false,
      });
      renderStudentView();
    });
    box.appendChild(msg);
    box.appendChild(keepLocalBtn);
    box.appendChild(useServerBtn);
  }

  function applyQuickWholeAction(kind) {
    if (!state.studentData) return;
    if (kind === 'clear') {
      state.draftAllocations = {};
    } else {
      state.draftAllocations = Object.assign({}, state.studentData.account.defaultAllocations || {});
    }
    onDraftChanged();
  }

  function onDraftChanged() {
    const rNo = state.studentData.round.roundNo;
    state.syncStatus = 'saved_local';
    P.writeLocalDraft(window.localStorage, state.accountIdentity, state.classroomId, rNo, {
      allocations: state.draftAllocations,
      baseVersion: state.draftVersion,
      dirty: true,
    });
    renderStudentView();
    if (state.draftSyncTimer) clearTimeout(state.draftSyncTimer);
    state.draftSyncTimer = setTimeout(function () {
      if (navigator.onLine) syncDraftToServer(false);
    }, 600);
  }

  async function syncDraftToServer(manual) {
    if (!state.classroomId || !state.studentData) return;
    const sentClassroomId = state.classroomId;
    const sentRoundNo = state.studentData.round.roundNo;
    const sentAllocations = Object.assign({}, state.draftAllocations);
    const sentJson = P.canonicalizeAllocationsJson(sentAllocations);
    const sentBaseVersion = state.draftVersion;

    try {
      const res = await api.saveDraft(sentClassroomId, sentRoundNo, sentAllocations, sentBaseVersion);
      if (state.classroomId !== sentClassroomId || !state.studentData || state.studentData.round.roundNo !== sentRoundNo) {
        return;
      }
      if (res.status === 409 && res.data && res.data.conflict) {
        state.syncStatus = 'conflict';
        state.conflictInfo = res.data;
        renderStudentView();
        return;
      }
      if (!res.ok) {
        state.syncStatus = 'sync_failed';
        updateSyncPill();
        if (manual) showBanner('保存草稿失败：' + (res.data.error || '请重试'));
        return;
      }

      const reconciled = P.reconcileDraftSyncSuccess({
        sentClassroomId: sentClassroomId,
        sentRoundNo: sentRoundNo,
        sentJson: sentJson,
        currentClassroomId: state.classroomId,
        currentRoundNo: state.studentData.round.roundNo,
        currentAllocations: state.draftAllocations,
        serverVersion: res.data.draftVersion,
        currentSyncStatus: state.syncStatus,
      });
      if (!reconciled.sameContext) return;

      state.draftVersion = reconciled.draftVersion;
      state.conflictInfo = null;
      state.syncStatus = reconciled.nextSyncStatus;
      P.writeLocalDraft(window.localStorage, state.accountIdentity, state.classroomId, sentRoundNo, {
        allocations: state.draftAllocations,
        baseVersion: state.draftVersion,
        dirty: reconciled.dirty,
      });
      renderStudentView();

      if (!reconciled.matchesSent && navigator.onLine) {
        if (state.draftSyncTimer) clearTimeout(state.draftSyncTimer);
        state.draftSyncTimer = setTimeout(function () {
          syncDraftToServer(false);
        }, 300);
      }
    } catch (e) {
      state.syncStatus = 'sync_failed';
      updateSyncPill();
    }
  }

  async function submitCurrentRound() {
    if (state.isSubmitting || !state.classroomId || !state.studentData) return;
    const sentClassroomId = state.classroomId;
    const sentRoundNo = state.studentData.round.roundNo;
    const sentAllocations = Object.assign({}, state.draftAllocations);
    const sentJson = P.canonicalizeAllocationsJson(sentAllocations);
    const reqId = 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    state.isSubmitting = true;
    updateStudentSubmitButton();
    try {
      await api.submitAllocation(sentClassroomId, sentRoundNo, sentAllocations, reqId);
      state.isSubmitting = false;
      if (state.classroomId !== sentClassroomId || !state.studentData || state.studentData.round.roundNo !== sentRoundNo) {
        return;
      }
      state.studentData.submission = { allocations: sentAllocations };
      const reconciled = P.reconcileSubmitSuccess({
        sentClassroomId: sentClassroomId,
        sentRoundNo: sentRoundNo,
        sentJson: sentJson,
        currentClassroomId: state.classroomId,
        currentRoundNo: state.studentData.round.roundNo,
        currentAllocations: state.draftAllocations,
        currentSyncStatus: state.syncStatus,
      });
      if (!reconciled.sameContext) return;
      state.syncStatus = reconciled.nextSyncStatus;
      P.writeLocalDraft(window.localStorage, state.accountIdentity, state.classroomId, sentRoundNo, {
        allocations: state.draftAllocations,
        baseVersion: state.draftVersion,
        dirty: reconciled.dirty,
      });
      if (reconciled.matchesSent) {
        if (state.draftSyncTimer) {
          clearTimeout(state.draftSyncTimer);
          state.draftSyncTimer = null;
        }
        await refreshStudentState();
      } else {
        renderStudentView();
        if (navigator.onLine) syncDraftToServer(false);
      }
    } catch (e) {
      state.isSubmitting = false;
      updateStudentSubmitButton();
      showBanner('正式提交失败：' + e.message);
    }
  }

  // ---------- 底部半屏面板 & 闹钟式滚轮 ----------

  function openAllocSheet(asset) {
    const openingCents = state.studentData.account.openingTotalCents;
    const capCents = P.computeAssetCapCents(openingCents, state.draftAllocations, asset.assetId);
    const currentCents = Number(state.draftAllocations[asset.assetId] || 0);

    state.sheet.open = true;
    state.sheet.assetId = asset.assetId;
    state.sheet.capCents = capCents;
    state.sheet.maxWan = Math.floor(capCents / P.CENTS_PER_WAN);
    state.sheet.selectedWan = Math.min(state.sheet.maxWan, Math.floor(currentCents / P.CENTS_PER_WAN));
    state.sheet.wheelDirty = false; // 关键：仅打开关闭绝不把小数吸附成整万元

    $('sheet-asset-title').textContent = asset.alias + ' · 投入资金';
    $('sheet-cap-hint').textContent = '本项可投上限：' + P.centsToWanDisplay(capCents) + ' 万元（每格 1 万元）';
    $('sheet-amount-input').value = currentCents > 0 ? P.centsToWanStr(currentCents) : '';
    $('sheet-error').textContent = '';

    buildWheelItems(state.sheet.maxWan, state.sheet.selectedWan);
    $('alloc-sheet').hidden = false;
  }

  function closeAllocSheet() {
    state.sheet.open = false;
    $('alloc-sheet').hidden = true;
  }

  function setSheetCents(cents) {
    const clamped = Math.max(0, Math.min(state.sheet.capCents, Math.trunc(Number(cents || 0))));
    state.sheet.wheelDirty = false;
    $('sheet-amount-input').value = clamped > 0 ? P.centsToWanStr(clamped) : '0';
    $('sheet-error').textContent = '';
    const wan = Math.min(state.sheet.maxWan, Math.floor(clamped / P.CENTS_PER_WAN));
    snapWheelToWan(wan, false);
  }

  function confirmAllocSheet() {
    let targetCents;
    if (state.sheet.wheelDirty) {
      targetCents = state.sheet.selectedWan * P.CENTS_PER_WAN;
    } else {
      const parsed = P.parseWanToCents($('sheet-amount-input').value);
      if (!parsed.ok) {
        $('sheet-error').textContent = parsed.error;
        return;
      }
      if (parsed.cents > state.sheet.capCents) {
        $('sheet-amount-input').value = P.centsToWanStr(state.sheet.capCents);
        $('sheet-error').textContent = '已超过本项上限，已自动调整为可投上限 ' + P.centsToWanDisplay(state.sheet.capCents) + ' 万元';
        return;
      }
      targetCents = parsed.cents;
    }

    if (targetCents <= 0) {
      delete state.draftAllocations[state.sheet.assetId];
    } else {
      state.draftAllocations[state.sheet.assetId] = targetCents;
    }
    closeAllocSheet();
    onDraftChanged();
  }

  function buildWheelItems(maxWan, selectedWan) {
    const list = $('sheet-wheel-list');
    list.textContent = '';
    for (let w = 0; w <= maxWan; w++) {
      const item = document.createElement('div');
      item.className = 'wheel-item' + (w === selectedWan ? ' selected' : '');
      item.textContent = w + ' 万元';
      item.dataset.wan = String(w);
      item.addEventListener('click', function () {
        snapWheelToWan(w, true);
      });
      list.appendChild(item);
    }
    snapWheelToWan(selectedWan, false);
  }

  function snapWheelToWan(wan, updateInput) {
    const clamped = Math.max(0, Math.min(state.sheet.maxWan, Math.round(wan)));
    state.sheet.selectedWan = clamped;
    // highlight box at top=66px (1.5 * 44px)
    const offset = 66 - clamped * 44;
    state.sheet.currentOffset = offset;
    const list = $('sheet-wheel-list');
    list.style.transform = 'translateY(' + offset + 'px)';
    Array.from(list.children).forEach(function (el, idx) {
      el.classList.toggle('selected', idx === clamped);
    });
    if (updateInput) {
      state.sheet.wheelDirty = true;
      $('sheet-amount-input').value = String(clamped);
      $('sheet-error').textContent = '';
    }
  }

  function bindWheelGestures() {
    const vp = $('sheet-wheel-viewport');
    if (!vp) return;

    vp.addEventListener('pointerdown', function (e) {
      state.sheet.dragging = true;
      state.sheet.dragStartY = e.clientY;
      state.sheet.dragStartOffset = state.sheet.currentOffset;
      vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener('pointermove', function (e) {
      if (!state.sheet.dragging) return;
      const dy = e.clientY - state.sheet.dragStartY;
      const nextOffset = state.sheet.dragStartOffset + dy;
      const rawWan = (66 - nextOffset) / 44;
      const clampedWan = Math.max(0, Math.min(state.sheet.maxWan, Math.round(rawWan)));
      $('sheet-wheel-list').style.transform = 'translateY(' + (66 - clampedWan * 44) + 'px)';
      state.sheet.selectedWan = clampedWan;
    });
    vp.addEventListener('pointerup', function () {
      if (!state.sheet.dragging) return;
      state.sheet.dragging = false;
      snapWheelToWan(state.sheet.selectedWan, true);
    });
    vp.addEventListener('wheel', function (e) {
      e.preventDefault();
      const step = e.deltaY > 0 ? 1 : -1;
      snapWheelToWan(state.sheet.selectedWan + step, true);
    }, { passive: false });
  }

  // ---------- 历史与第 15 轮报告 ----------

  async function loadHistoryAndReport() {
    if (!state.classroomId) return;
    try {
      const rep = await api.getReport(state.classroomId);
      const sumCard = $('report-summary-card');
      sumCard.hidden = false;
      sumCard.textContent = '';
      const h = document.createElement('h2');
      h.textContent = rep.ready ? '结课个人报告（共 15 轮）' : '阶段投资概览';
      const p = document.createElement('p');
      p.textContent = '起始资金：' + P.centsToWanDisplay(rep.summary.initialCashCents) + ' 万元 ｜ 期末资金：' +
        P.centsToWanDisplay(rep.summary.finalTotalCents) + ' 万元 ｜ 累计盈亏：' +
        P.centsToWanDisplay(rep.summary.totalPnlCents) + ' 万元（' + rep.summary.totalReturnPct + '%）';
      sumCard.appendChild(h);
      sumCard.appendChild(p);

      const tbody = $('history-tbody');
      tbody.textContent = '';
      (rep.rounds || []).forEach(function (r) {
        const tr = document.createElement('tr');
        const typeLabel = r.participationType === 'late_backfill'
          ? '迟到补录｜全现金'
          : (r.participationType === 'carried_over' ? '缺交沿用' : '正式提交');
        const rankLabel = r.isOfficialRanked
          ? ('第 ' + r.officialRank + ' 名 / ' + r.officialParticipantCount + ' 人')
          : ('参考第 ' + r.referenceRank + ' 名 / 参照 ' + r.officialParticipantCount + ' 人');
        [
          '第 ' + r.roundNo + ' 轮' + (r.calendarYear ? ('（' + r.calendarYear + '）') : ''),
          typeLabel,
          P.centsToWanDisplay(r.openingTotalCents),
          P.centsToWanDisplay(r.endingTotalCents),
          P.centsToWanDisplay(r.roundPnlCents),
          rankLabel,
        ].forEach(function (txt) {
          const td = document.createElement('td');
          td.textContent = txt;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      $('after-class-note-input').value = rep.afterClassNote || '';
      $('note-save-status').textContent = '';
    } catch (e) {
      showBanner('加载历史报告失败：' + e.message);
    }
  }

  async function saveNote() {
    if (!state.classroomId) return;
    try {
      await api.saveAfterClassNote(state.classroomId, $('after-class-note-input').value);
      $('note-save-status').textContent = '已保存';
      $('note-save-status').className = 'sync-pill ok';
    } catch (e) {
      $('note-save-status').textContent = '保存失败：' + e.message;
      $('note-save-status').className = 'sync-pill error';
    }
  }

  // ---------- 教师端控制台 & 投屏 ----------

  const ROUND_STATUS_LABELS = {
    pending: '未开盘',
    configuring: '配置中',
    locked: '已锁单',
    revealed: '已揭晓',
    completed: '已结课',
    active: '进行中',
  };
  const SUBMIT_STATUS_LABELS = {
    submitted: '已提交',
    draft: '草稿待提交',
    unsubmitted: '未提交',
    not_submitted: '未提交',
    pending: '未提交',
    ineligible: '本轮未参排',
  };
  function formatRoundStatus(status) {
    return ROUND_STATUS_LABELS[status] || status || '—';
  }
  function formatSubmitStatus(status) {
    return SUBMIT_STATUS_LABELS[status] || status || '—';
  }

  const TEACHER_PAGE_SIZE = 10;

  function renderTeacherClassroomList() {
    const list = $('teacher-classroom-list');
    if (!list) return;
    list.textContent = '';
    const pageItems = state.teacherClassrooms || [];
    const total = Number(state.teacherTotal || pageItems.length);
    const totalPages = Math.max(1, Number(state.teacherTotalPages || Math.ceil(total / TEACHER_PAGE_SIZE)));

    pageItems.forEach(function (c) {
      const row = document.createElement('div');
      row.className = 'classroom-btn-group';
      row.style.marginBottom = '8px';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cr-btn' + (Number(state.teacherClassroomId) === Number(c.classroom_id) ? ' cr-btn-primary' : '');
      btn.textContent = c.title + '（' + c.classroom_code + ' · 第 ' + c.current_round + ' 轮 · ' + formatRoundStatus(c.status) + ' · ' + c.member_count + ' 人）';
      btn.addEventListener('click', function () {
        state.teacherClassroomId = Number(c.classroom_id);
        state.teacherData = null;
        $('teacher-active-panel').hidden = true;
        renderTeacherClassroomList();
        loadTeacherDetail();
        renderTabs();
      });
      row.appendChild(btn);

      if (c.status !== 'completed') {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'cr-btn cr-btn-sm';
        closeBtn.textContent = '关闭场次';
        closeBtn.addEventListener('click', async function () {
          if (!await confirmDialog('确定关闭场次「' + c.title + '」？关闭后学员将无法再加入、保存草稿或提交配置。', {
            title: '关闭场次', confirmText: '关闭场次', danger: true,
          })) return;
          try {
            await api.adminClose(c.classroom_id);
            await loadTeacherConsole();
            await loadMyClassrooms();
            showBanner('场次已关闭', false);
          } catch (e) {
            showBanner('关闭场次失败：' + e.message);
          }
        });
        row.appendChild(closeBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'cr-btn cr-btn-danger cr-btn-sm';
      delBtn.textContent = '删除场次';
      delBtn.addEventListener('click', async function () {
        if (!await confirmDialog('确定永久删除场次「' + c.title + '（' + c.classroom_code + '）」及其所有学员与轮次数据？此操作不可恢复。', {
          title: '删除场次', confirmText: '永久删除', danger: true,
        })) return;
        try {
          await api.adminDelete(c.classroom_id);
          if (Number(state.teacherClassroomId) === Number(c.classroom_id)) {
            state.teacherClassroomId = null;
            state.teacherData = null;
            $('teacher-active-panel').hidden = true;
          }
          if (Number(state.currentClassroomId) === Number(c.classroom_id)) {
            state.currentClassroomId = null;
            state.studentData = null;
            closeSse();
          }
          await loadTeacherConsole();
          await loadMyClassrooms();
          renderTabs();
          showBanner('场次已删除', false);
        } catch (e) {
          showBanner('删除场次失败：' + e.message);
        }
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });

    if (total > TEACHER_PAGE_SIZE || totalPages > 1) {
      const pager = document.createElement('div');
      pager.className = 'classroom-btn-group';
      pager.style.marginTop = '10px';
      const prevBtn = makeActionBtn('上一页', 'cr-btn cr-btn-sm', function () {
        if (state.teacherPage > 1) {
          loadTeacherConsole(state.teacherPage - 1);
        }
      });
      prevBtn.disabled = state.teacherPage <= 1;
      const info = document.createElement('span');
      info.className = 'classroom-badge';
      info.textContent = '第 ' + state.teacherPage + ' / ' + totalPages + ' 页（共 ' + total + ' 场）';
      const nextBtn = makeActionBtn('下一页', 'cr-btn cr-btn-sm', function () {
        if (state.teacherPage < totalPages) {
          loadTeacherConsole(state.teacherPage + 1);
        }
      });
      nextBtn.disabled = state.teacherPage >= totalPages;
      pager.appendChild(prevBtn);
      pager.appendChild(info);
      pager.appendChild(nextBtn);
      list.appendChild(pager);
    }
  }

  async function loadTeacherConsole(page) {
    if (!state.isAdmin) return;
    const targetPage = Math.max(1, Number(page || state.teacherPage || 1));
    try {
      const data = await api.adminList(targetPage, TEACHER_PAGE_SIZE);
      const items = data.items || [];
      const total = Number(data.total != null ? data.total : items.length);
      const totalPages = Math.max(1, Number(data.totalPages || Math.ceil(total / TEACHER_PAGE_SIZE)));
      if (!items.length && targetPage > 1 && total > 0) {
        return loadTeacherConsole(totalPages);
      }
      state.teacherPage = Number(data.page || targetPage);
      state.teacherTotal = total;
      state.teacherTotalPages = totalPages;
      state.teacherClassrooms = items;
      renderTeacherClassroomList();
      if (state.teacherClassroomId) {
        await loadTeacherDetail();
      } else {
        $('teacher-active-panel').hidden = true;
      }
    } catch (e) {
      showBanner('加载教师控制台失败：' + e.message);
    }
  }

  const PRESET_INDUSTRIES = [
    { industryName: '能源', codes: ['600028.SH', '601857.SH', '601088.SH'] },
    { industryName: '制造', codes: ['600104.SH', '000651.SZ', '000333.SZ'] },
    { industryName: '金融', codes: ['601398.SH', '600036.SH', '601318.SH'] },
    { industryName: '零售', codes: ['601933.SH', '002024.SZ', '600827.SH'] },
  ];

  let teacherOptionsState = {
    availableWindows: [],
    industries: [],
    optionsReqSeq: 0,
    sampleReqSeq: 0,
    previewReqSeq: 0,
    activePreview: null,
    confirmRequestId: null,
    confirming: false,
  };

  function makeConfirmRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'cfm_' + crypto.randomUUID();
    }
    return 'cfm_' + Date.now() + '_' + Math.random().toString(16).slice(2, 10);
  }

  function invalidateTeacherPreview() {
    teacherOptionsState.optionsReqSeq++;
    teacherOptionsState.sampleReqSeq++;
    teacherOptionsState.previewReqSeq++;
    teacherOptionsState.activePreview = null;
    teacherOptionsState.confirmRequestId = null;
    if ($('btn-teacher-confirm')) $('btn-teacher-confirm').hidden = true;
    if ($('teacher-preview-result')) $('teacher-preview-result').textContent = '';
  }

  function initTeacherIndustryRows() {
    const wrap = $('teacher-industry-rows');
    if (!wrap || wrap.children.length > 0) return;
    PRESET_INDUSTRIES.forEach(function (ind, idx) {
      const row = document.createElement('div');
      row.className = 'teacher-industry-row';
      row.dataset.indIdx = String(idx);

      const sel = document.createElement('select');
      sel.className = 'cr-input teacher-ind-select';
      sel.hidden = true;
      sel.addEventListener('change', function () {
        const opt = sel.options[sel.selectedIndex];
        const nameEl = row.querySelector('.teacher-ind-name');
        if (nameEl && opt && opt.dataset.name) nameEl.value = opt.dataset.name;
        row.dataset.industryNodeId = sel.value || '';
        invalidateTeacherPreview();
      });
      row.appendChild(sel);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'cr-input teacher-ind-name';
      nameInput.value = ind.industryName;
      nameInput.placeholder = '行业' + (idx + 1);
      nameInput.maxLength = 16;
      nameInput.addEventListener('input', invalidateTeacherPreview);
      row.appendChild(nameInput);

      for (let j = 0; j < 3; j++) {
        const codeInput = document.createElement('input');
        codeInput.type = 'text';
        codeInput.className = 'cr-input teacher-ind-code';
        codeInput.value = ind.codes[j];
        codeInput.placeholder = '股票代码' + (j + 1);
        codeInput.maxLength = 16;
        codeInput.addEventListener('input', invalidateTeacherPreview);
        row.appendChild(codeInput);
      }

      const resampleBtn = document.createElement('button');
      resampleBtn.type = 'button';
      resampleBtn.className = 'cr-btn';
      resampleBtn.textContent = '重抽本组';
      resampleBtn.addEventListener('click', function () {
        sampleTeacherSelection(idx, false);
      });
      row.appendChild(resampleBtn);

      wrap.appendChild(row);
    });
  }

  function syncTeacherModeUi() {
    const modeEl = $('teacher-new-mode');
    const realBox = $('teacher-real-config');
    const variantEl = $('teacher-demo-variant');
    const seedEl = $('teacher-demo-seed');
    const isReal = modeEl && modeEl.value === 'real';
    if (realBox) realBox.hidden = !isReal;
    if (variantEl) variantEl.hidden = isReal;
    if (seedEl) seedEl.hidden = isReal || !variantEl || variantEl.value !== 'random';
  }

  function syncTeacherYearRange() {
    const syEl = $('teacher-start-year');
    const lbl = $('teacher-year-range');
    if (!syEl || !lbl) return;
    const sy = Math.trunc(Number(syEl.value || 2011));
    lbl.textContent = '（' + sy + '–' + (sy + 14) + ' 年，共 15 轮）';
  }

  function readTeacherCreateInputs() {
    const startYear = Math.trunc(Number(($('teacher-start-year') && $('teacher-start-year').value) || 2011));
    const industries = [];
    const wrap = $('teacher-industry-rows');
    if (wrap) {
      Array.from(wrap.children).forEach(function (row) {
        const nameEl = row.querySelector('.teacher-ind-name');
        const codeEls = row.querySelectorAll('.teacher-ind-code');
        const industryName = nameEl ? nameEl.value.trim() : '';
        const codes = Array.from(codeEls).map(function (el) { return el.value.trim().toUpperCase(); }).filter(Boolean);
        industries.push({
          industryNodeId: row.dataset.industryNodeId || null,
          industryName: industryName,
          codes: codes,
        });
      });
    }
    return { startYear: startYear, industries: industries };
  }

  function applySampledGroupsToRows(groups) {
    const wrap = $('teacher-industry-rows');
    if (!wrap || !Array.isArray(groups)) return;
    Array.from(wrap.children).forEach(function (row, idx) {
      const g = groups[idx];
      if (!g) return;
      row.dataset.industryNodeId = g.industryNodeId || '';
      const sel = row.querySelector('.teacher-ind-select');
      if (sel && !sel.hidden && g.industryNodeId) {
        sel.value = String(g.industryNodeId);
      }
      const nameEl = row.querySelector('.teacher-ind-name');
      if (nameEl) nameEl.value = g.industryName || '';
      const codeEls = row.querySelectorAll('.teacher-ind-code');
      (g.codes || []).forEach(function (code, j) {
        if (codeEls[j]) codeEls[j].value = code;
      });
    });
    invalidateTeacherPreview();
  }

  function renderIndustryDropdowns(industries) {
    const wrap = $('teacher-industry-rows');
    if (!wrap) return;
    Array.from(wrap.children).forEach(function (row) {
      const sel = row.querySelector('.teacher-ind-select');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- 选择 SW2021 一级行业 --</option>';
      (industries || []).forEach(function (ind) {
        const opt = document.createElement('option');
        opt.value = ind.industryNodeId;
        opt.dataset.name = ind.industryName;
        const suffix = ind.status === 'verifying'
          ? '（校验中 ' + ind.verifiedCount + '/' + ind.coarseCount + '）'
          : ('（合格 ' + ind.qualifiedCount + ' 只）');
        opt.textContent = ind.industryName + suffix;
        opt.disabled = !ind.enabled;
        sel.appendChild(opt);
      });
      sel.hidden = !industries || industries.length === 0;
    });
  }

  async function loadTeacherCreationOptions(pickRandomYear) {
    const statusEl = $('teacher-window-status');
    $('teacher-create-error').textContent = '';
    if (statusEl) statusEl.textContent = '正在核验可建场历史窗口与 SW2021 一级行业...';
    const reqSeq = ++teacherOptionsState.optionsReqSeq;
    try {
      const sy = pickRandomYear ? null : Math.trunc(Number(($('teacher-start-year') && $('teacher-start-year').value) || 2011));
      let res = await api.adminCreationOptions(sy);
      if (reqSeq !== teacherOptionsState.optionsReqSeq) return; // 忽略迟到响应
      teacherOptionsState.availableWindows = res.availableWindows || [];

      if (pickRandomYear && teacherOptionsState.availableWindows.length > 0) {
        const randIdx = Math.floor(Math.random() * teacherOptionsState.availableWindows.length);
        const picked = teacherOptionsState.availableWindows[randIdx];
        if ($('teacher-start-year')) $('teacher-start-year').value = String(picked.startYear);
        syncTeacherYearRange();
        if (Number(picked.startYear) !== Number(res.selectedStartYear)) {
          res = await api.adminCreationOptions(picked.startYear);
          if (reqSeq !== teacherOptionsState.optionsReqSeq) return;
          teacherOptionsState.availableWindows = res.availableWindows || teacherOptionsState.availableWindows;
        }
      } else if (res.selectedStartYear && $('teacher-start-year')) {
        const currentInputYear = Math.trunc(Number($('teacher-start-year').value || 2011));
        if (sy == null || currentInputYear === sy) {
          $('teacher-start-year').value = String(res.selectedStartYear);
          syncTeacherYearRange();
        } else {
          return; // 用户在请求期间已手动修改年份，丢弃旧响应
        }
      }

      teacherOptionsState.industries = res.industries || [];
      renderIndustryDropdowns(teacherOptionsState.industries);

      if (statusEl) {
        if (teacherOptionsState.availableWindows.length === 0) {
          const blockers = (res.windowStatus && res.windowStatus.blockers) || ['暂无满足全部数据门槛的 15 年窗口'];
          statusEl.innerHTML = '';
          const banner = document.createElement('div');
          banner.className = 'notice-banner';
          banner.textContent = '当前暂无可用历史窗口：' + blockers.join('；') + '（可切换为演示场次或重选年份）';
          statusEl.appendChild(banner);
        } else {
          const wins = teacherOptionsState.availableWindows.map(function (w) { return w.startYear + '–' + w.endYear; }).join('、');
          statusEl.textContent = (res.onlyOneWindowNote ? (res.onlyOneWindowNote + ' ') : '') +
            '可用窗口：' + wins + ' ｜ 当前窗口合格一级行业：' +
            teacherOptionsState.industries.filter(function (i) { return i.enabled; }).length + ' 个';
        }
      }
    } catch (e) {
      if (reqSeq !== teacherOptionsState.optionsReqSeq) return;
      if (statusEl) statusEl.textContent = '';
      $('teacher-create-error').textContent = '加载可用窗口失败：' + e.message;
    }
  }

  async function pickRandomAvailableYear() {
    invalidateTeacherPreview();
    await loadTeacherCreationOptions(true);
  }

  async function sampleTeacherSelection(targetGroupIndex, excludeCurrent) {
    $('teacher-create-error').textContent = '';
    const inputs = readTeacherCreateInputs();
    const reqSeq = ++teacherOptionsState.sampleReqSeq;
    const reqYear = inputs.startYear;
    const excludeComboKey = excludeCurrent
      ? inputs.industries.map(function (g) {
        return (g.industryNodeId || g.industryName) + ':' + g.codes.slice().sort().join(',');
      }).sort().join('|')
      : null;
    try {
      const res = await api.adminSample({
        startYear: reqYear,
        lockedGroups: inputs.industries,
        targetGroupIndex: targetGroupIndex,
        excludeComboKey: excludeComboKey,
      });
      const currentYear = Math.trunc(Number(($('teacher-start-year') && $('teacher-start-year').value) || 2011));
      if (reqSeq !== teacherOptionsState.sampleReqSeq || currentYear !== reqYear) return; // 忽略过期或切年份后的迟到响应
      applySampledGroupsToRows(res.groups);
      if (res.notes && res.notes.length && $('teacher-window-status')) {
        $('teacher-window-status').textContent = res.notes.join('；');
      }
    } catch (e) {
      $('teacher-create-error').textContent = '抽样失败：' + e.message;
    }
  }

  function renderPreviewBox(res) {
    const box = $('teacher-preview-result');
    if (!box) return;
    box.textContent = '';
    const banner = document.createElement('div');
    banner.className = 'notice-banner';
    if (!res.pass) {
      banner.textContent = '预览未通过：' + (res.blockers || []).join('；');
      box.appendChild(banner);
      return;
    }
    const extra = res.mode === 'demo'
      ? (' ｜ 演示剧本：' + (res.demoVariant === 'random' ? ('随机种子 ' + res.demoSeed) : '固定教学剧本'))
      : (' ｜ 分类基准：' + (res.taxonomy || 'SW2021') + ' ｜ ' + (res.survivorBiasNotice || ''));
    banner.textContent = '预览就绪（有效期至 ' + new Date(res.expiresAt).toLocaleTimeString() + '）：' +
      res.startYear + '–' + res.endYear + extra;
    box.appendChild(banner);
  }

  async function previewClassroomFromTeacher() {
    $('teacher-create-error').textContent = '';
    const reqSeq = ++teacherOptionsState.previewReqSeq;
    const title = $('teacher-new-title').value.trim();
    const mode = $('teacher-new-mode').value;
    const blindMode = $('teacher-new-blind').checked;
    const demoVariant = $('teacher-demo-variant') ? $('teacher-demo-variant').value : 'fixed';
    const demoSeed = $('teacher-demo-seed') ? $('teacher-demo-seed').value.trim() : '';
    const inputs = readTeacherCreateInputs();

    const payload = {
      title: title,
      mode: mode,
      blindMode: blindMode,
      startYear: inputs.startYear,
      demoVariant: demoVariant,
      demoSeed: demoSeed || null,
    };
    if (mode === 'real') payload.industries = inputs.industries;

    try {
      const res = await api.adminPreview(payload);
      const currentInputs = readTeacherCreateInputs();
      const currentMode = $('teacher-new-mode') ? $('teacher-new-mode').value : mode;
      if (reqSeq !== teacherOptionsState.previewReqSeq || currentInputs.startYear !== payload.startYear || currentMode !== payload.mode) {
        return; // 忽略切年份/改配置后的迟到预览响应
      }
      renderPreviewBox(res);
      if (res.pass && res.previewId) {
        teacherOptionsState.activePreview = res;
        teacherOptionsState.confirmRequestId = makeConfirmRequestId();
        if ($('btn-teacher-confirm')) $('btn-teacher-confirm').hidden = false;
      } else {
        invalidateTeacherPreview();
        renderPreviewBox(res);
      }
    } catch (e) {
      if (reqSeq !== teacherOptionsState.previewReqSeq) return;
      $('teacher-create-error').textContent = '预览失败：' + e.message;
    }
  }

  async function confirmClassroomFromPreview() {
    if (teacherOptionsState.confirming) return;
    const preview = teacherOptionsState.activePreview;
    if (!preview || !preview.previewId) {
      $('teacher-create-error').textContent = '请先执行预览建场';
      return;
    }
    const btn = $('btn-teacher-confirm');
    const expectedPreviewId = preview.previewId;
    const expectedPreviewSeq = teacherOptionsState.previewReqSeq;
    teacherOptionsState.confirming = true;
    if (btn) btn.disabled = true;
    $('teacher-create-error').textContent = '';

    try {
      const res = await api.adminConfirm({
        previewId: expectedPreviewId,
        confirmRequestId: teacherOptionsState.confirmRequestId,
      });
      const stale = !teacherOptionsState.activePreview
        || teacherOptionsState.activePreview.previewId !== expectedPreviewId
        || teacherOptionsState.previewReqSeq !== expectedPreviewSeq;
      if (stale) return;
      if (!res.ok) {
        if (res.status === 409 && res.data && res.data.newPreview) {
          teacherOptionsState.activePreview = res.data.newPreview;
          teacherOptionsState.confirmRequestId = makeConfirmRequestId();
          renderPreviewBox(res.data.newPreview);
          $('teacher-create-error').textContent = res.data.error || '数据已变化，请确认新预览';
          return;
        }
        throw new Error((res.data && res.data.error) || '确认建场失败');
      }
      invalidateTeacherPreview();
      state.teacherClassroomId = res.data.classroom.classroomId;
      await loadTeacherConsole();
      renderTabs();
    } catch (e) {
      $('teacher-create-error').textContent = e.message;
    } finally {
      teacherOptionsState.confirming = false;
      if (btn) btn.disabled = false;
    }
  }

  async function runTeacherPrecheck() {
    const resBox = $('teacher-precheck-result');
    $('teacher-create-error').textContent = '';
    resBox.textContent = '正在执行 15 年数据预检（若缺数将自动按需补全）...';
    try {
      const inputs = readTeacherCreateInputs();
      const res = await api.adminPrecheck({ startYear: inputs.startYear, industries: inputs.industries });
      resBox.textContent = '';

      const summary = document.createElement('div');
      summary.className = 'notice-banner';
      const backfillInfo = res.autoBackfill && res.autoBackfill.attemptedCodes && res.autoBackfill.attemptedCodes.length
        ? (' ｜ 已自动补全 ' + res.autoBackfill.attemptedCodes.length + ' 只标的（日线 ' + res.autoBackfill.filledBars + ' / 估值 ' + res.autoBackfill.filledValuations + ' / 停牌 ' + (res.autoBackfill.filledSuspensions || 0) + '）')
        : '';
      summary.textContent = (res.pass ? '预检通过：可用于创建真实场次。' : ('预检未通过：' + (res.blockers || []).join('；'))) +
        backfillInfo +
        ' ｜ 国债财富净值：' + (res.bondCheck && res.bondCheck.wealthCovered ? '已覆盖' : '未覆盖') +
        ' ｜ 转债校准样本：' + (res.cbCalibration ? res.cbCalibration.sampleCount : 0) + ' 条';
      resBox.appendChild(summary);

      const tblWrap = document.createElement('div');
      tblWrap.className = 'classroom-table-wrap';
      const tbl = document.createElement('table');
      tbl.className = 'classroom-table';
      tbl.innerHTML = '<thead><tr><th>行业</th><th>代码</th><th>名称</th><th>预检状态</th><th>说明</th></tr></thead>';
      const tb = document.createElement('tbody');
      (res.stockReports || []).forEach(function (sr) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = sr.industryName;
        const td2 = document.createElement('td'); td2.textContent = sr.canonicalCode;
        const td3 = document.createElement('td'); td3.textContent = sr.stockName || '—';
        const td4 = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'precheck-badge ' + sr.status;
        badge.textContent = sr.status === 'green' ? '正常' : (sr.status === 'yellow' ? '停牌顺延' : '不可用');
        td4.appendChild(badge);
        const td5 = document.createElement('td');
        const firstBad = (sr.years || []).find(function (y) { return y.status === 'red'; });
        const yellowCount = (sr.years || []).filter(function (y) { return y.status === 'yellow'; }).length;
        td5.textContent = sr.reason || (firstBad ? firstBad.reason : (yellowCount ? ('含 ' + yellowCount + ' 年停牌顺延取价') : '15 年完整覆盖'));
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4); tr.appendChild(td5);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      tblWrap.appendChild(tbl);
      resBox.appendChild(tblWrap);
    } catch (e) {
      resBox.textContent = '';
      $('teacher-create-error').textContent = '预检失败：' + e.message;
    }
  }

  async function createClassroomFromTeacher() {
    $('teacher-create-error').textContent = '';
    try {
      const title = $('teacher-new-title').value.trim();
      const mode = $('teacher-new-mode').value;
      const blindMode = $('teacher-new-blind').checked;
      const demoVariant = $('teacher-demo-variant') ? $('teacher-demo-variant').value : 'fixed';
      const demoSeed = $('teacher-demo-seed') ? $('teacher-demo-seed').value.trim() : '';
      const inputs = readTeacherCreateInputs();
      const payload = {
        title: title,
        mode: mode,
        blindMode: blindMode,
        startYear: inputs.startYear,
        demoVariant: demoVariant,
        demoSeed: demoSeed || null,
      };
      if (mode === 'real') {
        payload.industries = inputs.industries;
      }
      const res = await api.adminCreate(payload);
      state.teacherClassroomId = res.classroom.classroomId;
      await loadTeacherConsole();
      renderTabs();
    } catch (e) {
      $('teacher-create-error').textContent = e.message;
    }
  }

  async function loadTeacherDetail() {
    const targetId = Number(state.teacherClassroomId);
    if (!targetId) return;
    const reqSeq = ++state.teacherDetailSeq;
    state.teacherData = null;
    $('teacher-active-panel').hidden = true;
    try {
      const d = await api.adminGetState(targetId);
      if (reqSeq !== state.teacherDetailSeq || Number(state.teacherClassroomId) !== targetId) return;
      state.teacherData = d;
      $('teacher-active-panel').hidden = false;

      const c = d.classroom;
      const r = d.round;
      const ctrl = $('teacher-control-card');
      ctrl.textContent = '';
      const h = document.createElement('h3');
      h.textContent = c.title + '（' + c.classroomCode + ' · 第 ' + r.roundNo + '/' + c.totalRounds + ' 轮 · ' + r.calendarYear + ' 年 · 状态：' + formatRoundStatus(r.status) + '）';
      ctrl.appendChild(h);

      const countsP = document.createElement('p');
      countsP.textContent = '参课 ' + d.counts.totalMembers + ' 人 ｜ 当轮参排 ' + d.counts.eligibleCount + ' 人 ｜ 已提交 ' + d.counts.submittedCount + ' 人 / 未提交 ' + d.counts.unsubmittedCount + ' 人';
      ctrl.appendChild(countsP);

      const btns = document.createElement('div');
      btns.className = 'classroom-btn-group';
      if (c.status === 'completed') {
        const closedBadge = document.createElement('span');
        closedBadge.className = 'cr-badge';
        closedBadge.textContent = '本场次已关闭/已结课';
        btns.appendChild(closedBadge);
      } else {
        if (r.status === 'pending') {
          const bOpen = makeActionBtn('开放第 1 轮配置', 'cr-btn cr-btn-primary', async function () {
            await api.adminOpenRound(c.classroomId, 1, c.stateVersion);
            await loadTeacherDetail();
          });
          btns.appendChild(bOpen);
        }
        if (r.status === 'configuring') {
          const bLock = makeActionBtn('锁单', 'cr-btn cr-btn-danger', async function () {
            if (!await confirmDialog('确认锁单？当前已提交 ' + d.counts.submittedCount + ' 人 / 未提交 ' + d.counts.unsubmittedCount + ' 人。', {
              title: '确认锁单', confirmText: '确认锁单', danger: true,
            })) return;
            await api.adminLockRound(c.classroomId, r.roundNo, c.stateVersion);
            await loadTeacherDetail();
          });
          btns.appendChild(bLock);
        }
        if (r.status === 'locked') {
          const bUnlock = makeActionBtn('解锁回到配置中', 'cr-btn', async function () {
            await api.adminUnlockRound(c.classroomId, r.roundNo, c.stateVersion);
            await loadTeacherDetail();
          });
          const bReveal = makeActionBtn('揭晓并结算本轮', 'cr-btn cr-btn-success', async function () {
            await api.adminRevealRound(c.classroomId, r.roundNo, c.stateVersion);
            await loadTeacherDetail();
          });
          btns.appendChild(bUnlock);
          btns.appendChild(bReveal);
        }
        if (r.status === 'revealed' && r.roundNo < c.totalRounds) {
          const bNext = makeActionBtn('进入第 ' + (r.roundNo + 1) + ' 轮', 'cr-btn cr-btn-primary', async function () {
            await api.adminOpenRound(c.classroomId, r.roundNo + 1, c.stateVersion);
            await loadTeacherDetail();
          });
          btns.appendChild(bNext);
        }
      }
      if (c.blindMode && !c.identityRevealed) {
        const bId = makeActionBtn('揭示真实年份与股票名称', 'cr-btn', async function () {
          if (!await confirmDialog('确认向全体学员揭示真实年份与公司名称？（未来轮次收益仍保持保密）', {
            title: '揭示真实信息', confirmText: '确认揭示',
          })) return;
          await api.adminRevealIdentity(c.classroomId);
          await loadTeacherDetail();
        });
        btns.appendChild(bId);
      }
      const bProj = makeActionBtn('打开投屏视图', 'cr-btn', function () {
        switchTab('projector');
      });
      btns.appendChild(bProj);
      ctrl.appendChild(btns);

      // 二维码卡片
      const qrCard = $('teacher-qr-card');
      qrCard.textContent = '';
      const qh = document.createElement('h3'); qh.textContent = '入场二维码';
      qrCard.appendChild(qh);
      const qBox = document.createElement('div'); qBox.className = 'qr-box';
      if (d.qrDataUrl) {
        const img = document.createElement('img');
        img.src = d.qrDataUrl;
        img.alt = '课堂入场二维码';
        qBox.appendChild(img);
      }
      const urlP = document.createElement('div');
      urlP.textContent = '扫码链接：' + d.joinUrl;
      qBox.appendChild(urlP);
      qrCard.appendChild(qBox);

      // 学员名单与昵称管理
      const pCard = $('teacher-participants-card');
      pCard.textContent = '';
      const ph = document.createElement('h3'); ph.textContent = '参课名单与提交状态';
      pCard.appendChild(ph);
      d.participants.forEach(function (p) {
        const row = document.createElement('div');
        row.className = 'classroom-btn-group';
        row.style.marginBottom = '6px';
        const txt = document.createElement('span');
        txt.textContent = p.displayNickname + '（状态：' + formatSubmitStatus(p.submitStatus) + '）';
        const maskBtn = makeActionBtn(p.isNicknameMasked ? '恢复原昵称' : '屏蔽昵称', 'cr-btn', async function () {
          const nextNick = p.isNicknameMasked ? p.classroomNickname : ('学员#' + p.memberId);
          await api.adminUpdateNickname(c.classroomId, p.memberId, nextNick, !p.isNicknameMasked);
          await loadTeacherDetail();
        });
        row.appendChild(txt);
        row.appendChild(maskBtn);
        pCard.appendChild(row);
      });

      // 教师真实行情表
      const mCard = $('teacher-market-card');
      mCard.textContent = '';
      const mh = document.createElement('h3'); mh.textContent = '教师行情明细（已隐藏真实代码）';
      mCard.appendChild(mh);
      const mWrap = document.createElement('div'); mWrap.className = 'classroom-table-wrap';
      const mTbl = document.createElement('table'); mTbl.className = 'classroom-table';
      mTbl.innerHTML = '<thead><tr><th>行业</th><th>代号</th><th>真实名称</th><th>PE</th><th>PB</th><th>当轮涨跌</th></tr></thead>';
      const mTb = document.createElement('tbody');
      r.assets.forEach(function (a) {
        const tr = document.createElement('tr');
        [a.industryName, a.alias, a.stockName || '—', a.peDisplay, a.pbDisplay, P.formatReturnPct(a.returnRate)].forEach(function (v, idx) {
          const td = document.createElement('td');
          td.textContent = escapeText(v);
          if (idx === 5 && typeof a.returnRate === 'number') {
            if (a.returnRate > 0) td.className = 'ret-pos';
            else if (a.returnRate < 0) td.className = 'ret-neg';
          }
          tr.appendChild(td);
        });
        mTb.appendChild(tr);
      });
      mTbl.appendChild(mTb); mWrap.appendChild(mTbl); mCard.appendChild(mWrap);

      // 排行榜：展示全部已揭晓轮次的历史榜单矩阵（表头：昵称、第一轮、第二轮……）
      const rCard = $('teacher-ranking-card');
      rCard.textContent = '';
      const historyRounds = (d.roundHistoryLeaderboards && d.roundHistoryLeaderboards.length)
        ? d.roundHistoryLeaderboards
        : ((d.settlements && d.settlements.length) ? [{ roundNo: r.roundNo, settlements: d.settlements }] : []);
      if (historyRounds.length) {
        const rh = document.createElement('h3');
        rh.textContent = '各轮榜单（历史累计）';
        rCard.appendChild(rh);

        const cnNums = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        function formatRoundColumnLabel(n) {
          const num = Number(n);
          if (num >= 1 && num <= 10) return '第' + cnNums[num] + '轮';
          if (num > 10 && num < 20) return '第十' + cnNums[num - 10] + '轮';
          return '第' + num + '轮';
        }

        const memberMap = new Map();
        const latestRound = historyRounds[historyRounds.length - 1];
        (latestRound.settlements || []).forEach(function (s) {
          memberMap.set(s.memberId, { memberId: s.memberId, displayNickname: s.displayNickname, rounds: new Map() });
        });
        historyRounds.forEach(function (hr) {
          (hr.settlements || []).forEach(function (s) {
            if (!memberMap.has(s.memberId)) {
              memberMap.set(s.memberId, { memberId: s.memberId, displayNickname: s.displayNickname, rounds: new Map() });
            }
            memberMap.get(s.memberId).rounds.set(hr.roundNo, s);
          });
        });

        const wrap = document.createElement('div');
        wrap.className = 'classroom-table-wrap';
        const tbl = document.createElement('table');
        tbl.className = 'classroom-table';
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        const thName = document.createElement('th');
        thName.textContent = '昵称';
        htr.appendChild(thName);
        historyRounds.forEach(function (hr) {
          const th = document.createElement('th');
          th.textContent = formatRoundColumnLabel(hr.roundNo);
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        tbl.appendChild(thead);

        const tb = document.createElement('tbody');
        memberMap.forEach(function (m) {
          const tr = document.createElement('tr');
          const tdName = document.createElement('td');
          tdName.textContent = m.displayNickname;
          tr.appendChild(tdName);
          historyRounds.forEach(function (hr) {
            const td = document.createElement('td');
            const s = m.rounds.get(hr.roundNo);
            if (!s) {
              td.textContent = '—';
            } else {
              const rankText = s.isOfficialRanked ? ('第 ' + s.officialRank + ' 名') : ('补录第 ' + s.referenceRank + ' 名');
              td.textContent = rankText + ' · ' + P.centsToWanDisplay(s.endingTotalCents) + '万（' + P.centsToWanDisplay(s.roundPnlCents) + '万）';
            }
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        wrap.appendChild(tbl);
        rCard.appendChild(wrap);
      }
    } catch (e) {
      if (reqSeq !== state.teacherDetailSeq || Number(state.teacherClassroomId) !== targetId) return;
      showBanner('加载场次详情失败：' + e.message);
    }
  }

  async function loadProjectorView() {
    if (!state.teacherClassroomId) return;
    const container = $('projector-content');
    container.textContent = '加载投屏视图中...';
    try {
      const d = await api.adminGetProjector(state.teacherClassroomId, state.projectorRoundNo);
      container.textContent = '';
      const h = document.createElement('h2');
      h.textContent = d.classroom.title + ' · 第 ' + d.round.roundNo + ' 轮投屏（盲玩安全视图）';
      container.appendChild(h);
      const sub = document.createElement('p');
      sub.textContent = d.round.marketHeaderTitle + '：PE ' + d.round.marketPeDisplay + ' / PB ' + d.round.marketPbDisplay +
        (d.round.showIndexLevel ? (' ｜ 指数点位 ' + d.round.indexOpenLevel) : '');
      container.appendChild(sub);

      const returnRound = d.round.status === 'revealed'
        ? { roundNo: d.round.roundNo, label: '第 ' + d.round.roundNo + ' 轮各标的涨跌', assets: d.round.assets || [] }
        : (d.prevRevealedRound && d.prevRevealedRound.assets
          ? { roundNo: d.prevRevealedRound.roundNo, label: '上一轮（第 ' + d.prevRevealedRound.roundNo + ' 轮）各标的涨跌', assets: d.prevRevealedRound.assets }
          : null);
      if (returnRound && returnRound.assets.length) {
        const ah = document.createElement('h3');
        ah.textContent = returnRound.label;
        container.appendChild(ah);
        const aWrap = document.createElement('div');
        aWrap.className = 'classroom-table-wrap';
        const aTbl = document.createElement('table');
        aTbl.className = 'classroom-table';
        aTbl.innerHTML = '<thead><tr><th>行业</th><th>标的</th><th>PE</th><th>PB</th><th>涨跌幅</th></tr></thead>';
        const aTb = document.createElement('tbody');
        returnRound.assets.forEach(function (a) {
          const tr = document.createElement('tr');
          if (a.assetType === 'bond') tr.className = 'row-bond';
          const nameText = a.stockName ? (a.alias + '（' + a.stockName + '）') : a.alias;
          [a.industryName, nameText, a.peDisplay || '—', a.pbDisplay || '—', P.formatReturnPct(a.returnRate)].forEach(function (v, idx) {
            const td = document.createElement('td');
            td.textContent = escapeText(v);
            if (idx === 4 && typeof a.returnRate === 'number') {
              if (a.returnRate > 0) td.className = 'ret-pos';
              else if (a.returnRate < 0) td.className = 'ret-neg';
            }
            tr.appendChild(td);
          });
          aTb.appendChild(tr);
        });
        aTbl.appendChild(aTb);
        aWrap.appendChild(aTbl);
        container.appendChild(aWrap);
      }

      if (d.leaderboard && d.leaderboard.length) {
        const lh = document.createElement('h3'); lh.textContent = '正式榜单';
        container.appendChild(lh);
        d.leaderboard.forEach(function (row) {
          const p = document.createElement('div');
          p.textContent = '第 ' + row.rank + ' 名 · ' + row.displayNickname + ' · ' + P.centsToWanDisplay(row.endingTotalCents) + ' 万元';
          container.appendChild(p);
        });
      }
    } catch (e) {
      container.textContent = '投屏加载失败：' + e.message;
    }
  }

  function makeActionBtn(label, cls, fn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener('click', fn);
    return btn;
  }

  init();
})();
