// ========== 知识分享模块 回归测试 ==========
// 运行：node server/test/knowledge.test.js
// 覆盖：
//   A. P1-4 SSRF 防护（isSafeUrl）——用字面 IP，确定性、不依赖网络 DNS。
//   B. P2-2 输入长度上限常量（LIMITS）合理性自检。
// 说明：Markdown 存储型 XSS 净化已由 server/test/xss.test.js 覆盖，本文件不重复。
const assert = require('assert');
const ks = require('../routes/knowledge');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

(async () => {
  console.log('A. P1-4 SSRF 防护：isSafeUrl 必须拦截非公网/危险目标');
  assert.ok(typeof ks.isSafeUrl === 'function', 'isSafeUrl 未导出');

  // 应被拒绝（字面 IP 与非法协议/端口，均不触发真实 DNS）
  const denies = [
    ['非 http(s) 协议', 'ftp://example.com/'],
    ['file 协议', 'file:///etc/passwd'],
    ['非法 URL', 'not a url'],
    ['非 80/443 端口', 'http://93.184.216.34:22/'],
    ['IPv4 回环 127.0.0.1', 'http://127.0.0.1/'],
    ['IPv4 私网 10.x', 'http://10.0.0.1/'],
    ['IPv4 私网 192.168.x', 'http://192.168.1.1/'],
    ['IPv4 私网 172.16.x', 'http://172.16.0.1/'],
    ['云元数据 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 回环 ::1', 'http://[::1]/'],
  ];
  for (const [label, url] of denies) {
    await checkAsync('拒绝：' + label, async () => {
      assert.strictEqual(await ks.isSafeUrl(url), false, '本应拒绝：' + url);
    });
  }

  // 应被放行（字面公网 IP，不触发真实 DNS）
  const allows = [
    ['公网 IPv4 93.184.216.34', 'http://93.184.216.34/'],
    ['公网 IPv4 https 443', 'https://8.8.8.8/'],
  ];
  for (const [label, url] of allows) {
    await checkAsync('放行：' + label, async () => {
      assert.strictEqual(await ks.isSafeUrl(url), true, '本应放行：' + url);
    });
  }

  console.log('B. P2-2 输入长度上限常量存在且合理');
  check('LIMITS 已导出且为对象', () => {
    assert.ok(ks.LIMITS && typeof ks.LIMITS === 'object', 'LIMITS 缺失');
  });
  check('各上限均为正整数', () => {
    for (const k of Object.keys(ks.LIMITS)) {
      const v = ks.LIMITS[k];
      assert.ok(Number.isInteger(v) && v > 0, '上限 ' + k + ' 非正整数: ' + v);
    }
  });

  console.log('C. P2-1 服务端摘要生成：不信任前端、去掉 Markdown 标记');
  assert.ok(typeof ks.deriveSummary === 'function', 'deriveSummary 未导出');
  check('去除代码块/图片/链接标记并截断', () => {
    const md = '# 标题\n\n这是正文。```code``` 看 ![图](http://x/a.png) 和 [链接](http://x)。';
    const s = ks.deriveSummary(md);
    assert.ok(!s.includes('```'), '仍含代码块标记');
    assert.ok(!s.includes('![图]'), '仍含图片标记');
    assert.ok(!s.includes('http://x'), '仍含原始链接地址');
    assert.ok(s.includes('标题') && s.includes('正文'), '正文文字丢失');
    assert.ok(s.length <= ks.LIMITS.summary, '摘要超过上限');
  });
  check('超长正文生成的摘要被截断到上限', () => {
    const long = '字'.repeat(ks.LIMITS.summary + 500);
    const s = ks.deriveSummary(long);
    assert.strictEqual(s.length, ks.LIMITS.summary, '未截断到 summary 上限');
  });

  console.log('D. P2-4 正文内嵌图片校验：类型/大小/SVG');
  assert.ok(typeof ks.validateImages === 'function', 'validateImages 未导出');
  // 构造 6MB 的合法 PNG base64（约 8MB base64 长度，超过单图 5MB）
  const bigB64 = 'A'.repeat(8 * 1024 * 1024);
  check('拒绝 SVG 图片', () => {
    const c = '![x](data:image/svg+xml;base64,PHN2Zz4=)';
    const r = ks.validateImages(c);
    assert.strictEqual(r.ok, false, 'SVG 应被拒绝');
  });
  check('拒绝非允许图片格式', () => {
    const c = '![x](data:image/bmp;base64,QUJD)';
    const r = ks.validateImages(c);
    assert.strictEqual(r.ok, false, 'bmp 应被拒绝');
  });
  check('拒绝单图超过 5MB', () => {
    const c = '![x](data:image/png;base64,' + bigB64 + ')';
    const r = ks.validateImages(c);
    assert.strictEqual(r.ok, false, '超大单图应被拒绝');
  });
  check('允许常见 Web 图片且总量受控', () => {
    const ok = '![a](data:image/png;base64,iVBORw0KGgo=) ![b](data:image/jpeg;base64,QUJD)';
    const r = ks.validateImages(ok);
    assert.strictEqual(r.ok, true, '正常小图应放行：' + (r.error || ''));
  });
  check('空正文通过校验', () => {
    assert.strictEqual(ks.validateImages('').ok, true);
    assert.strictEqual(ks.validateImages(null).ok, true);
  });

  console.log('E. 评论昵称必须来自用户资料');
  check('优先使用资料昵称并去除首尾空格', () => {
    assert.strictEqual(ks.resolveCommentNickname('  小明  ', 'user01'), '小明');
  });
  check('资料昵称为空时使用登录名', () => {
    assert.strictEqual(ks.resolveCommentNickname('', 'user01'), 'user01');
  });
  check('资料昵称遵守评论昵称长度上限', () => {
    assert.strictEqual(
      ks.resolveCommentNickname('名'.repeat(ks.LIMITS.commentNick + 10), 'user01').length,
      ks.LIMITS.commentNick
    );
  });

  console.log('F. 分类权限边界');
  check('有知识写作权限的用户可以新增分类', () => {
    const layer = ks.stack.find(item => item.route && item.route.path === '/categories' && item.route.methods.post);
    const middlewareNames = layer.route.stack.map(item => item.handle.name);
    assert.ok(middlewareNames.includes('requireKsWrite'), '新增分类未使用知识写作权限');
  });
  check('分类修改和删除仅限分类所有者', () => {
    const layers = ks.stack.filter(item => item.route && item.route.path === '/categories/:id');
    for (const method of ['put', 'delete']) {
      const layer = layers.find(item => item.route.methods[method]);
      const middlewareNames = layer.route.stack.map(item => item.handle.name);
      assert.ok(middlewareNames.includes('requireCategoryOwner'), method + ' 未校验分类所有者');
    }
  });
  check('分类拖拽移动仅限分类所有者', () => {
    const layer = ks.stack.find(item => item.route && item.route.path === '/categories/:id/move' && item.route.methods.post);
    assert.ok(layer, '缺少分类移动接口');
    const middlewareNames = layer.route.stack.map(item => item.handle.name);
    assert.ok(middlewareNames.includes('requireCategoryOwner'), '分类移动未校验分类所有者');
  });
  check('文章修改、删除、发布仅限文章作者', () => {
    const protectedRoutes = ks.stack.filter(item => item.route && /^\/articles\/:id(?:\/publish|\/unpublish)?$/.test(item.route.path));
    for (const layer of protectedRoutes) {
      if (!layer.route.methods.put && !layer.route.methods.delete && !layer.route.methods.post) continue;
      const middlewareNames = layer.route.stack.map(item => item.handle.name);
      assert.ok(middlewareNames.includes('requireArticleOwner'), layer.route.path + ' 未校验文章作者');
    }
  });

  const failCount = results.filter(r => r[0] === 'FAIL').length;
  const passCount = results.filter(r => r[0] === 'PASS').length;
  console.log('\n结果：' + passCount + ' 通过 / ' + failCount + ' 失败 / 共 ' + results.length);
  process.exit(failCount ? 1 : 0);
})();
