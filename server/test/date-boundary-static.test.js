'use strict';

const assert = require('assert');
const checker = require('../../scripts/check-date-boundary');

const repositoryResult = checker.checkRepository();
assert.deepStrictEqual(repositoryResult.problems, []);
assert.strictEqual(repositoryResult.fixedRules, 10);
assert.strictEqual(repositoryResult.openMatches, 0);

const ruleId = 'timezone-offset-480';
const expression = ['getTimezoneOffset()', '+ 480'].join(' ');
const forbidden = ['getTimezoneOffset()', '+ 480'].join(' ');
const baseline = { rules: [{
  ruleId, file: 'sample.js', function: 'convert', expression, status: 'open', expectedMatches: 1,
}] };
const singleMatch = checker.analyzeSources([{
  path: 'sample.js', source: `function convert() { const value = offset.${forbidden}; }`,
}], baseline);
assert.deepStrictEqual(singleMatch.problems, []);

const extraMatch = checker.analyzeSources([{
  path: 'sample.js', source: `function convert() { const a = x.${forbidden}; const b = y.${forbidden}; }`,
}], baseline);
assert(extraMatch.problems.some(item => item.type === 'MATCH_COUNT_CHANGED' && item.actual === 2));

const fixedBaseline = { rules: [{ ...baseline.rules[0], status: 'fixed', expectedMatches: 0 }] };
assert.deepStrictEqual(checker.analyzeSources([{ path: 'sample.js', source: 'function convert() { return 1; }' }], fixedBaseline).problems, []);
assert(checker.analyzeSources([{
  path: 'sample.js', source: `function convert() { return x.${forbidden}; }`,
}], fixedBaseline).problems.some(item => item.type === 'FIXED_RULE_REAPPEARED'));

const unregistered = checker.analyzeSources([{
  path: 'sample.js', source: `function other() { return x.${forbidden}; }`,
}], baseline);
assert(unregistered.problems.some(item => item.type === 'UNREGISTERED_MATCH' && item.function === 'other'));

const rangeBaseline = { rules: [
  { ruleId: 'local-midnight-year-range', file: 'range.js', function: 'bind', expression: 'range', status: 'open', expectedMatches: 1 },
  { ruleId: 'utc-business-today-range', file: 'chart.js', function: 'renderStabilityChart', expression: 'today', status: 'open', expectedMatches: 1 },
] };
const rangeSource = [
  'function bind(){ function emit(){}; button.addEventListener(\'click\',function(){var d=',
  'new', ' Date(', "end+'T00:00:00')", ';d.setFullYear(d.getFullYear()-1);return d.toISOString().slice(0,10);});}'
].join('');
const todaySource = [
  'function renderStabilityChart(){function amountLabel(){};var today=',
  'new', ' Date(),', 'endDefault=today.toISOString().slice(0,10);}'
].join('');
const rangeSources = [
  { path: 'range.js', source: rangeSource },
  { path: 'chart.js', source: todaySource },
];
assert.deepStrictEqual(checker.analyzeSources(rangeSources, rangeBaseline).problems, []);
assert.strictEqual(checker.functionNameAt(rangeSources[0].source, rangeSources[0].source.indexOf('setFullYear(')), 'bind');
assert.strictEqual(checker.functionNameAt(rangeSources[1].source, rangeSources[1].source.indexOf('var today=')), 'renderStabilityChart');
const fixedRange = { rules: rangeBaseline.rules.map(rule => ({ ...rule, status: 'fixed', expectedMatches: 0 })) };
assert(checker.analyzeSources(rangeSources, fixedRange).problems.some(item => item.type === 'FIXED_RULE_REAPPEARED'));

console.log('日期边界静态检查测试通过：新增命中、数量变化、已修规则复发及年份区间 UTC 截日均被拦截。');
