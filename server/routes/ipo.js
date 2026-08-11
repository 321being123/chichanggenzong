// ========== 打新日历路由（优先读取日报，过期时回读本地发行数据） ==========
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { getBondBySecurityCode, getBondHistoryList } = require('../services/bondDataService');

function isBeijingStock(code) {
  return /^(920|82|83|87|43)/.test(String(code || ''));
}

function filterBeijingStocks(calendar) {
  return (calendar || []).map(day => ({
    ...day,
    apply_stocks: (day.apply_stocks || []).filter(item => !isBeijingStock(item.code)),
    list_stocks: (day.list_stocks || []).filter(item => !isBeijingStock(item.code)),
  }));
}

function normalizeIpoDate(value) {
  const text = String(value || '').trim().slice(0, 10);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function beijingToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function calendarDateRange(days) {
  const start = beijingToday();
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  return { start, end: end.toISOString().slice(0, 10) };
}

function hasUpcomingCalendar(calendar, days) {
  const { start, end } = calendarDateRange(days);
  return (calendar || []).some(day => {
    const date = normalizeIpoDate(day.date);
    if (!date || date < start || date > end) return false;
    return ['apply_stocks', 'apply_bonds', 'list_stocks', 'list_bonds']
      .some(key => Array.isArray(day[key]) && day[key].length > 0);
  });
}

async function buildLocalCalendar(days) {
  const { start, end } = calendarDateRange(days);
  const groups = new Map();
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function add(dateValue, key, item) {
    const date = normalizeIpoDate(dateValue);
    if (!date || date < start || date > end) return;
    if (key.endsWith('_stocks') && isBeijingStock(item.code)) return;
    if (!groups.has(date)) {
      const day = new Date(`${date}T00:00:00Z`);
      groups.set(date, {
        date,
        weekday: weekday[day.getUTCDay()],
        list_bonds: [], apply_bonds: [], list_stocks: [], apply_stocks: [],
      });
    }
    groups.get(date)[key].push({ name: item.name || '', code: item.code || '' });
  }

  const [stocks, bonds] = await Promise.all([
    pool.query('SELECT security_code, security_name, ipo_date, listing_date FROM ipo_history'),
    pool.query('SELECT security_code, security_name, onl_date, listing_date FROM bond_history'),
  ]);
  for (const row of stocks.rows) {
    const item = { code: row.security_code, name: row.security_name };
    add(row.ipo_date, 'apply_stocks', item);
    add(row.listing_date, 'list_stocks', item);
  }
  for (const row of bonds.rows) {
    const item = { code: row.security_code, name: row.security_name };
    add(row.onl_date, 'apply_bonds', item);
    add(row.listing_date, 'list_bonds', item);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildLocalAdviceMarkdown(calendar) {
  const apply = [];
  const listed = [];
  for (const day of calendar || []) {
    for (const item of day.apply_stocks || []) apply.push(`- ${item.name || item.code}（${item.code}，待评估）`);
    for (const item of day.apply_bonds || []) apply.push(`- ${item.name || item.code}（${item.code}，待评估）`);
    for (const item of day.list_stocks || []) listed.push(`- ${item.name || item.code}（${item.code}）`);
    for (const item of day.list_bonds || []) listed.push(`- ${item.name || item.code}（${item.code}）`);
  }
  if (!apply.length && !listed.length) return '';
  const lines = ['# 📋 本地发行数据', '', '## 📋 结论', ''];
  if (apply.length) lines.push('**打新**', ...apply, '');
  if (listed.length) lines.push('**上市**', ...listed, '');
  return lines.join('\n');
}

function extractCodeReport(md, code) {
  const lines = String(md || '').split(/\r?\n/);
  const heading = new RegExp(`^####\\s+.+?[（(]${code}[）)]`);
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,4}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function extractReportFooter(md) {
  const text = String(md || '');
  let start = text.indexOf('## 📊 预测跟踪统计');
  if (start < 0) start = text.indexOf('## 📊 当前赛道热度系数');
  if (start < 0) return '';
  const footer = text.indexOf('*本报告由打新日报系统自动生成', start);
  return text.slice(start, footer >= 0 ? footer : text.length).trim();
}

function codeReportWithFooter(md, code) {
  const section = extractCodeReport(md, code);
  if (!section) return String(md || '');
  return [section, extractReportFooter(md)].filter(Boolean).join('\n\n---\n\n');
}

function valueOrDash(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '暂无' : `${value}${suffix}`;
}

async function buildCalendarReport(code) {
  const latest = await pool.query(
    "SELECT summary_json->'calendar' AS calendar FROM ipo_reports ORDER BY report_date DESC LIMIT 1"
  );
  const calendar = latest.rows[0]?.calendar || [];
  let found = null;
  for (const day of calendar) {
    for (const key of ['apply_stocks', 'apply_bonds', 'list_stocks', 'list_bonds']) {
      const item = (day[key] || []).find(entry => String(entry.code) === code);
      if (item) {
        found = { ...item, date: day.date, key };
        break;
      }
    }
    if (found) break;
  }
  if (!found || (found.key.endsWith('stocks') && isBeijingStock(code))) return '';

  const isBond = found.key.endsWith('bonds');
  const eventName = found.key.startsWith('apply_') ? '申购' : '上市';
  let lines = [
    `# 📄 单独分析 — ${found.name}（${code}）`,
    '',
    '## 日历信息',
    `- **类型**：${isBond ? '新债' : '新股'}`,
    `- **事项**：${eventName}`,
    `- **日期**：${found.date || '暂无'}`,
  ];

  if (isBond) {
    const row = await getBondBySecurityCode(code) || {};
    lines = lines.concat([
      '',
      '## 基本资料',
      `- **债券评级**：${valueOrDash(row.display_rating || row.rating)}`,
      `- **发行规模**：${valueOrDash(row.display_issue_size || row.issue_size, '亿元')}`,
      `- **正股**：${valueOrDash(row.stock_name)}${row.stock_code ? `（${row.stock_code}）` : ''}`,
      `- **转股价**：${valueOrDash(row.display_conv_price || row.conv_price, '元')}`,
      `- **申购日**：${valueOrDash(row.onl_date)}`,
      `- **上市日**：${valueOrDash(row.listing_date)}`,
    ]);
  } else {
    const detail = await pool.query(
      `SELECT market_type, ipo_date, listing_date, issue_price, issue_pe, industry_pe,
              industry, main_business, subscribe_upper_limit
       FROM ipo_history WHERE security_code=$1 LIMIT 1`,
      [code]
    );
    const row = detail.rows[0] || {};
    lines = lines.concat([
      '',
      '## 基本资料',
      `- **市场**：${valueOrDash(row.market_type)}`,
      `- **所属行业**：${valueOrDash(row.industry)}`,
      `- **发行价**：${valueOrDash(row.issue_price, '元')}`,
      `- **发行市盈率**：${valueOrDash(row.issue_pe)}`,
      `- **行业市盈率**：${valueOrDash(row.industry_pe)}`,
      `- **申购上限**：${valueOrDash(row.subscribe_upper_limit, '万股')}`,
      `- **申购日**：${valueOrDash(row.ipo_date)}`,
      `- **上市日**：${valueOrDash(row.listing_date)}`,
      `- **主营业务**：${valueOrDash(row.main_business)}`,
    ]);
  }
  return lines.join('\n');
}

// 最新报告（或指定日期 YYYYMMDD）：返回摘要 + Markdown + HTML
router.get('/report', async (req, res) => {
  try {
    const date = req.query.date;
    let row;
    if (date) {
      const r = await pool.query(
        'SELECT report_date, md, html, summary_json FROM ipo_reports WHERE report_date=$1',
        [String(date)]
      );
      row = r.rows[0];
    } else {
      const r = await pool.query(
        'SELECT report_date, md, html, summary_json FROM ipo_reports ORDER BY report_date DESC LIMIT 1'
      );
      row = r.rows[0];
    }
    if (!row) {
      try {
        const localCalendar = await buildLocalCalendar(90);
        const localMd = buildLocalAdviceMarkdown(localCalendar);
        if (localMd) {
          const first = localCalendar[0] || {};
          return res.json({
            report_date: beijingToday().replace(/-/g, ''),
            summary: {
              date_display: `${beijingToday()}（本地发行数据）`,
              calendar: localCalendar,
              apply_stocks: first.apply_stocks || [],
              apply_bonds: first.apply_bonds || [],
              list_stocks: first.list_stocks || [],
              list_bonds: first.list_bonds || [],
            },
            md: localMd,
            html: '',
          });
        }
      } catch (_) {
        // 本地发行表不可用时返回空报告。
      }
      return res.json({ report_date: null, summary: null, md: '', html: '' });
    }
    let summary = typeof row.summary_json === 'string'
      ? JSON.parse(row.summary_json)
      : row.summary_json;
    let md = row.md || '';
    let reportDate = row.report_date;
    try {
      if (!hasUpcomingCalendar(summary && summary.calendar, 90)) {
        const localCalendar = await buildLocalCalendar(90);
        const localMd = buildLocalAdviceMarkdown(localCalendar);
        if (localMd) {
          const first = localCalendar[0] || {};
          summary = {
            ...(summary || {}),
            date_display: `${beijingToday()}（本地发行数据）`,
            calendar: localCalendar,
            apply_stocks: first.apply_stocks || [],
            apply_bonds: first.apply_bonds || [],
            list_stocks: first.list_stocks || [],
            list_bonds: first.list_bonds || [],
          };
          md = localMd;
          reportDate = beijingToday().replace(/-/g, '');
        }
      }
    } catch (_) {
      // 本地发行表不可用时仍返回原日报，避免日报接口整体失败。
    }
    res.json({ report_date: reportDate, summary, md, html: row.html || '' });
  } catch (e) {
    res.status(500).json({ error: '读取打新报告失败' });
  }
});

// 历史报告日期列表（前端历史下拉）
router.get('/reports', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT report_date,
              summary_json->>'date_display' AS date_display,
              summary_json->>'weekday' AS weekday
       FROM ipo_reports ORDER BY report_date DESC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: '读取报告列表失败' });
  }
});

