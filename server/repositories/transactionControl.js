const { pool } = require('../db/connection');

// 事务控制语句的统一出口：BEGIN/COMMIT/ROLLBACK 与 SAVEPOINT 只在数据层执行。
// 调用方仍持有事务边界（何时开始、何时提交、失败如何处理），本层只负责语句与标识符转义。
// 与 server/db/transaction.js 的 withTransaction 并存：新代码优先用 withTransaction，
// 存量手写事务按触碰范围改为调用本模块，语义与原先逐条 query 完全一致。

const ISOLATION_LEVELS = new Set([
  'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE',
]);

function assertIsolation(level) {
  const normalized = String(level || '').trim().toUpperCase();
  if (!ISOLATION_LEVELS.has(normalized)) throw new Error(`不支持的事务隔离级别：${level}`);
  return normalized;
}

function assertSavepoint(name) {
  const text = String(name || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(text)) throw new Error(`非法的保存点名：${name}`);
  return text;
}

async function begin(client = pool, options = {}) {
  const parts = ['BEGIN'];
  if (options.isolation) parts.push('ISOLATION LEVEL', assertIsolation(options.isolation));
  if (options.readOnly) parts.push('READ ONLY');
  await client.query(parts.join(' '));
}

async function commit(client = pool) {
  await client.query('COMMIT');
}

async function rollback(client = pool) {
  await client.query('ROLLBACK');
}

async function savepoint(client, name) {
  await client.query(`SAVEPOINT ${assertSavepoint(name)}`);
}

async function releaseSavepoint(client, name) {
  await client.query(`RELEASE SAVEPOINT ${assertSavepoint(name)}`);
}

async function rollbackToSavepoint(client, name) {
  await client.query(`ROLLBACK TO SAVEPOINT ${assertSavepoint(name)}`);
}

module.exports = { begin, commit, rollback, savepoint, releaseSavepoint, rollbackToSavepoint };
