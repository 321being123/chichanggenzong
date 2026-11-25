// 回归测试：反馈提交限流（管理员 10 分钟 100 条 / 普通登录用户 10 分钟 50 条，回复保持 5 分钟 10 条）
const assert = require('assert');
const rateLimit = require('../middleware/rateLimit');
const feedbackRouter = require('../routes/feedback');

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' -> ' + e.message);
    console.log('  ✗ ' + name + ' -> ' + e.message);
  }
}

function hit(mw, authUser) {
  return new Promise((resolve) => {
    let passed = false;
    let statusCode = null;
    let body = null;
    const req = { authUser, ip: '127.0.0.1' };
    const res = {
      status(c) {
        statusCode = c;
        return res;
      },
      json(d) {
        body = d;
        return res;
      },
    };
    const next = () => {
      passed = true;
    };
    Promise.resolve(mw(req, res, next)).then(() => {
      resolve({ passed, statusCode, body });
    });
  });
}

function clearTestBuckets(usernames) {
  for (const key of rateLimit.memBuckets.keys()) {
    if (usernames.some((u) => key.endsWith(':' + u))) {
      rateLimit.memBuckets.delete(key);
    }
  }
}

async function run() {
  const testUsers = ['rl_normal_user', 'rl_staff_content', 'rl_admin_user', 'rl_comment_user'];
  clearTestBuckets(testUsers);

  await check('普通登录用户提交反馈：10 分钟窗口最多放行 50 条，第 51 条返回 429', async () => {
    const user = { username: 'rl_normal_user', role: 'user', permissions: {} };
    let passedCount = 0;
    for (let i = 0; i < 50; i++) {
      const r = await hit(feedbackRouter.createLimiter, user);
      if (r.passed) passedCount++;
    }
    assert.strictEqual(passedCount, 50, '前 50 条应全部放行，实得 ' + passedCount);

    const r51 = await hit(feedbackRouter.createLimiter, user);
    assert.strictEqual(r51.passed, false, '第 51 条应被拦截');
    assert.strictEqual(r51.statusCode, 429);
    assert.ok(r51.body && String(r51.body.error).includes('10 分钟'), '普通用户提示应包含 10 分钟');

    const bucket = rateLimit.memBuckets.get('rl:feedback-create:rl_normal_user');
    assert.ok(bucket, '应写入 feedback-create 计数桶');
    assert.ok(bucket.reset - Date.now() > 5 * 60 * 1000, '普通用户窗口应大于 5 分钟（10 分钟）');
  });

  await check('仅具备 content_manage 的非管理员员工走普通用户限流（10 分钟 50 条）', async () => {
    const staff = { username: 'rl_staff_content', role: 'user', permissions: { content_manage: true } };
    for (let i = 0; i < 50; i++) {
      const r = await hit(feedbackRouter.createLimiter, staff);
      assert.strictEqual(r.passed, true, '第 ' + (i + 1) + ' 条应放行');
    }
    const r51 = await hit(feedbackRouter.createLimiter, staff);
    assert.strictEqual(r51.statusCode, 429);
    assert.ok(rateLimit.memBuckets.has('rl:feedback-create:rl_staff_content'), '应命中普通用户限流桶');
    assert.strictEqual(rateLimit.memBuckets.has('rl:feedback-create-admin:rl_staff_content'), false, '不应命中管理员限流桶');
  });

  await check('管理员身份提交反馈：10 分钟窗口最多放行 100 条，第 101 条返回 429', async () => {
    const admin = { username: 'rl_admin_user', role: 'admin', permissions: {} };
    let passedCount = 0;
    for (let i = 0; i < 100; i++) {
      const r = await hit(feedbackRouter.createLimiter, admin);
      if (r.passed) passedCount++;
    }
    assert.strictEqual(passedCount, 100, '管理员前 100 条应全部放行，实得 ' + passedCount);

    const r101 = await hit(feedbackRouter.createLimiter, admin);
    assert.strictEqual(r101.passed, false, '第 101 条应被拦截');
    assert.strictEqual(r101.statusCode, 429);
    assert.ok(r101.body && String(r101.body.error).includes('10 分钟'), '管理员提示应包含 10 分钟');

    const bucket = rateLimit.memBuckets.get('rl:feedback-create-admin:rl_admin_user');
    assert.ok(bucket, '应写入 feedback-create-admin 计数桶');
    assert.ok(bucket.reset - Date.now() > 5 * 60 * 1000, '管理员窗口应大于 5 分钟（10 分钟）');
  });

  await check('反馈回复限流保持每 5 分钟最多 10 条不变', async () => {
    const user = { username: 'rl_comment_user', role: 'user', permissions: {} };
    for (let i = 0; i < 10; i++) {
      const r = await hit(feedbackRouter.commentLimiter, user);
      assert.strictEqual(r.passed, true, '回复前 10 条应放行');
    }
    const r11 = await hit(feedbackRouter.commentLimiter, user);
    assert.strictEqual(r11.passed, false, '第 11 条回复应被拦截');
    assert.strictEqual(r11.statusCode, 429);
  });

  clearTestBuckets(testUsers);

  console.log('\n===== 反馈限流回归测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail > 0) {
    console.error('Failures:\n' + failures.join('\n'));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
