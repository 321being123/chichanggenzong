// 同轮只迁移一次干净模板；业务测试仍使用各自的临时库和独立进程。
// 单文件入口没有模板时沿用空库迁移，不从业务库或前一个测试复制数据。
'use strict';

const crypto = require('crypto');
const path = require('path');
const { Client } = require('pg');
const runControl = require('../lib/testRunControl');
const { TEST_DATABASE, testDatabaseConfig, assertTestDatabaseName } = require('../lib/testDatabase');

function templateName(runId) {
  if (!runId) throw new Error('迁移模板缺少 runId');
  return 'portfolio_test_schema_' + crypto.createHash('sha256').update(runId).digest('hex').slice(0, 16);
}

function assertOwnedTemplate(name) {
  const resources = [runControl.pgResource(TEST_DATABASE), runControl.dirResource(path.resolve(__dirname, '../../..', 'data'))];
  const inherited = runControl.inheritRunContext({ resources });
  if (process.env.NODE_ENV !== 'test' || !inherited || name !== templateName(inherited.runId)) {
    throw new Error('迁移模板必须属于当前已授权测试运行');
  }
}

function assertTemporaryName(name) {
  assertTestDatabaseName(name);
  if (!/^[a-zA-Z0-9_]{1,63}$/.test(name) || name === TEST_DATABASE || name.startsWith('portfolio_test_schema_')) {
    throw new Error('拒绝使用非独立临时库名称');
  }
}

async function withAdmin(fn) {
  const admin = new Client({ ...testDatabaseConfig(), connectionTimeoutMillis: 10000 });
  try { await admin.connect(); return await fn(admin); }
  finally { await admin.end().catch(() => {}); }
}

async function prepareTemplate(name) {
  assertOwnedTemplate(name);
  // CREATE 不带 IF EXISTS，不接管已有库；所有连接关闭后才能作为模板克隆。
  await withAdmin(admin => admin.query(`CREATE DATABASE "${name}"`));
  process.env.PGDATABASE = name;
  delete process.env.DATABASE_URL;
  const migrations = require('../../db/migrations');
  try { await migrations.runMigrations(); }
  finally { await require('../../db/connection').pool.end(); }
}

async function dropTemplate(name) {
  assertOwnedTemplate(name);
  await withAdmin(admin => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

async function createMigratedDatabase(admin, name) {
  assertTemporaryName(name);
  const template = process.env.TEST_SCHEMA_TEMPLATE;
  if (template) assertOwnedTemplate(template); // 错误配置必须失败，不能悄悄回退或克隆别的库。
  await admin.query(template
    ? `CREATE DATABASE "${name}" TEMPLATE "${template}"`
    : `CREATE DATABASE "${name}"`);
  process.env.PGDATABASE = name;
  delete process.env.DATABASE_URL;
  if (!template) await require('../../db/migrations').runMigrations();
  return { fromTemplate: Boolean(template) };
}

module.exports = { templateName, assertOwnedTemplate, createMigratedDatabase, dropTemplate };

if (require.main === module) {
  prepareTemplate(process.argv[2]).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
