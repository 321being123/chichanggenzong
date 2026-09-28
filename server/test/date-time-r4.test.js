const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const excelDateScript = String.raw`
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const ExcelJS = require('exceljs');
const { safeParseExcel } = require('./server/services/excelSafe');
const { normalizeDateCell } = require('./server/routes/import');
const coreEarnings = fs.readFileSync('./public/shared/core-earnings.js', 'utf8');
const normalizeEarningsDate = vm.runInNewContext(coreEarnings + '\nnormalizeDate', { Date, window: {}, document: {} });
(async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('样本');
  sheet.addRows([['日期'], [new Date(Date.UTC(2026, 8, 25))]]);
  sheet.getCell('A2').numFmt = 'yyyy-mm-dd';
  const parsed = await safeParseExcel((await workbook.xlsx.writeBuffer()).toString('base64'), { mode: 'first' });
  const cellText = parsed.rows[1][0];
  assert.strictEqual(normalizeDateCell(cellText), '2026-09-25');
  assert.strictEqual(normalizeEarningsDate(new Date(Date.UTC(2026, 8, 25))), '2026-09-25');
  process.stdout.write(JSON.stringify({ cellText, serverImportDate: normalizeDateCell(cellText), browserDate: normalizeEarningsDate(new Date(Date.UTC(2026, 8, 25))) }));
})().catch(error => { console.error(error); process.exit(1); });
`;

for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
  const result = spawnSync(process.execPath, ['-e', excelDateScript], {
    cwd: root,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(result.status, 0, `${tz} Excel 日期链路失败：${result.stderr || result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.serverImportDate, '2026-09-25', `${tz} 服务端导入日期偏移`);
  assert.strictEqual(output.browserDate, '2026-09-25', `${tz} 浏览器收益导入日期偏移`);
  console.log(`T11 ${tz}: ${output.serverImportDate} / ${output.browserDate}`);
}

const { parseQuoteTime } = require('../services/tencentQuote');
const { isoDateSafe } = require('../services/analysisFreshness');
const { buildEventKey } = require('../services/arbitrageRules');
const { isoDate: hkDailyIsoDate } = require('../services/hkDailyCoverage');

const tencentTime = parseQuoteTime('20260925001500');
assert.strictEqual(tencentTime, '2026-09-25T00:15:00+08:00');
assert.strictEqual(isoDateSafe(tencentTime), '2026-09-25');
assert.strictEqual(buildEventKey({ market: 'HK', strategyType: 'subscription', canonicalCode: '00001.HK', announcedAt: '2026-09-25' }), 'HK:subscription:00001.HK:2026-09-25');
assert.strictEqual(hkDailyIsoDate('2026-09-25'), '2026-09-25');
assert.strictEqual(hkDailyIsoDate('20260925'), '2026-09-25');
console.log('T12 真实调用输入：腾讯带 +08:00 的时刻、公告日期文本和港股来源日期文本均保持 2026-09-25');

const coreDateScript = String.raw`
const CoreDate = require('./public/shared/core-date.js');
process.stdout.write(CoreDate.todayInZone('Asia/Shanghai', '2026-09-27T16:30:00Z'));
`;
for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
  const result = spawnSync(process.execPath, ['-e', coreDateScript], {
    cwd: root,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(result.status, 0, `${tz} US/10 业务日计算失败：${result.stderr || result.stdout}`);
  assert.strictEqual(result.stdout, '2026-09-28', `${tz} US/10 日期上限未按北京时间计算`);
  console.log(`T13 US/10 ${tz}: ${result.stdout}`);
}
for (const file of ['server/routes/marketVolatility.js', 'server/scripts/importFederalFundsCsv.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /CoreDate\.todayInZone\('Asia\/Shanghai'\)/, `${file} 未使用上海日期作为导入上限`);
}
console.log('T13 US/10 两个手工导入入口均使用北京时间作为六日补齐的当前日期上限');
