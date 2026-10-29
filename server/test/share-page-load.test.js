const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..', '..');
const template = fs.readFileSync(path.join(root, 'server/views/share.html'), 'utf8');

async function check(kind, code) {
  const html = template.replace('__SHARE_KIND__', kind).replace('__SHARE_CODE__', code);
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const errors = [];
  w.console.error = (...args) => errors.push(args.map(String).join(' '));
  const calls = [];
  w.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const data = kind === 'stock'
      ? { ts_code: code, name: '测试股票' }
      : { analysis: { ts_code: code, name: '测试转债' } };
    return { ok: true, status: 200, json: async () => data };
  };
  const scripts = [...html.matchAll(/<script\s+src="([^"?]+)[^"]*"[^>]*><\/script>/g)]
    .map(match => match[1]).filter(src => !src.startsWith('/vendor/'));
  // 批次4：bond-analysis 取数已拆入 Presenter（presenters/bond-analysis-presenter.js）、
  // 三表状态已拆入 presenters/stock-analysis-statements-presenter.js；share.html 的 presenter 引用见拆分报告，
  // 测试先按目标加载顺序（View 之后紧跟 Presenter）补齐，避免拆分让运行时缺全局入口。
  const presenterAt = scripts.indexOf('/js/bond-analysis.js');
  scripts.splice(presenterAt + 1, 0, '/js/presenters/bond-analysis-presenter.js');
  const statementsAt = scripts.indexOf('/js/stock-analysis-statements.js');
  scripts.splice(statementsAt + 1, 0, '/js/presenters/stock-analysis-statements-presenter.js');
  for (const src of scripts) w.eval(fs.readFileSync(path.join(root, 'public', src.slice(1)), 'utf8'));
  if (w.document.readyState === 'loading') w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(calls.some(call => call.url.includes('/api/' + (kind === 'stock' ? 'stock-analysis/' : 'bond-analysis/') + code.slice(0, 6))), JSON.stringify(calls));
  assert(calls.every(call => call.method === 'GET' && !/\/stocks(?:\?|$)|\/watchlist|\/api\/data(?:\/|$)/.test(call.url)), JSON.stringify(calls));
  const summary = w.document.getElementById(kind + '-analysis-summary');
  assert(summary.textContent.includes(kind === 'stock' ? '测试股票' : '测试转债'), summary.textContent);
  assert.deepStrictEqual(errors, []);
  w.close();
}
(async () => {
  await check('stock', '600000.SH');
  await check('bond', '110081.SH');
  console.log('公开分享页：股票和转债加载真实脚本、只读请求及展示通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
