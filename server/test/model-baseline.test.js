// 模型输出基线的自我校验（批次5 第 1 步的守卫）。
// 目的不是重算业务结论，而是保证"基线工具本身不能说谎"：缺文件、缺用例、未测出、值变化都必须失败，
// 否则后续重组可以靠删用例或让用例报错来伪装成"输出一致"。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baseline = require('../../scripts/record-model-baseline');
const baselineFile = path.join(__dirname, 'fixtures', 'model-baseline.json');

let cases = 0;
function check(name, fn) {
  fn();
  cases += 1;
  assert.ok(true, name);
}

check('基线文件存在且用例集版本固定', () => {
  assert.ok(fs.existsSync(baselineFile), '缺少模型输出基线文件');
  const recorded = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  assert.strictEqual(recorded.suite, baseline.SUITE, '基线用例集版本与工具不一致');
  const total = Object.keys(recorded.cases || {}).length;
  assert.ok(total >= 30, `基线用例过少（${total}），覆盖不足等于没有基线`);
  const notOk = Object.entries(recorded.cases).filter(([, item]) => item.status !== 'ok');
  assert.strictEqual(notOk.length, 0, '基线里存在未测出的用例：' + notOk.map(([id]) => id).join(','));
});

check('当前代码与基线逐字段一致', () => {
  const recorded = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const result = baseline.compare(recorded, baseline.collect());
  assert.strictEqual(result.ok, true, '输出与基线不一致：' + result.diffs.map(diff => diff.id + '→' + diff.reason).join('；'));
});

check('删除基线里的用例必须判失败', () => {
  const result = baseline.compare(
    { cases: { a: { status: 'ok', hash: 'h1', value: 1 }, b: { status: 'ok', hash: 'h2', value: 2 } } },
    { a: { status: 'ok', hash: 'h1', value: 1 } },
  );
  assert.strictEqual(result.ok, false, '基线有、当前缺失的用例不得判通过');
  assert.strictEqual(result.diffs.length, 1);
  assert.match(result.diffs[0].reason, /当前没有该用例/);
});

check('两侧都未测出不得判通过', () => {
  const result = baseline.compare(
    { cases: { a: { status: 'error', hash: null, error: 'boom' } } },
    { a: { status: 'error', hash: null, error: 'boom' } },
  );
  assert.strictEqual(result.ok, false, '未测出不构成等价证据');
  assert.match(result.diffs[0].reason, /未测出/);
});

check('输出变化必须报出差异与两侧取值', () => {
  const result = baseline.compare(
    { cases: { a: { status: 'ok', hash: 'h1', value: 1 } } },
    { a: { status: 'ok', hash: 'h9', value: 9 } },
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.diffs[0].expected, 1);
  assert.strictEqual(result.diffs[0].actual, 9);
});

check('新增未登记用例必须判失败（防止悄悄扩范围）', () => {
  const result = baseline.compare(
    { cases: { a: { status: 'ok', hash: 'h1', value: 1 } } },
    { a: { status: 'ok', hash: 'h1', value: 1 }, b: { status: 'ok', hash: 'h2', value: 2 } },
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.diffs[0].reason, /基线中没有该用例/);
});

console.log(`model baseline tests passed (${cases} scenarios)`);
