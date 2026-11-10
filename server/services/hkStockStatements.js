// 港股财务三表：按 HKFRS 官方科目字典读取迁移 186 的宽表，不压缩回 20 项标准事实。
// 每列带实际期末、报告类型、公告日、币种与报告版本；请求可携带 analysis_version 只读对应报告组。
'use strict';

const hkRepository = require('../repositories/hkSecurityAnalysisRepository');
const dict = require('../dataAccess/lixingerReportMetrics');
const contract = require('../domain/securityAnalysisContract');

const FORMULA_VERSION = 'hk-statements-1';
const MIN_PERIODS = 3;
const MAX_PERIODS = 20;

function normalizeType(type) {
  const key = String(type || 'balance').trim();
  return dict.STATEMENTS.includes(key) ? key : null;
}

function isPerShare(metric) {
  return /eps|per_share|每股/i.test(`${metric.code} ${metric.name}`);
}

function sectionOf(metric) {
  const prefix = String(metric.code).split('.')[0];
  return prefix === 'bs' ? '资产负债表科目' : prefix === 'ps' ? '利润表科目' : '现金流量表科目';
}

// 报告组版本：完整身份 + 公式版本 + 已选 report_id / 版本摘要。报告修订后版本必然变化。
function versionOf(tsCode, rows) {
  const digest = rows.map(row => `${row.report_id}:${row.source_version || ''}:${row.period_end || ''}`).join(',');
  return contract.analysisVersionOf({ canonicalCode: tsCode, formulaVersion: FORMULA_VERSION, inputs: { reports: digest } });
}

async function listHkStatementRows(tsCode, type, limit) {
  const metrics = dict.metricsByStatement('HK', type);
  const columns = metrics.map(metric => `w.${dict.columnOf(metric.code)}`).join(',\n       ');
  const table = dict.tableNameOf('HK', type);
  // 表名与列名均来自版本化字典的受控常量，不接受请求参数；SQL 装配留在仓储层。
  const rows = await hkRepository.listHkStatementRows(tsCode, type, table, columns, limit);
  return { rows, metrics };
}

/**
 * @returns {{type,name,unit_label,currency,analysis_version,periods,fields,status}}
 * @throws {{status:number,error:string}} 版本冲突时 409
 */
async function getHkStockStatements(tsCode, type = 'balance', limit = 8, requestedVersion = null) {
  const kind = normalizeType(type);
  if (!kind) throw new Error('三表类型无效');
  const size = Math.max(MIN_PERIODS, Math.min(MAX_PERIODS, Number(limit) || 8));
  const { rows, metrics } = await listHkStatementRows(tsCode, kind, size);
  const version = versionOf(tsCode, rows);
  const conflict = contract.versionConflict(requestedVersion, version);
  if (conflict) {
    const error = new Error(conflict.error);
    error.status = 409;
    error.conflict = conflict;
    throw error;
  }

  const periods = rows.map(row => {
    const meta = contract.statementMetadataOf({
      report_id: row.report_id,
      period_end: row.period_end,
      fiscal_year: String(row.period_end || '').slice(0, 4),
      report_type_label: row.period_type,
      accounting_standard: row.accounting_standard,
      currency: row.currency_code,
      announced_at: row.announced_at,
      version: row.source_version,
      company_id: row.company_id,
    });
    return Object.assign(meta, {
      year: meta.fiscal_year,
      end_date: meta.period_end,
      currency: meta.currency,
      unit: meta.unit,
    });
  });

  // 不同报告币种不做跨期同比；币种切换或比较期不等长时 yoy 置空。
  const currencies = [...new Set(periods.map(period => period.currency).filter(Boolean))];
  const comparableCurrency = currencies.length === 1;
  const fields = [];
  for (const metric of metrics) {
    const column = dict.columnOf(metric.code);
    const values = rows.map(row => contract.finite(row[column]));
    if (values.every(value => value === null)) continue; // 未披露的科目不显示，也不补造
    const perShare = isPerShare(metric);
    fields.push({
      code: metric.code,
      label: metric.name,
      section: sectionOf(metric),
      level: 0,
      is_parent: false,
      unit: contract.statementUnitOf({ currency: currencies[0] || null, scale: perShare ? null : '亿元', perShare }),
      values: values.map((value, index) => {
        const prior = values[index + 1];
        const sameCurrency = comparableCurrency
          && String(periods[index] && periods[index].currency || '') === String(periods[index + 1] && periods[index + 1].currency || '');
        return {
          value: value === null ? null : (perShare ? value : value / 1e8),
          yoy: value === null || prior === null || prior === 0 || !sameCurrency ? null : (value - prior) / Math.abs(prior),
        };
      }),
    });
  }

  return {
    type: kind,
    name: dict.STATEMENT_LABEL[kind],
    standard: dict.standardOf('HK'),
    unit_label: `默认单位：${currencies[0] || '原币'}·亿元（每股数为原币/股）`,
    currency: currencies.length === 1 ? currencies[0] : null,
    currency_mixed: currencies.length > 1,
    analysis_version: version,
    report_ids: rows.map(row => row.report_id),
    periods,
    fields,
    status: periods.length ? contract.FIELD_STATUS.AVAILABLE : contract.FIELD_STATUS.MISSING,
  };
}

module.exports = { getHkStockStatements, versionOf, FORMULA_VERSION };
