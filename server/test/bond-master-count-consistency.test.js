// 2026-11-01 可转债只数口径统一（数据健康页 vs 上市列表）
// 背景：数据健康页「可转债主档」曾用 COUNT(bond_unified WHERE status='listed') = 433，
// 把定向/私募、已退市老债都算成在市，和上市列表（同期 307）对不上，也与主同步发布的
// profiles.length（311，含已摘牌债的冻结行情行）不一致。
// 现在两处都必须走「该交易日有行情 + 在市 + 公募 + 生命周期可判定」这一条口径。
// 本测试只做静态断言，不连数据库。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

// 列表 universe 与主档只数必须共用的谓词（缺一条就会出现只数不一致）
const SHARED_PREDICATES = [
  "u.status='listed'",
  "u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募')",
  'b.list_date IS NULL OR b.list_date <= ', // 参数写法不同，只比前缀
  'b.delist_date IS NULL OR b.delist_date > ',
  'p.maturity_date IS NULL OR p.maturity_date >= ',
  'p.conv_end_date IS NULL OR p.conv_end_date >= ',
  'u.conv_stop_date IS NULL OR u.conv_stop_date > ',
  'p.maturity_date IS NOT NULL OR p.conv_end_date IS NOT NULL OR b.delist_date IS NOT NULL',
].map(s => s.replace(/\s+/g, ' ').trim());

const squash = sql => String(sql || '').replace(/\s+/g, ' ');

check('主档只数改为按交易日分区派生（不再直接数 bond_unified）', () => {
  const registry = read('server/services/datasetPartitionRegistry.js');
  const entry = registry.match(/bond_master:\s*\{[\s\S]*?\n  \},/);
  assert.ok(entry, '找不到 bond_master 注册项');
  assert.ok(/partitionedCountSql/.test(entry[0]), 'bond_master 必须用 partitionedCountSql 按交易日计数');
  assert.ok(/market\.convertible_bond_daily_metrics/.test(entry[0]), '只数必须从当日行情分区派生');
  assert.ok(/COUNT\(DISTINCT m\.instrument_id\)/.test(entry[0]), '必须按证券去重，列表是 DISTINCT ON (instrument_id)');
  assert.ok(!/whereSql:\s*"WHERE status='listed'"/.test(entry[0]), '不能再用 WHERE status=list 的旧口径');
  assert.ok(!/dataAsOfStandaloneSql/.test(entry[0]), '分区数据集的日期来自分区键，不再取同步游标');
});

check('主档只数与列表 universe 共用同一组筛选谓词', () => {
  const registry = squash(read('server/services/datasetPartitionRegistry.js').match(/bond_master:\s*\{[\s\S]*?\n  \},/)[0]);
  const listSql = squash(read('server/repositories/convertibleBondListServiceRepository.js'));
  SHARED_PREDICATES.forEach(predicate => {
    assert.ok(registry.includes(predicate), `注册表缺少谓词：${predicate}`);
    assert.ok(listSql.includes(predicate), `列表缺少谓词：${predicate}`);
  });
});

check('主同步发布主档只数时取同口径快照，不再用 profiles.length', () => {
  const sync = read('server/services/convertibleBondAnalysisSync.js');
  assert.ok(/require\('\.\/datasetPartitionRegistry'\)/.test(sync), '同步需要读取注册表快照计数');
  assert.ok(/await readSnapshot\('bond_master', \{ partitionKey: daily\.tradeDate \}\)/.test(sync), '主档只数必须来自 readSnapshot(bond_master)');
  assert.ok(/let bondMasterRowCount = profiles\.length;/.test(sync), '读取失败时应回退本次处理只数并告警，不能阻断主同步');
  const publishLine = sync.match(/publishDatasetPartition\('bond_master'[\s\S]*?\}\),/);
  assert.ok(publishLine, '找不到 bond_master 发布语句');
  assert.ok(/rowCount: bondMasterRowCount/.test(publishLine[0]), '发布时必须使用统一口径只数');
  assert.ok(!/rowCount: profiles\.length/.test(publishLine[0]), '发布时不能再用 profiles.length');
  assert.ok(/processed_count: profiles\.length/.test(publishLine[0]), '本次处理只数应保留在诊断里便于对账');
});

check('任务通用发布路径的诊断也只数同口径', () => {
  const sync = read('server/services/convertibleBondAnalysisSync.js');
  const diag = sync.match(/bond_master:\s*\{ partition_row_count:[^}]*\}/);
  assert.ok(diag, '找不到 bond_master 诊断项');
  assert.ok(/partition_row_count: bondMasterRowCount/.test(diag[0]), 'partition_row_count 必须与发布只数一致');
  assert.ok(/processed_count: profiles\.length/.test(diag[0]), '诊断里保留本次处理只数');
});

check('数据健康页给出可转债主档中文名与只数口径说明', () => {
  const js = read('public/js/admin-analytics.js');
  assert.ok(/bond_master:\s*'可转债主档'/.test(js), '数据健康页数据集名称缺失，会显示成「其他数据集」');
  const legend = js.match(/\['可转债主档只数'[^\]]*\]/);
  assert.ok(legend, '缺少只数口径说明');
  assert.ok(/同一口径/.test(legend[0]), '说明必须写明与上市列表同口径');
});

// 用桩执行器跑一遍 readSnapshot，确认分区日期确实作为 $1 传进主档计数 SQL（不连数据库）。
async function checkSnapshotPlumbing() {
  const name = 'readSnapshot 用分区日期调用主档计数 SQL';
  try {
    const { readSnapshot } = require('../services/datasetPartitionRegistry');
    const calls = [];
    const executor = async (sql, params) => {
      calls.push({ sql: String(sql), params });
      // 计数查询返回只数，日期查询返回分区键
      return { rows: [{ row_count: 307, data_as_of: params && params[0] }] };
    };
    const snapshot = await readSnapshot('bond_master', { partitionKey: '2026-10-30' }, executor);
    assert.strictEqual(calls.length, 2, '分区数据集应执行计数与日期两条 SQL');
    assert.ok(/convertible_bond_daily_metrics/.test(calls[0].sql), '计数必须来自当日行情分区');
    assert.deepStrictEqual(calls[0].params, ['2026-10-30'], '分区日期必须作为 $1 传入');
    assert.strictEqual(snapshot.rowCount, 307);
    assert.strictEqual(snapshot.dataAsOf, '2026-10-30');
    tests.push(['PASS', name]); console.log('  [PASS] ' + name);
  } catch (error) {
    tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message);
  }
}

checkSnapshotPlumbing().then(() => {
  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
});
