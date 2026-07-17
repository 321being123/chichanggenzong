// ========== 打新日历路由（读取 Python 定时任务写入 PostgreSQL 的打新数据） ==========
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');

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
                circulation_mv, listing_date, ld_close_change,
                main_business, industry, subscribe_upper_limit
         FROM ipo_history WHERE listing_date IS NOT NULL AND listing_date <> ''
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
    res.json({ days, calendar });
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
    if (!fs.existsSync(file)) {
      return res.json({ code, md: '' });
    }
    const md = fs.readFileSync(file, 'utf-8');
    res.json({ code, md });
  } catch (e) {
    res.status(500).json({ error: '读取个股报告失败', detail: e.message });
  }
});

module.exports = router;
