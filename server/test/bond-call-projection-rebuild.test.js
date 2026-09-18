const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const analysis = read('server/services/convertibleBondAnalysis.js');
const exporter = read('server/scripts/exportVerifiedBondCallFacts.js');
const rebuild = read('server/scripts/rebuildBondCallProjection.js');
const deploy = read('deploy/rebuild_bond_call_projection.py');
const { pickAuthoritativeIdentity } = require('../scripts/rebuildBondCallProjection');

assert.match(analysis, /allowFallback = true/);
assert.match(analysis, /if \(!allowFallback\)/);
assert.match(analysis, /error\.budgetWindow === 'concurrency'/);
assert.match(rebuild, /guardRetryAttempts: 6/);
assert.match(rebuild, /--apply/);
assert.match(rebuild, /--confirm-production/);
assert.match(rebuild, /allowFallback: false/);
assert.match(rebuild, /交易所历史公告未完整/);
assert.match(rebuild, /hasExplicitConvertibleEvidence/);
assert.match(rebuild, /existingByKey/);
assert.match(rebuild, /historical_identity_repair_count/);
assert.match(rebuild, /tushareQuery\('cb_basic'/);
assert.match(rebuild, /ignored_non_convertible_count/);
assert.match(rebuild, /parser_version<>\$1 OR e\.parse_status<>'complete'/);
assert.match(rebuild, /verified_projection_rebuild/);
assert.match(rebuild, /publishDatasetSnapshot\(DATASET_CODE/);
assert.match(rebuild, /retryJobSlot/);
assert.match(exporter, /parser_version='call-event-v3'/);
assert.match(exporter, /parse_status='complete'/);
assert.match(exporter, /extracted_text/);
assert.match(deploy, /portfolio-db-backup\.service/);
assert.match(deploy, /--confirm-production/);
assert.match(deploy, /RejectPolicy/);
assert.match(deploy, /portfolio-bond-call-rebuild\.log/);
assert.doesNotMatch(deploy, /AutoAddPolicy/);

const historicalCandidates = [
  { ts_code: '100567.SH', bond_short_name: '山鹰转债', stk_code: '600567.SH', list_date: '20030701', delist_date: '20070213' },
  { ts_code: '110567.SH', bond_short_name: '山鹰转债', stk_code: '600567.SH', list_date: '20070917', delist_date: '20100205' },
  { ts_code: '110047.SH', bond_short_name: '山鹰转债', stk_code: '600567.SH', list_date: '20181210', delist_date: '20241121' },
  { ts_code: '110063.SH', bond_short_name: '鹰19转债', stk_code: '600567.SH', list_date: '20200103', delist_date: '20251215' },
];
assert.strictEqual(
  pickAuthoritativeIdentity({ title: '关于“山鹰转债”到期赎回暨摘牌的公告', event_date: '2024-11-22' }, historicalCandidates).ts_code,
  '110047.SH'
);
assert.strictEqual(
  pickAuthoritativeIdentity({ title: '关于“110063”停止交易的公告', event_date: '2025-12-15' }, historicalCandidates).ts_code,
  '110063.SH'
);
assert.strictEqual(
  pickAuthoritativeIdentity({ title: '关于“山鹰转债”有关事项的公告', event_date: '' }, historicalCandidates),
  null
);

console.log('bond call projection rebuild safeguards passed');
