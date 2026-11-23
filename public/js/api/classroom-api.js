(function (global) {
  'use strict';

  function getClient() {
    if (global.siteApi && typeof global.siteApi.fetchJson === 'function') {
      return global.siteApi;
    }
    throw new Error('siteApi 未初始化');
  }

  function requestJson(url, opts) {
    return getClient().fetchJson(url, opts);
  }

  const classroomApi = {
    getMe: function () {
      return requestJson('/api/me');
    },
    listMyClassrooms: function () {
      return requestJson('/api/classroom/my');
    },
    resolveByCode: function (code) {
      return requestJson('/api/classroom/by-code/' + encodeURIComponent(code));
    },
    joinClassroom: function (classroomId, nickname) {
      return requestJson('/api/classroom/' + classroomId + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nickname }),
      });
    },
    getStudentState: function (classroomId) {
      return requestJson('/api/classroom/' + classroomId + '/state');
    },
    saveDraft: function (classroomId, roundNo, allocations, expectedVersion) {
      return getClient().fetchResponse('/api/classroom/' + classroomId + '/rounds/' + roundNo + '/draft', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocations: allocations, expectedVersion: expectedVersion }),
      }).then(async function (res) {
        const data = await res.json().catch(function () { return {}; });
        return { ok: res.ok, status: res.status, data: data };
      });
    },
    submitAllocation: function (classroomId, roundNo, allocations, clientRequestId) {
      return requestJson('/api/classroom/' + classroomId + '/rounds/' + roundNo + '/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocations: allocations, clientRequestId: clientRequestId }),
      });
    },
    getHistory: function (classroomId) {
      return requestJson('/api/classroom/' + classroomId + '/history');
    },
    getReport: function (classroomId) {
      return requestJson('/api/classroom/' + classroomId + '/report');
    },
    saveAfterClassNote: function (classroomId, note) {
      return requestJson('/api/classroom/' + classroomId + '/report/note', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note }),
      });
    },
    // 教师端接口
    adminPrecheck: function (payload) {
      return requestJson('/api/classroom/admin/precheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    },
    adminList: function () {
      return requestJson('/api/classroom/admin/list');
    },
    adminCreate: function (payload) {
      return requestJson('/api/classroom/admin/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
    },
    adminGetState: function (classroomId) {
      return requestJson('/api/classroom/admin/' + classroomId + '/state');
    },
    adminGetProjector: function (classroomId, roundNo) {
      const qs = roundNo ? ('?roundNo=' + encodeURIComponent(roundNo)) : '';
      return requestJson('/api/classroom/admin/' + classroomId + '/projector' + qs);
    },
    adminOpenRound: function (classroomId, roundNo, expectedStateVersion) {
      return requestJson('/api/classroom/admin/' + classroomId + '/rounds/' + roundNo + '/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedStateVersion: expectedStateVersion }),
      });
    },
    adminLockRound: function (classroomId, roundNo, expectedStateVersion) {
      return requestJson('/api/classroom/admin/' + classroomId + '/rounds/' + roundNo + '/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedStateVersion: expectedStateVersion }),
      });
    },
    adminUnlockRound: function (classroomId, roundNo, expectedStateVersion) {
      return requestJson('/api/classroom/admin/' + classroomId + '/rounds/' + roundNo + '/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedStateVersion: expectedStateVersion }),
      });
    },
    adminRevealRound: function (classroomId, roundNo, expectedStateVersion) {
      return requestJson('/api/classroom/admin/' + classroomId + '/rounds/' + roundNo + '/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedStateVersion: expectedStateVersion }),
      });
    },
    adminRevealIdentity: function (classroomId) {
      return requestJson('/api/classroom/admin/' + classroomId + '/reveal-identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    adminUpdateNickname: function (classroomId, memberId, displayNickname, isMasked) {
      return requestJson('/api/classroom/admin/' + classroomId + '/members/' + memberId + '/nickname', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayNickname: displayNickname, isMasked: isMasked }),
      });
    },
    openEventStream: function (classroomId) {
      if (typeof EventSource === 'undefined') return null;
      return new EventSource('/api/classroom/' + classroomId + '/events');
    },
  };

  global.classroomApi = classroomApi;
})(typeof window !== 'undefined' ? window : globalThis);
