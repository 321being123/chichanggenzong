const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const file = path.resolve(__dirname, '../services/stockAnalysis.js');
const originalRequire = require('module').createRequire(file);
let state = [], calls = [], saved = [], writes = 0, primaryFailure = false, partial = false, secondaryFailure = false;
const event = { is_official: true, event_date: '20261014', title: '关于回购股份减少注册资本通知债权人的公告', url: 'https://www.sse.com.cn/example.pdf' };
const context = { module: { exports: {} }, console: { warn() {} }, process, Date, URLSearchParams,
  require: name => name === '../db/connection' ? { pool: { query: async sql => {
    if (sql.startsWith('SELECT')) return { rows: state };
    writes++; return { rows: [] };
  } } } : originalRequire(name),
  exchange: async () => { calls.push('exchange'); if (primaryFailure) throw new Error('主源失败'); return { complete: !partial, events: [event] }; },
  cninfo: async () => { calls.push('cninfo'); if (secondaryFailure) throw new Error('备源失败'); return { complete: true, events: [event] }; },
  save: async (code, events) => saved.push({ code, events }),
  response: {},
};
vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nfetchSseEvents = exchange; fetchSzseEvents = exchange; fetchCninfoEvents = cninfo; saveEvents = save; requestJson = async () => response;', context);
const service = context.module.exports;
(async () => {
  await service.refreshEvents('600763.SH', '20261020');
  assert.deepStrictEqual(calls, ['exchange'], '交易所完整成功不调用巨潮');
  assert.strictEqual(saved[0].events[0].title, event.title);
  assert.strictEqual(writes, 1);
  calls = [];
  await service.refreshEvents('000001.SZ', '20261020');
  assert.deepStrictEqual(calls, ['exchange'], '深交所完整成功同样不调用巨潮');
  calls = []; saved = []; writes = 0; primaryFailure = true;
  await service.refreshEvents('600763.SH', '20261020');
  assert.deepStrictEqual(calls, ['exchange', 'cninfo'], '主源失败才使用巨潮');
  primaryFailure = false; partial = true; calls = [];
  await service.refreshEvents('600763.SH', '20261020');
  assert.deepStrictEqual(calls, ['exchange', 'cninfo'], '分页未完成也必须进入备源');
  saved = []; writes = 0; secondaryFailure = true;
  await assert.rejects(service.refreshEvents('600763.SH', '20261020'), /备源失败/);
  assert.strictEqual(saved.length, 0, '采集失败保留旧公告');
  assert.strictEqual(writes, 0, '采集失败不推进成功水位');
  state = [{ last_success_date: '20261020', last_error: '' }]; calls = [];
  await service.refreshEvents('600763.SH', '20261020');
  assert.strictEqual(calls.length, 0, '同日成功复用已入库公告');
  await assert.rejects(service.fetchSseEvents('600763.SH', '20251020', '20261020', '', { structured: true }), /响应格式异常/);
  const frontend = fs.readFileSync(path.resolve(__dirname, '../../public/js/stock-analysis.js'), 'utf8');
  const el = {};
  const ui = { document: { getElementById: () => el } };
  vm.runInNewContext(frontend.split('\n').find(line => line.startsWith('function stockAnalysisRenderEvents(')), ui);
  ui.stockAnalysisRenderEvents([]);
  assert(el.innerHTML.includes('不代表公司没有发布公告'));
  assert(!el.innerHTML.includes('最近一年暂无公司公告'));
  console.log('stock announcement refresh: source order, completeness, retention, cache and honest empty state passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
