

// 自 server/services/notificationBatchService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function lockRequest(db, actorUsername, operation, clientRequestId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
    'notification_op:' + String(actorUsername || '') + ':' + operation + ':' + clientRequestId,
  ]);
}

module.exports = {
  lockRequest,
};
