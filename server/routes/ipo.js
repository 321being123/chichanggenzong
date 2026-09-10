// ========== 打新日历路由（读取 Python 定时任务写入 PostgreSQL 的打新数据） ==========
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { getBondBySecurityCode, getBondHistoryList } = require('../services/bondDataService');
const { getHkFormalGateStatus } = require('../services/hkIpoBacktest');

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

const IPO_MODEL_FEATURE_META = {
  issue_price: { label: '发行价', unit: '元/股' },
  issue_pe: { label: '发行PE', unit: '倍' },
  industry_pe: { label: '行业PE', unit: '倍' },
  fund_raised: { label: '募资规模', unit: '亿元' },
  online_shares: { label: '网上发行量', unit: '万股' },
  total_shares: { label: '发行总量', unit: '万股' },
  online_lottery_rate: { label: '网上中签率', unit: '%' },
  oversubscribe_multiple: { label: '超额认购倍数', unit: '倍' },
  circulation_mv: { label: '流通市值', unit: '亿元' },
  subscribe_upper_limit: { label: '申购上限', unit: '万股' },
  pe_ratio: { label: 'PE比值', unit: '无单位：发行PE÷行业PE' },
  circulation_mv_log: { label: '流通市值对数', unit: '无单位：log1p(流通市值)' },
  fund_raised_log: { label: '募资规模对数', unit: '无单位：log1p(募资规模)' },
  price_times_pe: { label: '发行价×PE', unit: '无单位：发行价×发行PE÷100' },
  lottery_rate_inverse: { label: '中签率倒数', unit: '无单位：1÷(中签率+0.001)' },
  circulation_per_lot: { label: '流通市值/中签率', unit: '无单位：流通市值÷(中签率+0.001)' },
  issue_pe_squared: { label: '发行PE平方', unit: '无单位：发行PE²÷1000' },
};

function cnStockSector(row) {
  const exposure = row && row.business_exposure && typeof row.business_exposure === 'object'
    ? row.business_exposure : {};
  const items = Array.isArray(exposure.exposures) ? exposure.exposures : [];
  const top = items.find(item => item && item.label);
  if (top) return `${top.label}${exposure.confidence != null ? `（可信度${Number(exposure.confidence).toFixed(2)}）` : ''}`;
  return row && row.industry ? `${row.industry}（行业兜底）` : '待补全';
}

