// 数据库连接与基础依赖（原 server/db.js 头部，物理拆分）
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { DEFAULT_FEE_SETTINGS } = require('../../public/shared/core-fees');

if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') {
  const databaseName = process.env.DATABASE_URL
    ? (() => { try { return new URL(process.env.DATABASE_URL).pathname.slice(1); } catch (_) { return ''; } })()
    : (process.env.PGDATABASE || '');
  if (!/(^|_)(test|migtest)(_|$)/i.test(databaseName)) {
    throw new Error(`测试进程拒绝连接非隔离数据库：${databaseName || '(未设置)'}`);
  }
}

// N0-A.4：直接 `node server/test/*.test.js` 会绕过统一入口（没有隔离测试库、没有本机资源互斥），
// 在没有 NODE_ENV=test 时甚至可能连到业务库。测试文件的唯一受控入口是
// `npm.cmd run test:all` 或 `npm.cmd run test:file -- <文件>`。
if (/[\\/]server[\\/]test[\\/].*\.test\.js$/i.test(process.argv[1] || '') && !process.env.TEST_RUN_ID) {
  // 直接 node 跑测试文件必须硬失败：部分用例会把连接错误兜成 [SKIP] 并退出 0，
  // 只抛异常会被吞成「跳过成功」，等于变相绕过隔离。
  console.error('测试文件必须经受控入口运行：npm.cmd run test:file -- <测试文件>（或 npm.cmd run test:all）。\n' +
    '直接 node 运行会绕过隔离测试库与本机资源互斥，本次不执行任何用例。');
  process.exit(2);
}

// DATA_DIR 指向项目根目录下的 data/（本文件位于 server/db，故需上溯两级）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// PostgreSQL TLS：PGSSL='true' 启用加密连接；若同时提供 PGSSL_CA（CA 证书路径），
// 则校验服务端证书（rejectUnauthorized=true），防止中间人；否则仅加密不校验（兼容自签名/内网）。
// 全部由环境变量控制，零新增依赖。
let ssl = false;
if (process.env.PGSSL === 'true') {
  ssl = process.env.PGSSL_CA
    ? { rejectUnauthorized: true, ca: fs.readFileSync(process.env.PGSSL_CA) }
    : { rejectUnauthorized: false };
}

const migrationRole = String(process.env.MIGRATION_ROLE || '').trim();
if (migrationRole && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(migrationRole)) {
  throw new Error('MIGRATION_ROLE 格式非法');
}
const roleOptions = migrationRole ? { options: `-c role=${migrationRole}` } : {};
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      ...roleOptions,
    })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'portfolio',
      max: 10,
      ssl,
      ...roleOptions,
    });

// 空闲连接被服务端单方面断开（PG 重启、网络抖动、管理员 pg_terminate_backend、临时测试库被删）时，
// pg 的 Pool 会向进程抛 'error' 事件；没有监听器时 Node 会把它当未捕获异常、直接退出整个进程。
// 这在生产上是"数据库抖一下就整个服务挂掉"，在测试里表现为"用例全过但进程崩了、退出码 1"。
// 这里只记录并继续运行：坏连接由池自动丢弃，下一次 acquire 会重建。
pool.on('error', (error) => {
  console.error('[db] 连接池空闲连接异常（已忽略，下次取连接自动重连）：' + String((error && error.message) || error).slice(0, 300));
});

module.exports = { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS };
