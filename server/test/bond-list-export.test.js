// 上市可转债导出：点击时冻结的本地筛选排序行、POST 白名单校验、真实 Express 路由、工作簿类型/空值/日期。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const ExcelJS = require('exceljs');
const { COLUMNS, TEXT_COLUMNS, PERCENT_COLUMNS } = require('../../public/shared/bond-list-contract');
const { validateBondListExportPayload, buildBondListWorkbook } = require('../services/bondListExport');
const { csrfMiddleware } = require('../middleware/security');
const router = require('../routes/bondAnalysis');

const ROOT = path.join(__dirname, '..', '..');
const queue = [];
function check(name, fn) { queue.push([name, fn]); }
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), 'utf8'); }

function baseRow(overrides = {}) {
  const row = {};
  COLUMNS.forEach(([key]) => { row[key] = null; });
  Object.assign(row, {
    bond_code: '110001', bond_name: '甲转债', stock_name: '甲科技', rating: 'AAA', safety: '安全',
    maturity_date: '2029-11-20', price: 100.2, change_pct: 0.008, stock_price: 12.3, stock_change_pct: 0.01,
    stock_pb: 2.2, convert_price: 11, conversion_value: 111.8, conversion_premium: -0.1037, bond_value: 96.1,
    bond_floor_premium: 0.0427, theoretical_value: 101.5, theoretical_deviation: -0.0128, stock_volatility: 0.24,
    call_trigger_price: 14.3, bond_market_cap_ratio: 0.05, asset_liability_ratio: 0.41, fund_holding_ratio: 0.038,
    remaining_years: 3, remain_size: 12.5, amount: 8800, turnover_rate: 0.012, maturity_yield_pre_tax: 0.021, double_low: 89.83,
  }, overrides);
  return row;
}

const ROW_A = baseRow();
const ROW_B = baseRow({
  bond_code: '123001', bond_name: '乙转债', stock_name: '乙股份', rating: 'AA-', safety: '中风险',
  maturity_date: '2027-05-01', price: 120.5, change_pct: -0.012, stock_price: 9.8, stock_change_pct: -0.02,
  stock_pb: 1.1, convert_price: 10, conversion_value: 98, conversion_premium: 0.2296, bond_value: 95.2,
  bond_floor_premium: 0.2658, theoretical_value: 118.2, theoretical_deviation: 0.0195, stock_volatility: 0.31,
  call_trigger_price: 13, bond_market_cap_ratio: 0.08, asset_liability_ratio: 0.62, fund_holding_ratio: 0.021,
  remaining_years: 0.44, remain_size: 3.21, amount: 5200.5, turnover_rate: 0.034, maturity_yield_pre_tax: -0.15, double_low: 143.46,
});
const ROW_MISSING = baseRow({
  bond_code: '113001', bond_name: '丙转债', stock_name: '丙实业', rating: null, safety: '未评级',
  maturity_date: null, price: null, change_pct: null, stock_price: null, stock_change_pct: null,
  stock_pb: null, convert_price: null, conversion_value: null, conversion_premium: null, bond_value: null,
  bond_floor_premium: null, theoretical_value: null, theoretical_deviation: null, stock_volatility: null,
  call_trigger_price: null, bond_market_cap_ratio: null, asset_liability_ratio: null, fund_holding_ratio: null,
  remaining_years: null, remain_size: null, amount: null, turnover_rate: null, maturity_yield_pre_tax: null, double_low: null,
});

check('导出请求体只接受 { tradeDate?, rows } 与 30 列白名单标量', () => {
  const valid = validateBondListExportPayload({ tradeDate: '2026-11-20', rows: [ROW_A] });
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.tradeDate, '2026-11-20');
  assert.strictEqual(validateBondListExportPayload({ rows: [] }).ok, true);
  assert.strictEqual(validateBondListExportPayload({ tradeDate: null, rows: [ROW_MISSING] }).ok, true);

  assert.strictEqual(validateBondListExportPayload(null).ok, false);
  assert.strictEqual(validateBondListExportPayload({ rows: [], extra: 1 }).ok, false);
  assert.strictEqual(validateBondListExportPayload({ rows: {} }).ok, false);
  assert.strictEqual(validateBondListExportPayload({ tradeDate: '2026/11/20', rows: [] }).ok, false);
  assert.strictEqual(validateBondListExportPayload({ rows: [ROW_A, { ...ROW_A, extra: 1 }] }).ok, false);
  assert.strictEqual(validateBondListExportPayload({ rows: [{ ...ROW_A, price: '100' }] }).ok, false);
  const missingKey = { ...ROW_A };
  delete missingKey.double_low;
  assert.strictEqual(validateBondListExportPayload({ rows: [missingKey] }).ok, false);
  assert.strictEqual(validateBondListExportPayload({ rows: [{ ...ROW_A, maturity_date: '2026-02-31' }] }).ok, false);
  assert.strictEqual(validateBondListExportPayload({ rows: Array.from({ length: 1001 }, () => ROW_A) }).ok, false);
});

check('工作簿表头与列表列一致，文本/数值/百分比/日期/缺失类型正确', async () => {
  const payload = validateBondListExportPayload({ rows: [ROW_B, ROW_A, ROW_MISSING] });
  assert.strictEqual(payload.ok, true);
  const workbook = await buildBondListWorkbook(payload.rows);
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  const sheet = loaded.getWorksheet('上市可转债');
  assert.strictEqual(sheet.rowCount, 4);
  assert.deepStrictEqual(sheet.getRow(1).values.slice(1), COLUMNS.map(column => column[1]));
  assert.strictEqual(sheet.getCell('A2').value, '123001');
  assert.strictEqual(sheet.getCell('A2').numFmt, '@');
  assert.strictEqual(sheet.getCell('B2').value, '乙转债');
  assert.strictEqual(sheet.getCell('C2').value, 120.5);
  assert.strictEqual(sheet.getCell('C2').numFmt, '0.00');
  assert.strictEqual(sheet.getCell('D2').value, -0.012);
  assert.strictEqual(sheet.getCell('D2').numFmt, '0.00%');
  assert.strictEqual(sheet.getCell('N2').value, 'AA-');
  assert.strictEqual(sheet.getCell('O2').value, '中风险');
  assert.strictEqual(sheet.getCell('P2').value, null, '缺失数值必须留空');
  assert.strictEqual(sheet.getCell('X2').value, '2027-05-01', '日期必须按文本保留原日期');
  assert.strictEqual(sheet.getCell('X2').numFmt, '@');
  assert.strictEqual(sheet.getCell('AD2').value, 143.46);
  assert.strictEqual(sheet.getCell('N4').value, '', '缺失文本必须留空');
  assert.strictEqual(sheet.getCell('O4').value, '未评级');
});

check('空结果仍生成只有表头的工作簿', async () => {
  const workbook = await buildBondListWorkbook([]);
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  const sheet = loaded.getWorksheet('上市可转债');
  assert.strictEqual(sheet.rowCount, 1);
  assert.strictEqual(sheet.getCell('A1').value, '代码');
  assert.strictEqual(sheet.getCell('AD1').value, '双低');
});

