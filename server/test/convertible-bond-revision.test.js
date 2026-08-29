const assert = require('assert');
const {
  FORMULA_VERSION, effectiveConversionPrice, successfulRevisionStartDate, isValidTerm, buildResetResult,
} = require('../services/convertibleBondRevisionService');

assert.strictEqual(FORMULA_VERSION, 'reset-v2');
const term = {
  term_id: 10, trigger_ratio: 0.85, observation_days: 3, required_days: 2,
  effective_from: '2026-08-01', conv_start_date: '2026-08-01',
  revision_direction: 'down', comparison_operator: 'lt', parse_status: 'complete',
};
assert.strictEqual(isValidTerm(term), true);
assert.strictEqual(isValidTerm({ ...term, revision_direction: 'up' }), false);
assert.strictEqual(isValidTerm({ ...term, parse_status: 'partial' }), false);

const changes = [
  { change_date: '2026-08-20', price_before: 10, price_after: 9 },
  { change_date: '2026-08-10', price_before: 11, price_after: 10 },
];
assert.strictEqual(effectiveConversionPrice(9, changes, '2026-08-25'), 9);
assert.strictEqual(effectiveConversionPrice(9, changes, '2026-08-15'), 10);
assert.strictEqual(effectiveConversionPrice(9, changes, '2026-08-05'), 11);
assert.strictEqual(effectiveConversionPrice(13.8, [{ change_date: '2026-07-24', price_before: 21.13, price_after: 21.03 }], '2026-08-05'), 13.8);
assert.strictEqual(successfulRevisionStartDate([
  { change_date: '2026-08-04', reason: '关于向下修正转股价格的公告' },
  { change_date: '2026-08-10', reason: '关于预计触发向下修正条件的提示性公告' },
], '2026-08-27'), '2026-08-04');

const bond = {
  instrument_id: 1, stock_instrument_id: 2, current_conv_price: 10,
  trigger_ratio: 0.85, observation_days: 3, required_days: 2,
  value_date: '2026-08-01', list_date: '2026-08-01', effective_from: '2026-08-01', conv_start_date: '2026-08-01',
  revision_direction: 'down', comparison_operator: 'lt', parse_status: 'complete', term_id: 10,
};
const openDates = ['2026-08-27', '2026-08-26', '2026-08-25'];
const result = buildResetResult(bond, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8.4 },
  { trade_date: '2026-08-25', close: 9 },
], [], openDates, new Set());
assert.strictEqual(result.status, 'met');
assert.strictEqual(result.dataStatus, 'complete');
assert.strictEqual(result.matchedDays, 2);
assert.strictEqual(result.triggerPrice, 8.5);
assert.strictEqual(result.minimumFutureDays, 0);

const rollingResult = buildResetResult({ ...bond, observation_days: 3, required_days: 2 }, [
  { trade_date: '2026-08-27', close: 9 },
  { trade_date: '2026-08-26', close: 9 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(rollingResult.matchedDays, 1);
assert.strictEqual(rollingResult.minimumFutureDays, 2);

const changedResult = buildResetResult({ ...bond, current_conv_price: 9 }, [
  { trade_date: '2026-08-27', close: 7.5 },
  { trade_date: '2026-08-26', close: 8.4 },
  { trade_date: '2026-08-25', close: 9 },
], [{ change_date: '2026-08-26', price_before: 10, price_after: 9 }], openDates, new Set());
assert.strictEqual(changedResult.matchedDays, 1);
assert.strictEqual(changedResult.status, 'tracking');

const missingResult = buildResetResult(bond, [
  { trade_date: '2026-08-27', close: 8 },
], [], openDates, new Set());
assert.strictEqual(missingResult.dataStatus, 'incomplete');
assert.strictEqual(missingResult.status, 'unknown');

const lockedResult = buildResetResult({ ...bond, next_eligible_date: '2026-09-01' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(lockedResult.status, 'not_active');
assert.strictEqual(lockedResult.dataStatus, 'complete');
assert.strictEqual(lockedResult.matchedDays, 0);

const unresolvedLock = buildResetResult({ ...bond, no_revision_lock_declared: true }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(unresolvedLock.status, 'not_active');
assert.strictEqual(unresolvedLock.matchedDays, 0);

const convStartDoesNotBlock = buildResetResult({ ...bond, conv_start_date: '2026-09-01' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 9 },
], [], openDates, new Set());
assert.strictEqual(convStartDoesNotBlock.status, 'met');
assert.strictEqual(convStartDoesNotBlock.diagnostics.not_started, undefined);
const restarted = buildResetResult({ ...bond, next_eligible_date: '2026-08-26' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(restarted.matchedDays, 2);
assert.strictEqual(restarted.dataStatus, 'complete');

const revised = buildResetResult(bond, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [{ change_date: '2026-08-26', price_before: 12, price_after: 10, reason: '关于向下修正转股价格的公告' }], openDates, new Set());
assert.strictEqual(revised.matchedDays, 2);
assert.strictEqual(revised.diagnostics.successful_revision_start_date, '2026-08-26');

console.log('convertible bond revision tests passed');
