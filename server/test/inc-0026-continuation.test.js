const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const definitions = require('../services/jobDefinitions');
const slots = read('server/services/jobScheduleSlots.js');
const orchestrator = read('server/services/jobOrchestrator.js');
const runner = read('server/services/jobRunnerProcess.js');
const guard = read('server/services/externalCallGuard.js');
const pyGuard = read('ipo-report/external_call_guard.py');
const bond = read('server/services/convertibleBondAnalysis.js');
const finance = read('server/services/companyFinancialIncrementalSync.js');
const hkex = read('server/services/hkexIpo.js');
const arbitrage = read('server/jobs/arbitrageSync.js');
const market = read('server/jobs/marketVolatilitySync.js');
const evidence = read('server/services/jobRecoveryEvidence.js');
const { businessDateText } = require('../services/jobRecoveryEvidence');
const { datasetPartitionKeyForSlot } = require('../services/jobOrchestrator');

assert.ok(definitions.JOB_DEFINITIONS.every(item => Number(item.slotExternalCallsLimit || 0) === 0));
assert.strictEqual(definitions.getJobDefinition('convertible_bond_revision_motive_inputs_sync').maxExternalCallsPerRun, null);
assert.doesNotMatch(orchestrator, /续批任务未声明槽位累计外部请求上限/);
assert.match(slots, /function continueSlot\(/);
assert.match(slots, /attempt_count=GREATEST\(attempt_count-1,0\)/);
assert.match(slots, /status='pending' AND \(next_attempt_at IS NULL OR next_attempt_at <= now\(\)/);
assert.match(slots, /slotExternalCallsTotal/);
assert.match(orchestrator, /continuationRequired/);
assert.match(orchestrator, /pendingStages/);
assert.match(orchestrator, /continuationMaxAgeHours/);
assert.match(orchestrator, /slotLimit/);
assert.match(orchestrator, /function datasetPartitionKeyForSlot\(slot, result = \{\}\)/);
assert.match(orchestrator, /result\.targetTradeDate/);
assert.match(orchestrator, /scopeKey: `\$\{blockedDatasets\[0\]\}:\$\{datasetScopeKey\(blockedDatasets\[0\]\)\}:\$\{partitionKey\}`/);
assert.match(runner, /setSlotExternalCallBudget/);
assert.match(guard, /slotExternalCallLimit/);
assert.match(pyGuard, /JOB_SLOT_EXTERNAL_CALL_LIMIT/);
assert.match(bond, /activeProfile\(row, targetTradeDate\)/);
assert.match(bond, /pendingStages\.has\('stockMarketBackfill'\)/);
assert.match(finance, /coverage_status: 'verified_no_change'/);
assert.match(hkex, /pending_not_due/);
assert.match(arbitrage, /parsePendingNotDue/);
assert.match(market, /MARKET_SUBDATASET_POLICIES/);
assert.match(evidence, /FROM job_runs/);
assert.match(evidence, /runResult\.ok === false/);
assert.match(evidence, /failedDatasets/);
assert.match(evidence, /expectedDataDate/);
assert.match(evidence, /SELECT dataset_code,scope_key,status/);
assert.match(evidence, /byCodeAndScope/);
assert.doesNotMatch(hkex, /statusMessage \? statusMessage\.slice\(0, 2000\) : null/);
assert.strictEqual(datasetPartitionKeyForSlot(
  { job_code: 'convertible_bond_universe_refresh', business_date: '2026-09-17' },
  { targetTradeDate: '2026-09-16' },
), '2026-09-16');
assert.strictEqual(datasetPartitionKeyForSlot(
  { job_code: 'convertible_bond_universe_refresh', business_date: '2026-09-17' },
  {},
), '2026-09-16');
assert.strictEqual(businessDateText(new Date('2026-09-15T16:00:00.000Z')), '2026-09-16');
assert.strictEqual(businessDateText('2026-09-16'), '2026-09-16');

console.log('OK inc-0026-continuation: 32 项续批、总止损、目标日和终态约束通过');
