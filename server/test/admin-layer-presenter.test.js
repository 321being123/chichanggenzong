// 实际 View 与 Presenter 一起加载，验证主列表的渲染和筛选接线。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const acorn = require('acorn');
const walk = require('acorn-walk');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'public/js', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
// 防止 View 直接调用只负责传输的低层请求方法，造成编排回流。
const presenterAst = acorn.parse(read('presenters/admin-presenter.js'), { ecmaVersion: 'latest' });
const transport = new Set();
for (const node of presenterAst.body) {
  if (node.type !== 'FunctionDeclaration') continue;
  walk.simple(node.body, { MemberExpression(member) {
    if (member.object && member.object.type === 'MemberExpression'
      && member.object.object.type === 'Identifier' && member.object.object.name === 'window'
      && member.object.property.name === 'siteApi') transport.add(node.id.name);
  } });
}
function directTransportCalls(source) {
  const found = [];
  walk.simple(acorn.parse(source, { ecmaVersion: 'latest' }), { CallExpression(call) {
    const c = call.callee;
    const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression'
      && c.object.type === 'Identifier' && c.object.name === 'window' && !c.computed ? c.property.name : '';
    if (transport.has(name)) found.push(name);
  } });
  return found;
}
assert(transport.has('adminFetchMe'), '应识别 Presenter 传输方法');
assert.deepStrictEqual(directTransportCalls(read('admin.js')), [], '后台 View 不得直接调用传输方法');
assert.deepStrictEqual(directTransportCalls('window.adminFetchMe()'), ['adminFetchMe'], '门禁应识别反例');

