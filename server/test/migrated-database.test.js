'use strict';
const assert = require('assert');
const path = require('path');
const { Client } = require('pg');
const control = require('./lib/testRunControl');
const { testDatabaseConfig } = require('./lib/testDatabase');
const helper = require('./helpers/migrated-database');

function configFor(database) {
  const config = testDatabaseConfig();
  if (config.connectionString) {
    const url = new URL(config.connectionString); url.pathname = '/' + database;
    config.connectionString = url.toString();
  } else config.database = database;
  return config;
}

(async () => {
  const inheritedTemplate = process.env.TEST_SCHEMA_TEMPLATE;
  const template = helper.templateName(process.env.TEST_RUN_ID);
  const names = [1, 2].map(n => 'portfolio_test_clone_' + process.pid + '_' + n);
  const admin = new Client(testDatabaseConfig());
  const clients = [];
  let createdTemplate = false;
  try {
    await admin.connect();
    if (!inheritedTemplate) {
      const prepared = await control.spawnWithTimeout(process.execPath,
        [path.join(__dirname, 'helpers/migrated-database.js'), template], {
          env: process.env, timeoutMs: 120000,
          onSpawn: pid => control.registerChild(process.env.TEST_RUN_ID, pid, '模板隔离回归准备'),
        });
      if (!control.isProcessAlive(prepared.pid)) control.unregisterChild(process.env.TEST_RUN_ID, prepared.pid);
      createdTemplate = true;
      assert.strictEqual(prepared.status, 0, prepared.out);
    }
    process.env.TEST_SCHEMA_TEMPLATE = template;

    let queries = 0;
    const rejectingAdmin = { query() { queries++; throw new Error('不应触达数据库'); } };
    await assert.rejects(helper.createMigratedDatabase(rejectingAdmin, 'portfolio'), /测试库名/);
    process.env.TEST_SCHEMA_TEMPLATE = 'portfolio_test_schema_foreign';
    await assert.rejects(helper.createMigratedDatabase(rejectingAdmin, names[0]), /当前已授权/);
    assert.strictEqual(queries, 0, '非法库名或外轮模板必须在写库前拒绝');
    process.env.TEST_SCHEMA_TEMPLATE = template;

    for (const name of names) {
      const result = await helper.createMigratedDatabase(admin, name);
      assert.strictEqual(result.fromTemplate, true);
      const client = new Client(configFor(name)); clients.push(client); await client.connect();
      const { rows } = await client.query('SELECT count(*)::int n FROM schema_migrations');
      assert.strictEqual(rows[0].n, require('../db/migrations').MIGRATIONS.length);
    }
    await clients[0].query('CREATE TABLE public.template_isolation_probe (value integer)');
    await clients[0].query('INSERT INTO public.template_isolation_probe VALUES (42)');
    const other = await clients[1].query("SELECT to_regclass('public.template_isolation_probe') AS name");
    assert.strictEqual(other.rows[0].name, null, '前一个文件的结构/数据不能进入后一个克隆');
    const source = new Client(configFor(template)); clients.push(source); await source.connect();
    const original = await source.query("SELECT to_regclass('public.template_isolation_probe') AS name");
    assert.strictEqual(original.rows[0].name, null, '业务测试不能污染模板');
    console.log('迁移模板回归通过：两库迁移集合一致、结构/数据隔离、错误目标零写入');
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    // MIGRATIONS 的导入会创建连接池，关闭后才允许删除临时库。
    await require('../db/connection').pool.end();
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    if (createdTemplate) await helper.dropTemplate(template);
    if (inheritedTemplate === undefined) delete process.env.TEST_SCHEMA_TEMPLATE;
    else process.env.TEST_SCHEMA_TEMPLATE = inheritedTemplate;
    await admin.end();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