// 打新历史（集思录式列表）
router.get('/history', async (req, res) => {
  try {
    const type = req.query.type === 'bond' ? 'bond' : 'stock';
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    let rows;
    if (type === 'bond') {
      rows = await getBondHistoryList(limit);
    } else {
      // 集思录式列：代码/名称/发行价/发行PE/行业PE/行业/发行总数/申购上限/顶格申购需配市值/中签率%/募资/上市日/首日涨幅
      // 预测涨幅：关联 predictions 表（取该代码最新一条有效预测），无预测则显示空
      const r = await pool.query(
        `              SELECT h.security_code, h.security_name, h.ipo_date,
                h.issue_price, h.issue_pe, h.industry_pe, h.fund_raised,
                h.total_shares, h.online_shares, h.online_lottery_rate,
                COALESCE(
                  h.circulation_mv,
                  ROUND((COALESCE(h.online_shares, h.total_shares) * h.issue_price / 10000.0)::numeric, 2)::double precision
                ) AS circulation_mv,
                h.listing_date, h.ld_close_change,
                h.main_business, h.industry, h.subscribe_upper_limit,
                h.issue_pe_status, h.data_quality_status,
                p.pred_return AS pred_return, COALESCE(p.has_prediction, false) AS has_prediction
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT pred_return, true AS has_prediction FROM predictions
           WHERE type = 'stock' AND code = h.security_code AND pred_return IS NOT NULL
           ORDER BY pred_date DESC LIMIT 1
         ) p ON true
         WHERE h.listing_date IS NOT NULL AND h.listing_date <> ''
           AND COALESCE(h.market_type, '') <> '北交所'
           AND h.security_code !~ '^(920|82|83|87|43)'
         ORDER BY h.listing_date DESC LIMIT $1`,
        [limit]
      );
      rows = r.rows;
    }
    res.json({ type, rows });
  } catch (e) {
    res.status(500).json({ error: '读取打新历史失败' });
  }
});

