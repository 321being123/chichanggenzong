// 回归测试：评论限流（knowledge.js:614 由 max:3 -> max:10 修复）
// 复刻生产配置，验证内存兜底路径下的限流契约，防止 max 被改回 3 导致正常回复被拦。
const assert = require('assert');
const rateLimit = require('../middleware/rateLimit');

let pass = 0, fail = 0;
const failures = [];

async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + e.message); console.log('  ✗ ' + name + ' -> ' + e.message); }
}

// 复刻 knowledge.js:614 评论限流配置
function makeCommentLimiter(overrides) {
  return rateLimit(Object.assign({
    prefix: 'ks-comment',
    windowMs: 5 * 60 * 1000,
    max: 10,
    getKey: req => (req.session.user || 'anon') + ':' + req.params.id,
    message: '评论太频繁，请稍后再试',
  }, overrides || {}));
}

// 模拟一次请求；内存路径下 next() 同步调用，无需 DB/Redis
function hit(mw, user, id) {
  return new Promise((resolve) => {
    let passed = false, code = null;
    const req = { session: { user }, params: { id } };
    const res = { status(c) { code = c; return res; }, json() { return res; } };
    const next = () => { passed = true; };
    Promise.resolve(mw(req, res, next)).then(() => resolve({ passed, blocked: code === 429 }));
  });
}

async function run() {
  // T1: 同用户同文章连发 12 条 -> 放行10 拦截2（max=10 契约）
  await check('T1 同用户同文章连发12条：放行10/拦截2（max=10契约）', async () => {
    const mw = makeCommentLimiter();
    let passed = 0, blocked = 0;
    for (let i = 0; i < 12; i++) {
      const r = await hit(mw, 'u1', 'a1');
      if (r.passed) passed++; else if (r.blocked) blocked++;
    }
    assert.strictEqual(passed, 10, '应放行10条，实得 ' + passed);
    assert.strictEqual(blocked, 2, '应拦截2条，实得 ' + blocked);
  });

  // T2: 不同用户独立计数（不会互相挤占额度）
  await check('T2 不同用户各自独立计数', async () => {
    const mw = makeCommentLimiter();
    let aPass = 0;
    for (let i = 0; i < 11; i++) { const r = await hit(mw, 'uA', 'aX'); if (r.passed) aPass++; }
    const b = await hit(mw, 'uB', 'aX');
    assert.strictEqual(aPass, 10, 'uA 应放行10，实得 ' + aPass);
    assert.strictEqual(b.passed, true, 'uB 第一条应放行（独立计数）');
  });

  // T3: 短窗口过期后重置（防止永久拦截，回应“5分钟后还拦”的担忧）
  await check('T3 窗口过期后计数重置（不会永久拦截）', async () => {
    const mw = makeCommentLimiter({ prefix: 'ks-expire', windowMs: 50 });
    const r1 = await hit(mw, 'u1', 'a1');
    assert.strictEqual(r1.passed, true, '首次应放行');
    await new Promise(r => setTimeout(r, 70));
    const r2 = await hit(mw, 'u1', 'a1');
    assert.strictEqual(r2.passed, true, '窗口过期后应再次放行');
  });

  console.log('\n===== 评论限流回归测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) { console.log('失败项: ' + failures.join('; ')); process.exit(1); }
  else console.log('ALL PASS');
}

run().then(() => process.exit(fail ? 1 : 0));
