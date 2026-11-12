// 港股财务三表：按 HKFRS 官方科目字典读取迁移 186 的宽表，不压缩回 20 项标准事实。
// 每列带实际期末、报告类型、公告日、币种与报告版本；请求可携带 analysis_version 只读对应报告组。
'use strict';

const dict = require('../dataAccess/lixingerReportMetrics');
const contract = require('../domain/securityAnalysisContract');
const statementService = require('./stockStatementService');

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

function versionConflict(requestedVersion, version) {
  return contract.versionConflict(requestedVersion, version);
}

// 兼容旧静态边界的仓储函数签名；现役读取统一走 stockStatementService → stockStatementsRepository。
async function listHkStatementRows(tsCode, type, table, columns, limit) {
  return require('../repositories/hkSecurityAnalysisRepository').listHkStatementRows(tsCode, type, table, columns, limit);
}

/**
 * @returns {{type,name,unit_label,currency,analysis_version,periods,fields,status}}
 * @throws {{status:number,error:string}} 版本冲突时 409
 */
async function getHkStockStatements(tsCode, type = 'balance', limit = 8, requestedVersion = null, options = {}) {
  const kind = normalizeType(type);
  if (!kind) throw new Error('三表类型无效');
  try {
    return await statementService.getStockStatements({
      tsCode, market: 'HK', type: kind,
      limit: Math.max(MIN_PERIODS, Math.min(MAX_PERIODS, Number(limit) || 8)),
      requestedVersion, formulaVersion: FORMULA_VERSION, ...options,
    });
  } catch (error) {
    // 保持港股旧入口的 409 语义；统一服务已经完成同一校验，这里只保留边界兼容。
    const version = error.conflict && error.conflict.actual;
    const conflict = versionConflict(requestedVersion, version);
    if (conflict) error.status = 409;
    throw error;
  }
}

async function getHkStockStatementVersions(tsCode) {
  return statementService.getStockStatementVersions({
    tsCode, market: 'HK', formulaVersion: FORMULA_VERSION,
  });
}

module.exports = { getHkStockStatements, getHkStockStatementVersions, versionOf, FORMULA_VERSION };
