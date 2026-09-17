const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const analysis = read('server/services/convertibleBondAnalysis.js');
const exporter = read('server/scripts/exportVerifiedBondCallFacts.js');
const rebuild = read('server/scripts/rebuildBondCallProjection.js');
const deploy = read('deploy/rebuild_bond_call_projection.py');

assert.match(analysis, /allowFallback = true/);
assert.match(analysis, /if \(!allowFallback\)/);
assert.match(rebuild, /--apply/);
assert.match(rebuild, /--confirm-production/);
assert.match(rebuild, /allowFallback: false/);
assert.match(rebuild, /交易所历史公告未完整/);
assert.match(rebuild, /hasExplicitConvertibleEvidence/);
assert.match(rebuild, /existingByKey/);
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

console.log('bond call projection rebuild safeguards passed');
