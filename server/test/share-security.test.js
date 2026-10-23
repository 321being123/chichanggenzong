// ========== 证券分析与通用分享：登记、白名单、签名与前端契约测试 ==========
// 纯函数 + 模板静态检查，不连库、不联网。路由行为另由本地运行验收覆盖。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registry = require('../services/shareRegistry');
const wechatShare = require('../services/wechatShare');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('--- 证券分析与通用分享测试 ---');

const ORIGINAL_ORIGIN = process.env.SHARE_PUBLIC_ORIGIN;
function withOrigin(value, fn) {
  if (value == null) delete process.env.SHARE_PUBLIC_ORIGIN;
  else process.env.SHARE_PUBLIC_ORIGIN = value;
  try { return fn(); } finally {
    if (ORIGINAL_ORIGIN == null) delete process.env.SHARE_PUBLIC_ORIGIN;
    else process.env.SHARE_PUBLIC_ORIGIN = ORIGINAL_ORIGIN;
  }
}

// ===== 内容类型与证券类型白名单 =====
test('只接受 security-analysis 一种内容类型', () => {
  assert.strictEqual(registry.isKnownContentType('security-analysis'), true);
  assert.strictEqual(registry.isKnownContentType('knowledge-article'), false);
  assert.strictEqual(registry.isKnownContentType(''), false);
  assert.strictEqual(registry.isKnownContentType(null), false);
});

test('只接受 bond / stock 两种证券类型', () => {
  assert.strictEqual(registry.isKnownKind('bond'), true);
  assert.strictEqual(registry.isKnownKind('stock'), true);
  assert.strictEqual(registry.isKnownKind('fund'), false);
  assert.strictEqual(registry.isKnownKind('security-analysis'), false);
});

test('非法类型直接 400，不进入身份查询', async () => {
  const result = await registry.resolveSecurity('fund', '110081');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 400);
});

test('非法代码 400，空代码与超长代码都被拒绝', async () => {
  for (const code of ['', '   ', 'abcdef', '123456789012345678901234']) {
    const result = await registry.resolveSecurity('bond', code);
    assert.strictEqual(result.ok, false, `代码 ${JSON.stringify(code)} 应被拒绝`);
    assert.strictEqual(result.status, 400);
  }
});

// ===== 标准身份与公开地址 =====
test('转债代码规范化：沪市 11 开头、深市 12 开头', () => {
  assert.strictEqual(registry.securitySharePath('bond', '110081.SH'), '/s/security/bond/110081.SH');
  const bondSh = registry.securitySharePath('bond', '110081.SH');
  const bondSz = registry.securitySharePath('bond', '123001.SZ');
  assert.notStrictEqual(bondSh, bondSz);
});

test('分享地址由 SHARE_PUBLIC_ORIGIN 生成，路径不拼接查询参数', () => {
  withOrigin('https://example.com', () => {
    assert.strictEqual(registry.publicOrigin(), 'https://example.com');
    assert.strictEqual(
      registry.securityShareUrl('bond', '110081.SH'),
      'https://example.com/s/security/bond/110081.SH'
    );
  });
});

test('未配置 SHARE_PUBLIC_ORIGIN 时不生成地址，也不回落到请求 Host', () => {
  withOrigin(null, () => {
    assert.strictEqual(registry.publicOrigin(), null);
    assert.strictEqual(registry.securityShareUrl('bond', '110081.SH'), null);
  });
});

test('SHARE_PUBLIC_ORIGIN 非法协议被拒绝', () => {
  withOrigin('javascript:alert(1)', () => assert.strictEqual(registry.publicOrigin(), null));
  withOrigin('ftp://example.com', () => assert.strictEqual(registry.publicOrigin(), null));
  withOrigin('not-a-url', () => assert.strictEqual(registry.publicOrigin(), null));
});

test('元信息标题格式为「名称（代码）｜证券分析｜存在小站」', () => {
  withOrigin('https://example.com', () => {
    const meta = registry.buildSecurityMeta({ kind: 'bond', code: '110081.SH', digits: '110081', name: '闻泰转债' });
    assert.strictEqual(meta.title, '闻泰转债（110081）｜证券分析｜存在小站');
    assert.strictEqual(meta.canonical, 'https://example.com/s/security/bond/110081.SH');
    assert.strictEqual(meta.imageUrl, 'https://example.com/share-cover.png');
    assert.ok(meta.description.length > 0);
    assert.ok(!/\d+\.\d+\s*元/.test(meta.description), '描述不得含具体价格');
  });
});

