// ACCESS-01 前端导航访问矩阵测试（静态断言，不依赖浏览器/数据库）
// 验证：统一访问矩阵存在且口径正确；switchMain（FRONT-01 拆分后位于 js/navigation.js）与
// index.html 的 URL 解析已统一复用该矩阵。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const nav = fs.readFileSync(path.join(root, 'public', 'js', 'navigation.js'), 'utf8');
const sess = fs.readFileSync(path.join(root, 'public', 'js', 'session.js'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'public', 'js', 'access-policy.js'), 'utf8');
const coreTrade = fs.readFileSync(path.join(root, 'public', 'shared', 'core-trade.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');

let checks = 0;
function ok(cond, msg) { checks++; assert.ok(cond, msg); }

// 提取 access-policy.js 中的数组成员
function arrayItems(name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\];');
  const m = policy.match(re);
  assert.ok(m, 'access-policy.js 缺少 ' + name + ' 数组');
  return m[1].replace(/\/\/.*$/gm, '').split(',').map(s => s.trim().replace(/^'|'$/g, '').replace(/^"|"$/g, '')).filter(Boolean);
}

const publicPages = arrayItems('publicPages');
const protectedPages = arrayItems('protectedPages');
// allowedPages 由 publicPages.concat(protectedPages) 推导，而非字面量数组
const allowedPages = publicPages.concat(protectedPages);

// 1) 访问矩阵口径与整改报告 ACCESS-01 一致
const expectedPublic = ['home', 'knowledge', 'stock-analysis', 'bond-safety', 'market-volatility', 'ipo', 'changelog'];
ok(JSON.stringify(publicPages) === JSON.stringify(expectedPublic),
  '公开页面应为 ' + expectedPublic.join(',') + '，实际为 ' + publicPages.join(','));

const expectedProtected = ['holdings', 'profile', 'position-compare'];
ok(JSON.stringify(protectedPages) === JSON.stringify(expectedProtected),
  '受限页面应为 ' + expectedProtected.join(',') + '，实际为 ' + protectedPages.join(','));

// allowedPages 是公开 + 受限的并集
ok(allowedPages.length === publicPages.length + protectedPages.length, 'allowedPages 应为公开与受限的并集');

// 2) switchMain 已统一复用矩阵，删除硬编码 holdings/profile 例外
// 注：FRONT-01 拆分后 switchMain 位于 js/navigation.js，断言跟随代码位置
ok(html.includes('ACCESS_POLICY.requiresLogin(main)') || nav.includes('ACCESS_POLICY.requiresLogin(main)'),
  'switchMain 应改用 ACCESS_POLICY.requiresLogin');
ok(!/!username && \(main === 'holdings' \|\| main === 'profile'\)/.test(nav),
  'switchMain 不应再硬编码 holdings/profile 例外');

// 3) 首次 URL 解析已统一复用矩阵，删除独立 publicMain
ok(html.includes('ACCESS_POLICY.isPublic(requestedMain)'), 'URL 解析应改用 ACCESS_POLICY.isPublic');
ok(!/var publicMain/.test(html), 'index.html 不应再保留独立 publicMain 变量');
ok(!/publicMain\.includes/.test(html), 'index.html 不应再引用 publicMain');

// 4) 所有导航入口（data-main）与页面容器（#main-）都必须在 allowedPages 中
const navMains = [];
const navRe = /data-main="([^"]+)"/g;
let nm;
while ((nm = navRe.exec(html))) navMains.push(nm[1]);
navMains.forEach(m => ok(allowedPages.includes(m), '导航入口 ' + m + ' 未在 allowedPages 中登记'));

const pageIds = [];
const pageRe = /id="main-([^"]+)"/g;
let pm;
while ((pm = pageRe.exec(html))) pageIds.push(pm[1]);
pageIds.forEach(p => ok(allowedPages.includes(p), '页面容器 main-' + p + ' 未在 allowedPages 中登记'));

// 5) 策略里登记的可作为 main 的页面，HTML 都应有对应容器（无孤儿配置）
allowedPages.forEach(p => ok(pageIds.includes(p) || navMains.includes(p),
  'allowedPages 中的 ' + p + ' 在 index.html 找不到对应 data-main 或 #main- 容器'));

