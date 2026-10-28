const { pool } = require('../db/connection');

// 自 server/services/notificationService.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_public_notification_recipients(params, client = pool) {
  return client.query(`SELECT count(*)::int AS count FROM public.notification_recipients
        WHERE notification_id=$1 AND recipient_slot_key=$2`, params);
}

// 按反馈定位待失效通知；releaseRunId 只失效该批次，缺省失效全部有效完成通知。
async function selectInvalidatableFeedbackNotifications(params, client = pool) {
  const args = [params.feedbackId];
  let extra = '';
  if (params.releaseRunId) {
    args.push(String(params.releaseRunId));
    extra = ` AND release_run_id = $${args.length}`;
  }
  return client.query(
    `SELECT id::text AS id FROM public.notifications
      WHERE feedback_id=$1 AND invalidated_at IS NULL${extra}
      ORDER BY id DESC`,
    args,
  );
}

module.exports = {
  selectInvalidatableFeedbackNotifications,
  select_public_notification_recipients,
};
