// 上市可转债 Excel 导出：只校验并序列化 Presenter 点击时提交的当前展示行。
// 不查库、不重算、不访问外部、不写数据库；列/格式定义与列表 View 共用一份。
const ExcelJS = require('exceljs');
const {
  COLUMNS, TEXT_COLUMNS, PERCENT_COLUMNS,
} = require('../../public/shared/bond-list-contract');

const COLUMN_KEYS = COLUMNS.map(([key]) => key);
const COLUMN_KEY_SET = new Set(COLUMN_KEYS);
const TEXT_KEY_SET = new Set(TEXT_COLUMNS);
const DATE_KEY_SET = new Set(['maturity_date']);
const PERCENT_KEY_SET = new Set(PERCENT_COLUMNS);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function cellValue(row, key) {
  if (key === 'bond_code') return String(row.bond_code == null ? '' : row.bond_code);
  if (key === 'maturity_date') return row.maturity_date ? String(row.maturity_date).slice(0, 10) : '';
  if (key === 'safety') return row.safety ? String(row.safety) : '未评级';
  if (TEXT_KEY_SET.has(key)) return row[key] == null ? '' : String(row[key]);
  return numberOrNull(row[key]);
}

function columnLetter(index) {
  let value = index;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function invalid(message) {
  return { ok: false, error: message };
}

// 只接受 Presenter 提交的 { tradeDate?, rows }；每行必须恰好包含 30 个白名单列和标量类型。
function validateBondListExportPayload(body) {
  if (!isPlainObject(body)) return invalid('导出请求体必须为对象');
  const topKeys = Object.keys(body);
  if (topKeys.some(key => key !== 'tradeDate' && key !== 'rows')) return invalid('导出请求包含不支持的字段');
  let tradeDate = null;
  if (body.tradeDate !== undefined && body.tradeDate !== null) {
    if (!isValidIsoDate(body.tradeDate)) return invalid('交易日格式应为 YYYY-MM-DD');
    tradeDate = body.tradeDate;
  }
  if (!Array.isArray(body.rows)) return invalid('rows 必须为数组');
  if (body.rows.length > 1000) return invalid('导出行数不能超过 1000');
  for (const row of body.rows) {
    if (!isPlainObject(row)) return invalid('rows 只能包含普通对象');
    const keys = Object.keys(row);
    if (keys.length !== COLUMN_KEYS.length) return invalid('每行必须且只能包含列表 30 列');
    if (keys.some(key => !COLUMN_KEY_SET.has(key))) return invalid('导出行包含不支持的列');
    for (const key of COLUMN_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) return invalid('导出行缺少列表列：' + key);
      const value = row[key];
      if (DATE_KEY_SET.has(key)) {
        if (value !== null && value !== '' && !isValidIsoDate(value)) return invalid('到期日格式应为 YYYY-MM-DD');
      } else if (TEXT_KEY_SET.has(key)) {
        if (value !== null && typeof value !== 'string') return invalid(key + ' 必须为文本或空');
      } else if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        return invalid(key + ' 必须为数值或空');
      }
    }
  }
  return { ok: true, tradeDate, rows: body.rows };
}

async function buildBondListWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '存在小站';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('上市可转债', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS.map(([key, header]) => ({
    header,
    key,
    width: key === 'bond_name' || key === 'stock_name' ? 18 : key === 'bond_code' ? 12 : 14,
  }));
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(COLUMNS.length)}1` };
  sheet.getRow(1).height = 24;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF555555' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFBFC' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFF0F0F0' } } };
  });

  (rows || []).forEach((source, rowIndex) => {
    const row = sheet.addRow(COLUMN_KEYS.reduce((values, key) => {
      values[key] = cellValue(source || {}, key);
      return values;
    }, {}));
    row.height = 21;
    COLUMN_KEYS.forEach((key, index) => {
      const cell = row.getCell(index + 1);
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFEEF1F5' } } };
      if (PERCENT_KEY_SET.has(key)) cell.numFmt = '0.00%';
      else if (TEXT_KEY_SET.has(key)) cell.numFmt = '@';
      else cell.numFmt = '0.00';
      if (rowIndex % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBFCFE' } };
    });
  });
  return workbook;
}

module.exports = {
  COLUMNS, TEXT_COLUMNS, PERCENT_COLUMNS,
  validateBondListExportPayload, buildBondListWorkbook,
};
