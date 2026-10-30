// 发布收尾报告判据（2026-10-30，C-04）：DEPLOY_RESULT 必须能机器区分
// 「本次没核对」与「已完整读取、确认无相关反馈」，且新增字段不得改变退出码语义。
// 纯静态断言，不连接生产、不执行部署。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'deploy', 'deploy_password.py'), 'utf8');

const STATUS_VALUES = [
  'not_crosschecked',
  'skipped_missing_operator',
  'skipped_missing_deployment_id',
  'read_failed',
  'apply_failed',
  'applied_with_pending',
  'applied_verified'
];

const cases = [
  ['DEPLOY_RESULT 输出 feedback_status', function () {
    assert.match(
      SOURCE,
      /"feedback_status":\s*feedback_result\.get\(/,
      'summary 必须把反馈处置状态写进 DEPLOY_RESULT'
    );
  }],
  ['七种反馈处置状态均已定义', function () {
    for (const value of STATUS_VALUES) {
      assert.ok(SOURCE.includes('"' + value + '"'), '缺少状态定义：' + value);
    }
  }],
  ['未提供核对批次记为未核对而非无反馈', function () {
    assert.ok(SOURCE.includes('"status": "not_crosschecked"'), '缺核对依据必须记 not_crosschecked');
    assert.ok(
      SOURCE.includes('本次没有本批反馈核对依据'),
      'not_crosschecked 的原因必须写明没有本批核对依据'
    );
  }],
  ['各分支返回都带处置状态', function () {
    const inline = SOURCE.match(/"status":\s*"/g) || [];
    const assigned = SOURCE.match(/"status":\s*"applied_with_pending"/g) || [];
    assert.ok(inline.length + assigned.length >= 6, '处置状态分支不足：' + inline.length);
  }],
  ['反馈失败不改变代码部署成功语义', function () {
    assert.ok(SOURCE.includes('"code_deployed": True'), '代码部署成功标记必须保留');
    const tail = SOURCE.slice(SOURCE.indexOf('if not summary["feedback_applied"]'));
    assert.ok(!/raise SystemExit/.test(tail.slice(0, 400)), '反馈未完成不得转为部署失败退出');
  }]
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log('  ✓ ' + name);
  } catch (error) {
    failed += 1;
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}
console.log('release-report-status: ' + cases.length + ' 项检查，失败 ' + failed);
process.exit(failed ? 1 : 0);
