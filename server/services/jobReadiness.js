// 就绪窗口的纯函数（方案 2026-11-18 P0）。
// 单独成模块的原因：调度侧（jobScheduleSlots）和业务侧（jobs/marketClose）都要算同一个
// 检查点时刻。两处各写一份必然漂移——尤其"首查前不请求外部终盘"这条：调度按 17:15 唤醒，
// 但 Runner 若没有同一份换算，15:10 那次仍会去外采 cb_daily/fund_daily。
// 这里只做时间换算和试点判定，不碰数据库、不碰调度状态。

const READINESS_WAIT_KINDS = Object.freeze(['lock', 'publication', 'dependency']);
const READINESS_DEFAULT_DELAY_MINUTES = 15;

function shanghaiDateText(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

// 业务日统一按上海自然日归一化：PostgreSQL 的 DATE 经驱动常返回 Date，
// 直接 toISOString().slice(0,10) 会在凌晨偏移一天（日期边界规范）。
function normalizeBusinessDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : shanghaiDateText(value);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : shanghaiDateText(parsed);
}

// 'HH:MM' + 业务日 → 绝对时刻。Date.UTC 的字段先当北京时间用，再减去东八区偏移。
function readinessMoment(businessDate, clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock || '').trim());
  const date = normalizeBusinessDate(businessDate);
  if (!match || !date) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!(hour >= 0 && hour < 24) || !(minute >= 0 && minute < 60)) return null;
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0));
}

// 试点判定：只有声明了 readinessCheckpoints 的任务才切换到 waiting_readiness /
// 才延迟外部终盘取数。未声明即沿用既有契约，避免一次性改动全部链路。
function isReadinessPilot(definition) {
  return Boolean(definition && Array.isArray(definition.readinessCheckpoints) && definition.readinessCheckpoints.length);
}

function readinessCheckpoints(definition) {
  return isReadinessPilot(definition) ? definition.readinessCheckpoints : [];
}

// 下一个检查点：第一个仍在未来的时刻；全部已过时按有限兜底推进，
// 不因"检查点用尽"就无限等待或立刻判失败。
function nextReadinessCheckpoint(slot, definition, now = new Date()) {
  const current = new Date(now);
  for (const clock of readinessCheckpoints(definition)) {
    const at = readinessMoment(slot && slot.business_date, clock);
    if (at && at.getTime() > current.getTime()) {
      const stopAt = readinessBoundaryMoment(slot, definition, 'readinessStopAt');
      if (stopAt && stopAt.getTime() > current.getTime() && at.getTime() > stopAt.getTime()) return stopAt;
      return at;
    }
  }
  const stopAt = readinessBoundaryMoment(slot, definition, 'readinessStopAt');
  const fallback = new Date(current.getTime() + READINESS_DEFAULT_DELAY_MINUTES * 60000);
  if (stopAt && stopAt.getTime() > current.getTime() && fallback.getTime() > stopAt.getTime()) return stopAt;
  return fallback;
}

function readinessBoundaryMoment(slot, definition, field) {
  return readinessMoment(slot && slot.business_date, definition && definition[field]);
}

// 外部终盘取数是否已开窗：首个检查点之前一律不开窗。
// 15:10 只做候选预览；到 17:15（基金 17:30）之后才允许请求 cb_daily / fund_daily，
// 这样"每天前几次必然拿不到终盘"的无效外采和无效失败都被消掉。
function terminalFetchWindowOpen(definition, businessDate, now = new Date()) {
  const checkpoints = readinessCheckpoints(definition);
  if (!checkpoints.length) return true;
  const first = readinessMoment(businessDate, checkpoints[0]);
  if (!first || Number.isNaN(first.getTime())) return true;
  return new Date(now).getTime() >= first.getTime();
}

module.exports = {
  READINESS_WAIT_KINDS, READINESS_DEFAULT_DELAY_MINUTES,
  shanghaiDateText, normalizeBusinessDate,
  readinessMoment, isReadinessPilot, readinessCheckpoints, nextReadinessCheckpoint,
  readinessBoundaryMoment, terminalFetchWindowOpen,
};
