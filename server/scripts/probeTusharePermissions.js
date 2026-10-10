#!/usr/bin/env node
// 6,000 积分 Tushare 权限探测：逐 Token、逐接口登记实测结果。
// 探测本身经过 externalCallGuard，默认只在人工低峰期运行，不由定时任务调用。
const { testProviderAvailability } = require('../services/externalApiConfig');

const STANDARD_PROBES = [
  'trade_cal', 'stock_basic', 'daily', 'daily_basic', 'adj_factor',
  'income', 'income_vip', 'balancesheet', 'balancesheet_vip',
  'cashflow', 'cashflow_vip', 'fina_indicator', 'fina_indicator_vip', 'forecast',
  'dividend', 'cb_basic', 'cb_daily', 'cb_issue', 'cb_price_chg',
  'index_daily', 'index_member_all', 'new_share', 'top10_cb_holders', 'pledge_stat',
];

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  if(option('probe')==='repo-daily') {
    const {syncRepoDailyRates,tradingDates}=require('../services/repoDailyRates');
    const {shiftDay}=require('../services/cashIncome');
    const targetDate=option('target-date'),count=Number(option('trading-days','30'));
    if(option('code','204001.SH')!=='204001.SH'||!Number.isInteger(count)||count<30) throw new Error('准入要求GC001至少30个已完成交易日');
    let startDate=targetDate;
    while(tradingDates(startDate,targetDate).length<count) startDate=shiftDay(startDate,-1);
    const result=await syncRepoDailyRates({targetDate,startDate,probe:true});
    const officialFile=option('official-evidence');
    if(officialFile||process.argv.includes('--official-probe')){
      const admission=require('../services/repoSourceAdmission'),{pool}=require('../db/connection');
      const officialSamples=officialFile?JSON.parse(require('fs').readFileSync(officialFile,'utf8')):[await admission.probeOfficial(targetDate,pool.query.bind(pool))];
      result.sourceAdmission=await admission.record(admission.assess({rows:result.samples,expectedDates:tradingDates(startDate,targetDate),targetDate,officialSamples,fetchedAt:new Date().toISOString(),permissionVerified:result.ok}),pool.query.bind(pool));
      if(result.sourceAdmission.status!=='admitted')process.exitCode=1;
    }
    console.log(JSON.stringify(result,null,2));
    if(!result.ok) process.exitCode=1;
    return;
  }
  const apis = (option('apis', STANDARD_PROBES.join(',')) || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const roles = (option('roles', 'primary,backup') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(value => ['primary', 'backup'].includes(value));
  const results = [];
  for (const role of roles) {
    for (const api of apis) {
      // 每次调用间隔由 Guard/数据库预算控制；这里不并发，避免探测本身造成限流。
      results.push(await testProviderAvailability('tushare', role, api));
    }
  }
  const summary = {
    account_tier: '6000_points',
    note: '仅记录实测权限，不推断积分；_vip 接口按报告期最小请求探测，未通过探测前不得进入自动任务。',
    checked_count: results.length,
    available: results.filter(row => row.ok).length,
    unavailable: results.filter(row => !row.ok).length,
    results,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Tushare 权限探测完成：${summary.available}/${summary.checked_count} 可用，结果已写入后台外部 API 配置。`);
    for (const row of results) console.log(`- ${row.role}/${row.api_name}: ${row.status}${row.message ? `（${row.message}）` : ''}`);
  }
}

main().catch(error => {
  console.error(`Tushare 权限探测失败：${error.message}`);
  process.exitCode = 1;
}).finally(()=>require('../db/connection').pool.end());
