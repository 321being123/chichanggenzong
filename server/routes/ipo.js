// ========== 打新日历路由（读取 Python 定时任务写入 PostgreSQL 的打新数据） ==========
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');

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
    const detail = await pool.query(
      `SELECT rating, issue_size, conv_price, stk_code, stk_name, onl_date, listing_date
       FROM bond_history WHERE security_code=$1 LIMIT 1`,
      [code]
    );
    const row = detail.rows[0] || {};
    lines = lines.concat([
      '',
      '## 基本资料',
      `- **债券评级**：${valueOrDash(row.rating)}`,
      `- **发行规模**：${valueOrDash(row.issue_size, '亿元')}`,
      `- **正股**：${valueOrDash(row.stk_name)}${row.stk_code ? `（${row.stk_code}）` : ''}`,
      `- **转股价**：${valueOrDash(row.conv_price, '元')}`,
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
    res.status(500).json({ error: '读取打新报告失败', detail: e.message });
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
    res.status(500).json({ error: '读取报告列表失败', detail: e.message });
  }
});

// 打新历史（集思录式列表）
router.get('/history', async (req, res) => {
  try {
    const type = req.query.type === 'bond' ? 'bond' : 'stock';
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    let rows;
    if (type === 'bond') {
      // 集思录式可转债详细列（扩展后 bond_history 含 cb_issue 全字段）
      const r = await pool.query(
        `SELECT security_code, security_name,
           ann_date, res_ann_date, issue_size, issue_type, rating,
           shd_ration_ratio, issue_price, shd_ration_record_date,
           onl_date, onl_size, onl_pch_num, offl_size, shd_ration_size,
           conv_price, stk_code, stk_name,
           listing_date, first_day_return
         FROM bond_history
         ORDER BY COALESCE(res_ann_date, ann_date, listing_date) DESC NULLS LAST LIMIT $1`,
        [limit]
      );
      rows = r.rows;
    } else {
      // 集思录式列：代码/名称/发行价/发行PE/行业PE/行业/发行总数/申购上限/顶格申购需配市值/中签率%/募资/上市日/首日涨幅
      const r = await pool.query(
        `              SELECT security_code, security_name, ipo_date,
                issue_price, issue_pe, industry_pe, fund_raised,
                total_shares, online_shares, online_lottery_rate,
                COALESCE(
                  circulation_mv,
                  ROUND((COALESCE(online_shares, total_shares) * issue_price / 10000.0)::numeric, 2)::double precision
                ) AS circulation_mv,
                listing_date, ld_close_change,
                main_business, industry, subscribe_upper_limit
         FROM ipo_history
         WHERE listing_date IS NOT NULL AND listing_date <> ''
           AND COALESCE(market_type, '') <> '北交所'
           AND security_code !~ '^(920|82|83|87|43)'
         ORDER BY listing_date DESC LIMIT $1`,
        [limit]
      );
      rows = r.rows;
    }
    res.json({ type, rows });
  } catch (e) {
    res.status(500).json({ error: '读取打新历史失败', detail: e.message });
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
    res.json({ days, calendar: filterBeijingStocks(calendar) });
  } catch (e) {
    res.status(500).json({ error: '读取打新日历失败', detail: e.message });
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
      return res.json({ code, md: extractCodeReport(md, code) || md });
    }
    const reports = await pool.query(
      'SELECT md FROM ipo_reports WHERE md LIKE $1 ORDER BY report_date DESC',
      [`%${code}%`]
    );
    for (const row of reports.rows) {
      const section = extractCodeReport(row.md, code);
      if (section) {
        return res.json({ code, md: section });
      }
    }
    const calendarReport = await buildCalendarReport(code);
    res.json({ code, md: calendarReport });
  } catch (e) {
    res.status(500).json({ error: '读取个股报告失败', detail: e.message });
  }
});

module.exports = router;
