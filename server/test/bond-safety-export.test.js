const assert = require('assert');
const ExcelJS = require('exceljs');
const { filterAndSortRows, buildBondSafetyWorkbook } = require('../services/bondSafetyExport');

(async () => {
  const source = [
    { bond_code:'2', bond_name:'乙债', stock_name:'乙股', pe_ttm:'亏损', pb:2, dividend_yield:0, bond_price:110.126, change_pct:-0.5, double_low:130.1, convert_premium:20, convert_price:10, convert_value:90, indicator_interest:4.5, indicator_liquidity:0.8, indicator_leverage:2, safety:'高风险' },
    { bond_code:'1', bond_name:'甲债', stock_name:'甲股', pe_ttm:12.3, pb:1.2, dividend_yield:1.5, bond_price:100.126, change_pct:1.2, double_low:115.2, convert_premium:15, convert_price:8, convert_value:95, indicator_interest:8.125, indicator_liquidity:1.25, indicator_leverage:1.1, safety:'安全' },
  ];
  const filtered = filterAndSortRows(source, { search:'甲', rating:'安全', sort:'bond_price', dir:'desc' });
  assert.strictEqual(filtered.length, 1);
  const workbook = await buildBondSafetyWorkbook(filtered);
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  const sheet = loaded.getWorksheet('可转债安全性');
  assert.strictEqual(sheet.rowCount, 2);
  assert.strictEqual(sheet.getCell('A2').value, '1');
  assert.strictEqual(sheet.getCell('F2').value, 0.015);
  assert.strictEqual(sheet.getCell('F2').numFmt, '0.00%');
  assert.strictEqual(sheet.getCell('G2').numFmt, '0.00');
  assert.strictEqual(sheet.getCell('H2').font.color.argb, 'FFD93025');
  assert.strictEqual(sheet.getCell('M2').value, 8.125);
  assert.strictEqual(sheet.getCell('M2').numFmt, '0.00');
  assert.strictEqual(sheet.getCell('P2').fill.fgColor.argb, 'FF00B050');
  console.log('PASS=9 FAIL=0');
})().catch(error => { console.error(error); process.exit(1); });