// 打新日历：未来 N 天申购/上市日（来自最新报告的 summary_json.calendar）
router.get('/calendar', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
    const r = await pool.query(
      "SELECT summary_json->'calendar' AS calendar FROM ipo_reports ORDER BY report_date DESC LIMIT 1"
    );
    const row = r.rows[0];
    let calendar = [];
    if (row && row.calendar) {
      calendar = typeof row.calendar === 'string' ? JSON.parse(row.calendar) : row.calendar;
    }
    let filteredCalendar = filterBeijingStocks(calendar);
    try {
      if (!hasUpcomingCalendar(filteredCalendar, days)) filteredCalendar = await buildLocalCalendar(days);
    } catch (_) {
      // 本地发行表不可用时仍返回原日报日历。
    }
    res.json({ days, calendar: filteredCalendar });
  } catch (e) {
    res.status(500).json({ error: '读取打新日历失败' });
  }
});

// 个股单独分析日报：从 ipo-report/individual/<code>.md 读取
router.get('/report/code', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!/^[0-9A-Za-z]+$/.test(code)) {
      return res.status(400).json({ error: '非法 code' });
    }
    const file = path.join(__dirname, '..', '..', 'ipo-report', 'individual', code + '.md');
    if (fs.existsSync(file)) {
      const md = fs.readFileSync(file, 'utf-8');
      return res.json({ code, md: codeReportWithFooter(md, code) });
    }
    const reports = await pool.query(
      'SELECT md FROM ipo_reports WHERE md LIKE $1 ORDER BY report_date DESC',
      [`%${code}%`]
    );
    for (const row of reports.rows) {
      const section = extractCodeReport(row.md, code);
      if (section) {
        return res.json({ code, md: codeReportWithFooter(row.md, code) });
      }
    }
    const calendarReport = await buildCalendarReport(code);
    res.json({ code, md: calendarReport });
  } catch (e) {
    res.status(500).json({ error: '读取个股报告失败' });
  }
});

module.exports = router;