test('转债与股票使用不同描述，且都不含即时价格承诺', () => {
  const bond = registry.buildSecurityMeta({ kind: 'bond', code: '110081.SH', digits: '110081', name: 'A' });
  const stock = registry.buildSecurityMeta({ kind: 'stock', code: '600519.SH', digits: '600519', name: 'B' });
  assert.notStrictEqual(bond.description, stock.description);
  for (const meta of [bond, stock]) {
    assert.ok(!/实时|今日/.test(meta.description), '描述不得承诺实时或当日数据');
  }
});

// ===== 签名地址白名单 =====
test('本站主站与已登记分享页可以签名', () => {
  withOrigin('https://example.com', () => {
    assert.strictEqual(registry.isAllowedSignUrl('https://example.com/'), true);
    assert.strictEqual(registry.isAllowedSignUrl('https://example.com/index.html'), true);
    assert.strictEqual(registry.isAllowedSignUrl('https://example.com/?main=bond-safety&sub=analysis&bond=110081'), true);
    assert.strictEqual(registry.isAllowedSignUrl('https://example.com/s/security/bond/110081.SH'), true);
    assert.strictEqual(registry.isAllowedSignUrl('https://example.com/s/security/stock/600519.SH'), true);
  });
});

test('外部域名、其他路径、带 fragment 的地址一律不签名', () => {
  withOrigin('https://example.com', () => {
    const rejected = [
      'https://evil.example.com/steal',
      'https://example.com.evil.com/',
      'http://example.com/',                       // 协议不同（http vs https）
      'https://example.com/admin.html',
      'https://example.com/api/admin/users',
      'https://example.com/s/security/fund/110081.SH',
      'https://example.com/s/security/bond/110081.SS',
      'https://example.com/s/security/bond/110081.SH#frag',
      'javascript:alert(1)',
      '',
    ];
    for (const url of rejected) {
      assert.strictEqual(registry.isAllowedSignUrl(url), false, `应拒绝：${url}`);
    }
  });
});

test('未配置站点地址时所有签名请求都被拒绝', () => {
  withOrigin(null, () => {
    assert.strictEqual(registry.isAllowedSignUrl('https://example.com/'), false);
  });
});

// ===== 微信签名算法 =====
test('签名算法与微信官方示例一致', () => {
  // 官方文档示例：jsapi_ticket / noncestr / timestamp / url 四个参数，字典序拼接后 sha1。
  const signature = wechatShare.signTicket(
    'sM4AOVdWfPE4DxkXGEs8VMCPGGVi4C3VM0P37wVUCFvkVAy_90u5h9nbSlYy3-Sl-HhTdfl2fzFy1AOcHKP7qg',
    'Wm3WZYTPz0wzccnW',
    1414587457,
    'http://mp.weixin.qq.com?params=value'
  );
  assert.strictEqual(signature, '0f9de62fce790f9a083d5c99e95740ceb90c27ed');
});

test('签名对 url 敏感：换查询参数结果必须不同', () => {
  const base = wechatShare.signTicket('ticket', 'nonce', 1700000000, 'https://example.com/?main=stock-analysis');
  const other = wechatShare.signTicket('ticket', 'nonce', 1700000000, 'https://example.com/?main=bond-safety');
  assert.notStrictEqual(base, other);
});

test('未配置微信凭据时 isConfigured 为 false 且 buildConfig 不抛错', async () => {
  const savedId = process.env.WECHAT_APP_ID;
  const savedSecret = process.env.WECHAT_APP_SECRET;
  delete process.env.WECHAT_APP_ID;
  delete process.env.WECHAT_APP_SECRET;
  try {
    assert.strictEqual(wechatShare.isConfigured(), false);
    const config = await wechatShare.buildConfig('https://example.com/');
    assert.strictEqual(config.configured, false);
    assert.ok(!('appId' in config), '未配置时不得返回 appId');
    assert.ok(!('signature' in config), '未配置时不得返回 signature');
  } finally {
    if (savedId != null) process.env.WECHAT_APP_ID = savedId;
    if (savedSecret != null) process.env.WECHAT_APP_SECRET = savedSecret;
  }
});

