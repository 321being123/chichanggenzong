// 自然日位移的纯函数（按 Asia/Shanghai 归属日期）。
// 从 server/services/cashIncome.js 抽出，供收益结算与公告时间窗共用。
const CoreDate = require('../../public/shared/core-date');

function shiftDay(day, offset = 1) {
  const instant = new Date(day + 'T12:00:00+08:00');
  instant.setUTCDate(instant.getUTCDate() + offset);
  return CoreDate.dateInZone(instant, 'Asia/Shanghai');
}

module.exports = { shiftDay };
