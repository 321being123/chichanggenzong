const ExcelJS = require('exceljs');

const COLUMNS = [
  { header: '债券代码', key: 'bond_code', width: 13 },
  { header: '债券名称', key: 'bond_name', width: 16 },
  { header: '正股名称', key: 'stock_name', width: 16 },
  { header: 'PE-TTM', key: 'pe_ttm', width: 14 },
  { header: 'PB', key: 'pb', width: 11 },
  { header: '股息率', key: 'dividend_yield', width: 12 },
  { header: '最新债券价格', key: 'bond_price', width: 16 },
  { header: '涨跌幅', key: 'change_pct', width: 12 },
  { header: '双低', key: 'double_low', width: 12 },
  { header: '转股溢价率', key: 'convert_premium', width: 15 },
  { header: '转股价', key: 'convert_price', width: 12 },
  { header: '转股价值', key: 'convert_value', width: 14 },
  { header: '利息保障≥7倍', key: 'indicator_interest', width: 17 },
  { header: '现金覆盖负债>=1', key: 'indicator_liquidity', width: 19 },
  { header: '负债/市值≤1.5', key: 'indicator_leverage', width: 17 },
  { header: '安全性', key: 'safety', width: 12 },
];

const SORT_KEYS = new Set(COLUMNS.map(column => column.key));

function filterAndSortRows(rows, query = {}) {
  const search = String(query.search || '').trim().toLowerCase();
  const rating = String(query.rating || '').trim();
  const key = SORT_KEYS.has(query.sort) ? query.sort : 'bond_price';
  const direction = query.dir === 'desc' ? -1 : 1;
  return (rows || []).filter(row => {
    const textMatch = !search || [row.bond_code, row.bond_name, row.stock_name]
      .some(value => String(value || '').toLowerCase().includes(search));
    return textMatch && (!rating || row.safety === rating);
  }).sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null || av === '') return (bv == null || bv === '') ? 0 : 1;
    if (bv == null || bv === '') return -1;
    const an = Number(av), bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * direction;
    return String(av).localeCompare(String(bv), 'zh-CN') * direction;
  });
}

function excelRow(row) {
  return {
    bond_code: String(row.bond_code || ''),
    bond_name: row.bond_name || '',
    stock_name: row.stock_name || '',
    pe_ttm: typeof row.pe_ttm === 'number' ? row.pe_ttm : (row.pe_ttm || ''),
    pb: row.pb,
    dividend_yield: row.dividend_yield == null ? null : Number(row.dividend_yield) / 100,
    bond_price: row.bond_price,
    change_pct: row.change_pct == null ? null : Number(row.change_pct) / 100,
    double_low: row.double_low,
    convert_premium: row.convert_premium == null ? null : Number(row.convert_premium) / 100,
    convert_price: row.convert_price,
    convert_value: row.convert_value,
    indicator_interest: row.indicator_interest == null ? '' : row.indicator_interest,
    indicator_liquidity: row.indicator_liquidity == null ? '' : row.indicator_liquidity,
    indicator_leverage: row.indicator_leverage == null ? '' : row.indicator_leverage,
    safety: row.safety || '',
  };
}

async function buildBondSafetyWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '存在小站';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('可转债安全性', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS;
  sheet.autoFilter = { from: 'A1', to: 'P1' };
  sheet.getRow(1).height = 24;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF555555' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFBFC' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFF0F0F0' } } };
  });

  rows.forEach((source, index) => {
    const row = sheet.addRow(excelRow(source));
    row.height = 21;
    row.eachCell(cell => {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFEEF1F5' } } };
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBFCFE' } };
    });
    [4, 5, 7, 9, 11, 12].forEach(column => { row.getCell(column).numFmt = '0.00'; });
    [6, 8, 10].forEach(column => { row.getCell(column).numFmt = '0.00%'; });
    [13, 14, 15].forEach(column => { row.getCell(column).numFmt = '0.00'; });
    const change = Number(source.change_pct);
    if (Number.isFinite(change) && change !== 0) {
      row.getCell(8).font = { bold: true, color: { argb: change > 0 ? 'FFD93025' : 'FF137333' } };
    }
    const indicatorColors = { '达标': ['FFE6F4EA','FF137333'], '不达标': ['FFFCE8E6','FFD93025'], '数据不足': ['FFF0F2F5','FF697386'], '行业豁免': ['FFE8EAF6','FF283593'] };
    [13, 14, 15].forEach(column => {
      const cell = row.getCell(column), colors = indicatorColors[cell.value];
      if (colors) {
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:colors[0] } };
        cell.font = { bold:true, color:{ argb:colors[1] } };
      }
    });
    const ratingColors = { '安全': 'FF00B050', '低风险': 'FF92D050', '中风险': 'FFFFFF00', '高风险': 'FFFFC000' };
    const ratingCell = row.getCell(16);
    if (ratingColors[source.safety]) {
      ratingCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ratingColors[source.safety] } };
      ratingCell.font = { bold: true, color: { argb: source.safety === '安全' ? 'FFFFFFFF' : 'FF102218' } };
      ratingCell.alignment = { vertical: 'middle', horizontal: 'center' };
    }
  });
  return workbook;
}

module.exports = { COLUMNS, filterAndSortRows, buildBondSafetyWorkbook };
