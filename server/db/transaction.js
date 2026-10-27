// 统一事务封装（批次0，应用分层整改方案 5.1）。
//
// 合同：
// 1) 拥有事务：withTransaction(fn) → checkout → BEGIN → fn(client) → COMMIT。
//    成功提交，异常 ROLLBACK 后抛出「原错误」；回滚自身失败只挂到 error.rollbackError，
//    不覆盖原错误。finally 只释放本次取得的连接，不触碰外部传入的连接。
// 2) 复用外层事务：withTransaction(fn, { tx }) 直接以 tx 调用 fn，
//    不 BEGIN / COMMIT / ROLLBACK / release。这不是隐式嵌套事务，
//    需要局部容错请调用方自行使用 SAVEPOINT。
// 3) 会话级基础设施不适用本封装：externalCallGuard 的 advisory lock 跨网络请求持锁，
//    连接归属和释放者按 governance/architecture-boundaries.json 的 exceptions 登记。
const { pool } = require('./connection');

/**
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ tx?: import('pg').PoolClient }} [options]
 * @returns {Promise<T>}
 */
async function withTransaction(fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('withTransaction 需要事务函数');
  const outer = options && options.tx;
  if (outer) return fn(outer);

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    committed = true;
    return value;
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // 保留原错误，回滚失败只作为附加证据
        if (error && typeof error === 'object') error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
