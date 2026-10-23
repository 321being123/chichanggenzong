// ========== 前端 vendored 依赖版本一致性 ==========
// 背景：DOM 净化库以 vendor 文件形式被页面直接引用，不经过打包。
// 只改 package.json 不会更新浏览器实际加载的代码，必须同步替换 vendor 文件与页面缓存参数。
// 本轮 dompurify 3.4.16 → 3.4.17 修复 GHSA-cg2g-xh64-v4q7 / GHSA-mrv2-3pqr-j5jr / GHSA-c6gr-qvv4-5v3f。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('--- vendored 依赖版本一致性 ---');

const vendorPath = path.join(root, 'public', 'vendor', 'dompurify.min.js');
const vendorSource = fs.readFileSync(vendorPath, 'utf8');

function vendorVersion() {
  const matched = vendorSource.match(/DOMPurify\s+(\d+\.\d+\.\d+)/);
  assert.ok(matched, 'vendor 文件头应包含 DOMPurify 版本号');
  return matched[1];
}

function declaredVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const raw = (pkg.dependencies && pkg.dependencies.dompurify) || '';
  const matched = String(raw).match(/(\d+\.\d+\.\d+)/);
  assert.ok(matched, `package.json 应声明 dompurify 版本，实际为 ${JSON.stringify(raw)}`);
  return matched[1];
}

function pageVersionRefs() {
  const pages = ['index.html', 'ipo-report.html', 'share-knowledge.html'];
  const refs = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, 'public', page), 'utf8');
    const matched = html.match(/dompurify\.min\.js\?v=([\d.]+)/);
    assert.ok(matched, `${page} 应引用带版本参数的 dompurify`);
    refs.push({ page, version: matched[1] });
  }
  return refs;
}

test('vendor 文件版本不低于修复版 3.4.17', () => {
  const version = vendorVersion();
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(
    major > 3 || (major === 3 && (minor > 4 || (minor === 4 && patch >= 17))),
    `vendor 版本 ${version} 仍受 GHSA-cg2g-xh64-v4q7 等影响，需 >= 3.4.17`
  );
});

test('package.json 声明版本与 vendor 实际文件一致', () => {
  assert.strictEqual(
    declaredVersion(), vendorVersion(),
    `package.json 声明 ${declaredVersion()}，vendor 实际 ${vendorVersion()}：只改依赖声明不会更新浏览器加载的代码`
  );
});

test('三个引用页面的缓存参数与 vendor 版本一致', () => {
  const version = vendorVersion();
  for (const ref of pageVersionRefs()) {
    assert.strictEqual(ref.version, version, `${ref.page} 缓存参数 ${ref.version} 与 vendor ${version} 不一致，浏览器会继续用旧缓存`);
  }
});

test('vendor 文件是可直接 <script> 引入的完整产物', () => {
  assert.ok(vendorSource.length > 20000, `文件过小（${vendorSource.length} 字节），可能下载不完整`);
  assert.ok(/DOMPurify/.test(vendorSource), '应包含 DOMPurify 导出');
  assert.ok(!/^\s*<!doctype/i.test(vendorSource), '不应是 HTML 错误页');
  assert.ok(!/^\s*<html/i.test(vendorSource), '不应是 HTML 错误页');
});

test('净化调用未启用受本次漏洞影响的选项', () => {
  // 三个 CVE 分别依赖 SAFE_FOR_TEMPLATES、IN_PLACE+hook、PARSER_MEDIA_TYPE=application/xhtml+xml。
  // 当前用法是默认 HTML 净化，不含上述能力；若将来启用需重新评估对应的缓解措施。
  const safe = fs.readFileSync(path.join(root, 'public', 'shared', 'md-safe.js'), 'utf8');
  assert.ok(/DOMPurify\.sanitize/.test(safe), '净化入口应在 md-safe.js');
  for (const risky of ['SAFE_FOR_TEMPLATES', 'IN_PLACE', 'addHook', 'PARSER_MEDIA_TYPE']) {
    assert.ok(!safe.includes(risky), `净化配置不应使用 ${risky}（会命中本次漏洞的利用条件）`);
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
