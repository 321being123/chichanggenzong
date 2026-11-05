// 空候选池回归（2026-11-05 生产补数中断）：港股目标池主档的交易所字段是历史脏数据，
// loadUniverse 返回空时 computeSelection 提前返回却缺 evaluated，auditInputs 遍历即抛
// "Cannot read properties of undefined (reading 'forEach')"，整批补数被打成 failed。
// 本用例不连数据库、不调外部接口，只固定「空池返回契约」与「缺口审计不崩」两件事。
'use strict';
const assert = require('assert');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    tests.push(['FAIL', name + ' :: ' + error.message]);
    console.log('  [FAIL] ' + name + ' :: ' + error.message);
  }
}

const REPO = '../repositories/stockSelectionRepository';
const SERVICE = '../services/stockSelectionService';

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function serviceWithEmptyUniverse() {
  stub(REPO, {
    loadMarketValuation: async () => ({}),
    loadUniverse: async () => [],
    saveInputGapQueue: async () => 1,
  });
  const servicePath = require.resolve(SERVICE);
  delete require.cache[servicePath];
  return require(SERVICE);
}

async function main() {
  await check('空候选池时 computeSelection 仍返回 evaluated / anomalyById 契约', async () => {
    const service = serviceWithEmptyUniverse();
    const computed = await service.computeSelection({ market: 'HK', asOfDate: '2026-09-30' });
    assert.deepStrictEqual(computed.evaluated, []);
    assert.deepStrictEqual(computed.anomalyById, {});
    assert.strictEqual(computed.quality.reason, 'universe_empty');
  });

  await check('空候选池时 auditInputs 不抛错，返回零缺口并保存队列', async () => {
    const service = serviceWithEmptyUniverse();
    const audit = await service.auditInputs({ market: 'HK', asOfDate: '2026-09-30' });
    assert.strictEqual(audit.gapCount, 0);
    assert.deepStrictEqual(audit.gaps, []);
    assert.strictEqual(audit.coverage.universeCount, 0);
  });

  await check('港股候选池按市场纳入，不再被交易所脏值清空', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), 'utf8');
    assert.match(source, /AND \(i\.market = 'HK' OR i\.exchange_code = ANY\(\$3::text\[\]\)\)/);
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log(`\nstock-selection-empty-universe: ${tests.length - failed.length}/${tests.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
