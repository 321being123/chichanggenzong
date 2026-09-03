const assert = require('assert');
const {
  FORMULA_VERSION, CALCULATION_LOGIC_VERSION, effectiveConversionPrice, successfulRevisionStartDate, implicitSseNoRevisionRestartDate, isValidTerm, buildResetResult,
} = require('../services/convertibleBondRevisionService');

assert.strictEqual(FORMULA_VERSION, 'reset-v2');
assert.strictEqual(CALCULATION_LOGIC_VERSION, 'reset-logic-20260903-1');
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

const floorBlockedResult = buildResetResult({ ...bond, net_asset_floor_applicable: true, net_asset_floor_value: 11 }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(floorBlockedResult.status, 'floor_blocked');
assert.strictEqual(floorBlockedResult.diagnostics.net_asset_floor_blocked, true);

const floorStillActionable = buildResetResult({ ...bond, current_conv_price: 12, net_asset_floor_applicable: true, net_asset_floor_value: 11 }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(floorStillActionable.status, 'met');

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
assert.strictEqual(lockedResult.matchedDays, 3);
assert.strictEqual(lockedResult.minimumFutureDays, 0);

const unresolvedLock = buildResetResult({ ...bond, no_revision_lock_declared: true }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(unresolvedLock.status, 'not_active');
assert.strictEqual(unresolvedLock.matchedDays, 3);

const convStartDoesNotBlock = buildResetResult({ ...bond, conv_start_date: '2026-09-01' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 9 },
], [], openDates, new Set());
assert.strictEqual(convStartDoesNotBlock.status, 'met');
assert.strictEqual(convStartDoesNotBlock.diagnostics.not_started, undefined);
const newlyListed = buildResetResult({ ...bond, value_date: '2026-08-01', list_date: '2026-08-25', effective_from: '2026-08-25' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
  { trade_date: '2026-08-24', close: 8 },
  { trade_date: '2026-08-23', close: 8 },
], [], ['2026-08-27', '2026-08-26', '2026-08-25', '2026-08-24', '2026-08-23'], new Set());
assert.strictEqual(newlyListed.matchedDays, 3);
assert.deepStrictEqual(newlyListed.diagnostics.expected_dates, ['2026-08-27', '2026-08-26', '2026-08-25']);
const restarted = buildResetResult({ ...bond, next_eligible_date: '2026-08-26' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [], openDates, new Set());
assert.strictEqual(restarted.matchedDays, 2);
assert.strictEqual(restarted.dataStatus, 'complete');

const noRevisionReset = buildResetResult({ ...bond, no_revision_announced_at: '2026-08-25', no_revision_parser_version: '7' }, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 9 },
], [], openDates, new Set());
assert.strictEqual(noRevisionReset.matchedDays, 2);
assert.strictEqual(noRevisionReset.diagnostics.no_revision_restart_date, '2026-08-26');

const legacyMalformedNoRevision = buildResetResult({ ...bond,
  no_revision_announced_at: '2026-08-25', no_revision_parser_version: '6',
  next_eligible_date: '2027-07-15', no_revision_lock_declared: false,
}, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 9 },
], [], openDates, new Set());
assert.strictEqual(legacyMalformedNoRevision.matchedDays, 2);
assert.strictEqual(legacyMalformedNoRevision.diagnostics.next_eligible_date, null);
assert.strictEqual(legacyMalformedNoRevision.diagnostics.raw_next_eligible_date, '2027-07-15');
assert.strictEqual(legacyMalformedNoRevision.diagnostics.restart_source, 'explicit_no_revision');

const revised = buildResetResult(bond, [
  { trade_date: '2026-08-27', close: 8 },
  { trade_date: '2026-08-26', close: 8 },
  { trade_date: '2026-08-25', close: 8 },
], [{ change_date: '2026-08-26', price_before: 12, price_after: 10, reason: '关于向下修正转股价格的公告' }], openDates, new Set());
assert.strictEqual(revised.matchedDays, 2);
assert.strictEqual(revised.diagnostics.successful_revision_start_date, '2026-08-26');

// 斯达转债：8 月 6 日达到 15/30，8 月 7 日没有上交所规定的“修正/不修正”公告，
// 应视为本次不修正，并从 8 月 7 日重新起算，而不是继续沿用 8 月 6 日前的 21 天。
const sseOpenDates = [
  '2026-08-28','2026-08-27','2026-08-26','2026-08-25','2026-08-24','2026-08-21','2026-08-20','2026-08-19',
  '2026-08-18','2026-08-17','2026-08-14','2026-08-13','2026-08-12','2026-08-11','2026-08-10','2026-08-07',
  '2026-08-06','2026-08-05','2026-08-04','2026-08-03','2026-07-31','2026-07-30','2026-07-29','2026-07-28',
  '2026-07-27','2026-07-24','2026-07-23','2026-07-22','2026-07-21','2026-07-20','2026-07-17',
];
const sseBars = sseOpenDates.map(date => ({
  trade_date: date,
  close: date >= '2026-07-17' && date <= '2026-08-14' ? 80 : 120,
}));
const sseBond = { ...bond, ts_code: '113702.SH', current_conv_price: 104.79, observation_days: 30, required_days: 15, value_date: '2026-06-01', list_date: '2026-06-01', effective_from: '2026-06-01' };
assert.strictEqual(implicitSseNoRevisionRestartDate(sseBond, sseBars, [], sseOpenDates, '2026-06-01', []), '2026-08-07');
assert.strictEqual(implicitSseNoRevisionRestartDate({ ...sseBond, ts_code: '127108.SZ' }, sseBars, [], sseOpenDates, '2026-06-01', []), null);
const sseRestarted = buildResetResult(sseBond, sseBars, [], sseOpenDates, new Set());
assert.strictEqual(sseRestarted.diagnostics.implicit_sse_no_revision_restart_date, '2026-08-07');
assert.strictEqual(sseRestarted.matchedDays, 6);
assert.strictEqual(sseRestarted.status, 'tracking');
const sseResponded = buildResetResult({ ...sseBond, revision_responses: [{ event_type: 'no_revision', announced_at: '2026-08-07' }] }, sseBars, [], sseOpenDates, new Set());
assert.strictEqual(sseResponded.diagnostics.implicit_sse_no_revision_restart_date, null);
assert.strictEqual(sseResponded.status, 'met');

console.log('convertible bond revision tests passed');