check('Presenter 渲染后的本地筛选排序行与 Excel 顺序/数值一致，只发送 30 列', async () => {
  let searchValue = '甲';
  let statusValue = 'complete';
  const context = {
    console,
    window: {},
    document: { getElementById: id => id === 'bond-list-search' ? { value: searchValue } : id === 'bond-list-status' ? { value: statusValue } : null },
    escapeHtml: value => String(value),
    bondLifecycleMark: () => '',
    showToast: () => {},
  };
  context.window.BondListContract = { COLUMNS, TEXT_COLUMNS, PERCENT_COLUMNS };
  let captured = null;
  const downloaded = [];
  context.window.siteApi = {
    jsonHeaders: () => ({ 'Content-Type': 'application/json' }),
    requestRaw: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, response: { blob: async () => ({ type: 'xlsx' }) } };
    },
  };
  vm.createContext(context);
  vm.runInContext(read('public/js/bond-list.js'), context);
  vm.runInContext(read('public/js/presenters/bond-list-presenter.js'), context);
  context.bondListRender = () => {};
  context.bondListDownload = (blob, tradeDate) => downloaded.push([blob, tradeDate]);
  context.bondListState.rows = [
    { ...ROW_A, data_status: 'complete' },
    { ...ROW_B, data_status: 'partial' },
    { ...ROW_MISSING, data_status: 'partial' },
  ];
  context.bondListState.tradeDate = '2026-11-20';
  context.bondListState.sortKey = 'price';
  context.bondListState.sortDir = -1;

  context.bondListApplyFilters();
  assert.deepStrictEqual(context.bondListState.filtered.map(row => row.bond_code), ['110001'], '搜索/状态筛选必须由 View 完成');

  searchValue = '';
  statusValue = '';
  context.bondListApplyFilters();
  assert.deepStrictEqual(context.bondListState.filtered.map(row => row.bond_code), ['123001', '110001', '113001'], '排序必须由 View 完成且缺失值最后');

  await context.exportBondList();
  assert.strictEqual(captured.url, '/api/bond-analysis/bonds/export');
  assert.strictEqual(captured.options.method, 'POST');
  assert.deepStrictEqual(Object.keys(captured.body).sort(), ['rows', 'tradeDate']);
  assert.strictEqual(captured.body.tradeDate, '2026-11-20');
  assert.deepStrictEqual(captured.body.rows.map(row => row.bond_code), ['123001', '110001', '113001']);
  assert.deepStrictEqual(captured.body.rows.map(row => row.price), [120.5, 100.2, null]);
  captured.body.rows.forEach(row => {
    assert.strictEqual(Object.keys(row).length, 30);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'stock_code'), false, '不得发送内部正股代码');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'data_status'), false, '不得发送数据状态');
  });
  assert.deepStrictEqual(downloaded, [[{ type: 'xlsx' }, '2026-11-20']]);

  const workbook = await buildBondListWorkbook(captured.body.rows);
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  const sheet = loaded.getWorksheet('上市可转债');
  assert.deepStrictEqual([2, 3, 4].map(row => sheet.getCell(`A${row}`).value), ['123001', '110001', '113001']);
  assert.deepStrictEqual([2, 3, 4].map(row => sheet.getCell(`C${row}`).value), [120.5, 100.2, null]);
});