async function buildCnStockLiveReport(code) {
  const result = await pool.query(
    `SELECT h.security_code,h.security_name,h.market_type,h.ipo_date,h.listing_date,
            h.issue_price,h.issue_pe,h.industry_pe,h.industry,h.main_business,
            h.subscribe_upper_limit,h.fund_raised,h.total_shares,h.online_shares,
            h.online_lottery_rate,h.oversubscribe_multiple,h.ld_close_change,
            h.business_exposure,h.data_quality_status,
            p.pred_return,p.pred_date,p.base_pred_return,p.sector_adjustment_pp,
            p.sector_multiplier,p.sector_confidence,p.prediction_context
       FROM ipo_history h
       LEFT JOIN LATERAL (
         SELECT pred_return,pred_date,base_pred_return,sector_adjustment_pp,
                sector_multiplier,sector_confidence,prediction_context
           FROM predictions
          WHERE type='stock' AND code=h.security_code
          ORDER BY pred_date DESC,updated_at DESC NULLS LAST
          LIMIT 1
       ) p ON true
      WHERE h.market_code='CN' AND h.security_code=$1
      LIMIT 1`, [code]
  );
  const row = result.rows[0];
  if (!row) return '';
  const context = row.prediction_context && typeof row.prediction_context === 'object'
    ? row.prediction_context : {};
  let quality = row.data_quality_status && typeof row.data_quality_status === 'object'
    ? row.data_quality_status : {};
  if (typeof row.data_quality_status === 'string') {
    try { quality = JSON.parse(row.data_quality_status); } catch (_) { quality = {}; }
  }
  const pending = Array.isArray(quality.pending_not_due) ? quality.pending_not_due : [];
  const missing = Array.isArray(quality.missing_fields) ? quality.missing_fields : [];
  const fieldStates = quality.field_states && typeof quality.field_states === 'object' ? quality.field_states : {};
  const pendingLabels = {
    listing_date: '上市日期',
    online_lottery_rate: '网上中签率',
    oversubscribe_multiple: '最终超额认购倍数',
  };
  const sectorLabel = context.sector_label || '';
  const sectorComponents = Array.isArray(context.sector_components) ? context.sector_components : [];
  const topSector = sectorComponents.find(item => item && (item.label || item.sector_key)) || {};
  const sectorHeatMultiplier = topSector.multiplier == null ? null : Number(topSector.multiplier);
  const sectorSampleCount = topSector.sample_count == null ? null : Number(topSector.sample_count);
  const appliedSectorMultiplier = context.sector_multiplier ?? row.sector_multiplier;
  const sectorConfidence = context.sector_confidence ?? row.sector_confidence;
  const calculation = context.calculation_detail && typeof context.calculation_detail === 'object'
    ? context.calculation_detail : {};
  const adviceCalculation = context.advice_calculation && typeof context.advice_calculation === 'object'
    ? context.advice_calculation : {};
  const missingLabels = {
    industry: '所属行业',
    industry_pe: '行业市盈率',
    main_business: '主营业务',
    business_exposure: '业务赛道',
  };
  const prediction = row.pred_return == null
    ? '待计算'
    : `${row.pred_return}%${context.prediction_range_low != null && context.prediction_range_high != null
      ? `（可能区间${context.prediction_range_low}%～${context.prediction_range_high}%）` : ''}`;
  const stage = context.prediction_stage_label || '研究估算';
  const lines = [
    `# 📄 打新详情 — ${row.security_name || code}（${code}）`,
    '',
    '## 基本资料',
    `- **市场板块**：${valueOrDash(row.market_type)}`,
    `- **所属行业**：${valueOrDash(row.industry)}`,
    `- **业务赛道**：${cnStockSector(row)}`,
    `- **主营业务**：${valueOrDash(row.main_business)}`,
    `- **发行价格**：${valueOrDash(row.issue_price, '元')}`,
    `- **发行市盈率**：${valueOrDash(row.issue_pe)}`,
    `- **行业市盈率**：${valueOrDash(row.industry_pe)}`,
    `- **募集资金**：${valueOrDash(row.fund_raised, '亿元')}`,
    `- **发行总量**：${valueOrDash(row.total_shares, '万股')}`,
    `- **网上发行量**：${valueOrDash(row.online_shares, '万股')}`,
    `- **顶格申购上限**：${valueOrDash(row.subscribe_upper_limit, '万股')}`,
    `- **申购日期**：${valueOrDash(row.ipo_date)}`,
    `- **上市日期**：${valueOrDash(row.listing_date)}`,
    '',
    '## 发行阶段预测',
    `- **可能涨幅**：${prediction}`,
    `- **预测版本**：${stage}`,
    `- **预测日期**：${valueOrDash(row.pred_date)}`,
  ];
  if (row.pred_return != null) {
    lines.splice(lines.length - 3, 0,
      '- **预测模型**：XGBoost（发行阶段模型）',
      `- **模型基准涨幅**：${valueOrDash(row.base_pred_return, '%')}`,
      `- **热度赛道**：${valueOrDash(sectorLabel || null)}`,
      `- **赛道热度系数**：${sectorHeatMultiplier != null && Number.isFinite(sectorHeatMultiplier)
        ? `×${sectorHeatMultiplier.toFixed(2)}${sectorSampleCount != null && Number.isFinite(sectorSampleCount) ? `（样本${sectorSampleCount}只）` : ''}`
        : '暂无'}`,
      `- **赛道修正**：${appliedSectorMultiplier != null && Number.isFinite(Number(appliedSectorMultiplier))
        ? `×${Number(appliedSectorMultiplier).toFixed(2)}${sectorConfidence != null ? `（业务可信度${Number(sectorConfidence).toFixed(2)}）` : ''}`
        : '未做赛道修正'}`,
    );
    if (calculation.model) {
      const features = calculation.model_features && typeof calculation.model_features === 'object'
        ? calculation.model_features : {};
      const featureStatus = calculation.model_feature_status && typeof calculation.model_feature_status === 'object'
        ? calculation.model_feature_status : {};
      const featureText = Object.entries(features).map(([key, value]) => {
        const meta = IPO_MODEL_FEATURE_META[key] || { label: key, unit: '无单位：模型字段' };
        const status = featureStatus[key] === '补位' ? '（补位）' : '';
        const number = value == null || value === '' ? '暂无' : Number.isFinite(Number(value)) ? Number(value).toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : String(value);
        return `${meta.label}（${meta.unit}）=${number}${status}`;
      });
      lines.push('', '## 预测计算明细',
        `- **模型**：${calculation.model}（${calculation.model_stage || stage}）`,
        `- **模型输入**：${featureText.length ? featureText.join('；') : '暂无'}`,
        `- **XGBoost原始输出**：${valueOrDash(calculation.raw_model_return, '%')}`,
        `- **模型校准**：板块基准${valueOrDash(calculation.board_base, '%')}，校准系数${valueOrDash(calculation.model_calibration_multiplier, '')}，校准后${valueOrDash(calculation.model_calibrated_return, '%')}`,
        `- **赛道计算**：${calculation.sector_formula || '暂无'}`,
        `- **赛道修正后**：${valueOrDash(calculation.sector_return, '%')}`,
        `- **市场温度修正**：${valueOrDash(calculation.market_temperature)}，系数${valueOrDash(calculation.temperature_multiplier, '')}，最终${valueOrDash(calculation.final_return, '%')}`,
        `- **最终可能区间**：${calculation.range_low != null && calculation.range_high != null ? `${calculation.range_low}%～${calculation.range_high}%` : '暂无'}`,
      );
      const components = Array.isArray(context.sector_components) ? context.sector_components : [];
      if (components.length) {
        lines.push('- **赛道成分**：', ...components.map(item => {
          const component = item && typeof item === 'object' ? item : {};
          return `  - ${component.label || component.sector_key || '未知赛道'}：权重${component.weight ?? '暂无'}，历史系数×${component.multiplier ?? '暂无'}，样本${component.sample_count ?? '暂无'}只`;
        }
        ));
      }
    }
    if (Array.isArray(adviceCalculation.steps) && adviceCalculation.steps.length) {
      lines.push('', '## 打新建议评分明细',
        `- **综合评分**：${valueOrDash(adviceCalculation.score, '分')}`,
        `- **市场状态**：${valueOrDash(adviceCalculation.market_temperature)}${adviceCalculation.break_rate != null ? `，破发率${adviceCalculation.break_rate}%` : ''}`,
        ...adviceCalculation.steps.map(step => {
          const before = step.before == null ? '起始' : `${step.before}分`;
          const after = step.after == null ? '暂无' : `${step.after}分`;
          const note = step.note ? `（${step.note}）` : '';
          return `- ${step.step || '评分步骤'}：${before} × ${step.multiplier ?? 1} = ${after}${note}`;
        }),
      );
    }
  }
  if (pending.length) {
    lines.push('', '## 尚未公布数据', ...pending.map(field => `- **${pendingLabels[field] || field}**：发行结果公告后更新`));
  }
  const unresolvedDetail = missing.filter(field => missingLabels[field]);
  if (unresolvedDetail.length) {
    lines.push('', '## 资料补全状态', ...unresolvedDetail.map(field => `- **${missingLabels[field]}**：发行资料已到，但当前尚未解析成功，系统会继续重试`));
  }
  if (fieldStates.industry_pe && fieldStates.industry_pe.status === 'source_unavailable') {
    lines.push('', '## 暂无可用来源', '- **行业市盈率**：当前同行样本不足或行业名称无法匹配，系统低频复查，不影响行业、赛道和主营业务完整状态');
  }
  if (row.ld_close_change != null) {
    lines.push('', '## 上市结果', `- **首日收盘涨幅**：${row.ld_close_change}%`);
  }
  lines.push('', `> 资料状态：${quality.status === 'complete' ? '完整' : '部分待补全'}；详情读取已入库事实，不在页面请求时调用外部接口。`);
  return lines.join('\n');
}