(async () => {
  const dom = new JSDOM('<!doctype html><div id="admin-user"></div><div id="toast"></div><div id="view-overview"></div><div id="view-users"></div><div id="view-brokers"></div><div id="view-audit"></div><div id="view-aimodels"></div><div id="view-knowledge"></div><div id="view-arbitrage"></div><div id="admin-modal"><div id="admin-modal-box"><div id="admin-modal-title"></div><div id="admin-modal-body"></div><div id="admin-modal-actions"></div></div></div><div id="view-settings"></div><div id="view-holidays"></div><div id="view-jobs"><div id="jobs-summary"></div><div id="job-worker-status"></div><table><tbody id="jobs-slots-tbody"></tbody><tbody id="jobs-tbody"></tbody><tbody id="jobs-alerts-tbody"></tbody><tbody id="jobs-alert-history-tbody"></tbody></table></div>', { url: 'http://localhost/admin.html', runScripts: 'dangerously' });
  const w = dom.window, calls = [];
  w.api = p => p;
  w.siteApi = { get: async url => {
    calls.push(url);
    if (url === '/api/me') return { ok: true, payload: { username: 'synthetic', accountIdentity: 'id', role: 'admin' } };
    if (url === '/api/admin/overview') return { ok: true, payload: { totalUsers: 8 } };
    if (url.startsWith('/api/admin/users?')) return { ok: true, payload: { list: [], total: 0 } };
    if (url === '/api/admin/brokers/C01') return { ok: true, payload: { name: '测试券商', market: 'A', import_unit: 'lot' } };
    if (url.startsWith('/api/admin/brokers?')) return { ok: true, payload: { list: [{ code: 'C01', name: '测试券商', market: 'A' }] } };
    if (url.startsWith('/api/admin/audit?')) return { ok: true, payload: { list: [{ actor: 'tester', action: 'example', result: 'success' }], modules: [] } };
    if (url === '/api/admin/jobs/overview') return { ok: true, payload: { counts: [], alerts: [], workers: [], health: {} } };
    if (url.startsWith('/api/admin/jobs/slots?')) return { ok: true, payload: { list: [] } };
    if (url.startsWith('/api/admin/jobs/notifications?')) return { ok: true, payload: { list: [] } };
    if (url.startsWith('/api/admin/jobs?')) return { ok: true, payload: { recent: [] } };
    if (url === '/api/admin/settings') return { ok: true, payload: { register_open: '1', require_email: '0' } };
    if (url === '/api/admin/holidays') return { ok: true, payload: { years: { '2026': ['2026-01-01'] } } };
    if (url.startsWith('/api/admin/knowledge/articles?')) return { ok: true, payload: { list: [{ id: 1, title: '测试文章', status: 'draft' }], total: 1 } };
    if (url.startsWith('/api/admin/knowledge/comments?')) return { ok: true, payload: { list: [{ id: 2, nickname: '评论用户', content: '测试评论' }], total: 1 } };
    if (url.startsWith('/api/admin/knowledge/users')) return { ok: true, payload: { list: [{ username: 'writer', role: 'user', status: 'active' }] } };
    if (url.startsWith('/api/admin/arbitrage/candidates?')) return { ok: true, payload: { rows: [{ case_id: 11, name: '测试事件' }], total: 1 } };
    if (url === '/api/admin/arbitrage/11') return { ok: true, payload: { name: '测试事件', documents: [] } };
    if (url === '/api/admin/models') return { ok: true, payload: { list: [{ id: 'm1', name: '测试模型', model: 'local', apiUrl: 'https://example.com', enabled: true }] } };
    throw Error('unexpected request ' + url);
  }, request: async (url, options) => { calls.push(url); return { ok: true, payload: {} }; }, del: async url => ({ ok: false, payload: { error: 'no' } }), jsonHeaders: () => ({}) };
  for (const file of ['utils.js', 'presenters/admin-presenter.js', 'admin.js']) {
    const script = w.document.createElement('script'); script.textContent = read(file); w.document.body.appendChild(script);
  }
  await tick(); await tick();
  assert(w.document.getElementById('view-overview').textContent.includes('平台总用户'));
  w.renderUsers(); await tick();
  w.document.getElementById('users-search').value = '待清空';
  await w.adminUsersReset();
  assert.strictEqual(w.document.getElementById('users-search').value, '');
  await w.adminToggleStatus('target', 'active');
  assert(calls.includes('/api/admin/users/target/status'));
  assert(w.document.getElementById('toast').textContent.includes('已禁用'));
  await w.adminResetUserPassword('target', '123');
  assert(w.document.getElementById('toast').textContent.includes('密码至少6位'));
  await w.adminDeleteKsArticle('7');
  assert(w.document.getElementById('toast').textContent.includes('删除失败'));
  w.renderBrokers(); await tick();
  assert(w.document.getElementById('brokers-tbody').textContent.includes('测试券商'));
  w.document.getElementById('brokers-search').value = '关键字'; w.adminBrokersSearch(); await tick();
  assert(calls.some(url => url.includes('search=' + encodeURIComponent('关键字'))));
  w.openBrokerForm('C01'); await tick();
  assert.strictEqual(w.document.getElementById('broker-name').value, '测试券商');
  await w.adminSubmitBroker({ isEdit: false, code: '', name: '' });
  assert(w.document.getElementById('toast').textContent.includes('代码和名称均必填'));
  w.closeAdminModal();
  await w.loadJobsData();
  assert(w.document.getElementById('jobs-summary').textContent.includes('今日计划'));
  assert(w.document.getElementById('jobs-slots-tbody').textContent.includes('暂无计划'));
  w.renderAudit(); await tick();
  assert(w.document.getElementById('audit-tbody').textContent.includes('tester'));
  w.document.getElementById('audit-filter-actor').value = 'actor';
  w.document.getElementById('audit-filter-result').value = 'failure';
  await w.loadAuditData();
  assert(calls.some(url => url.includes('/api/admin/audit?') && url.includes('actor=actor') && url.includes('result=failure')));
  w.renderSettings(); await tick();
  assert(w.document.getElementById('view-settings').textContent.includes('站点'));
  w.switchSettingsTab('external-api'); w.renderSettings(); await tick();
  assert.strictEqual(w.document.querySelector('[data-panel=\"external-api\"]').hidden, false);
  w.renderHolidays(); await tick();
  assert(w.document.getElementById('view-holidays').textContent.includes('2026年'));
  w.renderKnowledge(); await tick();
  assert(w.document.getElementById('ks-ad-tbody').textContent.includes('测试文章'));
  w.document.querySelector('[data-tab="comments"]').click(); await tick();
  assert(w.document.getElementById('ks-cm-tbody').textContent.includes('测试评论'));
  w.document.querySelector('[data-tab="permissions"]').click(); await tick();
  assert(w.document.getElementById('ks-per-tbody').textContent.includes('writer'));
  w.renderArbitrage(); await tick();
  assert(w.document.getElementById('arb-admin-tbody').textContent.includes('测试事件'));
  await w.adminArbDetail(11);
  assert(w.document.getElementById('admin-modal-body').textContent.includes('测试事件'));
  w.renderAimodels(w.document.getElementById('view-aimodels')); await tick();
  assert(w.document.getElementById('aimodels-tbody').textContent.includes('测试模型'));
  w.openModelForm('m1'); await tick();
  assert.strictEqual(w.document.getElementById('model-name').value, '测试模型');
  await w.adminSubmitModel({ isEdit: false, name: 'n', model: 'm', apiUrl: 'https://example.com', apiKey: '' });
  assert(w.document.getElementById('toast').textContent.includes('API Key 必填'));
  w.closeAdminModal();
  w.close();
  console.log('后台 Presenter 与 View 列表接线通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