check('真实 Express 路由：游客同源 POST 返回 XLSX，空结果表头，非法结构 4xx', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(csrfMiddleware);
  app.use('/api/bond-analysis', router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/bond-analysis/bonds/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `${base}/?main=bond-safety`, ...headers },
    body: JSON.stringify(body),
  });
  try {
    const response = await post({ tradeDate: '2026-11-20', rows: [ROW_B, ROW_A] });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert(response.headers.get('content-disposition').includes('2026-11-20'));
    const buffer = Buffer.from(await response.arrayBuffer());
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(buffer);
    const sheet = loaded.getWorksheet('上市可转债');
    assert.strictEqual(sheet.rowCount, 3);
    assert.deepStrictEqual([2, 3].map(row => sheet.getCell(`A${row}`).value), ['123001', '110001']);

    const empty = await post({ tradeDate: '2026-11-20', rows: [] });
    assert.strictEqual(empty.status, 200);
    const emptyBook = new ExcelJS.Workbook();
    await emptyBook.xlsx.load(Buffer.from(await empty.arrayBuffer()));
    assert.strictEqual(emptyBook.getWorksheet('上市可转债').rowCount, 1);

    const extra = await post({ rows: [{ ...ROW_A, extra: 1 }] });
    assert.strictEqual(extra.status, 400);
    assert.strictEqual((await extra.json()).error.includes('30 列'), true);

    const wrongType = await post({ rows: [{ ...ROW_A, price: '100' }] });
    assert.strictEqual(wrongType.status, 400);
    const tooMany = await post({ rows: Array.from({ length: 1001 }, () => ROW_A) });
    assert.strictEqual(tooMany.status, 400);

    const crossOrigin = await post({ rows: [] }, { Origin: 'https://evil.example', Referer: 'https://evil.example/' });
    assert.strictEqual(crossOrigin.status, 403, '全局来源校验必须继续拒绝跨站 POST');

    const oversize = await post({ rows: Array.from({ length: 1000 }, () => ({ ...ROW_A, bond_name: 'x'.repeat(2000) })) });
    assert.strictEqual(oversize.status, 413, '全局 JSON 请求体大小限制必须继续生效');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

check('网络错误时提示并恢复按钮，不下载也不在异步后读取状态', async () => {
  const events = [];
  const context = {
    console,
    window: {
      CoreDate: { todayInZone: () => '2026-11-22' },
      siteApi: {
        jsonHeaders: () => ({}),
        requestRaw: async () => ({ ok: false, response: null, error: '请求超时，请稍后重试' }),
      },
    },
    bondListState: { filtered: [], tradeDate: '2026-11-20', exportSeq: 0 },
    bondListExportRow: row => row,
    bondListSetExportButton: (busy, text) => events.push(['button', busy, text]),
    bondListDownload: () => events.push(['download']),
    showToast: message => events.push(['toast', message]),
  };
  vm.createContext(context);
  vm.runInContext(read('public/js/presenters/bond-list-presenter.js'), context);
  await context.exportBondList();
  assert.deepStrictEqual(events, [
    ['button', true, '导出中...'],
    ['toast', '请求超时，请稍后重试'],
    ['button', false, '导出 Excel'],
  ]);
});

check('导出实现只序列化本地行，不新增 GET 分支、不回查/重算/外部/写库', () => {
  const route = read('server/routes/bondAnalysis.js');
  const service = read('server/services/bondListExport.js');
  const shared = read('public/shared/bond-list-contract.js');
  const presenter = read('public/js/presenters/bond-list-presenter.js');
  const view = read('public/js/bond-list.js');
  const html = read('public/index.html');
  const app = read('server/app.js');
  const start = route.indexOf("router.post('/bonds/export'");
  const end = route.indexOf("router.get('/bonds'", start);
  assert(start >= 0 && end > start, '缺少 POST 导出路由');
  const block = route.slice(start, end);
  assert(!route.includes("router.get('/bonds/export'"), '不得保留公开 GET 导出分支');
  assert(!block.includes('getBondList') && !block.includes('refreshQuotes'), '导出路由不得回查列表或触发行情');
  assert(!block.includes('filterAndSort') && !block.includes('calculate'), '导出路由不得重算筛选/指标');
  assert(block.includes('validateBondListExportPayload') && block.includes('buildBondListWorkbook'));
  assert(service.includes('不查库、不重算、不访问外部、不写数据库'));
  assert(service.includes('body.rows.length > 1000') && service.includes('isPlainObject'));
  assert(!shared.includes('filterAndSort'), '共享契约只保留列/格式定义，不再提供跨端筛选器');
  assert(presenter.includes("window.siteApi.requestRaw('/api/bond-analysis/bonds/export'")
    && presenter.includes("method: 'POST'") && presenter.includes('JSON.stringify(payload)'), 'Presenter 必须用 requestRaw POST 当前行');
  assert(presenter.includes('var rows = bondListState.filtered.map(bondListExportRow)'), '必须发送点击时已筛选排序的行');
  assert(presenter.includes('var filenameDate = tradeDate || fallbackDate') && presenter.includes('bondListDownload(blob, filenameDate)'), '文件名日期必须在点击时冻结');
  assert(presenter.indexOf('var filenameDate') < presenter.indexOf('await window.siteApi.requestRaw'), '文件名日期必须先于异步请求捕获');
  const downloadFn = view.slice(view.indexOf('function bondListDownload'), view.indexOf('function bondListStartAutoRefresh'));
  assert(!downloadFn.includes('bondListState'), '下载函数不得在异步后读取当前状态');
  assert(view.includes('function bondListExportRow') && view.includes('BOND_LIST_COLUMNS.forEach'));
  assert(html.includes('id="bond-list-export"') && html.includes('data-act="exportBondList"'));
  const toolbarAt = html.indexOf('class="bond-list-toolbar"');
  assert(toolbarAt >= 0 && html.slice(toolbarAt, html.indexOf('</div>', toolbarAt)).includes('bond-list-export'), '导出按钮必须位于列表工具栏内');
  assert(/\.bond-list-toolbar\s*\{[^}]*flex-wrap:wrap/.test(read('public/css/bond-safety.css')), '移动工具栏必须允许换行');
  assert(app.includes('csrfMiddleware') && app.includes("express.json({ limit: '1mb'"), '全局来源校验与请求体大小限制必须保留');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of queue) {
    try {
      await fn();
      pass += 1;
      console.log('ok - ' + name);
    } catch (error) {
      fail += 1;
      console.error('not ok - ' + name + ' :: ' + error.message);
    }
  }
  console.log('bond-list-export: ' + pass + ' 项通过，' + fail + ' 项失败');
  if (fail) process.exit(1);
})();
