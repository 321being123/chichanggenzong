// 大模型后台配置服务（aiModels.js）单元测试
// 零依赖：monkeypatch db.getConfig/setConfig 用内存对象代替真实 PG，避免连库。
// 运行: node server/test/aimodels.test.js
const assert = require('assert');

// 先 mock db 的读写，再加载 aiModels（aiModels 顶部 destructure db.getConfig/setConfig）
const db = require('../db');
const _store = {};
db.getConfig = async (key, def) => (key in _store ? _store[key] : (def === undefined ? '' : def));
db.setConfig = async (key, val) => { _store[key] = String(val); };

const {
  getModels, saveModels, getActiveSorted, maskKey, recordStatus, getStatus, ensureAiModelsInit
} = require('../services/aiModels');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message)); }
}

async function main() {
  console.log('大模型配置服务 (aiModels):');

  await check('getModels/saveModels 往返一致', async () => {
    const list = [
      { id: 'a', name: 'A', model: 'm1', apiUrl: 'https://x/v1', apiKey: 'k1', enabled: true, order: 0 },
      { id: 'b', name: 'B', model: 'm2', apiUrl: 'https://y/v1', apiKey: 'k2', enabled: false, order: 1 }
    ];
    await saveModels(list);
    const got = await getModels();
    assert.strictEqual(got.length, 2);
    assert.strictEqual(got[0].id, 'a');
  });

  await check('getActiveSorted 仅返回启用且有 Key 有 model，按 order 升序', async () => {
    await saveModels([
      { id: 'd', name: '停用', model: 'm', apiUrl: 'https://d/v1', apiKey: 'k', enabled: false, order: 0 },
      { id: 'e', name: '无Key', model: 'm', apiUrl: 'https://e/v1', apiKey: '', enabled: true, order: 1 },
      { id: 'f', name: '无model', model: '', apiUrl: 'https://f/v1', apiKey: 'k', enabled: true, order: 2 },
      { id: 'g', name: '正常1', model: 'm', apiUrl: 'https://g/v1', apiKey: 'k', enabled: true, order: 3 },
      { id: 'h', name: '正常2', model: 'm', apiUrl: 'https://h/v1', apiKey: 'k', enabled: true, order: 4 }
    ]);
    const active = await getActiveSorted();
    assert.deepStrictEqual(active.map(m => m.id), ['g', 'h']);
  });

  await check('getActiveSorted 把 enabled:false 与缺失字段都排除', async () => {
    await saveModels([
      { id: 'x', name: 'X', model: 'm', apiUrl: 'https://x/v1', apiKey: 'k', order: 0 }, // 无 enabled 视为启用
      { id: 'y', name: 'Y', model: 'm', apiUrl: 'https://y/v1', apiKey: 'k', enabled: false, order: 1 }
    ]);
    const active = await getActiveSorted();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].id, 'x');
  });

  await check('maskKey 标准长度打码（前4***后4）', () => {
    assert.strictEqual(maskKey('sk-Bnf1234567890abcd'), 'sk-B***abcd');
  });
  await check('maskKey 过短只留前2位+***', () => {
    assert.strictEqual(maskKey('abc'), 'ab***');
    assert.strictEqual(maskKey('short'), 'sh***');
  });
  await check('maskKey 空值返回空串', () => {
    assert.strictEqual(maskKey(''), '');
    assert.strictEqual(maskKey(null), '');
  });

  await check('recordStatus/getStatus 成功记录 ok 与耗时', () => {
    recordStatus('s1', true, '', 123);
    const s = getStatus('s1');
    assert.ok(s && s.ok === true && s.ms === 123 && s.at > 0);
  });
  await check('recordStatus/getStatus 失败记录错误信息并截断', () => {
    const longErr = 'x'.repeat(500);
    recordStatus('s2', false, longErr, 45);
    const s = getStatus('s2');
    assert.ok(s && s.ok === false && s.ms === 45 && s.error.length <= 200);
  });
  await check('getStatus 未知 id 返回 null', () => {
    assert.strictEqual(getStatus('nope'), null);
  });

  await check('ensureAiModelsInit 空库且有 VISION_API_KEY 时写入一条默认模型', async () => {
    _store['ai_models'] = ''; // 清空
    process.env.VISION_API_KEY = 'sk-env-default';
    process.env.VISION_MODEL = 'agnes-2.0-flash';
    process.env.VISION_API_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';
    await ensureAiModelsInit();
    const list = await getModels();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, '默认模型');
    assert.strictEqual(list[0].model, 'agnes-2.0-flash');
    assert.strictEqual(list[0].apiKey, 'sk-env-default');
    assert.strictEqual(list[0].enabled, true);
  });
  await check('ensureAiModelsInit 已有配置时不覆盖', async () => {
    await saveModels([{ id: 'keep', name: '已存在', model: 'm', apiUrl: 'https://k/v1', apiKey: 'k', enabled: true, order: 0 }]);
    const before = (await getModels()).length;
    await ensureAiModelsInit();
    assert.strictEqual((await getModels()).length, before);
  });

  console.log('\n通过 ' + passed + ' · 失败 ' + failed);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
