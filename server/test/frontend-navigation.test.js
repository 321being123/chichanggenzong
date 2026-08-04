// ACCESS-01 前端导航访问矩阵测试（静态断言，不依赖浏览器/数据库）
// 验证：统一访问矩阵存在且口径正确；index.html 的 switchMain 与 URL 解析已统一复用该矩阵。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const policy = fs.readFileSync(path.join(root, 'public', 'js', 'access-policy.js'), 'utf8');

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
ok(html.includes('ACCESS_POLICY.requiresLogin(main)'), 'switchMain 应改用 ACCESS_POLICY.requiresLogin');
ok(!/!username && \(main === 'holdings' \|\| main === 'profile'\)/.test(html),
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

console.log('frontend-navigation: ' + checks + ' 项断言通过');
