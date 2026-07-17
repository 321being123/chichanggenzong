// ========== Excel 解析隔离(P0-6) 回归测试 ==========
// 运行：node server/test/excel.test.js
// 验证：正常 xlsx 能解析；非 xlsx(魔数错)被拒；声明解压体积巨大的压缩炸弹被拒；
// 解析在独立子进程完成（超时/异常不拖垮主进程由 excelSafe 保证，本测试覆盖解析结果正确性）。
const assert = require('assert');
const ExcelJS = require('exceljs');
const { safeParseExcel } = require('../services/excelSafe');

const results = [];
const promises = [];
function check(name, fn) {
  const p = Promise.resolve().then(fn).then(
    () => { results.push(['PASS', name]); console.log('  [PASS] ' + name); },
    e => { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
  );
  promises.push(p);
  return p;
}

console.log('A. 正常 xlsx 应解析出表头与数据行');
check('构造小表并解析', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRows([['code', 'name', 'price'], ['600000', '浦发银行', 10.5], ['000001', '平安银行', 12.3]]);
  const buf = await wb.xlsx.writeBuffer();
  const b64 = buf.toString('base64');
  const r = await safeParseExcel(b64, { mode: 'first' });
  assert.ok(Array.isArray(r.rows) && r.rows.length >= 2, '行数异常');
  assert.strictEqual(r.rows[0][0], 'code');
  assert.strictEqual(r.rows[1][0], '600000');
});

console.log('B. 非 xlsx（魔数错误）应被拒绝');
check('传入纯文本 base64', async () => {
  let threw = false;
  try { await safeParseExcel(Buffer.from('这是文本不是Excel').toString('base64'), { mode: 'first' }); }
  catch (e) { threw = true; assert.ok(/有效的 Excel/.test(e.message), '错误提示不符: ' + e.message); }
  assert.ok(threw, '非 xlsx 未被拒绝');
});

console.log('C. 压缩炸弹（声明解压体积巨大）应被拒绝');
check('伪造 ZIP 本地头声明 300MB 解压', async () => {
  const b = Buffer.alloc(40);
  b[0] = 0x50; b[1] = 0x4B; b[2] = 0x03; b[3] = 0x04; // PK\x03\x04
  b.writeUInt32LE(10, 18);                 // 偏移18 = 压缩后很小（典型的炸弹特征）
  b.writeUInt32LE(300 * 1024 * 1024, 22);  // 偏移22 = 解压后 300MB
  b.writeUInt16LE(0, 26); b.writeUInt16LE(0, 28);
  let threw = false;
  try { await safeParseExcel(b.toString('base64'), { mode: 'first' }); }
  catch (e) { threw = true; assert.ok(/体积过大|压缩炸弹/.test(e.message), '错误提示不符: ' + e.message); }
  assert.ok(threw, '压缩炸弹未被拒绝');
});

console.log('D. 超大输入应被直接拒绝（不启动子进程）');
check('传入 >64MB base64 被拒', async () => {
  const huge = 'A'.repeat(65 * 1024 * 1024);
  let threw = false;
  try { await safeParseExcel(huge, { mode: 'first' }); }
  catch (e) { threw = true; assert.ok(/过大/.test(e.message), '错误提示不符: ' + e.message); }
  assert.ok(threw, '超大输入未被拒绝');
});

Promise.all(promises).then(() => {
  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n========================================');
  console.log(`P0-6 Excel 隔离回归：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) { failed.forEach(f => console.log('  - ' + f[1])); process.exit(1); }
  console.log('全部通过 ✅');
});
