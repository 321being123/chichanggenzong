const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const analysis = read('server/services/convertibleBondAnalysis.js');
const exporter = read('server/scripts/exportVerifiedBondCallFacts.js');
const rebuild = read('server/scripts/rebuildBondCallProjection.js');
const deploy = read('deploy/rebuild_bond_call_projection.py');
const {
  pickAuthoritativeIdentity,
  duplicatedAuxiliaryKeys,
  officialCheckpointPath,
  readOfficialCheckpoint,
  writeOfficialCheckpoint,
} = require('../scripts/rebuildBondCallProjection');

assert.match(analysis, /allowFallback = true/);
assert.match(analysis, /if \(!allowFallback\)/);
assert.match(analysis, /error\.budgetWindow === 'concurrency'/);
assert.match(rebuild, /attempt <= 6/);
assert.match(rebuild, /--apply/);
assert.match(rebuild, /--confirm-production/);
assert.match(rebuild, /交易所历史公告未完整/);
assert.match(rebuild, /hasExplicitConvertibleEvidence/);
assert.match(rebuild, /existingByKey/);
assert.match(rebuild, /historical_identity_repair_count/);
assert.match(rebuild, /tushareQuery\('cb_basic'/);
assert.match(rebuild, /fetchSseEvents/);
assert.match(rebuild, /fetchSzseEvents/);
assert.doesNotMatch(rebuild, /fetchSzseEventsBatch/);
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

const genericCallCandidates = [
  { ts_code: '123134.SZ', bond_short_name: '卡倍转债', stk_code: '300863.SZ', list_date: '20220118', delist_date: '20230323' },
  { ts_code: '123238.SZ', bond_short_name: '卡倍转02', stk_code: '300863.SZ', list_date: '20240201', delist_date: '20250123' },
];
assert.strictEqual(
  pickAuthoritativeIdentity({ title: '关于提前赎回可转换公司债券的法律意见书', event_date: '2023-03-10' }, genericCallCandidates).ts_code,
  '123134.SZ'
);
assert.strictEqual(
  pickAuthoritativeIdentity({ title: '关于提前赎回可转换公司债券的法律意见书', event_date: '2024-12-20' }, genericCallCandidates).ts_code,
  '123238.SZ'
);
assert.strictEqual(
  pickAuthoritativeIdentity({ title: '关于提前赎回可转换公司债券的法律意见书', event_date: '2024-02-10' }, genericCallCandidates).ts_code,
  '123238.SZ'
);

const unlistedPrivatePlacementCandidates = [
  { ts_code: '124022.SZ', bond_short_name: '楚天定转', stk_code: '300358.SZ', list_date: null, delist_date: null },
  { ts_code: '123240.SZ', bond_short_name: '楚天转债', stk_code: '300358.SZ', list_date: '20240229', delist_date: '20251230' },
];
assert.strictEqual(
  pickAuthoritativeIdentity(
    { title: '楚天科技:关于预计触发可转债转股价格向下修正条件的提示性公告', event_date: '2024-09-06' },
    unlistedPrivatePlacementCandidates
  ).ts_code,
  '123240.SZ'
);
assert.strictEqual(
  pickAuthoritativeIdentity(
    { title: '关于楚天定转转股事项的公告', event_date: '2024-09-06' },
    unlistedPrivatePlacementCandidates
  ).ts_code,
  '124022.SZ'
);

const auxiliaryKeys = duplicatedAuxiliaryKeys([
  { source_number: 'issuer', instrument_id: 1, event_date: '2024-09-25', title: '关于不提前赎回天路转债的公告' },
  { source_number: 'review', instrument_id: 1, event_date: '2024-09-25', title: '关于不提前赎回天路转债的核查意见' },
  { source_number: 'correction', instrument_id: 1, event_date: '2024-09-26', title: '关于不提前赎回天路转债公告的更正公告' },
  { source_number: 'only-review', instrument_id: 2, event_date: '2024-09-25', title: '关于提前赎回示例转债的法律意见书' },
]);
assert.deepStrictEqual([...auxiliaryKeys], ['review', 'correction']);

const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-call-checkpoint-'));
try {
  const checkpoint = officialCheckpointPath('SZ', '2024-09-01', '2025-02-23', checkpointRoot);
  writeOfficialCheckpoint(checkpoint, 'SZ', '2024-09-01', '2025-02-23', {
    '300358.SZ': [{ title: '关于预计触发可转债赎回条件的提示性公告' }],
  });
  assert.deepStrictEqual(readOfficialCheckpoint(checkpoint, 'SZ', '2024-09-01', '2025-02-23'), {
    '300358.SZ': [{ title: '关于预计触发可转债赎回条件的提示性公告' }],
  });
  assert.deepStrictEqual(readOfficialCheckpoint(checkpoint, 'SH', '2024-09-01', '2025-02-23'), {});
} finally {
  fs.rmSync(checkpointRoot, { recursive: true, force: true });
}

console.log('bond call projection rebuild safeguards passed');
