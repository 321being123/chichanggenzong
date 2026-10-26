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
// 2026-10-23：原「版本记录」一级页并入「反馈」，feedback 成为公开页；changelog 保留为旧址公开别名
const expectedPublic = ['home', 'knowledge', 'stock-analysis', 'bond-safety', 'market-volatility', 'ipo', 'arbitrage', 'feedback', 'changelog'];
ok(JSON.stringify(publicPages) === JSON.stringify(expectedPublic),
  '公开页面应为 ' + expectedPublic.join(',') + '，实际为 ' + publicPages.join(','));

// 站内通知属本人数据，必须登录（2026-10-25）
const expectedProtected = ['holdings', 'profile', 'position-compare', 'notifications'];
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

// 可转债子页初始化必须只加载当前 URL 对应的子页，避免上市列表首开重复请求安全性整表。
ok(nav.includes('if (typeof initBondCycleSub === \'function\') initBondCycleSub();') &&
  !nav.includes('{ loadBondSafety(); if (typeof initBondCycleSub'),
  '进入可转债列表时不得额外加载安全性列表');
ok(html.includes('initBondCycleSub 已按当前 URL 恢复可转债子页') && !html.includes('switchBondSub(requestedSub);'),
  '初始化后不得再次重复加载可转债子页');

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
// 例外：changelog 是 2026-10-23 保留的旧址公开别名，启动段与 switchMain 会归一化为 feedback/sub=versions，
// 因此不再有独立容器，但必须仍有归一化逻辑（由 feedback-static.test.js 覆盖）。
const PUBLIC_ALIASES = ['changelog'];
allowedPages.forEach(p => ok(pageIds.includes(p) || navMains.includes(p) || PUBLIC_ALIASES.includes(p),
  'allowedPages 中的 ' + p + ' 在 index.html 找不到对应 data-main 或 #main- 容器'));

