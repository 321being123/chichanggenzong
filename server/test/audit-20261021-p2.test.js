// ========== 2026-10-21 三视角审查「需专项验证」批回归 ==========
// 运行：node server/test/audit-20261021-p2.test.js
// 覆盖：R-2 默认拒绝、R-3 异步统一、R-4 错误 requestId、R-12 请求体收敛、
//       U-6 非悬停状态、U-9 断点/触控、U-11 对比度色、R-8 敏感文件迁出。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

console.log('A. R-3 异步处理函数统一 asyncHandler');
check('knowledge.js 全部 async 路由处理函数被 asyncHandler 包装', () => {
  const src = read('server/routes/knowledge.js');
  const arrows = src.split('\n').filter(l => l.includes('async (req, res) => {'));
  const wrapped = arrows.filter(l => l.includes('asyncHandler(async (req, res) => {'));
  assert.strictEqual(arrows.length, wrapped.length, '存在未包装的 async 处理函数');
  assert.ok(src.includes("require('../middleware/async')"), '缺少 asyncHandler 引入');
});
check('ipo.js 全部 async 路由处理函数被 asyncHandler 包装', () => {
  const src = read('server/routes/ipo.js');
  const arrows = src.split('\n').filter(l => l.includes('async (req, res) => {'));
  const wrapped = arrows.filter(l => l.includes('asyncHandler(async (req, res) => {'));
  assert.strictEqual(arrows.length, wrapped.length, '存在未包装的 async 处理函数');
});
check('进程入口有失控异常兜底（记录后退出，不吞异常）', () => {
  for (const file of ['server.js', 'server/worker.js']) {
    const src = read(file);
    assert.ok(src.includes('unhandledRejection') && src.includes('uncaughtException'), file + ' 缺进程级兜底');
    assert.ok(src.includes('process.exit(1)'), file + ' 必须有序退出而不是继续带病运行');
  }
});

console.log('B. R-4 错误响应统一携带 requestId');
check('requestId 中间件给 { error } 响应注入 requestId', () => {
  const src = read('server/middleware/errorHandler.js');
  assert.ok(src.includes('body.requestId === undefined'), '缺少 requestId 注入逻辑');
  // 行为验证：模拟 res.json 注入（requestId 由中间件生成，错误响应必须携带同一请求号）
  const { requestId } = require('../middleware/errorHandler');
  let sent = null;
  const req = { headers: {}, method: 'GET', path: '/x' };
  const res = {
    setHeader: () => {},
    json: function (body) { sent = body; return this; },
  };
  requestId(req, res, () => {});
  assert.ok(req.id, '中间件必须生成请求号');
  res.json({ error: '出错了' });
  assert.strictEqual(sent.requestId, req.id, '错误响应缺 requestId');
  sent = null;
  res.json({ ok: true, data: 1 });
  assert.strictEqual(sent.requestId, undefined, '成功响应不应被注入 requestId');
});

console.log('C. R-12 请求体上限收敛');
check('全局 JSON 上限收敛到 1MB，大体积仅限登记路由', () => {
  const src = read('server/app.js');
  assert.ok(src.includes("express.json({ limit: '1mb'"), '全局上限应为 1mb');
  assert.ok(!/app\.use\(express\.json\(\{ limit: '15mb'/.test(src), '全局不得再直接放开 15mb');
  for (const p of ['/api/vision-parse', '/api/vision-upload', '/api/excel-parse', '/api/excel-history-parse', '/api/knowledge/articles']) {
    assert.ok(src.includes(p), '缺少大体积路由登记：' + p);
  }
  assert.ok(src.includes('import-snapshot'), '缺少整包恢复路由登记');
});

console.log('D. U-6/U-9/U-11 可访问性');
check('U-6 无价格/涨跌状态有可见文案与 aria-label，不依赖悬停', () => {
  const src = read('public/shared/core-tables.js');
  assert.ok(src.includes('⟳ 无价') && src.includes('aria-label="无价格数据"'), '无价格状态缺可见文案');
  assert.ok(src.includes('⟳ 无跌') && src.includes('aria-label="无涨跌数据"'), '无涨跌状态缺可见文案');
});
check('U-9 720px 例外断点已归入 760/900 双分界，触控设备有 44px 保障', () => {
  const src = read('public/shared/style.css');
  assert.ok(!/max-width:\s*720px/.test(src), '仍有 720px 断点残留');
  assert.ok(src.includes('@media (pointer: coarse) and (min-width: 761px)'), '缺 761px 以上触控 44px 规则');
});
check('U-11 小字浅灰不再使用不达 AA 的颜色', () => {
  const bad = /color:\s*#(?:8c8c8c|888888|999999|aaaaaa|777777|888|999|aaa|777)(?![0-9a-fA-F])/i;
  for (const file of ['public/shared/style.css', 'public/login.html', 'public/js/admin.js', 'public/js/ipo.js', 'public/shared/core-tables.js']) {
    assert.ok(!bad.test(read(file)), file + ' 仍存在低对比灰字');
  }
});

console.log('E. R-8 敏感文件与探针已迁出仓库根');
check('仓库根不再保留真实持仓备份与生产 dump', () => {
  for (const f of ['huatai_backup_20260803.json', '_tmp_prod_api.json', '_tmp_prod_151.json']) {
    assert.ok(!fs.existsSync(path.join(root, f)), f + ' 不应留在仓库根');
  }
});
check('仓库根 _tmp 探针文件已清零', () => {
  const left = fs.readdirSync(root).filter(f => f.startsWith('_tmp'));
  assert.strictEqual(left.length, 0, '残留探针：' + left.join(','));
});

console.log('F. R-2 后台未登记路径默认拒绝（源码回归）');
check('admin 能力派发保持默认拒绝与员工白名单', () => {
  const src = read('server/routes/admin.js');
  assert.ok(src.includes('const STAFF_ONLY_PATHS'), '白名单缺失');
  assert.ok(src.includes('该后台接口未登记所需能力'), '未登记路径必须显式拒绝');
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('PASS=' + results.filter(r => r[0] === 'PASS').length + ' FAIL=' + failed.length);
if (failed.length) process.exit(1);
console.log('audit-20261021-p2 全部通过');
