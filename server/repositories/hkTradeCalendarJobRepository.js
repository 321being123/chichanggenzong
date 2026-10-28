'use strict';

function checkAnnualScheduleReminderQuery1(executor, ...args) { return executor(`SELECT COUNT(DISTINCT trade_date)::int AS covered_days,
            COUNT(*) FILTER (WHERE raw_payload ? 'official_schedule'
              AND COALESCE(raw_payload#>>'{official_schedule,source_url}','') <> ''
              AND COALESCE(raw_payload#>>'{official_schedule,verified_at}','') <> ''
              AND COALESCE(raw_payload#>>'{official_schedule,quality_status}','') = 'passed')::int AS verified_days
       FROM market.trade_calendar
      WHERE exchange='HKEX' AND trade_date >= $1::date AND trade_date < ($1::date + interval '1 year')`, ...args); }

module.exports = {
  checkAnnualScheduleReminderQuery1, };
