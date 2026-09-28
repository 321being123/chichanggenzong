'use strict';

const assert = require('assert');
const checker = require('../../scripts/check-date-boundary');

const repositoryResult = checker.checkRepository();
assert.deepStrictEqual(repositoryResult.problems, []);
assert.strictEqual(repositoryResult.fixedRules, 1);
assert.strictEqual(repositoryResult.openMatches, 6);

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

console.log('日期边界静态检查测试通过：新增命中、数量变化和已修规则复发均被拦截。');
