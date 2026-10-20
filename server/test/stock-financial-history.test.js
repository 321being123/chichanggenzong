const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fetchCompanyReports } = require('../services/companyFinancialIncrementalSync');
const response = (code, period = '20251231') => ({ fields: ['ts_code', 'ann_date', 'end_date', 'report_type'], items: [[code, '20260429', period, '1']] });
(async () => {
  const calls = [];
  const options = { historyFull: true, startDate: '20030306', asOfDate: '20261020', query: async (api, params) => {
    calls.push({ api, params }); return response('600370.SH', params.start_date.slice(0, 4) + '1231');
  } };
  const result = await fetchCompanyReports({ tsCode: '600370.SH', needs: ['income'] }, options);
  assert.strictEqual(calls.length, 5, '历史按五年窗口请求，不重拉每个季度');
  assert.strictEqual(calls[0].params.start_date, '20030101');
  assert.strictEqual(calls.at(-1).params.end_date, '20261020');
  assert(calls.every(call => call.params.report_type === '1'));
  assert.strictEqual(result.results.income.length, 5);
  let splitCalls = 0;
  const split = await fetchCompanyReports({ tsCode: '600370.SH', needs: ['balance'] }, {
    ...options, asOfDate: '20071231', query: async (api, params) => {
      splitCalls++;
      const data = response('600370.SH');
      if (params.start_date.slice(0, 4) !== params.end_date.slice(0, 4)) data.items = Array(100).fill(data.items[0]);
      return data;
    },
  });
  assert.strictEqual(splitCalls, 6, '疑似截断的长窗口改按年度核验');
  assert.strictEqual(split.results.balance.length, 5);
  let number = 0;
  const partial = await fetchCompanyReports({ tsCode: '600370.SH', needs: ['income'] }, {
    ...options, query: async () => { if (++number === 2) throw new Error('历史窗口失败'); return response('600370.SH'); },
  });
  assert.strictEqual(partial.results.income.length, 0, '中间窗口失败不能将部分历史登记完整');
  assert(partial.errors.income);

  const file = path.resolve(__dirname, '../services/stockAnalysis.js');
  const native = require('module').createRequire(file);
  let fresh = false, apiCalls = 0, saved = [], wrongStock = false;
  const context = { module: { exports: {} }, console, process, Date,
    require: name => name === '../db/connection' ? { pool: { query: async () => ({ rows: [
      { ts_code: '600370.SH', name: '*ST三房', market: 'CN', list_date: '20030306', raw_data: { industry: '化工' } },
    ] }) } } : name === './market' ? { ...native(name), tushareQuery: async (api, params) => {
      apiCalls++; assert.strictEqual(api, 'dividend'); assert.deepStrictEqual(Object.keys(params), ['ts_code']);
      return { fields: ['ts_code', 'end_date', 'cash_div_tax'], items: [[wrongStock ? '600763.SH' : '600370.SH', '20221231', 0.1]] };
    } } : name === './financialDataArchitecture' ? { ...native(name), persistCollectedData: async (metadata, bundle) => saved.push({ metadata, bundle }) }
      : name === './datasetCursors' ? { ...native(name), getDatasetCursors: async () => new Map(),
      isDatasetFresh: () => fresh, markDatasetSuccess: async (scope, code) => {
        assert.strictEqual(code, 'stock_dividend'); fresh = true;
      } } : native(name),
    save: async (metadata, bundle) => saved.push({ metadata, bundle }),
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  await context.module.exports.refreshDividends('600370.SH', '20261020');
  assert.strictEqual(saved[0].metadata.name, '*ST三房');
  assert.strictEqual(saved[0].metadata.industry, '化工');
  assert.strictEqual(saved[0].bundle.dividends[0].end_date, '20221231');
  await context.module.exports.refreshDividends('600370.SH', '20261020');
  assert.strictEqual(apiCalls, 1, '成功分红数据在TTL内复用数据库');
  fresh = false; wrongStock = true;
  await assert.rejects(context.module.exports.refreshDividends('600370.SH', '20261020'), /证券身份不一致/);
  assert.strictEqual(saved.length, 1, '身份错误不能覆盖已有分红');
  assert.strictEqual(fresh, false);
  const serviceFile = path.resolve(__dirname, '../services/companyFinancialIncrementalSync.js');
  const serviceRequire = require('module').createRequire(serviceFile);
  let statements = [], failHistoryWrite = false;
  const client = { query: async (sql, args) => {
    statements.push({ sql, args });
    if (sql.includes('SELECT source_id')) return { rows: [{ source_id: 1 }] };
    if (sql.includes('RETURNING run_id')) return { rows: [{ run_id: 123 }] };
    if (failHistoryWrite && sql.includes("'financial_history'")) throw new Error('历史标记写入失败');
    return { rows: [] };
  }, release() {} };
  const persistContext = { module: { exports: {} }, console, process, Date,
    require: name => name === '../db' ? { pool: { connect: async () => client } }
      : name === './financialDataArchitecture' ? { syncReportRows: async () => {} }
      : name === './datasetCursors' ? { markDatasetSuccess: async () => {}, markDatasetFailure: async () => {} }
      : serviceRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(serviceFile, 'utf8'), persistContext);
  const target = { tsCode: '600370.SH', companyId: 9695, instrumentId: 1, needs: ['income'] };
  const reports = { results: { income: [{ end_date: '20251231', ann_date: '20260429' }] }, errors: {} };
  await persistContext.module.exports.persistCompanyReports(target, reports, { historyStart: '20030306' });
  assert(statements.find(item => item.sql.includes("'financial_history'")).args.includes('2003-03-06'));
  assert.strictEqual(statements.at(-1).sql, 'COMMIT', '历史标记与报表在同一事务提交');
  statements = []; failHistoryWrite = true;
  await assert.rejects(persistContext.module.exports.persistCompanyReports(target, reports, { historyStart: '20030306' }), /历史标记写入失败/);
  assert.strictEqual(statements.at(-1).sql, 'ROLLBACK', '历史标记失败不能返回完整采集成功');
  statements = []; failHistoryWrite = false;
  await persistContext.module.exports.persistCompanyReports(target, { results: { income: [] }, errors: {} }, { historyStart: '20030306' });
  assert(!statements.some(item => item.sql.includes("'financial_history'")), '空结果不登记完整历史');
  console.log('stock financial history: full windows, truncation, failure retention and dividend cache passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