function assessHkGreenshoe(details, protectionRatio) {
  const item = details && typeof details === 'object' ? details : {};
  const status = String(item.status || '').toLowerCase();
  const ratio = Number(protectionRatio ?? item.protectionRatioPct);
  if (status === 'exercised' || status === 'over_allocated' || (Number.isFinite(ratio) && ratio > 0)) {
    return '偏利好：有稳价安排';
  }
  if (status === 'not_exercised') return '中性：机制存在，未行使';
  if (status === 'not_available' || status === 'no_over_allocation') return '偏不利：缺少绿鞋保护';
  if (status === 'not_disclosed' || !status) return '待确认';
  return '中性：机制待确认';
}

function calendarDay(date) {
  return { date, weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(`${date}T00:00:00+08:00`)),
    apply_stocks: [], apply_bonds: [], list_stocks: [], list_bonds: [] };
}

function mergeCalendarDays(...calendars) {
  const byDate = new Map();
  for (const calendar of calendars.flat()) {
    if (!calendar || !calendar.date) continue;
    const target = byDate.get(calendar.date) || calendarDay(calendar.date);
    for (const key of ['apply_stocks', 'apply_bonds', 'list_stocks', 'list_bonds']) {
      const existing = target[key] || [];
      const incoming = Array.isArray(calendar[key]) ? calendar[key] : [];
      const unique = new Map(existing.concat(incoming).map(item => [
        item.secu_code || item.code || item.name || '', item,
      ]));
      target[key] = [...unique.values()];
    }
    byDate.set(calendar.date, target);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
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

function stockHistoryStageSql(alias = 'h') {
  return `CASE WHEN ${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
    CASE
      WHEN ${alias}.listing_date::date = (timezone('Asia/Shanghai', now()))::date THEN 'listing_today'
      WHEN ${alias}.listing_date::date < (timezone('Asia/Shanghai', now()))::date THEN 'listed'
      ELSE 'subscribed'
    END
  ELSE 'subscribed' END`;
}

function stockFieldStatusSql(alias = 'h') {
  return `jsonb_build_object(
    'ipo_date', CASE WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'value' ELSE 'missing' END,
    'listing_date', CASE
      WHEN ${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'value'
      ELSE 'pending'
    END,
    'issue_price', CASE WHEN ${alias}.issue_price IS NOT NULL THEN 'value' ELSE 'missing' END,
    'online_lottery_rate', CASE WHEN ${alias}.online_lottery_rate IS NOT NULL THEN 'value' ELSE 'pending' END,
    'oversubscribe_multiple', CASE WHEN ${alias}.oversubscribe_multiple IS NOT NULL THEN 'value' ELSE 'pending' END,
    'industry', CASE WHEN NULLIF(${alias}.industry, '') IS NOT NULL THEN 'value'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'industry_pe', CASE WHEN ${alias}.industry_pe IS NOT NULL THEN 'value'
      WHEN ${alias}.data_quality_status->'field_states'->'industry_pe'->>'status' = 'source_unavailable' THEN 'source_unavailable'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'main_business', CASE WHEN NULLIF(${alias}.main_business, '') IS NOT NULL THEN 'value'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'business_exposure', CASE
      WHEN ${alias}.business_exposure ? 'exposures' THEN 'value'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'ld_close_change', CASE WHEN ${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
      CASE
        WHEN ${alias}.listing_date::date > (timezone('Asia/Shanghai', now()))::date THEN 'pending'
        WHEN ${alias}.ld_close_change IS NOT NULL THEN 'value'
        ELSE 'missing'
      END
      ELSE 'pending'
    END
  )`;
}

async function loadStockCalendar(days, market = 'CN') {
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT (timezone('Asia/Shanghai', now()))::date AS start_date,
              (timezone('Asia/Shanghai', now()))::date + ($1::int * INTERVAL '1 day') AS end_date
     ), stock_events AS (
       SELECT CASE WHEN $2='HK' THEN COALESCE(to_char(h.offer_open_at,'YYYY-MM-DD'),h.ipo_date) ELSE h.ipo_date END AS event_date, 'apply' AS event_type,
              h.security_code AS code, COALESCE(NULLIF(h.security_name_cn,''),NULLIF(q.name,''),h.security_name) AS name
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT q.name FROM market_quote_cache q
            WHERE q.source='tencent' AND q.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
            ORDER BY q.fetched_at DESC LIMIT 1
         ) q ON true, bounds b
         WHERE h.market_code=$2
           AND (CASE WHEN $2='HK' THEN COALESCE(to_char(h.offer_open_at,'YYYY-MM-DD'),h.ipo_date) ELSE h.ipo_date END) ~ '^\\d{4}-\\d{2}-\\d{2}$'
           AND (CASE WHEN $2='HK' THEN COALESCE(to_char(h.offer_open_at,'YYYY-MM-DD'),h.ipo_date) ELSE h.ipo_date END) >= to_char(b.start_date, 'YYYY-MM-DD')
          AND (CASE WHEN $2='HK' THEN COALESCE(to_char(h.offer_open_at,'YYYY-MM-DD'),h.ipo_date) ELSE h.ipo_date END) < to_char(b.end_date, 'YYYY-MM-DD')
          AND ($2='HK' OR (COALESCE(h.market_type, '') <> '北交所' AND h.security_code !~ '^(920|82|83|87|43)'))
       UNION ALL
       SELECT CASE WHEN $2='HK' THEN COALESCE(to_char(h.listing_at,'YYYY-MM-DD'),h.listing_date) ELSE h.listing_date END AS event_date, 'listing' AS event_type,
              h.security_code AS code, COALESCE(NULLIF(h.security_name_cn,''),NULLIF(q.name,''),h.security_name) AS name
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT q.name FROM market_quote_cache q
            WHERE q.source='tencent' AND q.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
            ORDER BY q.fetched_at DESC LIMIT 1
         ) q ON true, bounds b
         WHERE h.market_code=$2
           AND (CASE WHEN $2='HK' THEN COALESCE(to_char(h.listing_at,'YYYY-MM-DD'),h.listing_date) ELSE h.listing_date END) ~ '^\\d{4}-\\d{2}-\\d{2}$'
           AND (CASE WHEN $2='HK' THEN COALESCE(to_char(h.listing_at,'YYYY-MM-DD'),h.listing_date) ELSE h.listing_date END) >= to_char(b.start_date, 'YYYY-MM-DD')
          AND (CASE WHEN $2='HK' THEN COALESCE(to_char(h.listing_at,'YYYY-MM-DD'),h.listing_date) ELSE h.listing_date END) < to_char(b.end_date, 'YYYY-MM-DD')
          AND ($2='HK' OR (COALESCE(h.market_type, '') <> '北交所' AND h.security_code !~ '^(920|82|83|87|43)'))
     )
     SELECT event_date AS date,event_type,code,name
       FROM stock_events ORDER BY event_date,code,event_type`, [days, market]
  );
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.date)) groups.set(row.date, calendarDay(row.date));
    const key = row.event_type === 'apply' ? 'apply_stocks' : 'list_stocks';
    groups.get(row.date)[key].push({ code: row.code, name: row.name, secu_code: row.code });
  }
  return [...groups.values()];
}

async function loadBondCalendar(days) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (e.instrument_id, e.event_type, e.event_date)
            e.event_date::text AS date, e.event_type, split_part(i.canonical_code, '.', 1) AS code,
            i.canonical_code AS secu_code, i.name
       FROM event.instrument_events e
       JOIN core.instruments i ON i.instrument_id=e.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=e.instrument_id
      WHERE i.asset_class='convertible_bond'
        AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
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
       FROM ipo_history WHERE security_code=$1 AND market_code='CN' LIMIT 1`,
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
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM ipo_history h
          WHERE h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND h.market_code='CN'
            AND h.ipo_date <= to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD')
            AND COALESCE(h.market_type, '') <> '北交所'
            AND h.security_code !~ '^(920|82|83|87|43)'`
      );
      total = countResult.rows[0] ? countResult.rows[0].total : 0;
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
    const type = req.query.type === 'bond' ? 'bond' : (req.query.type === 'hk_stock' ? 'hk_stock' : 'stock');
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    let rows;
    let total = null;
    if (type === 'bond') {
      rows = await getBondHistoryList(limit);
    } else if (type === 'hk_stock') {
      const countResult = await pool.query("SELECT COUNT(*)::int AS total FROM ipo_history WHERE market_code='HK'");
      total = countResult.rows[0] ? countResult.rows[0].total : 0;
      const r = await pool.query(
        `SELECT h.security_code,h.security_name,
                COALESCE(NULLIF(h.security_name_cn,''),NULLIF(q.name,''),h.security_name) AS security_name_cn,
                h.market_type,h.ipo_status,
                COALESCE(to_char(h.offer_open_at,'YYYY-MM-DD'),h.ipo_date) AS offer_open_date,
                to_char(h.offer_close_at,'YYYY-MM-DD') AS offer_close_date,
                to_char(h.pricing_at,'YYYY-MM-DD') AS pricing_date,
                to_char(h.allotment_at,'YYYY-MM-DD') AS allotment_date,
                COALESCE(to_char(h.listing_at,'YYYY-MM-DD'),h.listing_date) AS listing_date,
                h.issue_price_low,h.issue_price_high,h.issue_price_final,h.lot_size_shares,h.lot_amount_hkd,
                h.application_fee_hkd,h.brokerage_fee_hkd,h.online_lottery_rate,h.oversubscribe_multiple AS public_oversubscription,
                live.subscription_multiple AS subscription_live_multiple,
                live.source_code AS subscription_live_source,
                live.observed_at AS subscription_live_observed_at,
                (live.raw_payload->>'signal_kind') AS subscription_live_kind,
                (live.raw_payload->>'signal_origin') AS subscription_live_origin,
                (live.observed_at IS NULL OR live.observed_at < now() - interval '1 day') AS subscription_live_stale,
                livermore_grey.grey_market_price_hkd AS livermore_grey_market_price_hkd,
                livermore_grey.grey_market_change_pct AS livermore_grey_market_change_pct,
                livermore_grey.observed_at AS livermore_grey_market_observed_at,
                futu_grey.grey_market_price_hkd AS futu_grey_market_price_hkd,
                futu_grey.grey_market_change_pct AS futu_grey_market_change_pct,
                futu_grey.observed_at AS futu_grey_market_observed_at,
                NULLIF(h.greenshoe_details->>'protectionRatioPct','')::numeric AS greenshoe_protection_ratio,
                NULLIF(h.greenshoe_details->>'initialPublicOfferShares','')::numeric AS greenshoe_initial_public_offer_shares,
                NULLIF(h.greenshoe_details->>'finalPublicOfferShares','')::numeric AS greenshoe_final_public_offer_shares,
                (SELECT document->'parserEvidence'->>'publicOversubscriptionQualifier'
                   FROM jsonb_array_elements(COALESCE(h.source_documents,'[]'::jsonb)) document
                  WHERE document->>'type'='allotment_result'
                    AND document->'parserEvidence'->>'publicOversubscriptionQualifier' IS NOT NULL
                  ORDER BY document->>'announcedAt' DESC NULLS LAST
                  LIMIT 1) AS public_oversubscription_qualifier,
                h.public_offer_ratio,h.international_offer_ratio,
                h.cornerstone_details,h.greenshoe_details,h.source_documents,h.data_completeness,
                perf.listing_close,
                CASE WHEN h.issue_price_final IS NOT NULL AND h.issue_price_final > 0 AND perf.listing_close IS NOT NULL
                     THEN ROUND(((perf.listing_close / h.issue_price_final - 1) * 100)::numeric, 2) END AS actual_return,
                CASE WHEN h.issue_price_final IS NOT NULL AND perf.listing_close IS NOT NULL AND h.lot_size_shares IS NOT NULL
                     THEN ROUND(((perf.listing_close - h.issue_price_final) * h.lot_size_shares)::numeric, 2) END AS lot_profit,
                h.facts_published_at AS published_at,
                to_char(h.facts_published_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS data_as_of,
                NULL::numeric AS pred_return,NULL::numeric AS score,'facts' AS stage,'待事实完整后校准' AS advice,
                (h.facts_published_at IS NULL OR h.facts_published_at < now() - interval '2 days') AS is_stale,
                CASE WHEN h.facts_published_at IS NULL THEN '缺少事实更新时间'
                     WHEN h.facts_published_at < now() - interval '2 days' THEN '事实超过 2 天未更新'
                     ELSE '' END AS stale_reason
           FROM ipo_history h
           LEFT JOIN LATERAL (
             SELECT q.name
               FROM market_quote_cache q
              WHERE q.source='tencent'
                AND q.symbol='hk' || replace(h.security_code,'.HK','')
              ORDER BY q.fetched_at DESC
              LIMIT 1
           ) q ON true
           LEFT JOIN LATERAL (
             SELECT s.subscription_multiple,s.source_code,s.observed_at,s.raw_payload
               FROM analytics.hk_ipo_market_snapshots s
              WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g') AND s.signal_type='subscription'
              ORDER BY s.observed_at DESC
              LIMIT 1
           ) live ON true
           LEFT JOIN LATERAL (
             SELECT s.grey_market_price_hkd,s.grey_market_change_pct,s.observed_at
               FROM analytics.hk_ipo_market_snapshots s
              WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g') AND s.signal_type='grey_market' AND s.source_code='livermore'
              ORDER BY s.observed_at DESC
              LIMIT 1
           ) livermore_grey ON true
           LEFT JOIN LATERAL (
             SELECT s.grey_market_price_hkd,s.grey_market_change_pct,s.observed_at
               FROM analytics.hk_ipo_market_snapshots s
              WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g') AND s.signal_type='grey_market' AND s.source_code='futu-public'
              ORDER BY s.observed_at DESC
              LIMIT 1
           ) futu_grey ON true
           LEFT JOIN LATERAL (
             SELECT d.close AS listing_close
              FROM market.daily_bars d
              WHERE d.instrument_id=h.instrument_id
                AND d.trade_date >= CASE
                  WHEN h.listing_at IS NOT NULL THEN h.listing_at::date
                  WHEN h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN h.listing_date::date
                END
              ORDER BY d.trade_date,d.source_id DESC
              LIMIT 1
           ) perf ON true
          WHERE h.market_code='HK'
          ORDER BY COALESCE(h.offer_open_at,h.listing_at,h.facts_published_at) DESC NULLS LAST,h.security_code
          LIMIT $1 OFFSET $2`, [limit, offset]
      );
      rows = r.rows.map(row => ({
        ...row,
        greenshoe_assessment: assessHkGreenshoe(row.greenshoe_details, row.greenshoe_protection_ratio),
      }));
    } else {
      // 集思录式列：代码/名称/发行价/发行PE/行业PE/行业/发行总数/申购上限/顶格申购需配市值/中签率%/募资/上市日/首日涨幅
      // 预测涨幅：关联 predictions 表（取该代码最新一条有效预测），无预测则显示空
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM ipo_history h
          WHERE h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND h.market_code='CN'
            AND h.ipo_date <= to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD')
            AND COALESCE(h.market_type, '') <> '北交所'
            AND h.security_code !~ '^(920|82|83|87|43)'`
      );
      total = countResult.rows[0] ? countResult.rows[0].total : 0;
      const r = await pool.query(
        `              SELECT h.security_code, h.security_name, h.ipo_date,
                h.issue_price, h.issue_pe, h.industry_pe, h.fund_raised,
                h.total_shares, h.online_shares, h.online_lottery_rate, h.oversubscribe_multiple,
                COALESCE(
                  h.circulation_mv,
                  ROUND((COALESCE(h.online_shares, h.total_shares) * h.issue_price / 10000.0)::numeric, 2)::double precision
                ) AS circulation_mv,
                h.listing_date, h.ld_close_change,
                h.main_business, h.industry, h.subscribe_upper_limit,
                h.issue_pe_status, h.data_quality_status,
                ${stockHistoryStageSql('h')} AS history_stage,
                ${stockFieldStatusSql('h')} AS field_status,
                to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD') AS data_as_of,
                p.pred_return AS pred_return,
                p.base_pred_return AS base_pred_return,
                p.sector_adjustment_pp AS sector_adjustment_pp,
                p.sector_multiplier AS sector_multiplier,
                p.sector_confidence AS sector_confidence,
                p.prediction_context AS prediction_context,
                COALESCE(p.has_prediction, false) AS has_prediction
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT pred_return, base_pred_return, sector_adjustment_pp,
                  sector_multiplier, sector_confidence, prediction_context,
                  true AS has_prediction FROM predictions
           WHERE type = 'stock' AND code = h.security_code AND pred_return IS NOT NULL
           ORDER BY pred_date DESC LIMIT 1
         ) p ON true
          WHERE h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND h.market_code='CN'
            AND h.ipo_date <= to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD')
           AND COALESCE(h.market_type, '') <> '北交所'
           AND h.security_code !~ '^(920|82|83|87|43)'
         ORDER BY h.ipo_date DESC, NULLIF(h.listing_date, '') DESC NULLS LAST, h.security_code LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      rows = r.rows;
    }
    const formalGate = type === 'hk_stock' ? await getHkFormalGateStatus() : null;
    res.json({ type, rows, ...(total !== null ? { total, limit, offset } : {}), ...(formalGate ? { formal_gate: formalGate } : {}) });
  } catch (e) {
    res.status(500).json({ error: '读取打新历史失败' });
  }
});

// 打新日历：未来 N 天申购/上市日（股票来自 ipo_history，新债来自标准事件表）
router.get('/calendar', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10) || 30, 90);
    const market = String(req.query.market || 'CN').toUpperCase();
    const selectedMarket = ['CN', 'HK', 'ALL'].includes(market) ? market : 'CN';
    const cnCalendar = selectedMarket === 'HK' ? [] : await loadStockCalendar(days);
    const [hkCalendar, bondCalendar] = await Promise.all([
      selectedMarket === 'CN' ? [] : loadStockCalendar(days, 'HK'),
      selectedMarket === 'HK' ? [] : loadBondCalendar(days),
    ]);
    const calendar = mergeCalendarDays(cnCalendar, hkCalendar, bondCalendar);
    res.json({ days, market: selectedMarket, calendar });
  } catch (e) {
    res.status(500).json({ error: '读取打新日历失败' });
  }
});

// 个股单独分析日报：从 ipo-report/individual/<code>.md 读取
router.get('/report/code', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!/^[0-9A-Za-z.]+$/.test(code)) {
      return res.status(400).json({ error: '非法 code' });
    }
    const hkCode = /^\d{1,5}(?:\.HK)?$/i.test(code)
      ? `${String(code).replace(/\.HK$/i, '').padStart(5, '0')}.HK` : null;
    if (hkCode) {
      const fact = await pool.query(
        `SELECT security_code,security_name,
                COALESCE(NULLIF(h.security_name_cn,''),NULLIF(q.name,''),h.security_name) AS security_name_cn,
                market_type,ipo_status,
                COALESCE(to_char(offer_open_at,'YYYY-MM-DD'),ipo_date) AS offer_open_date,
                to_char(offer_close_at,'YYYY-MM-DD') AS offer_close_date,
                to_char(pricing_at,'YYYY-MM-DD') AS pricing_date,
                to_char(allotment_at,'YYYY-MM-DD') AS allotment_date,
                COALESCE(to_char(listing_at,'YYYY-MM-DD'),listing_date) AS listing_date,
                issue_price_low,issue_price_high,issue_price_final,lot_size_shares,lot_amount_hkd,
                application_fee_hkd,brokerage_fee_hkd,oversubscribe_multiple,greenshoe_details,facts_published_at,
                (SELECT s.subscription_multiple FROM analytics.hk_ipo_market_snapshots s
                  WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
                    AND s.signal_type='subscription' ORDER BY s.observed_at DESC LIMIT 1) AS subscription_live_multiple,
                (SELECT s.grey_market_change_pct FROM analytics.hk_ipo_market_snapshots s
                  WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
                    AND s.signal_type='grey_market' AND s.source_code='livermore' ORDER BY s.observed_at DESC LIMIT 1) AS livermore_grey_market_change_pct,
                (SELECT s.grey_market_change_pct FROM analytics.hk_ipo_market_snapshots s
                  WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
                    AND s.signal_type='grey_market' AND s.source_code='futu-public' ORDER BY s.observed_at DESC LIMIT 1) AS futu_grey_market_change_pct
           FROM ipo_history h
           LEFT JOIN LATERAL (
             SELECT name
               FROM market_quote_cache
              WHERE source='tencent' AND symbol='hk' || replace(h.security_code,'.HK','')
              ORDER BY fetched_at DESC
              LIMIT 1
           ) q ON true
          WHERE h.market_code='HK' AND h.security_code=$1 LIMIT 1`, [hkCode]
      );
      if (fact.rows[0]) {
        const row = fact.rows[0];
        const lines = [
          `# 📄 港股 IPO 事实 — ${row.security_name_cn || row.security_name || '中文名待补'}（${hkCode}）`, '',
          '## 当前状态', `- **阶段**：${row.ipo_status || 'active'}`, `- **板块**：${row.market_type || '待补全'}`,
          '', '## 关键日期', `- **公开发售开始**：${row.offer_open_date || '待公告'}`, `- **公开发售结束**：${row.offer_close_date || '待公告'}`,
          `- **定价日**：${row.pricing_date || '待公告'}`, `- **配售结果**：${row.allotment_date || '待公告'}`, `- **上市日**：${row.listing_date || '待公告'}`,
          '', '## 申购事实', `- **发行价区间**：${row.issue_price_low == null ? '待公告' : row.issue_price_low + '–' + (row.issue_price_high == null ? row.issue_price_low : row.issue_price_high) + ' 港元'}`,
          `- **最终发行价**：${row.issue_price_final == null ? '待公告' : row.issue_price_final + ' 港元'}`,
          `- **每手股数**：${row.lot_size_shares == null ? '待公告' : row.lot_size_shares}`, `- **每手资金**：${row.lot_amount_hkd == null ? '待公告' : row.lot_amount_hkd + ' 港元'}`,
          `- **申请费用（含佣金及征费）**：${row.application_fee_hkd == null ? '待公告' : row.application_fee_hkd + ' 港元'}`, `- **经纪佣金**：${row.brokerage_fee_hkd == null ? '待公告' : row.brokerage_fee_hkd + ' 港元'}`,
          `- **申购期认购倍数**：${row.subscription_live_multiple == null ? '暂无盘中数据' : row.subscription_live_multiple + ' 倍（来源：' + (row.subscription_live_source === 'vbkr-public' ? '华盛公开新股页' : '利弗莫尔') + '）'}`,
          `- **最终超额认购倍数**：${row.oversubscribe_multiple == null ? '待配售结果' : row.oversubscribe_multiple + ' 倍'}`,
          `- **绿鞋判断**：${assessHkGreenshoe(row.greenshoe_details, null)}`,
          `- **利弗莫尔暗盘涨幅**：${row.livermore_grey_market_change_pct == null ? '暂无' : row.livermore_grey_market_change_pct + '%'}`,
          `- **富途暗盘涨幅**：${row.futu_grey_market_change_pct == null ? '暂无' : row.futu_grey_market_change_pct + '%'}`,
          '', '## 研究状态', '- 当前仅展示官方事实；研究评分与正式建议待历史样本、质量门禁和回测完成后开放。',
          `- **事实更新时间**：${row.facts_published_at || '暂无'}`,
        ];
        return res.json({ code: hkCode, market: 'HK', stage: 'facts', score: null, advice: null, md: lines.join('\n') });
      }
    }
    const liveCn = await buildCnStockLiveReport(code);
    if (liveCn) {
      return res.json({ code, market: 'CN', stage: 'facts', score: null, advice: null, md: liveCn });
    }
    // 数据库报告会随补数和重新生成及时更新；仓库内单债文件只是部署兜底，不能遮住新数据。
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
    const file = path.join(__dirname, '..', '..', 'ipo-report', 'individual', code + '.md');
    if (fs.existsSync(file)) {
      const md = fs.readFileSync(file, 'utf-8');
      return res.json({ code, md: codeReportWithFooter(md, code) });
    }
    const calendarReport = await buildCalendarReport(code);
    res.json({ code, md: calendarReport });
  } catch (e) {
    res.status(500).json({ error: '读取个股报告失败' });
  }
});

module.exports = router;
module.exports.mergeCalendarDays = mergeCalendarDays;
module.exports.assessHkGreenshoe = assessHkGreenshoe;