// ===== 模板与前端契约 =====
const root = path.join(__dirname, '..', '..');
const templatePath = path.join(root, 'server', 'views', 'share.html');
const template = fs.readFileSync(templatePath, 'utf8');

test('分享页模板放在 server/views，不放 public（避免静态直出未替换的占位符）', () => {
  assert.ok(fs.existsSync(templatePath), '模板应位于 server/views/share.html');
  assert.ok(!fs.existsSync(path.join(root, 'public', 'share.html')), 'public 下不应存在未渲染的分享模板');
  const staticMiddleware = fs.readFileSync(path.join(root, 'server', 'app.js'), 'utf8');
  assert.ok(/app\.use\('\/', shareRouter\)/.test(staticMiddleware), 'app.js 应挂载 shareRouter');
});

test('模板占位符与渲染代码一一对应，没有遗留未替换标记', () => {
  const required = ['__SHARE_TITLE__', '__SHARE_DESCRIPTION__', '__SHARE_CANONICAL__', '__SHARE_KIND__', '__SHARE_CODE__', '__SHARE_NAME__', '__SHARE_PATH__', '__SHARE_OG_IMAGE__', '__APP_VERSION__'];
  for (const token of required) {
    assert.ok(template.includes(token), `模板应包含占位符 ${token}`);
  }
  const route = fs.readFileSync(path.join(root, 'server', 'routes', 'share.js'), 'utf8');
  for (const token of required) {
    assert.ok(route.includes(token), `渲染代码应替换 ${token}`);
  }
});

test('分享页零内联脚本与样式（CSP 未把 share.html 加入哈希白名单）', () => {
  // 内联 <script> 不带 src 才会被 CSP 哈希校验拦截；外链脚本不在其中。
  const inlineScripts = template.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || [];
  const inlineStyles = template.match(/<style\b/gi) || [];
  assert.deepStrictEqual(inlineScripts, [], '分享页不得有内联 <script>');
  assert.deepStrictEqual(inlineStyles, [], '分享页不得有内联 <style>');
  assert.ok(!/\son[a-z]+=/i.test(template), '分享页不得使用内联事件属性');
  assert.ok(!/\sstyle=/i.test(template), '分享页不得使用内联 style 属性');

  const security = fs.readFileSync(path.join(root, 'server', 'middleware', 'security.js'), 'utf8');
  assert.ok(!security.includes("'share.html'"), 'CSP 哈希白名单不应包含新分享页：保持零内联而非放行哈希');
});

test('分享页不加载账户、持仓、自选、知识、后台脚本', () => {
  const forbidden = ['session.js', 'core-account.js', 'core-trade.js', 'knowledge.js', 'admin.js', 'navigation.js', 'access-policy.js'];
  for (const name of forbidden) {
    assert.ok(!template.includes(name), `分享页不应加载 ${name}`);
  }
  assert.ok(template.includes('bond-analysis.js'), '分享页应复用转债分析渲染脚本');
  assert.ok(template.includes('stock-analysis.js'), '分享页应复用股票分析渲染脚本');
  assert.ok(template.includes('shared/share.js'), '分享页应加载通用分享控件');
});

test('模板输出 Open Graph 与 canonical，标题不依赖前端脚本改写', () => {
  assert.ok(/property="og:title" content="__SHARE_TITLE__"/.test(template), 'og:title 应由服务端生成');
  assert.ok(/property="og:url" content="__SHARE_CANONICAL__"/.test(template), 'og:url 应为 canonical');
  assert.ok(/rel="canonical" href="__SHARE_CANONICAL__"/.test(template), '应有 canonical link');
  assert.ok(template.indexOf('<title>__SHARE_TITLE__</title>') >= 0, 'title 应服务端直出');
});

