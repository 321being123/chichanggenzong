(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.classroomPresenter = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const CENTS_PER_WAN = 1000000;

  function parseWanToCents(raw) {
    if (raw === null || raw === undefined) return { ok: true, cents: 0 };
    const s = String(raw).trim().replace(/,/g, '');
    if (s === '') return { ok: true, cents: 0 };
    if (!/^\d+(?:\.\d+)?$/.test(s)) {
      return { ok: false, error: '请输入非负数字（最多 6 位万元小数）' };
    }
    const parts = s.split('.');
    const intPart = parts[0];
    const fracPart = parts[1] || '';
    if (fracPart.length > 6) {
      return { ok: false, error: '最多支持 6 位万元小数（精确到分）' };
    }
    const num = Number(intPart + fracPart.padEnd(6, '0'));
    if (!Number.isSafeInteger(num) || num < 0) {
      return { ok: false, error: '金额超出安全范围' };
    }
    return { ok: true, cents: num };
  }

  function centsToWanStr(cents) {
    const n = Math.trunc(Number(cents || 0));
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const intPart = Math.floor(abs / CENTS_PER_WAN);
    const fracPart = String(abs % CENTS_PER_WAN).padStart(6, '0').replace(/0+$/, '');
    return sign + (fracPart ? (intPart + '.' + fracPart) : String(intPart));
  }

  function centsToWanDisplay(cents) {
    const n = Math.trunc(Number(cents || 0));
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const intPart = Math.floor(abs / CENTS_PER_WAN);
    const frac = String(abs % CENTS_PER_WAN).padStart(6, '0');
    const trimmed = frac.replace(/0+$/, '');
    if (!trimmed) return sign + intPart + '.00';
    if (trimmed.length <= 2) return sign + intPart + '.' + trimmed.padEnd(2, '0');
    return sign + intPart + '.' + trimmed;
  }

  function computeAllocatedSumCents(allocations) {
    let sum = 0;
    for (const val of Object.values(allocations || {})) {
      sum += Math.max(0, Math.trunc(Number(val || 0)));
    }
    return sum;
  }

  function computeAssetCapCents(openingTotalCents, allocations, targetAssetId) {
    let otherSum = 0;
    for (const [k, v] of Object.entries(allocations || {})) {
      if (k === targetAssetId) continue;
      otherSum += Math.max(0, Math.trunc(Number(v || 0)));
    }
    return Math.max(0, Math.trunc(Number(openingTotalCents || 0)) - otherSum);
  }

  function computePercentCapCents(capCents, pct) {
    if (pct >= 100) return Math.max(0, Math.trunc(Number(capCents || 0)));
    if (pct <= 0) return 0;
    return Math.floor((Math.max(0, Math.trunc(Number(capCents || 0))) * pct) / 100);
  }

  function formatReturnPct(rate) {
    if (rate === null || rate === undefined) return '—';
    const pct = (Number(rate) * 100).toFixed(2);
    return (Number(rate) > 0 ? '+' : '') + pct + '%';
  }

  function buildLocalDraftKey(accountIdentity, classroomId, roundNo) {
    return 'classroom_draft:' + String(accountIdentity || '') + ':' + String(classroomId) + ':' + String(roundNo);
  }

  function readLocalDraft(storage, accountIdentity, classroomId, roundNo) {
    if (!storage || !accountIdentity) return null;
    try {
      const raw = storage.getItem(buildLocalDraftKey(accountIdentity, classroomId, roundNo));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.accountIdentity !== accountIdentity) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeLocalDraft(storage, accountIdentity, classroomId, roundNo, payload) {
    if (!storage || !accountIdentity) return;
    try {
      storage.setItem(
        buildLocalDraftKey(accountIdentity, classroomId, roundNo),
        JSON.stringify({
          accountIdentity: accountIdentity,
          classroomId: Number(classroomId),
          roundNo: Number(roundNo),
          allocations: payload.allocations || {},
          baseVersion: Number(payload.baseVersion || 0),
          dirty: Boolean(payload.dirty),
          updatedAt: Date.now(),
        })
      );
    } catch (e) { /* ignore quota */ }
  }

  function clearAccountLocalDrafts(storage, accountIdentity) {
    if (!storage || !accountIdentity) return;
    try {
      const prefix = 'classroom_draft:' + String(accountIdentity) + ':';
      const toRemove = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      toRemove.forEach(function (k) { storage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  function resolveInitialDraftState(opts) {
    const local = opts && opts.localDraft;
    const serverDraft = opts && opts.serverDraft;
    const serverSub = opts && opts.serverSubmission;
    const defaultAlloc = (opts && opts.defaultAllocations) || {};
    const serverVer = serverDraft ? Number(serverDraft.draftVersion || 0) : 0;

    if (local && local.dirty) {
      const baseVer = Number(local.baseVersion || 0);
      if (serverVer > baseVer) {
        return {
          draftAllocations: Object.assign({}, local.allocations || {}),
          draftVersion: baseVer,
          syncStatus: 'conflict',
          conflictInfo: {
            conflict: true,
            serverVersion: serverVer,
            serverAllocations: Object.assign({}, (serverDraft && serverDraft.allocations) || {}),
            serverUpdatedAt: serverDraft ? serverDraft.updatedAt : null,
          },
        };
      }
      return {
        draftAllocations: Object.assign({}, local.allocations || {}),
        draftVersion: baseVer,
        syncStatus: 'saved_local',
        conflictInfo: null,
      };
    }

    if (serverDraft) {
      return {
        draftAllocations: Object.assign({}, serverDraft.allocations || {}),
        draftVersion: serverVer,
        syncStatus: serverSub ? 'submitted' : 'synced',
        conflictInfo: null,
      };
    }

    if (serverSub) {
      return {
        draftAllocations: Object.assign({}, serverSub.allocations || {}),
        draftVersion: 0,
        syncStatus: 'submitted',
        conflictInfo: null,
      };
    }

    return {
      draftAllocations: Object.assign({}, defaultAlloc),
      draftVersion: 0,
      syncStatus: 'idle',
      conflictInfo: null,
    };
  }

  function canonicalizeAllocationsJson(allocations) {
    const clean = {};
    const keys = Object.keys(allocations || {}).sort();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = Math.trunc(Number(allocations[k] || 0));
      if (v > 0) clean[k] = v;
    }
    return JSON.stringify(clean);
  }

  function reconcileDraftSyncSuccess(opts) {
    const sentClassroomId = Number(opts.sentClassroomId);
    const sentRoundNo = Number(opts.sentRoundNo);
    const currentClassroomId = Number(opts.currentClassroomId);
    const currentRoundNo = Number(opts.currentRoundNo);
    const serverVersion = Number(opts.serverVersion || 0);

    if (sentClassroomId !== currentClassroomId || sentRoundNo !== currentRoundNo) {
      return { sameContext: false, matchesSent: false, nextSyncStatus: opts.currentSyncStatus, dirty: true };
    }

    const currentJson = canonicalizeAllocationsJson(opts.currentAllocations);
    const matchesSent = currentJson === String(opts.sentJson || '');
    if (matchesSent) {
      return {
        sameContext: true,
        matchesSent: true,
        draftVersion: serverVersion,
        nextSyncStatus: 'synced',
        dirty: false,
      };
    }

    return {
      sameContext: true,
      matchesSent: false,
      draftVersion: serverVersion,
      nextSyncStatus: 'saved_local',
      dirty: true,
    };
  }

  function reconcileSubmitSuccess(opts) {
    const sentClassroomId = Number(opts.sentClassroomId);
    const sentRoundNo = Number(opts.sentRoundNo);
    const currentClassroomId = Number(opts.currentClassroomId);
    const currentRoundNo = Number(opts.currentRoundNo);

    if (sentClassroomId !== currentClassroomId || sentRoundNo !== currentRoundNo) {
      return { sameContext: false, matchesSent: false, nextSyncStatus: opts.currentSyncStatus, dirty: true };
    }

    const currentJson = canonicalizeAllocationsJson(opts.currentAllocations);
    const matchesSent = currentJson === String(opts.sentJson || '');
    if (matchesSent) {
      return {
        sameContext: true,
        matchesSent: true,
        nextSyncStatus: 'submitted',
        dirty: false,
      };
    }

    return {
      sameContext: true,
      matchesSent: false,
      nextSyncStatus: 'saved_local',
      dirty: true,
    };
  }

  return {
    CENTS_PER_WAN: CENTS_PER_WAN,
    parseWanToCents: parseWanToCents,
    centsToWanStr: centsToWanStr,
    centsToWanDisplay: centsToWanDisplay,
    computeAllocatedSumCents: computeAllocatedSumCents,
    computeAssetCapCents: computeAssetCapCents,
    computePercentCapCents: computePercentCapCents,
    formatReturnPct: formatReturnPct,
    buildLocalDraftKey: buildLocalDraftKey,
    readLocalDraft: readLocalDraft,
    writeLocalDraft: writeLocalDraft,
    clearAccountLocalDrafts: clearAccountLocalDrafts,
    resolveInitialDraftState: resolveInitialDraftState,
    canonicalizeAllocationsJson: canonicalizeAllocationsJson,
    reconcileDraftSyncSuccess: reconcileDraftSyncSuccess,
    reconcileSubmitSuccess: reconcileSubmitSuccess,
  };
});