// ===== UI-01：清理无效入口并补齐管理员入口 =====
// 交易历史的“清空记录”按钮与无调用方的 clearTrades() 已删除
ok(!/清空记录/.test(html), 'index.html 不应再保留“清空记录”按钮');
ok(!/onclick="clearTrades\(\)"/.test(html), 'index.html 不应再调用 clearTrades()');
ok(!/function clearTrades\(/.test(coreTrade), 'core-trade.js 不应再保留无调用方的 clearTrades()');
// 头像改为下拉菜单，固定含 个人中心 / 版本记录 / 退出登录
// 注：FRONT-01 拆分后头像菜单由 js/session.js 的 renderTopUser 渲染，断言跟随代码位置
ok(html.includes('个人中心') || sess.includes('个人中心'), '头像菜单缺少“个人中心”');
ok(html.includes('版本记录') || sess.includes('版本记录'), '头像菜单缺少“版本记录”');
ok(html.includes('退出登录') || sess.includes('退出登录'), '头像菜单缺少“退出登录”');
ok(html.includes("switchMain('profile')") || sess.includes("switchMain('profile')"), '个人中心菜单项未接入个人中心页');
ok(html.includes("switchMain('changelog')") || sess.includes("switchMain('changelog')"), '版本记录菜单项未接入版本记录页');
ok(html.includes('logout()') || sess.includes('logout()'), '退出登录菜单项未接入退出逻辑');
// 管理后台入口仅管理员可见（role === 'admin' 时挂 /admin.html）
ok((html.includes('isAdmin') || sess.includes('isAdmin')) && (html.includes("'/admin.html'") || sess.includes("'/admin.html'")),
  '管理后台入口未按要求（仅管理员）接入 /admin.html');
ok(!/^\s*<a [^>]*admin\.html/.test(html), '管理后台入口不应在 HTML 中硬编码为常驻链接');
// 菜单样式存在
ok(css.includes('.nav-user-menu') && css.includes('.nav-user-item'), '缺少头像下拉菜单样式');

// ===== UI-02：一级导航按用户任务重排 =====
// 一级入口：首页、我的资产、研究工具（下拉）、投资笔记
ok(html.includes('data-main="home"') && html.includes('>首页<'), '一级导航缺少“首页”入口');
ok(html.includes('data-main="holdings"') && html.includes('我的资产'), '一级导航缺少“我的资产”入口');
ok(html.includes('data-main="knowledge"') && html.includes('投资笔记'), '一级导航缺少“投资笔记”入口');
// 研究工具为下拉触发器（data-dropdown），且子项映射四个现有页面
ok(html.includes('data-dropdown="research"') && html.includes('id="research-menu"'), '研究工具未实现为下拉触发器');
['stock-analysis','bond-safety','market-volatility','ipo'].forEach(function (sub) {
  ok(html.includes('class="sub-tab" data-main="' + sub + '"'), '研究工具下拉缺少子项 ' + sub);
});
// 旧一级入口已收敛（不再作为一级 tab 出现）
['股债分析','股市周期','持仓管理','可转债','版本记录'].forEach(function (old) {
  ok(!new RegExp('class="main-tab" data-main="[^"]*"[^>]*>' + old + '<').test(html), '旧一级入口“' + old + '”应已移走/重排');
});
// 删除全局劫持 Ctrl+R / F5（恢复浏览器标准刷新）
ok(!/keydown[\s\S]{0,120}F5[\s\S]{0,80}preventDefault/.test(html), '不应再全局劫持 F5/Ctrl+R');
// 导航写入历史（pushState），支持前进/后退（popstate）
// 注：FRONT-01 拆分后 switchMain/setupMainNav 位于 js/navigation.js
ok(html.includes('history.pushState') || nav.includes('history.pushState'), 'switchMain 应使用 pushState 写入历史');
ok(html.includes('popstate') || nav.includes('popstate'), '应监听 popstate 支持浏览器前进/后退');
// 下拉样式存在
ok(css.includes('.main-tab-dropdown') && css.includes('.dropdown-menu') && css.includes('.sub-tab'), '缺少研究工具下拉样式');

// ===== UI-03：可转债产品入口收敛到统一上下文 =====
// 可转债专题子导航含四类能力：安全性 / 周期 / 估值 / 个券分析
['safety','cycle','valuation','analysis'].forEach(function (sub) {
  ok(new RegExp('class="bond-sub-tab[^"]*"[^>]*data-sub="' + sub + '"').test(html), '可转债子导航缺少子项 ' + sub);
});
// 新增“个券分析”子页容器
ok(html.includes('id="sub-bond-analysis"'), '缺少可转债个券分析子页容器 sub-bond-analysis');
// 转债分析内容块已迁入可转债专题子页，不再内嵌在股票分析页
ok(html.includes('id="sub-bond-analysis"') && html.includes('id="bond-analysis-content"'), '可转债分析内容块应位于可转债专题子页内');
ok(!/id="main-stock-analysis"[\s\S]{0,2000}id="bond-analysis-content"/.test(html), '股票分析页不应再内嵌可转债分析内容块');
// 个券分析子页自带搜索/刷新栏，回调传入 bond 上下文
ok(html.includes('id="bond-analysis-code"'), '个券分析子页缺少转债搜索输入框 bond-analysis-code');
ok(html.includes("securityAnalysisSubmit(null,'bond')"), '个券分析“开始分析”按钮未传入 bond 上下文');
ok(html.includes("securityAnalysisRefresh('bond')"), '个券分析“刷新”按钮未传入 bond 上下文');
// switchBondSub 已支持 analysis 分支（bond-cycle.js）
const bondCycleJs = fs.readFileSync(path.join(root, 'public', 'js', 'bond-cycle.js'), 'utf8');
ok(bondCycleJs.includes("getElementById('sub-bond-analysis')") && bondCycleJs.includes("sub !== 'analysis'"), 'switchBondSub 未处理 analysis 分支');
ok(bondCycleJs.includes("params.set('sub', 'analysis')"), 'switchBondSub 未把 analysis 写入深链');
// 深链解析支持 analysis 子页，并能自动带入 code 分析
ok(html.includes("['safety','cycle','valuation','analysis']"), 'URL 解析子页列表未包含 analysis');
ok(html.includes("securityAnalysisSubmit(reqCode, 'bond')"), 'analysis 深链未自动带入 code 进行分析');
// 旧转债分析深链（main=stock-analysis&code=转债）自动映射到可转债个券分析
ok(html.includes("securityAnalysisKind(maybeCode) === 'bond'"), '旧转债深链未做自动映射');

console.log('frontend-navigation: ' + checks + ' 项断言通过');
