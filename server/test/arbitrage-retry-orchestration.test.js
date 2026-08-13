const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../db/connection');
const parser = require('../services/arbitrageParser');
const slots = require('../services/jobScheduleSlots');

test('PDF 文档锁跨调用持有，并在完成后释放', async (t) => {
  const originalConnect = pool.connect;
  t.after(() => { pool.connect = originalConnect; });
  const queries = [];
  let released = 0;
  let available = true;
  pool.connect = async () => ({
    query: async (sql) => {
      queries.push(sql);
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: available }] };
      return { rows: [] };
    },
    release: () => { released++; },
  });

  const releaseLock = await parser.acquireDocumentParseLock(10, 20);
  assert.equal(typeof releaseLock, 'function');
  assert.equal(released, 0, '外部解析完成前不能提前归还锁连接');
  await releaseLock();
  assert.equal(released, 1);
  assert.ok(queries.some(sql => /pg_advisory_unlock/.test(sql)));

  available = false;
  const notClaimed = await parser.acquireDocumentParseLock(10, 20);
  assert.equal(notClaimed, null);
  assert.equal(released, 2, '未领取到锁也必须归还连接');
});

test('重复人工同步复用已经到期的待执行实例', async (t) => {
  const originalConnect = pool.connect;
  t.after(() => { pool.connect = originalConnect; });
  const inserted = { slot_id: 88, job_code: 'arbitrage_sync', status: 'pending' };
  let active = null;
  let inserts = 0;
  pool.connect = async () => ({
    query: async (sql) => {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM ops\.job_schedule_slots/.test(sql)) return { rows: active ? [active] : [] };
      if (/INSERT INTO ops\.job_schedule_slots/.test(sql)) {
        inserts++;
        active = inserted;
        return { rows: [inserted] };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
    release: () => {},
  });

  const first = await slots.enqueueManualJob('arbitrage_sync');
  const second = await slots.enqueueManualJob('arbitrage_sync');
  assert.equal(first.slot_id, 88);
  assert.equal(second.slot_id, 88);
  assert.equal(inserts, 1);
});

test('不同套利事件的人工重新解析分别进入持久化任务队列', async (t) => {
  const originalConnect = pool.connect;
  t.after(() => { pool.connect = originalConnect; });
  const rows = [];
  let nextId = 100;
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM ops\.job_schedule_slots/.test(sql)) {
        const payload = JSON.parse(params[2]);
        return { rows: rows.filter(row => row.job_code === params[0] && row.request_payload.caseId === payload.caseId).slice(-1) };
      }
      if (/INSERT INTO ops\.job_schedule_slots/.test(sql)) {
        const row = { slot_id: nextId++, job_code: params[0], status: 'pending', request_payload: JSON.parse(params[3]) };
        rows.push(row);
        return { rows: [row] };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
    release: () => {},
  });

  const caseOne = await slots.enqueueManualJob('arbitrage_reparse', { caseId: 1 });
  const duplicate = await slots.enqueueManualJob('arbitrage_reparse', { caseId: 1 });
  const caseTwo = await slots.enqueueManualJob('arbitrage_reparse', { caseId: 2 });
  assert.equal(caseOne.slot_id, duplicate.slot_id);
  assert.notEqual(caseOne.slot_id, caseTwo.slot_id);
  assert.equal(rows.length, 2);
});

test('质量异常二次恢复在同一事务中先删旧 resolved 再关闭 open', async (t) => {
  const originalConnect = pool.connect;
  t.after(() => { pool.connect = originalConnect; });
  const queries = [];
  let released = false;
  pool.connect = async () => ({
    query: async (sql) => {
      const normalized = sql.trim();
      queries.push(normalized);
      if (/SELECT target_instrument_id/.test(sql)) return { rows: [{ target_instrument_id: 9 }] };
      if (/SELECT 1[\s\S]*parse_status='failed'/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release: () => { released = true; },
  });

  await parser.resolveParseFailure(7);
  const begin = queries.findIndex(sql => sql === 'BEGIN');
  const removeOld = queries.findIndex(sql => /DELETE FROM ops\.data_quality_issues/.test(sql));
  const resolveOpen = queries.findIndex(sql => /UPDATE ops\.data_quality_issues/.test(sql));
  const commit = queries.findIndex(sql => sql === 'COMMIT');
  assert.ok(begin >= 0 && removeOld > begin && resolveOpen > removeOld && commit > resolveOpen);
  assert.equal(released, true);
});

test('质量异常恢复失败时回滚并归还连接', async (t) => {
  const originalConnect = pool.connect;
  t.after(() => { pool.connect = originalConnect; });
  const queries = [];
  let released = false;
  pool.connect = async () => ({
    query: async (sql) => {
      const normalized = sql.trim();
      queries.push(normalized);
      if (/SELECT target_instrument_id/.test(sql)) return { rows: [{ target_instrument_id: 9 }] };
      if (/SELECT 1[\s\S]*parse_status='failed'/.test(sql)) return { rows: [] };
      if (/DELETE FROM ops\.data_quality_issues/.test(sql)) throw new Error('forced failure');
      return { rows: [] };
    },
    release: () => { released = true; },
  });

  await assert.rejects(() => parser.resolveParseFailure(7), /forced failure/);
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(released, true);
});
