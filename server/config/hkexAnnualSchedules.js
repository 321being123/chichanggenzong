// 港交所年度证券市场计划安排，来源为港交所年度假期通告。
// 新年份仅在官方通告核验后加入；未知日期不得推断为开市或休市。
const SCHEDULES = {
  2026: {
    title: '2026 年香港证券市场假期',
    sourceUrl: 'https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf',
    verifiedAt: '2026-09-25',
    holidays: {
      '01-01': '元旦',
      '02-17': '农历年初一',
      '02-18': '农历年初二',
      '02-19': '农历年初三',
      '04-03': '耶稣受难节',
      '04-06': '复活节星期一',
      '04-07': '清明节补假',
      '05-01': '劳动节',
      '05-25': '佛诞补假',
      '06-19': '端午节',
      '07-01': '香港特别行政区成立纪念日',
      '10-01': '国庆日',
      '10-19': '重阳节补假',
      '12-25': '圣诞节',
    },
    halfDays: {
      '02-16': { holidayName: '农历新年前夕', closeTime: '12:10' },
      '12-24': { holidayName: '圣诞节前夕', closeTime: '12:10' },
      '12-31': { holidayName: '新年前夕', closeTime: '12:10' },
    },
  },
};

function dateText(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function scheduleForDate(value) {
  const date = dateText(value);
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  const schedule = SCHEDULES[year];
  if (!schedule) return null;
  const monthDay = date.slice(5);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const holidayName = schedule.holidays[monthDay] || null;
  const halfDay = schedule.halfDays[monthDay] || null;
  const isOpen = weekday >= 1 && weekday <= 5 && !holidayName;
  const sessionType = isOpen ? (halfDay ? 'half_day' : 'full_day') : 'closed';
  return {
    isOpen,
    sessionType,
    closeTime: isOpen ? (halfDay ? halfDay.closeTime : '16:10') : null,
    holidayName: holidayName || (halfDay && halfDay.holidayName) || (weekday === 0 || weekday === 6 ? '周末' : null),
    evidence: {
      title: schedule.title,
      source_url: schedule.sourceUrl,
      year,
      verified_at: schedule.verifiedAt,
    },
  };
}

function supportedScheduleYears() {
  return Object.keys(SCHEDULES).map(Number).sort((a, b) => a - b);
}

module.exports = { scheduleForDate, supportedScheduleYears };
