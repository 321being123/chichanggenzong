const assert = require('assert');
const { fetchJson } = require('../services/wechatShareSource');
const originalFetch = global.fetch;
(async () => {
  try {
    let calls = [];
    global.fetch = async (url, options) => { calls.push({ url, signal: options.signal }); return { ok: true, json: async () => ({ ticket: 'sample' }) }; };
    assert.deepStrictEqual(await fetchJson('https://example.test/ticket', '票据'), { ticket: 'sample' });
    assert.strictEqual(calls[0].url, 'https://example.test/ticket');
    assert.ok(calls[0].signal);
    global.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(fetchJson('https://example.test/ticket', '票据'), /票据返回 HTTP 429/);
    global.fetch = async () => ({ ok: true, json: async () => ({ errcode: 40001 }) });
    await assert.rejects(fetchJson('https://example.test/ticket', '票据'), /40001/);
    global.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(fetchJson('https://example.test/ticket', '票据'), /票据请求失败/);
    console.log('wechat share source: response, timeout and failure handling passed');
  } finally { global.fetch = originalFetch; }
})().catch(error => { console.error(error); process.exitCode = 1; });
