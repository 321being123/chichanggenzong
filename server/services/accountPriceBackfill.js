// 导入/保存账户后补行情：给「账户需要的日期里有持仓、却缺当日价格」的标的补收盘价。
// 背景：2026-10-29 being 当天导入，行情任务早已跑完，15 只持仓没有当日价格，净值判不完整；
// 若导入自带历史净值，前几天同样会缺价。这里按「最早缺口日 → 今天」整段补齐；
// 具体走 Tushare（A股/基金/转债）还是腾讯（港股）由数据层按证券类型决定，业务层不感知。
// 串行、失败静默、不阻塞保存响应。
const repository = require('../repositories/accountPriceBackfillRepository');

const MAX_CODES = 80;
const LOOKBACK_DAYS = 30;

function todayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const pick = type => (parts.find(p => p.type === type) || {}).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function shiftDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function backfillMissingTodayPrices(username, accountName, options = {}) {
  if (!username || !accountName) return { checked: 0, filled: 0, reason: 'missing_scope' };
  const today = options.today || todayShanghai(options.now);
  const fromDate = options.fromDate || shiftDays(today, -LOOKBACK_DAYS);
  const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), MAX_CODES) : MAX_CODES;
  const { rows } = await repository.selectPositionCodesMissingPrice([username, accountName, fromDate, limit, today]);
  if (!rows.length) return { checked: 0, filled: 0, today, fromDate };
  const backfill = options.backfill || require('../jobs/replayNav').backfillDailyPrices;
  const failed = [];
  let filled = 0;
  for (const row of rows) {
    // 只补这只标的真正缺的区间，避免为了今天一天把整月历史重拉。
    const start = row.first_missing && row.first_missing > fromDate ? row.first_missing : fromDate;
    try {
      if (await backfill(username, accountName, row.code, start, today)) filled += 1;
      else failed.push(row.code);
    } catch (error) {
      failed.push(row.code);
    }
  }
  return { checked: rows.length, filled, failed, today, fromDate };
}

module.exports = { backfillMissingTodayPrices, todayShanghai };