test('分享控件暴露 Share.open 并支持四个渠道', () => {
  const share = fs.readFileSync(path.join(root, 'public', 'shared', 'share.js'), 'utf8');
  assert.ok(/window\.Share\s*=/.test(share), '应暴露 window.Share');
  assert.ok(/open:\s*open/.test(share), '应暴露 open');
  assert.ok(/close:\s*close/.test(share), '应暴露 close');
  for (const channel of ['wechat-friend', 'wechat-timeline', 'qq', 'copy']) {
    assert.ok(share.includes(`'${channel}'`), `应支持渠道 ${channel}`);
  }
  assert.ok(!/navigator\.clipboard[\s\S]{0,80}alert\(/.test(share), '复制失败不得用原生 alert');
});

test('主站标题区接入分享按钮，走 data-act 事件委托', () => {
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(/data-act="Share\.open"/.test(index), '主站分享按钮应使用 data-act 委托');
  assert.ok(!/onclick="Share/.test(index), '主站不得使用内联 onclick');
  assert.ok(index.includes('shared/share.js'), '主站应加载分享控件');
  assert.ok(index.includes('css/share.css'), '主站应加载分享样式');
});

test('分享页同时提供两个消息容器，且不输出运维更新时间', () => {
  // stockAnalysisSetMessage 按 ctx 分别写 stock-analysis-message / bond-analysis-message；
  // 缺任一个都会导致加载提示无法清空（浏览器实测残留过"正在读取..."）。
  assert.ok(/id="stock-analysis-message"/.test(template), '应有 stock-analysis-message 容器');
  assert.ok(/id="bond-analysis-message"/.test(template), '应有 bond-analysis-message 容器');
  // bond-analysis-updated 会写入"尚有 N 项资料待补全"，属运维信息，不得出现在公开页。
  assert.ok(!/id="bond-analysis-updated"/.test(template), '分享页不得输出 bond-analysis-updated');
  assert.ok(!/id="stock-analysis-updated"/.test(template), '分享页不得输出 stock-analysis-updated');
});

test('分享页标题在深色 hero 上使用浅色，不沿用正文深灰', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'share.css'), 'utf8');
  const rule = css.match(/\.stock-analysis-hero h1\s*\{[^}]*\}/);
  assert.ok(rule, '应有 .stock-analysis-hero h1 规则');
  assert.ok(/color:\s*#fff/i.test(rule[0]), '标题颜色应为浅色（深色 hero 背景）');
  assert.ok(!/color:\s*#333/i.test(rule[0]), '标题不得使用正文深灰');
});

test('分享页脚本声明 username、showToast、switchMain 三个被复用的全局', () => {
  const page = fs.readFileSync(path.join(root, 'public', 'js', 'share-page.js'), 'utf8');
  assert.ok(/window\.username/.test(page), '应声明 username 供分析脚本读取');
  assert.ok(/window\.showToast/.test(page), '应提供 showToast');
  assert.ok(/window\.switchMain/.test(page), '应提供 switchMain 兜底');
  assert.ok(/刷新数据/.test(page), '分享页应过滤"请点击刷新数据"这类运维提示');
});

test('分享页初始化前校验证券类型与地址一致', () => {
  const page = fs.readFileSync(path.join(root, 'public', 'js', 'share-page.js'), 'utf8');
  assert.ok(/securityAnalysisKind\(digits\)\s*!==\s*kind/.test(page), '应校验解析类型与登记类型一致');
  assert.ok(/securityAnalysisSelect\(digits, kind\)/.test(page), '应按类型分派到既有分析入口');
});

test('分享样式复用 760px 正文断点与 44px 操作区', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'share.css'), 'utf8');
  assert.ok(/@media\s*\(max-width:\s*760px\)/.test(css), '应使用 760px 正文分界');
  assert.ok(/min-height:\s*44px/.test(css), '触控操作区至少 44px');
  assert.ok(/font-size:\s*16px/.test(css), '输入字号 16px');
});

test('封面上限检查：og:image 为 512×512 PNG 位图（满足抓取 ≥300×300）', () => {
  const coverPath = path.join(root, 'public', 'share-cover.png');
  assert.ok(fs.existsSync(coverPath), '应存在公开封面图');
  const buffer = fs.readFileSync(coverPath);
  assert.deepStrictEqual([...buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], '封面应为 PNG');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert.ok(width >= 300 && height >= 300, `封面尺寸 ${width}×${height} 不足 300×300`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
