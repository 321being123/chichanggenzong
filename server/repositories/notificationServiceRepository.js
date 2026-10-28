const { pool } = require('../db/connection');

// 自 server/services/notificationService.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_public_notification_recipients(params, client = pool) {
  return client.query(`SELECT count(*)::int AS count FROM public.notification_recipients
        WHERE notification_id=$1 AND recipient_slot_key=$2`, params);
}

module.exports = {
  select_public_notification_recipients,
};
