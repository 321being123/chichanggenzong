'use strict';
const assert = require('assert');
const { formatDuration, summarizeTimings } = require('./lib/testTimings');

// 准备耗时不混进文件排名；失败/跳过文件只要执行过就计时，未执行项不伪造为 0。
const entries = [
  { file: 'schema', kind: 'setup', durationMs: 1000 },
  { file: 'failed.js', kind: 'file', durationMs: 500 },
  { file: 'skipped.py', kind: 'file', durationMs: 200 },
  { file: 'unknown.js', kind: 'file', durationMs: undefined },
  { file: 'zero.js', kind: 'file', durationMs: 0 },
];
const report = summarizeTimings(entries, 2100, 2);
assert.strictEqual(report.elapsedMs, 2100);
assert.strictEqual(report.fileMs, 700);
assert.strictEqual(report.setupMs, 1000);
assert.strictEqual(report.measuredFiles, 3);
assert.deepStrictEqual(report.slowest.map(x => x.file), ['failed.js', 'skipped.py']);
assert.strictEqual(entries.length, 5);
assert.strictEqual(formatDuration(1234), '1.23s');
assert.strictEqual(formatDuration(undefined), '未知');
assert.strictEqual(formatDuration(-1), '未知');
assert.deepStrictEqual(summarizeTimings([], 0).slowest, []);
console.log('测试耗时统计通过：文件/准备分开、慢项排序、未知与未执行不伪装计时');
