// 导入/保存账户后，给「今天有持仓但缺当日价格」的标的做一次临时行情采集。
// 背景：2026-10-29 being 账户当天导入，行情任务早已跑完，14 只持仓没有当日价格，
// 净值任务因此判该账户不完整。这里只补当日、串行、失败静默，不阻塞保存响应。
const repository = require('../repositories/accountPriceBackfillRepository');

const MAX_CODES = 80;

function todayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const pick = type => (parts.find(p => p.type === type) || {}).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

async function backfillMissingTodayPrices(username, accountName, options = {}) {
  if (!username || !accountName) return { checked: 0, filled: 0, reason: 'missing_scope' };
  const today = options.today || todayShanghai(options.now);
  const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), MAX_CODES) : MAX_CODES;
  const { rows } = await repository.selectPositionCodesMissingPrice([username, accountName, today, limit]);
  if (!rows.length) return { checked: 0, filled: 0, today };
  const backfill = options.backfill || require('../jobs/replayNav').backfillDailyPrices;
  const failed = [];
  let filled = 0;
  for (const row of rows) {
    try {
      if (await backfill(username, accountName, row.code, today, today)) filled += 1;
      else failed.push(row.code);
    } catch (error) {
      failed.push(row.code);
    }
  }
  return { checked: rows.length, filled, failed, today };
}

module.exports = { backfillMissingTodayPrices, todayShanghai };