// ===== UI-01：清理无效入口并补齐管理员入口 =====
// 交易历史的“清空记录”按钮与无调用方的 clearTrades() 已删除
ok(!/清空记录/.test(html), 'index.html 不应再保留“清空记录”按钮');
ok(!/onclick="clearTrades\(\)"/.test(html), 'index.html 不应再调用 clearTrades()');
ok(!/function clearTrades\(/.test(coreTrade), 'core-trade.js 不应再保留无调用方的 clearTrades()');
// 头像改为下拉菜单，固定含 个人中心 / 版本记录 / 退出登录
// 注：FRONT-01 拆分后头像菜单由 js/session.js 的 renderTopUser 渲染，断言跟随代码位置
ok(html.includes('个人中心') || sess.includes('个人中心'), '头像菜单缺少“个人中心”');
// 2026-10-26：反馈与版本已并回一级导航「反馈」tab，头像菜单不再重复提供，且不应再出现
ok(!/label:\s*['"]反馈与版本['"]/.test(sess), '头像菜单不应再保留“反馈与版本”');
ok(html.includes('退出登录') || sess.includes('退出登录'), '头像菜单缺少“退出登录”');
ok(html.includes("switchMain('profile')") || sess.includes("switchMain('profile')"), '个人中心菜单项未接入个人中心页');
ok(!sess.includes("switchMain('feedback')"), '头像菜单不应再挂反馈页入口');
ok(html.includes('logout()') || sess.includes('logout()'), '退出登录菜单项未接入退出逻辑');
// 管理后台入口仅管理员可见（role === 'admin' 时挂 /admin.html）
ok((html.includes('isAdmin') || sess.includes('isAdmin')) && (html.includes("'/admin.html'") || sess.includes("'/admin.html'")),
  '管理后台入口未按要求（仅管理员）接入 /admin.html');
ok(!/^\s*<a [^>]*admin\.html/.test(html), '管理后台入口不应在 HTML 中硬编码为常驻链接');
// 菜单样式存在
ok(css.includes('.nav-user-menu') && css.includes('.nav-user-item'), '缺少头像下拉菜单样式');

// ===== UI-02：一级导航按用户任务重排（平铺）=====
// 一级入口：首页、投资笔记、持仓管理、打新日历、可转债、证券分析、市场周期、反馈（原「版本记录」，2026-10-23 并入反馈）
const EXPECTED_MAIN_TABS = [
  { main: 'home', label: '首页' },
  { main: 'knowledge', label: '投资笔记' },
  { main: 'holdings', label: '持仓管理' },
  { main: 'ipo', label: '打新日历' },
  { main: 'bond-safety', label: '可转债' },
  { main: 'stock-analysis', label: '证券分析' },
  { main: 'market-volatility', label: '市场周期' },
  { main: 'feedback', label: '反馈' }
];
EXPECTED_MAIN_TABS.forEach(function (t) {
  ok(html.includes('data-main="' + t.main + '"') && html.includes('>' + t.label + '<'),
    '一级导航缺少“' + t.label + '”入口');
});
// 研究工具已拆为独立一级入口，不再以下拉形式存在
ok(!html.includes('data-dropdown="research"'), '研究工具不应再以下拉触发器存在');
ok(!html.includes('id="research-menu"'), '不应再保留研究工具下拉菜单');
// 旧一级入口已收敛（不再作为一级 tab 出现）
['股债分析','股市周期'].forEach(function (old) {
  ok(!new RegExp('class="main-tab" data-main="[^"]*"[^>]*>' + old + '<').test(html), '旧一级入口“' + old + '”应已移走/重排');
});
// 删除全局劫持 Ctrl+R / F5（恢复浏览器标准刷新）
ok(!/keydown[\s\S]{0,120}F5[\s\S]{0,80}preventDefault/.test(html), '不应再全局劫持 F5/Ctrl+R');
// 导航写入历史（pushState），支持前进/后退（popstate）
// 注：FRONT-01 拆分后 switchMain/setupMainNav 位于 js/navigation.js
ok(html.includes('history.pushState') || nav.includes('history.pushState'), 'switchMain 应使用 pushState 写入历史');
ok(html.includes('popstate') || nav.includes('popstate'), '应监听 popstate 支持浏览器前进/后退');

// ===== UI-03：可转债分析已收敛到统一证券分析入口 =====
// 可转债专题子导航仅含三类能力：安全性 / 周期 / 估值，不再有独立“个券分析”子项
['safety','cycle','valuation'].forEach(function (sub) {
  ok(new RegExp('class="bond-sub-tab[^"]*"[^>]*data-sub="' + sub + '"').test(html), '可转债子导航缺少子项 ' + sub);
});
ok(!/data-sub="analysis"/.test(html), '可转债子导航不应再保留独立 analysis 子项');
// 可转债分析内容块仍存在于页面（通过统一证券分析入口触发），不再有独立 sub-bond-analysis 子页
ok(html.includes('id="bond-analysis-content"'), '缺少可转债分析内容块 bond-analysis-content');
ok(html.includes('id="main-stock-analysis"') && html.includes('id="bond-analysis-content"'), '可转债分析内容块应内嵌于统一证券分析页');
ok(!html.includes('id="sub-bond-analysis"'), '不应再保留独立的可转债个券分析子页容器');
// 统一证券分析入口：名称联想下拉框 + 提交/刷新回调
ok(html.includes('id="stock-analysis-suggestions"') && html.includes('aria-autocomplete="list"'), '统一证券分析缺少名称联想下拉框');
ok(html.includes('data-act="securityAnalysisSubmit"') && html.includes('data-act="securityAnalysisRefresh"'), '统一证券分析入口缺少提交/刷新回调');
// 旧转债分析深链（main=stock-analysis&code=转债）自动映射到可转债分析
ok(html.includes("securityAnalysisKind(maybeCode) === 'bond'"), '旧转债深链未做自动映射');

// ===== 反馈页子栏目使用全站二级标题导航（2026-10-25：去掉独立 FEEDBACK hero 卡片） =====
ok(html.includes('class="bond-sub-nav fb-sub-nav"'), '反馈子栏目应复用全站二级标题导航 bond-sub-nav');
ok(/class="bond-sub-tab active"[^>]*data-fb-sub="versions"/.test(html), '「版本更新」应为默认激活的二级标题');
// 默认子页＝版本更新（2026-10-25 反馈：点击「反馈」直接看版本改了什么）
const feedbackJs = fs.readFileSync(path.join(root, 'public/js/feedback.js'), 'utf8');
ok(/sub:\s*'versions'/.test(feedbackJs), '反馈页初始子页应为版本更新');
ok(/SUBS\.indexOf\(sub\) >= 0 \? sub : 'versions'/.test(feedbackJs), '无 sub 参数或非法 sub 时应回落到版本更新');
ok(!html.includes('fb-hero'), '反馈页不应再有独立 FEEDBACK hero 卡片');
// 页面内不再放「提交反馈」按钮：统一由左侧全局悬浮入口（feedback-fab）承担
ok(!html.includes('data-fb-act="open-form"'), '反馈页不应再有页面内「提交反馈」按钮');
ok(!fs.readFileSync(path.join(root, 'public/js/feedback.js'), 'utf8').includes('data-fb-act="open-form"'),
  '反馈列表工具栏不应再有「提交反馈」按钮');
// 子栏目必须保持 .bond-sub-nav 的默认对齐，否则激活下划线不贴导航条底边（2026-10-25 样式回归）
ok(!/\.fb-sub-nav\s*\{[^}]*align-items/.test(fs.readFileSync(path.join(root, 'public/css/feedback.css'), 'utf8')),
  'feedback.css 不得覆盖 .bond-sub-nav 的 align-items');

// ===== 日期输入框：点击整框唤起原生选择器（2026-10-25 全站统一交互） =====
const uiActions = fs.readFileSync(path.join(root, 'public', 'shared', 'ui-actions.js'), 'utf8');
ok(uiActions.includes('showPicker'), 'shared/ui-actions.js 应统一处理日期框点击唤起选择器');
ok(/input\[type="date"\], input\[type="month"\], input\[type="datetime-local"\]/.test(uiActions),
  '日期框统一交互应覆盖 date / month / datetime-local 三类输入');
// 鼠标按下即阻止原生聚焦，否则框内会出现「年」被选中的分段高亮（2026-10-25 反馈）
ok(/addEventListener\('mousedown'[\s\S]{0,300}?preventDefault/.test(uiActions),
  '日期框应阻止原生分段选中，避免出现年/月/日选中态');
['public/index.html', 'public/admin.html'].forEach(function (rel) {
  ok(fs.readFileSync(path.join(root, rel), 'utf8').includes('shared/ui-actions.js'),
    rel + ' 必须加载 shared/ui-actions.js，否则日期框统一交互不生效');
});

// ===== 筛选栏控件统一外观（2026-10-25 反馈：后台输入框/日期框走原生样式） =====
const styleCss = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
ok(/\.filter-bar input:not\(\[type=checkbox\]\):not\(\[type=radio\]\)[\s\S]{0,500}?border-radius:\s*7px/.test(styleCss),
  '后台筛选栏输入控件应统一为 7px 圆角规范');
ok(/\.filter-bar select\s*\{[\s\S]{0,300}?height:\s*36px/.test(styleCss),
  '后台筛选栏下拉框应与输入框同高（36px）');
ok(/\.filter-bar[\s\S]{0,600}?input\[type="date"\][\s\S]{0,120}?width:\s*150px/.test(styleCss),
  '后台筛选栏日期框应统一宽度');

// ===== 站内通知：铃铛常驻 + 通知页三级子栏目 + 登录页保护（2026-10-25） =====
const sessionJs = fs.readFileSync(path.join(root, 'public/js/session.js'), 'utf8');
ok(/function buildBell\(/.test(sessionJs) && /nav-bell-badge/.test(sessionJs),
  'session.js 应构建常驻铃铛与未读徽标');
// 铃铛必须在头像按钮之前插入（头像左侧），不能反过来
ok(sessionJs.indexOf('wrap.appendChild(buildBell())') >= 0
  && sessionJs.indexOf('wrap.appendChild(buildBell())') < sessionJs.lastIndexOf('wrap.appendChild(button)'),
  '铃铛应挂在头像左侧');
ok(/total > 99 \? '99\+'/.test(sessionJs), '未读超过 99 应显示 99+');
ok(/stopNotificationPolling\(\)/.test(sessionJs) && /document\.hidden/.test(sessionJs),
  '隐藏时必须暂停轮询，退出登录必须清理计时器');
ok(/if \(seq !== notifPoll\.seq \|\| who !== username\) return null;/.test(sessionJs),
  '旧响应不得覆盖新未读数');
ok(html.includes('id="main-notifications"'), '缺少站内通知一级页容器');
ok(/data-nt-sub="all"[\s\S]{0,200}?data-nt-sub="feedback"[\s\S]{0,200}?data-nt-sub="system"/.test(html),
  '通知页应有全部/反馈/系统三个子栏目');
const notificationsJs = fs.readFileSync(path.join(root, 'public/js/notifications.js'), 'utf8');
ok(/params\.set\('sub', state\.sub\)/.test(notificationsJs) && /notification/.test(notificationsJs),
  '通知页应把子栏目与正文编号写进地址栏，支持刷新与返回恢复');
ok(!/markRead\([^)]*\);\s*render\(\);\s*loadFirst/.test(notificationsJs),
  '打开列表不得自动已读');
ok(/data-nt-act="readall"/.test(notificationsJs), '通知页应提供全部已读入口');
// 2026-10-25 验收反例：同一浏览器换账号 / 删号后同名重注册都不得复用上一个人的通知缓存。
// 只比对用户名不够——同名重注册用户名相同但账号身份不同，必须绑定不可复用身份。
ok(/user:\s*who,\s*identity:\s*identity/.test(notificationsJs), '通知列表快照必须同时记录登录名与账号身份');
ok(/data\.identity !== identity/.test(notificationsJs) && /clearSnapshot\(\)/.test(notificationsJs),
  '快照的账号身份与当前身份不一致时必须丢弃');
ok(/function ownerKey\(\)/.test(notificationsJs) && /'u:'\s*\+\s*who\s*\+\s*'\|id:'\s*\+\s*currentIdentity\(\)/.test(notificationsJs),
  '列表归属键必须同时包含用户名与账号身份（只用建号时间会把不同账号判成同一人）');
ok(/state\.owner/.test(notificationsJs) && /switched/, '换账号（含同名重注册）必须整体丢弃内存列表与详情');
ok(/firstMount/.test(notificationsJs), '首次挂载不能误判为换账号而丢弃快照');
ok(/clearCache:\s*clearCache/.test(notificationsJs), '通知模块必须导出 clearCache 供退出登录清理');
const sessionSrc = fs.readFileSync(path.join(root, 'public/js/session.js'), 'utf8');
ok(/accountIdentity\s*=\s*String\(d\.accountIdentity/.test(sessionSrc), 'session.js 必须保存 /api/me 返回的账号身份');
ok(/async function logout\(\)[\s\S]{0,200}?clearNotificationCache\(\)/.test(sessionSrc),
  '退出登录必须清理通知缓存');
ok(/if \(!d\.username\)[\s\S]{0,200}?clearNotificationCache\(\)/.test(sessionSrc),
  '会话失效（含账号被删）时必须清理通知缓存');
const authRouteSrc = fs.readFileSync(path.join(root, 'server/routes/auth.js'), 'utf8');
ok(/accountIdentity:\s*String\(a\.account_identity/.test(authRouteSrc), '/api/me 必须返回不可复用的账号身份');
const usersSrc = fs.readFileSync(path.join(root, 'server/db/users.js'), 'utf8');
ok(/AS account_identity/.test(usersSrc), 'getUserAuth 必须带出与收件人同口径的账号身份');
ok(html.includes('js/notifications.js'), '首页必须加载 js/notifications.js');
const accessPolicyJs = fs.readFileSync(path.join(root, 'public/js/access-policy.js'), 'utf8');
ok(/protectedPages[\s\S]{0,200}'notifications'/.test(accessPolicyJs), '通知页必须要求登录');
const navigationJs = fs.readFileSync(path.join(root, 'public/js/navigation.js'), 'utf8');
ok(navigationJs.includes("main === 'notifications'"), 'navigation.js 应派发通知页入口');
ok(/\.nav-bell[\s\S]{0,300}?width:\s*36px/.test(styleCss), '铃铛应有共享样式（shared/style.css）');
ok(/\.nav-bell-badge\[hidden\]\s*\{\s*display:\s*none/.test(styleCss), '未读为 0 时徽标必须隐藏');

// 后台：站内通知仅系统管理员可见，接口路径派发为 admin_only
const adminHtml = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
ok(/data-view="notifications" data-admin-only="1"/.test(adminHtml), '后台菜单应标记站内通知仅管理员可见');
ok(adminHtml.includes('js/admin-notifications.js'), '后台必须加载 admin-notifications.js');
const adminJs = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
ok(/dataset\.adminOnly === '1'/.test(adminJs), '后台菜单应按 adminOnly 隐藏非管理员入口');
const adminRoutes = fs.readFileSync(path.join(root, 'server/routes/admin.js'), 'utf8');
ok(/indexOf\('\/notifications'\) === 0\) return 'admin_only'/.test(adminRoutes.replace(/\s+/g, ' '))
  || adminRoutes.includes("return 'admin_only'"), '后台通知接口必须登记为仅管理员可用');

console.log('frontend-navigation: ' + checks + ' 项断言通过');
