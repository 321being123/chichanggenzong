'use strict';

function listMarketCalendar(executor, ...args) { return executor(`SELECT trade_date::text AS trade_date, is_open, source_code, raw_payload
       FROM market.trade_calendar
      WHERE exchange='HKEX' AND trade_date=ANY($1::date[])`, ...args); }

module.exports = { listMarketCalendar };
