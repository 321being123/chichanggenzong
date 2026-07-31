// 知识分享扩展功能集成测试（本地）
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
let adminCookie = '';
let userCookie = '';

function parseEnv() {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const obj = {};
  raw.split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) obj[m[1]] = m[2];
  });
  return obj;
}

async function api(method, p, body, cookie) {
  const headers = { 'Content-Type': 'application/json', 'Origin': BASE };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + p, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

// fetch 不直接暴露 set-cookie 数组，这里从原始响应取
async function loginRaw(uname, pwd) {
  const headers = { 'Content-Type': 'application/json', 'Origin': BASE };
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers, body: JSON.stringify({ username: uname, password: pwd }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('登录失败 ' + uname + ': ' + JSON.stringify(data));
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : '';
}

function assert(cond, msg) {
  if (!cond) { console.error('❌ 失败: ' + msg); process.exitCode = 1; }
  else console.log('✅ ' + msg);
}

(async () => {
  const env = parseEnv();
  const adminU = env.ADMIN_USERNAME;
  const adminP = env.ADMIN_PASSWORD;

  // 1. 管理员登录
  adminCookie = await loginRaw(adminU, adminP);
  assert(adminCookie, '管理员登录成功');

  // 2. 注册测试用户
  const tu = 'ks_test_' + Date.now();
  const tp = 'test123456';
  const reg = await api('POST', '/api/auth/register', { username: tu, password: tp, email: '' });
  assert(reg.status === 200 || reg.status === 400, '测试用户注册（已存在则跳过）: ' + reg.status);

  // 3. 测试用户登录
  userCookie = await loginRaw(tu, tp);
  assert(userCookie, '测试用户登录成功');

  // 4. 测试用户无写权限 → 发文章应 403
  const deny = await api('POST', '/api/knowledge/articles', { title: 'x', content: 'y' }, userCookie);
  assert(deny.status === 403, '无权限用户发文被拒 (403)，实际 ' + deny.status);

  // 5. 管理员开启该用户写权限
  const perm = await api('POST', '/api/admin/knowledge/users/' + encodeURIComponent(tu) + '/permission', { enabled: true }, adminCookie);
  assert(perm.status === 200 && perm.data.enabled === true, '管理员开启测试用户写权限');

  // 6. 测试用户现在可发文
  const create = await api('POST', '/api/knowledge/articles', { title: '测试文章', content: '# 标题\n正文内容' }, userCookie);
  assert(create.status === 200 && create.data.id, '测试用户发文成功，得到 id=' + (create.data && create.data.id));
  const artId = create.data.id;

  // 7. 发布
  const pub = await api('POST', '/api/knowledge/articles/' + artId + '/publish', {}, userCookie);
  assert(pub.status === 200 && pub.data.share_token, '文章发布成功并生成分享 token');

  // 8. 评论：一级
  const c1 = await api('POST', '/api/knowledge/articles/' + artId + '/comments', { nickname: '甲', content: '一级评论' }, userCookie);
  assert(c1.status === 200 && c1.data.id, '发表一级评论');
  const c1id = c1.data.id;

  // 9. 回复一级
  const c2 = await api('POST', '/api/knowledge/articles/' + artId + '/comments', { nickname: '乙', content: '回复甲', parent_id: c1id }, userCookie);
  assert(c2.status === 200 && c2.data.parent_id === c1id, '发表楼中楼回复（parent_id 正确）');
  const c2id = c2.data.id;

  // 10. 回复二级
  const c3 = await api('POST', '/api/knowledge/articles/' + artId + '/comments', { nickname: '丙', content: '回复乙', parent_id: c2id }, userCookie);
  assert(c3.status === 200 && c3.data.parent_id === c2id, '发表对回复的回复');

  // 11. 读取嵌套结构
  const comments = await api('GET', '/api/knowledge/articles/' + artId + '/comments', null, userCookie);
  assert(comments.data.length === 1, '评论树一级只有 1 条');
  const root = comments.data[0];
  assert(root.id === c1id && root.replies && root.replies.length === 1, '一级评论下挂有 1 条回复');
  const child = root.replies[0];
  assert(child.id === c2id && child.replies && child.replies.length === 1, '回复下再挂有 1 条回复（楼中楼三层）');
  assert(child.replies[0].id === c3.id, '第三层为丙的回复');

  // 12. SSRF 防护：抓取内网地址应被拒
  const ssrf = await api('POST', '/api/knowledge/import-url', { url: 'http://127.0.0.1:3000/' }, adminCookie);
  assert(ssrf.status === 400, 'SSRF：内网地址抓取被拒 (400)，实际 ' + ssrf.status);

  // 13. 文件导入：.md
  const mdPath = path.join(require('os').tmpdir(), 'ks_test_' + Date.now() + '.md');
  fs.writeFileSync(mdPath, '# 导入测试\n\n这是通过文件导入的内容。');
  const fd = new FormData();
  const fileBuf = fs.readFileSync(mdPath);
  fd.append('file', new Blob([fileBuf]), 'import_test.md');
  const fr = await fetch(BASE + '/api/knowledge/import-file', {
    method: 'POST', headers: { 'Origin': BASE, 'Cookie': adminCookie }, body: fd,
  });
  const fdata = await fr.json();
  assert(fr.status === 200 && fdata.content && fdata.content.indexOf('导入测试') >= 0, '文件导入 .md 成功解析正文');

  // 14. 首页最新文章
  const latest = await api('GET', '/api/knowledge/latest?limit=5', null, userCookie);
  const found = (latest.data || []).some(a => a.id === artId);
  assert(found, '首页最新文章列表包含刚发布文章');

  // 15. 后台评论管理可见
  const cm = await api('GET', '/api/admin/knowledge/comments?limit=10', null, adminCookie);
  assert(cm.status === 200 && cm.data.total >= 3, '后台评论管理可列出评论（共 ' + (cm.data && cm.data.total) + '）');

  // 16. 后台文章管理可见
  const arts = await api('GET', '/api/admin/knowledge/articles?limit=10', null, adminCookie);
  assert(arts.status === 200 && (arts.data.list || []).some(a => a.id === artId), '后台文章管理可列出该文章');

  // 清理
  await api('DELETE', '/api/admin/knowledge/articles/' + artId, null, adminCookie);
  await api('DELETE', '/api/admin/users/' + encodeURIComponent(tu), null, adminCookie);
  console.log('\n测试完成。退出码: ' + (process.exitCode || 0));
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
