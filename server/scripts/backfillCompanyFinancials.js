#!/usr/bin/env node
// 公司财务历史回填：默认只预览；真正写入必须显式传入 --apply。
// 该脚本不注册进日常调度，按批次执行并复用统一 Tushare 调用保护。
require('dotenv').config();

const { pool, runMigrations } = require('../db');
const { listTargetCompanies, runCompanyFinancialBackfill } = require('../services/companyFinancialIncrementalSync');

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);

function valueOf(flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function parsePeriods() {
  const value = valueOf('--report-periods');
  if (!value) return ['20260331', '20260630'];
  return value.split(',').map(item => item.trim()).filter(item => /^\d{8}$/.test(item));
}

async function main() {
  const apply = has('--apply');
  const confirmProduction = has('--confirm-production');
  const limit = Math.max(1, Number(valueOf('--limit', '20')) || 20);
  const reportPeriods = parsePeriods();
  const asOfDate = valueOf('--as-of') || null;
  const targetScope = valueOf('--scope', 'bond_underlyings');
  const offset = Math.max(0, Number(valueOf('--offset', '0')) || 0);
  const preferVip = has('--prefer-vip');
  const maxCalls = Math.max(1, Number(valueOf('--max-calls', process.env.FINANCIAL_BACKFILL_MAX_CALLS || '80')) || 80);

  if (apply && process.env.NODE_ENV === 'production' && !confirmProduction) {
    throw new Error('生产回填必须同时传入 --confirm-production');
  }

  await runMigrations();
  const allTargets = await listTargetCompanies();
  const targets = targetScope === 'bond_underlyings'
    ? allTargets.filter(target => (target.reasons || []).includes('convertible_bond'))
    : allTargets;
  const preview = {
    mode: apply ? 'apply' : 'dry-run',
    targetCount: targets.length,
    offset,
    selectedCount: Math.max(0, Math.min(limit, targets.length - offset)),
    targetScope,
    reportPeriods,
    maxCalls,
    sample: targets.slice(offset, offset + Math.min(limit, 10)).map(target => ({ tsCode: target.tsCode, companyId: target.companyId, reasons: target.reasons })),
  };
  if (!apply) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE = '1';
  process.env.JOB_EXTERNAL_CALL_LIMIT = String(maxCalls);
  const result = await runCompanyFinancialBackfill({ companyLimit: limit, offset, reportPeriods, asOfDate, preferVip, targetScope });
  console.log(JSON.stringify({ ...preview, result }, null, 2));
  if (!result.ok) process.exitCode = 2;
}

main().catch(error => {
  console.error(`公司财务历史回填失败：${error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
