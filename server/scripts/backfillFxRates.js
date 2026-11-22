#!/usr/bin/env node
// 外币→人民币汇率回填 CLI。核心逻辑在 services/fxForeignRate，这里只做参数解析与输出。
//
// 用途：港股里用美元记账的公司（汇丰、友邦、渣打、中芯国际等），财报是外币、市值是港币，
// 「格雷厄姆低估」要把两者折算到同一币种才能相减。过去 market.fx_rates 只有 HKD→CNY，
// 这批公司只能判「缺汇率」跳过。本脚本从理杏仁官方补其余币种对。
//
// 只写 base_currency=外币、quote_currency='CNY' 的行：不动 HKD→CNY 现有数据，
// 不改账户估值与 accounts.hk_rate 兼容字段，幂等可重复执行。
//
// 用法：
//   node server/scripts/backfillFxRates.js                              预演（只读，不写库）
//   node server/scripts/backfillFxRates.js --apply                      按默认起点回填并补到最新
//   node server/scripts/backfillFxRates.js --apply --since=2019-01-01   指定起点
//   node server/scripts/backfillFxRates.js --apply --currencies=USD     只处理指定币种
'use strict';
const { pool } = require('../db/connection');
const CoreDate = require('../../public/shared/core-date.js');
const { syncForeignRates, DEFAULT_CURRENCIES } = require('../services/fxForeignRate');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const sinceArg = (argv.find(a => a.startsWith('--since=')) || '').split('=')[1] || null;
  const curArg = (argv.find(a => a.startsWith('--currencies=')) || '').split('=')[1] || '';
  const currencies = curArg
    ? curArg.split(',').map(c => c.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_CURRENCIES.slice();
  return { apply, since: CoreDate.normalizeBusinessDate(sinceArg) || '2019-01-01', currencies };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await syncForeignRates({ currencies: args.currencies, since: args.since, apply: args.apply });
  console.log(`模式：${report.apply ? '执行（写库）' : '预演（只读）'}  目标币种对：→ ${report.quoteCurrency}  数据源ID：${report.sourceId}`);
  for (const c of report.currencies) {
    const head = `${c.currency}→${report.quoteCurrency}`;
    if (c.error) {
      console.log(`  ${head}: ${c.error}`);
      continue;
    }
    const span = c.firstDate ? `${c.firstDate} ~ ${c.lastDate}` : '无数据';
    const latest = c.latest ? `，最新 ${c.latest.rateDate}=${c.latest.rate}` : '';
    console.log(`  ${head}: 接口 ${c.fetched} 条，采纳区间 ${span}${latest}，拒绝 ${c.rejected} 条`
      + (report.apply ? `，写入 ${c.written} 行` : ''));
  }
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('回填失败：', e && e.message ? e.message : e); process.exit(1); });
}

module.exports = { parseArgs };
