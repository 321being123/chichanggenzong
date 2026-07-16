// ========== P1-2 用户数据并发覆盖 回归测试 ==========
// 运行：node server/test/concurrency.test.js
// 说明：通过 mock pg 验证 registerUser / updateUserAccounts / loadUser 均只操作
// 单用户且使用数据库唯一约束完成原子判重，不再 load 全量用户快照后整体回写，
// 从而杜绝并发注册/改账户列表时旧快照覆盖其他用户密码或账户信息。
const assert = require('assert');
const Module = require('module');

// ---- mock pg：记录所有 query 调用，rowCount 可由测试控制 ----
const calls = [];
let nextRowCount = 1;
class FakePool {
  query(text, params) {
    const rec = { text, params };
    calls.push(rec);
    return Promise.resolve({ rowCount: nextRowCount, rows: [] });
  }
}
const fakePg = { Pool: FakePool };
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: fakePg };

const db = require('../db');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

async function main() {
  console.log('A. registerUser —— 原子判重，唯一约束冲突即不插入');
  await check('注册 SQL 使用 ON CONFLICT (username) DO NOTHING（原子判重，非全表回写）', async () => {
    nextRowCount = 1;
    calls.length = 0;
    const inserted = await db.registerUser('alice', 'hash', ['默认账户']);
    assert.strictEqual(inserted, true, 'rowCount=1 应返回 true');
    const q = calls[calls.length - 1];
    assert.ok(/INSERT INTO users .* ON CONFLICT \(username\) DO NOTHING/.test(q.text), '注册 SQL 必须含 ON CONFLICT DO NOTHING，实际: ' + q.text);
    assert.deepStrictEqual(q.params, ['alice', 'hash', JSON.stringify(['默认账户'])]);
  });
  await check('用户名已存在（rowCount=0）时 registerUser 返回 false，不覆盖', async () => {
    nextRowCount = 0;
    calls.length = 0;
    const inserted = await db.registerUser('alice', 'hash2', ['默认账户']);
    assert.strictEqual(inserted, false, '冲突应返回 false');
  });

  console.log('B. updateUserAccounts —— 仅更新当前用户一行');
  await check('更新账户列表只 UPDATE 单用户，不含其他用户快照', async () => {
    calls.length = 0;
    await db.updateUserAccounts('bob', ['招商', '华泰']);
    const q = calls[calls.length - 1];
    assert.ok(/UPDATE users SET accounts=\$2 WHERE username=\$1/.test(q.text), '必须是单用户 UPDATE，实际: ' + q.text);
    assert.deepStrictEqual(q.params, ['bob', JSON.stringify(['招商', '华泰'])]);
  });

  console.log('C. loadUser —— 仅读取单用户，不暴露全量用户名+密码哈希');
  await check('loadUser 用 WHERE username=$1 单用户查询（非 SELECT 全表）', async () => {
    calls.length = 0;
    await db.loadUser('carol');
    const q = calls[calls.length - 1];
    assert.ok(/SELECT .* FROM users WHERE username=\$1/.test(q.text), '必须是单用户 SELECT，实际: ' + q.text);
    assert.deepStrictEqual(q.params, ['carol']);
    assert.ok(!/FROM users$/.test(q.text) && !/FROM users WHERE$/.test(q.text), '不应是无条件的全表 SELECT');
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) {
    console.log('失败项:'); failed.forEach(f => console.log('  - ' + f[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch(e => { console.error(e); process.exit(1); });

