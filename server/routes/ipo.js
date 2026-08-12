// ========== 打新日历路由（读取 Python 定时任务写入 PostgreSQL 的打新数据） ==========
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

function calendarDay(date) {
  return { date, weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(`${date}T00:00:00+08:00`)),
    apply_stocks: [], apply_bonds: [], list_stocks: [], list_bonds: [] };
}

function trimCalendar(calendar, days) {
  const start = new Date();
  const startText = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(start);
  const end = new Date(`${startText}T00:00:00+08:00`);
  end.setDate(end.getDate() + days);
  const endText = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(end);
  return (calendar || []).filter(day => {
    const date = String(day.date || '').slice(0, 10);
    return date >= startText && date < endText;
  });
}

async function loadBondCalendar(days) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (e.instrument_id, e.event_type, e.event_date)
            e.event_date::text AS date, e.event_type, split_part(i.canonical_code, '.', 1) AS code,
            i.canonical_code AS secu_code, i.name
       FROM event.instrument_events e
       JOIN core.instruments i ON i.instrument_id=e.instrument_id
      WHERE i.asset_class='convertible_bond'
        AND e.event_type IN ('online_subscription','listing')
        AND e.event_date >= CURRENT_DATE
        AND e.event_date < CURRENT_DATE + ($1::int * INTERVAL '1 day')
      ORDER BY e.instrument_id, e.event_type, e.event_date, e.source_updated_at DESC NULLS LAST`, [days]
  );
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.date)) groups.set(row.date, calendarDay(row.date));
    const key = row.event_type === 'online_subscription' ? 'apply_bonds' : 'list_bonds';
    groups.get(row.date)[key].push({ code: row.code, name: row.name, secu_code: row.secu_code });
  }
  return [...groups.values()];
}

async function buildCalendarReport(code) {
  const bond = await getBondBySecurityCode(code);
  if (bond) {
    const eventResult = await pool.query(
      `SELECT event_type,event_date::text AS date
         FROM event.instrument_events
        WHERE instrument_id=$1 AND event_type IN ('online_subscription','listing')
        ORDER BY event_date DESC, event_type DESC LIMIT 1`, [bond.instrument_id]
    );
    const event = eventResult.rows[0];
    if (!event) return '';
    const isApply = event.event_type === 'online_subscription';
    const found = { code: String(code).split('.')[0], name: bond.bond_name, date: event.date,
      key: isApply ? 'apply_bonds' : 'list_bonds' };
    const eventName = isApply ? '申购' : '上市';
    const lines = [
      `# 📄 单独分析 — ${found.name}（${found.code}）`, '', '## 日历信息',
      '- **类型**：新债', `- **事项**：${eventName}`, `- **日期**：${found.date || '暂无'}`,
      '', '## 基本资料',
      `- **债券评级**：${valueOrDash(bond.display_rating || bond.rating)}`,
      `- **发行规模**：${valueOrDash(bond.display_issue_size || bond.issue_size, '亿元')}`,
      `- **正股**：${valueOrDash(bond.stock_name)}${bond.stock_code ? `（${bond.stock_code}）` : ''}`,
      `- **转股价**：${valueOrDash(bond.display_conv_price || bond.conv_price, '元')}`,
      `- **申购日**：${valueOrDash(bond.onl_date)}`,
      `- **上市日**：${valueOrDash(bond.listing_date)}`,
    ];
    return lines.join('\n');
  }
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
    if (!row) return res.json({ report_date: null, summary: null, md: '', html: '' });
    const summary = typeof row.summary_json === 'string'
      ? JSON.parse(row.summary_json)
      : row.summary_json;
    res.json({ report_date: row.report_date, summary, md: row.md || '', html: row.html || '' });
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
    const stockCalendar = trimCalendar(filterBeijingStocks(calendar), days);
    const bondCalendar = await loadBondCalendar(days);
    const byDate = new Map(stockCalendar.map(day => [day.date, { ...calendarDay(day.date), ...day }]));
    for (const day of bondCalendar) {
      const target = byDate.get(day.date) || calendarDay(day.date);
      target.apply_bonds = day.apply_bonds;
      target.list_bonds = day.list_bonds;
      byDate.set(day.date, target);
    }
    res.json({ days, calendar: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) });
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
