// 测试隔离库的统一实现（N0-A）：全量入口与单文件引导共用同一套建库/清理逻辑，
// 不允许两处各写一份，否则「统一入口」只是名义上的。
'use strict';

const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

// 测试库名必须带 test/migtest 标识（server/db/connection.js 与既有防护一致）。
const TEST_DATABASE = String(process.env.PGTESTDATABASE || 'portfolio_test').replace(/[^a-zA-Z0-9_]/g, '_');

// ---------------------------------------------------------------------------
// R3：任何数据库接触之前先证明目标是测试库
//
// 修前的问题：TEST_DATABASE 只做字符替换，把 PGTESTDATABASE 设成 portfolio 就得到
// database=portfolio；这个模块自己 new Client，绕过了 server/db/connection.js 的保护，
// 于是 cleanupTestArtifacts 会向业务库发两条 DELETE。
//
// 所以校验必须放在**建连接之前**，而且全量入口、单文件入口、直接调用 helper 三条路径
// 共用同一个判定。判定不过一律抛错，不降级、不「先连上再说」。
// ---------------------------------------------------------------------------
const SYSTEM_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);

// 业务库名字可能来自 DATABASE_URL 或 PGDATABASE，两种都要认。
function configuredBusinessDatabase() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      const name = decodeURIComponent(String(parsed.pathname || '').replace(/^\//, ''));
      if (name) return name;
    } catch (_) { /* URL 非法时退回 PGDATABASE */ }
  }
  return String(process.env.PGDATABASE || 'portfolio');
}

function assertTestDatabaseName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) throw new Error('测试库名为空，拒绝连接数据库');
  const lower = raw.toLowerCase();
  if (SYSTEM_DATABASE_NAMES.has(lower)) {
    throw new Error('拒绝把系统库当测试库：' + raw + '（测试库名必须包含 test）');
  }
  if (!lower.includes('test')) {
    throw new Error('测试库名必须包含 test，当前为 ' + raw + '；拒绝在该库上执行任何测试写入');
  }
  const business = configuredBusinessDatabase().toLowerCase();
  // 只有「看着像业务库的名字」才参与同名判定：测试入口会把 PGDATABASE 改写成测试库，
  // 若把改写后的值当业务库，正常的 portfolio_test 反而会被拒。
  if (business && !business.includes('test') && lower === business) {
    throw new Error('拒绝把业务库当测试库：' + raw + ' 与当前配置的业务库同名，测试清理会误删业务数据');
  }
  return raw;
}

// 模块加载即校验：非法配置在 require 阶段就失败，后续任何入口（含 new Client）都不会被执行。
assertTestDatabaseName(TEST_DATABASE);

// 可注入的 Client 工厂：只用于回归证明「校验失败时 connect/query 一次都没被调用」。
let clientFactory = config => new Client(config);
function __setClientFactory(factory) {
  clientFactory = typeof factory === 'function' ? factory : (config => new Client(config));
}

function testDatabaseConfig() {
  assertTestDatabaseName(TEST_DATABASE);
  const configured = process.env.DATABASE_URL;
  if (configured) {
    const url = new URL(configured);
    url.pathname = '/' + TEST_DATABASE;
    return { connectionString: url.toString() };
  }
  return {
    host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '', database: TEST_DATABASE,
  };
}

// 测试用例会故意创建 test_guard_* / cninfo-test 熔断记录验证持久化行为。
// 测试库是从业务库模板复制而来，必须在每轮测试前后清掉这些测试专属记录，
// 防止历史测试数据进入验收统计；绝不连接或修改业务库。
async function cleanupTestArtifacts() {
  // 校验在建 Client 之前：目标不是测试库就一个查询都不发。
  assertTestDatabaseName(TEST_DATABASE);
  const client = clientFactory(testDatabaseConfig());
  try {
    await client.connect();
    await client.query(`
      DELETE FROM ops.external_call_budgets
       WHERE source LIKE 'test_guard_%' OR source = 'cninfo-test'
    `);
    await client.query(`
      DELETE FROM ops.external_circuits
       WHERE source LIKE 'test_guard_%' OR source = 'cninfo-test'
    `);
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureTestDatabase() {
  // 测试必须运行在独立数据库；首次运行从当前业务库复制结构和本地样例数据。
  assertTestDatabaseName(TEST_DATABASE);
  const configured = process.env.DATABASE_URL;
  let adminConfig;
  if (configured) {
    const url = new URL(configured);
    url.pathname = '/postgres';
    adminConfig = { connectionString: url.toString() };
  } else {
    adminConfig = {
      host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '', database: 'postgres',
    };
  }
  const client = clientFactory(adminConfig);
  try {
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [TEST_DATABASE]);
    if (!exists.rowCount) {
      const source = String(process.env.PGDATABASE || 'portfolio').replace(/[^a-zA-Z0-9_]/g, '_');
      if (source !== TEST_DATABASE) await client.query(`CREATE DATABASE "${TEST_DATABASE}" TEMPLATE "${source}"`);
      else await client.query(`CREATE DATABASE "${TEST_DATABASE}"`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  TEST_DATABASE,
  testDatabaseConfig,
  cleanupTestArtifacts,
  ensureTestDatabase,
  assertTestDatabaseName,
  configuredBusinessDatabase,
  __setClientFactory,
};
