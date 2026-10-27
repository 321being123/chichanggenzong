// ========== 2026-10-21 三视角审查回归（纯函数/轻mock） ==========
// 运行：node server/test/audit-20261021-units.test.js
// 覆盖：P-6 到期/强赎/未确认语义、P-7 名称不变量、R-1 账户名二次解码、
//       U-17/U-18 前端守卫与官方链接白名单的源码级回归。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---- pg mock（对齐 auth-security.test.js 方式）----
class FakePool {
  query(text, params) {
    FakePool.calls.push({ text, params });
    return Promise.resolve({ rowCount: 1, rows: [{ '?column?': 1 }] });
  }
}
FakePool.calls = [];
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(['PASS', name]); console.log('  [PASS] ' + name); })
    .catch(e => { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); });
}

const { classifyCallKind } = require('../services/convertibleBondRedemptionSync');
const { isCleanSecurityName } = require('../services/securityIdentity');

(async () => {
  console.log('A. P-6 到期兑付 / 提前强赎 / 未确认 三类语义');
  await check('即将到期及停止交易 → maturity（正常到期）', () => {
    assert.strictEqual(classifyCallKind('关于鸿路转债即将到期及停止交易的第一次提示性公告', 'implementation'), 'maturity');
    assert.strictEqual(classifyCallKind('关于万孚转债即将到期暨停止交易的第一次提示性公告', 'implementation'), 'maturity');
    assert.strictEqual(classifyCallKind('南方航空关于“南航转债”到期兑付暨摘牌的第三次提示性公告', 'implementation'), 'maturity');
  });
  await check('提前赎回/赎回暨摘牌 → early（提前强赎）', () => {
    assert.strictEqual(classifyCallKind('关于提前赎回“水羊转债”暨即将停止交易的重要提示性公告', 'implementation'), 'early');
    assert.strictEqual(classifyCallKind('关于实施“应流转债”赎回暨摘牌的第七次提示性公告', 'implementation'), 'early');
    assert.strictEqual(classifyCallKind('关于提前赎回“恒逸转2”的第六次提示性公告', 'exercise'), 'early');
    assert.strictEqual(classifyCallKind('应流股份关于实施“应流转债”赎回暨摘牌的公告', 'implementation'), 'early');
  });
  await check('仅停止交易等无法区分标题 → unconfirmed（未确认）', () => {
    assert.strictEqual(classifyCallKind('关于“示例转债”停止交易的公告', 'implementation'), 'unconfirmed');
    assert.strictEqual(classifyCallKind('关于示例转债赎回公告', 'implementation'), 'unconfirmed');
  });
  await check('到期与提前字样同现按提前强赎；waive/warning 不分类', () => {
    assert.strictEqual(classifyCallKind('关于提前赎回并到期兑付的公告', 'implementation'), 'early');
    assert.strictEqual(classifyCallKind('关于不提前赎回的公告', 'waive'), null);
    assert.strictEqual(classifyCallKind('关于预计触发赎回条件的公告', 'warning'), null);
    assert.strictEqual(classifyCallKind('关于可转债到期兑付结果暨股份变动的公告', 'completion'), 'maturity');
  });

  console.log('B. P-7 证券短名不变量');
  await check('干净简称通过', () => {
    for (const name of ['航亚发债', '常青转债二', '国科转债2', '三房转债', '*ST三房', 'H&H国际控股']) {
      assert.strictEqual(isCleanSecurityName(name), true, name);
    }
  });
  await check('正文残留脏名拒绝', () => {
    for (const name of ['为“航亚转债', '常青转债二、可转换公司', '国科转债2、可转换公司', '简称为“航亚转债”', '', '  ']) {
      assert.strictEqual(isCleanSecurityName(name), false, name);
    }
  });

  console.log('C. R-1 账户名二次解码（合法百分号账户）');
  await check('assertOwnership 对 100% 账户名不再抛 URIError', async () => {
    const auth = require('../middleware/auth');
    let nextArg = 'UNSET';
    await auth.assertOwnership({ session: { user: 'u1' }, params: { name: '100%' }, body: {} }, {}, (e) => { nextArg = e; });
    assert.strictEqual(nextArg, undefined, 'next 应无错误调用，实际: ' + String(nextArg));
  });
  await check('assertOwnership 对普通账户名正常放行', async () => {
    const auth = require('../middleware/auth');
    let called = false;
    await auth.assertOwnership({ session: { user: 'u1' }, params: { name: '主账户' }, body: {} }, {}, () => { called = true; });
    assert.strictEqual(called, true);
  });

  console.log('D. U-17/U-18/R-17 前端源码回归');
  const root = path.join(__dirname, '..', '..');
  // 批次4：状态与选择已拆入 Presenter，守卫断言需同时覆盖 View 与 Presenter，避免拆分让检查失效。
  const stockAnalysis = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'public', 'js', 'presenters', 'stock-analysis-presenter.js'), 'utf8');
  const bondAnalysis = fs.readFileSync(path.join(root, 'public', 'js', 'bond-analysis.js'), 'utf8');
  const positionComparison = fs.readFileSync(path.join(root, 'server', 'routes', 'positionComparison.js'), 'utf8');
  const utils = fs.readFileSync(path.join(root, 'public', 'js', 'utils.js'), 'utf8');
  const arbitrage = fs.readFileSync(path.join(root, 'public', 'js', 'arbitrage.js'), 'utf8');
  await check('U-17 切换与刷新均核对当前选择后再渲染', () => {
    // select 的乱序守卫自批次2 起改为递增序号：只比对 tsCode 无法区分 A→B→A（第一次 A 与第三次 A 同码）。
    // 两种写法都要求"回来时必须重新核对当前选择"，没有放宽检查。
    const selectGuarded = stockAnalysis.includes('if (stockAnalysisState.selected !== tsCode) return;')
      || stockAnalysis.includes('if (stockAnalysisState.selectToken !== selectToken) return;');
    assert.ok(selectGuarded, 'select 缺乱序守卫');
    assert.ok(stockAnalysis.includes('var stillCurrent = stockAnalysisState.selected === tsCode;'), 'refresh 缺乱序守卫');
  });
  await check('U-18 官方链接白名单覆盖上交所/深交所/巨潮且仅 https', () => {
    assert.ok(bondAnalysis.includes("host === 'static.cninfo.com.cn'"), '缺巨潮白名单');
    assert.ok(bondAnalysis.includes("(/(^|\\.)sse\\.com\\.cn$/).test(host)") || /sse\\\.com\\\.cn/.test(bondAnalysis), '缺上交所白名单');
    assert.ok(/szse\\\.cn/.test(bondAnalysis), '缺深交所白名单');
    assert.ok(bondAnalysis.includes('https:\\/\\/'), '必须限定 https');
  });
  await check('U-18 白名单行为：官方域名放行、非法地址拒绝', () => {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const src = bondAnalysis.match(/function bondAnalysisSourceLink\(url,label\) \{[\s\S]*?\n\}/);
    assert.ok(src, '找不到 bondAnalysisSourceLink');
    const bondAnalysisSourceLink = new Function('escapeHtml', src[0] + '; return bondAnalysisSourceLink;')(esc);
    assert.ok(bondAnalysisSourceLink('https://disc.static.szse.cn/disclosure/a.pdf', '深交所').includes('<a href='), '深交所应放行');
    assert.ok(bondAnalysisSourceLink('https://big5.sse.com.cn/disclosure/a.pdf', '上交所').includes('<a href='), '上交所应放行');
    assert.ok(bondAnalysisSourceLink('https://static.cninfo.com.cn/a.pdf', '巨潮').includes('<a href='), '巨潮应放行');
    assert.strictEqual(bondAnalysisSourceLink('http://static.cninfo.com.cn/a.pdf', '非https'), '', 'http 必须拒绝');
    assert.strictEqual(bondAnalysisSourceLink('javascript:alert(1)', '脚本'), '', '脚本协议必须拒绝');
    assert.strictEqual(bondAnalysisSourceLink('https://evil.example.com/a.pdf', '任意域'), '', '非官方域必须拒绝');
  });
  await check('R-1 仓位公开路由用 asyncHandler 包装 assertOwnership', () => {
    assert.ok(positionComparison.includes('asyncHandler(assertOwnership)'), 'positionComparison 必须包装异步中间件');
    const bareUse = positionComparison.replace(/asyncHandler\(assertOwnership\)/g, '')
      .split('\n').filter(l => l.includes('assertOwnership') && !l.includes('require('));
    assert.strictEqual(bareUse.length, 0, '不允许裸注册 assertOwnership：' + bareUse.join(' | '));
  });
  await check('R-17 全局 num/pctv 唯一定义在 utils.js', () => {
    assert.ok(utils.includes('function num(v, d)') && utils.includes('function pctv(v, d)'), 'utils.js 需提供共享格式器');
    assert.ok(!arbitrage.includes('function num(') && !arbitrage.includes('function pctv('), 'arbitrage 不得再覆盖全局格式器');
    const valuation = fs.readFileSync(path.join(root, 'public', 'js', 'bond-valuation.js'), 'utf8');
    const cycle = fs.readFileSync(path.join(root, 'public', 'js', 'bond-cycle.js'), 'utf8');
    assert.ok(!valuation.includes('function num(') && !valuation.includes('function pctv('), 'bond-valuation 不得重复定义');
    assert.ok(!cycle.includes('function num('), 'bond-cycle 不得重复定义 num');
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('PASS=' + results.filter(r => r[0] === 'PASS').length + ' FAIL=' + failed.length);
  if (failed.length) process.exit(1);
  console.log('audit-20261021-units 全部通过');
})().catch(e => { console.error(e); process.exit(1); });
