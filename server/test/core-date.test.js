'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { spawnSync } = require('child_process');
const CoreDate = require('../../public/shared/core-date.js');
const snapshot = require('../jobs/navSnapshot');

assert.strictEqual(CoreDate.normalizeBusinessDate('2026-09-25'), '2026-09-25');
assert.strictEqual(CoreDate.normalizeBusinessDate('2026-02-29'), null);
assert.strictEqual(CoreDate.normalizeBusinessDate('2026-09-25T00:00:00Z'), null);
assert.strictEqual(CoreDate.compactDateToIso('20260925'), '2026-09-25');
assert.strictEqual(CoreDate.compactDateToIso('20260229'), null);
assert.strictEqual(CoreDate.dateInZone('2026-09-27T17:00:00.000Z', 'Asia/Shanghai'), '2026-09-28');
assert.strictEqual(CoreDate.dateTimeInZone('2026-09-27T17:00:00.000Z', 'Asia/Shanghai'), '2026-09-28 01:00:00');
assert.strictEqual(CoreDate.dateTimeInZone('2026-11-01T05:59:59Z', 'America/New_York'), '2026-11-01 01:59:59');
assert.strictEqual(CoreDate.dateTimeInZone('2026-11-01T06:00:00Z', 'America/New_York'), '2026-11-01 01:00:00');
assert.strictEqual(CoreDate.dateTimeInZone('2026-11-01T05:59:59Z', 'Asia/Shanghai'), '2026-11-01 13:59:59');
assert.strictEqual(CoreDate.dateTimeInZone('2026-11-01T06:00:00Z', 'Asia/Shanghai'), '2026-11-01 14:00:00');
assert.strictEqual(CoreDate.dateInZone('2026-09-25', 'Asia/Shanghai'), null);
assert.strictEqual(CoreDate.subtractYears('2026-09-28', 1), '2025-09-28');
assert.strictEqual(CoreDate.subtractYears('2024-02-29', 1), '2023-02-28');
assert.strictEqual(CoreDate.subtractYears('2025-01-01', 1), '2024-01-01');
assert.strictEqual(CoreDate.subtractYears('2025-09-28', 0), '2025-09-28');

const browserContext = { self: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../../public/shared/core-date.js'), 'utf8'), browserContext);
assert.strictEqual(browserContext.self.CoreDate.dateTimeInZone('2026-09-27T17:00:00Z', 'Asia/Shanghai'), '2026-09-28 01:00:00');
const indexHtml = fs.readFileSync(require.resolve('../../public/index.html'), 'utf8');
assert(indexHtml.indexOf('shared/core-date.js') < indexHtml.indexOf('js/utils.js'), 'core-date.js 必须先于 utils.js 加载');
for (const page of ['admin.html', 'login.html']) {
  const html = fs.readFileSync(require.resolve('../../public/' + page), 'utf8');
  assert(html.indexOf('shared/core-date.js') >= 0, `${page} 必须加载 core-date.js`);
  assert(html.indexOf('shared/core-date.js') < html.indexOf('js/utils.js'), `${page} 的 core-date.js 必须先于 utils.js 加载`);
}

const probe = `const date = require('pg').types.getTypeParser(1082, 'text')('2026-09-25');
const core = require('./public/shared/core-date');
console.log(JSON.stringify({zone: Intl.DateTimeFormat().resolvedOptions().timeZone, date: core.dateInZone(date, 'Asia/Shanghai'), now: core.dateTimeInZone(new Date('2026-09-27T17:00:00.000Z'), 'Asia/Shanghai')}));`;
for (const TZ of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
  const child = spawnSync(process.execPath, ['-e', probe], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TZ },
  });
  assert.strictEqual(child.status, 0, child.stderr || `${TZ} 子进程失败`);
  const result = JSON.parse(child.stdout);
  assert.strictEqual(result.zone, TZ);
  assert.strictEqual(result.date, '2026-09-25');
  assert.strictEqual(result.now, '2026-09-28 01:00:00');
}

async function verifyPostgresDateBoundary() {
  assert.strictEqual(process.env.NODE_ENV, 'test', 'PostgreSQL DATE 验证只能在统一测试入口运行');
  const database = String(process.env.PGDATABASE || '');
  assert(/(^|_)(test|migtest)(_|$)/i.test(database), '测试必须使用隔离数据库');
  const { pool } = require('../db/connection');
  try {
    const { rows } = await pool.query("SELECT current_setting('server_version') AS pg_version, DATE '2026-09-25' AS raw_date, DATE '2026-09-25'::text AS date_text");
    assert.strictEqual(rows[0].date_text, '2026-09-25');
    assert(rows[0].raw_date instanceof Date, 'OID 1082 的默认解码类型应保持 Date');
    assert.strictEqual(CoreDate.dateInZone(rows[0].raw_date, 'Asia/Shanghai'), '2026-09-25');
    const rates = snapshot.buildFxByDate([{ rate_date: rows[0].date_text, rate: 7.1 }]);
    assert.strictEqual(rates.get('2026-09-25'), 7.1);
    assert.strictEqual(rates.get('2026-09-24'), undefined);
    assert.throws(() => snapshot.buildFxByDate([{ rate_date: rows[0].raw_date, rate: 7.1 }]), /YYYY-MM-DD 文本/);
    assert.match(rows[0].pg_version, /^\d+\.\d+/);
  } finally {
    await pool.end();
  }
}

verifyPostgresDateBoundary().then(() => {
  console.log('core-date tests passed (UTC/上海/纽约 + isolated PostgreSQL DATE)');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
