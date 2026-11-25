'use strict';

// 股市模拟沙盘同源 SSE 通知中心（仅在事务提交后广播 roundNo + stateVersion）

const subscribersByClassroom = new Map();

function subscribe(classroomId, res) {
  const key = String(classroomId);
  if (!subscribersByClassroom.has(key)) {
    subscribersByClassroom.set(key, new Set());
  }
  const set = subscribersByClassroom.get(key);
  set.add(res);
  return () => {
    const s = subscribersByClassroom.get(key);
    if (s) {
      s.delete(res);
      if (s.size === 0) subscribersByClassroom.delete(key);
    }
  };
}

function broadcastStateChange(classroomId, payload) {
  const key = String(classroomId);
  const set = subscribersByClassroom.get(key);
  if (!set || set.size === 0) return 0;
  const data = JSON.stringify({
    classroomId: Number(classroomId),
    roundNo: Number(payload.roundNo),
    stateVersion: Number(payload.stateVersion),
    status: String(payload.status || ''),
    reason: String(payload.reason || 'state'),
  });
  const frame = `event: state_change\ndata: ${data}\n\n`;
  let sent = 0;
  for (const res of set) {
    try {
      res.write(frame);
      sent++;
    } catch (e) {
      set.delete(res);
    }
  }
  return sent;
}

module.exports = {
  subscribe,
  broadcastStateChange,
};
