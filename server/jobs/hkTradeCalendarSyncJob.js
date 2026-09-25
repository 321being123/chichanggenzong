const { syncHkTradeCalendar } = require('./hkTradeCalendarSync');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { supportedScheduleYears } = require('../config/hkexAnnualSchedules');
const { sendAlert } = require('../services/jobAlertMailer');

const JOB = 'hk_trade_calendar_sync';
let running = false;

async function checkAnnualScheduleReminder(date, { query = pool.query.bind(pool), notify = sendAlert, enabled = process.env.NODE_ENV === 'production' } = {}) {
  const currentDate = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentDate) || currentDate < `${currentDate.slice(0, 4)}-11-01`) {
    return { status: 'not_due' };
  }
  if (!enabled) return { status: 'suppressed_non_production' };
  const targetYear = Number(currentDate.slice(0, 4)) + 1;
  const daysInYear = new Date(Date.UTC(targetYear, 1, 29)).getUTCDate() === 29 ? 366 : 365;
  const { rows } = await query(
    `SELECT COUNT(DISTINCT trade_date)::int AS covered_days,
            COUNT(*) FILTER (WHERE raw_payload ? 'official_schedule'
              AND COALESCE(raw_payload#>>'{official_schedule,source_url}','') <> ''
              AND COALESCE(raw_payload#>>'{official_schedule,verified_at}','') <> ''
              AND COALESCE(raw_payload#>>'{official_schedule,quality_status}','') = 'passed')::int AS verified_days
       FROM market.trade_calendar
      WHERE exchange='HKEX' AND trade_date >= $1::date AND trade_date < ($1::date + interval '1 year')`,
    [`${targetYear}-01-01`]
  );
  const coveredDays = Number(rows[0] && rows[0].covered_days || 0);
  const verifiedDays = Number(rows[0] && rows[0].verified_days || 0);
  const complete = supportedScheduleYears().includes(targetYear) && coveredDays === daysInYear && verifiedDays === daysInYear;
  const alertKey = `hkex-calendar:${targetYear}:annual-plan`;
  if (complete) {
    await query(
      `UPDATE ops.alert_notifications
          SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
        WHERE alert_key=$1 AND status NOT IN ('resolved','acknowledged')`,
      [alertKey]
    );
    return { status: 'verified', targetYear, coveredDays, verifiedDays };
  }
  const noticePublished = supportedScheduleYears().includes(targetYear);
  await notify({
    alertKey,
    alertType: 'calendar_coverage_warning',
    severity: 'warning',
    jobCode: JOB,
    scopeType: 'job',
    scopeKey: `${JOB}:HKEX:${targetYear}`,
    subject: `港交所 ${targetYear} 年度交易日历待核验`,
    summary: noticePublished
      ? `${targetYear} 年 HKEX 年度计划已登记，但全年覆盖或官方证据未齐：日历覆盖 ${coveredDays}/${daysInYear} 天，官方核验 ${verifiedDays}/${daysInYear} 天。`
      : `${targetYear} 年 HKEX 证券市场年度安排尚未录入并核验；当前覆盖 ${coveredDays}/${daysInYear} 天、官方核验 ${verifiedDays}/${daysInYear} 天。请等待港交所公告并经核验后录入，不按普通工作日推测。`,
  });
  return { status: 'pending', targetYear, coveredDays, verifiedDays, noticePublished };
}

async function runHkTradeCalendarSync(reason = 'scheduled', context = {}) {
  if (running) return { skipped: true, reason: 'already_running' };
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'already_running' };
  running = true;
  const runId = await startJobRun(JOB);
  try {
    const result = await syncHkTradeCalendar(context);
    const annualReminder = await checkAnnualScheduleReminder(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()))
      .catch(error => ({ status: 'check_failed', error: error.message || String(error) }));
    result.annualReminder = annualReminder;
    await finishJobRun(runId, Boolean(result && result.ok), JSON.stringify(result || {}));
    console.log(`[hk-trade-calendar] ${reason} 港交所交易日历同步完成:`, result);
    return result;
  } catch (error) {
    await finishJobRun(runId, false, error.message || String(error));
    throw error;
  } finally {
    running = false;
    await releaseJob(JOB);
  }
}

module.exports = { runHkTradeCalendarSync, checkAnnualScheduleReminder };
