// ========== P1-3 服务端数据校验 回归测试 ==========
// 运行：node server/test/validation.test.js
// 说明：验证 cashBase/hkRate/totalAsset/fundRecord 等顶层字段的边界校验，
// 实测非法类型、负汇率、负本金、HTML 注入等均被拦截。
const assert = require('assert');
const { validateAccountData } = require('../middleware/validate');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

// 一个其它字段均合法的最小合法载荷
const base = () => ({ positions: [], trades: [], navHistory: [], cashFlows: [] });

check('负港币汇率被拒绝（P1-3 原可穿透）', () => {
  const r = validateAccountData({ ...base(), hkRate: -0.5 });
  assert.strictEqual(r.ok, false, '负汇率应被拒绝');
});
check('港币汇率为 0 被拒绝（必须为正）', () => {
  const r = validateAccountData({ ...base(), hkRate: 0 });
  assert.strictEqual(r.ok, false, '0 汇率应被拒绝');
});
check('合法正港币汇率通过', () => {
  const r = validateAccountData({ ...base(), hkRate: 0.868 });
  assert.strictEqual(r.ok, true, '正汇率应通过');
});
check('负期初本金被拒绝', () => {
  const r = validateAccountData({ ...base(), cashBase: -100 });
  assert.strictEqual(r.ok, false, '负本金应被拒绝');
});
check('非负期初本金通过', () => {
  const r = validateAccountData({ ...base(), cashBase: 100 });
  assert.strictEqual(r.ok, true, '非负本金应通过');
});
check('负总市值被拒绝', () => {
  const r = validateAccountData({ ...base(), totalAsset: -1 });
  assert.strictEqual(r.ok, false, '负总市值应被拒绝');
});
check('基金记录非数组被拒绝', () => {
  const r = validateAccountData({ ...base(), fundRecord: 'abc' });
  assert.strictEqual(r.ok, false, 'fundRecord 非数组应被拒绝');
});
check('基金记录含 HTML 被拒绝（防注入）', () => {
  const r = validateAccountData({ ...base(), fundRecord: ['<script>alert(1)</script>'] });
  assert.strictEqual(r.ok, false, 'fundRecord 含 HTML 应被拒绝');
});
check('基金记录为安全文本数组通过', () => {
  const r = validateAccountData({ ...base(), fundRecord: ['易方达蓝筹', '华夏成长'] });
  assert.strictEqual(r.ok, true, '正常 fundRecord 应通过');
});
check('完全合法的空载荷通过', () => {
  const r = validateAccountData(base());
  assert.strictEqual(r.ok, true, '空合法载荷应通过');
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) {
  console.log('失败项:'); failed.forEach(f => console.log('  - ' + f[1]));
  process.exit(1);
}
console.log('全部通过 ✅');
