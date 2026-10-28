// ========== 站内通知群发投递 Runner（2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.8 节。
// 纪律（2026-10-25 验收反例后加固）：
//  - 必须带执行令牌，缺令牌一律拒绝投递（fail-closed），不能降级为「无保护执行」。
//  - 进入执行态、每页写收件/游标/计数、收尾定状态，全部走带守卫的批次更新：
//    守卫同时校验 dispatch_generation、槽位 running、execution_token 与有效租约；
//    影响 0 行即视为失去归属，立即回滚整页并停写，绝不继续投递或写成功。
//  - 只消费预览时固定的名单，投递前重验账号与会话身份；同名新注册账号（身份不同）记 skipped。
//  - 逐行 SAVEPOINT 记 failed 并继续本页；页级异常整页回滚，不提交半页游标。
//  - 已投递(delivered)/跳过(skipped) 永不重投，重试只处理 pending + failed。
const { pool } = require('../db');
const store = require('../db/notifications');
const txControl = require('../repositories/transactionControl');
const { loadBatch, verifyExecution } = require('../repositories/notificationDispatchRepository.js');

const JOB_CODE = 'notification_dispatch';
const PAGE_SIZE = 50;
// 单次领取最多推进的页数：达到后返回续批，由现有框架再次领取（不是人群截断）
const MAX_PAGES_PER_RUN = 200;

function emptyCounts() {
  // 计数必须用框架认识的固定字段名；顶层 skipped 会被当成整个任务跳过
  return { deliveredCount: 0, skippedCount: 0, failedCount: 0, pendingCount: 0 };
}

// 每页写入前的守卫：批次状态 + 槽位执行令牌 + 有效租约 + 批次代次
/* verifyExecution 已迁入 server/repositories/notificationDispatchRepository.js */

// 带守卫的批次写入：0 行表示本执行已失去归属，抛错让整页回滚
async function writeBatch(client, opts, fields) {
  const updated = await store.updateBatchGuarded(client, {
    batchId: opts.batchId, generation: opts.generation,
    slotId: opts.slotId, executionToken: opts.executionToken,
  }, fields);
  if (!updated) {
    const err = new Error('失去执行归属（令牌/租约/代次变化），已停止写入');
    err.executionLost = true;
    throw err;
  }
  return updated;
}

/* loadBatch 已迁入 server/repositories/notificationDispatchRepository.js */

// 收尾：以收件表实际状态核对计数后定状态，不用累计缓存冒充进度
async function finalize(client, opts, counts) {
  const pending = Number(counts.pending || 0);
  const failed = Number(counts.failed || 0);
  if (pending > 0) {
    await writeBatch(client, opts, {
      status: 'running',
      deliveredCount: counts.delivered, skippedCount: counts.skipped,
      failedCount: failed, pendingCount: pending, remainingCount: pending + failed,
      cursor: opts.cursor, scanRound: opts.scanRound,
    });
    return { status: 'running', pending: pending, failed: failed };
  }
  const completed = failed === 0;
  // 本轮结束仍有失败：升新扫描轮次并重置位置，让自动重试与人工 retry 只重处理 pending+failed
  const nextRound = opts.scanRound + 1;
  await writeBatch(client, opts, {
    // 全部 skipped 也算完成；pending=0 但 failed>0 只能是 partial
    status: completed ? 'completed' : 'partial',
    deliveredCount: counts.delivered, skippedCount: counts.skipped,
    failedCount: failed, pendingCount: 0, remainingCount: failed,
    cursor: null, scanRound: completed ? opts.scanRound : nextRound,
    completedAt: completed ? new Date() : null,
    nextAttemptAt: completed ? null : new Date(Date.now() + 60 * 1000),
  });
  if (!completed) await store.resetRecipientScanRound(client, opts.notificationId);
  return { status: completed ? 'completed' : 'partial', pending: 0, failed: failed };
}

function lostResult(counts, reason) {
  return {
    ok: false, status: 'partial', executionLost: true, reason: reason,
    deliveredCount: Number(counts.delivered || 0), skippedCount: Number(counts.skipped || 0),
    failedCount: Number(counts.failed || 0), pendingCount: Number(counts.pending || 0),
  };
}

async function runNotificationDispatch(reason, context) {
  const ctx = context || {};
  const batchId = String(ctx.batchId || '');
  if (!/^\d{1,19}$/.test(batchId)) {
    return { ok: false, status: 'blocked', error: '通知投递缺少有效批次编号', ...emptyCounts() };
  }
  const batch = await loadBatch(batchId);
  if (!batch) {
    return { ok: false, status: 'blocked', error: '通知投递批次不存在', ...emptyCounts() };
  }
  const opts = {
    batchId: batchId,
    notificationId: batch.notificationId,
    slotId: Number(ctx.slotId) || Number(batch.dispatch_slot_id) || null,
    executionToken: ctx.executionToken || null,
    generation: Number(batch.dispatch_generation || 0),
    scanRound: Math.max(Number(batch.scan_round || 1), 1),
    cursor: batch.cursor || '0',
  };
  if (!opts.slotId) {
    return { ok: false, status: 'blocked', error: '通知投递批次缺少调度槽位', ...emptyCounts() };
  }
  // 缺令牌不降级：没有执行归属时宁可不投递
  if (!opts.executionToken) {
    return { ok: false, status: 'blocked', error: '通知投递缺少执行令牌，拒绝执行', ...emptyCounts() };
  }
  if (['completed', 'cancelled'].includes(batch.status)) {
    // 已完成或已取消：不投递，幂等返回当前计数
    const counts = await store.countRecipients(pool, batch.notificationId);
    return {
      ok: true, status: batch.status,
      deliveredCount: counts.delivered, skippedCount: counts.skipped,
      failedCount: counts.failed, pendingCount: counts.pending,
    };
  }

  const client = await pool.connect();
  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  let guardLost = null;
  let pages = 0;
  try {
    // 进入执行态：必须在事务内先核验令牌/租约/代次，再用同样的守卫写入
    await txControl.begin(client);
    const enterGuard = await verifyExecution(client, opts);
    if (!enterGuard.ok) {
      await txControl.rollback(client);
      const counts = await store.countRecipients(pool, batch.notificationId);
      return lostResult(counts, enterGuard.reason);
    }
    await writeBatch(client, opts, { status: 'running' });
    await txControl.commit(client);

    let exhausted = false;
    while (!exhausted) {
      if (pages >= MAX_PAGES_PER_RUN) break;
      await txControl.begin(client);
      let rows;
      try {
        const guard = await verifyExecution(client, opts);
        if (!guard.ok) {
          await txControl.rollback(client);
          guardLost = guard.reason;
          break;
        }
        rows = await store.scanRecipients(client, batch.notificationId, opts.cursor, PAGE_SIZE, opts.scanRound);
        if (!rows.length) {
          await txControl.commit(client);
          exhausted = true;
          break;
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          await txControl.savepoint(client, 'recipient');
          try {
            const username = row.recipientUsername;
            // 投递前重验账号：删号 → account_deleted；停用 → account_inactive；
            // 同名但建号时间不同（删号后重注册）→ account_replaced，只记 skipped 不投递
            const account = username ? await store.getActiveAccount(client, username) : null;
            if (!username) {
              await store.skipRecipient(client, row.id, 'account_deleted', opts.scanRound);
              skipped++;
            } else if (!account) {
              await store.skipRecipient(client, row.id, 'account_inactive', opts.scanRound);
              skipped++;
            } else if (row.recipientIdentity && String(account.identity || '') !== String(row.recipientIdentity)) {
              await store.skipRecipient(client, row.id, 'account_replaced', opts.scanRound);
              skipped++;
            } else if (await store.deliverRecipient(client, row.id, opts.scanRound)) {
              delivered++;
            }
            await txControl.releaseSavepoint(client, 'recipient');
          } catch (rowError) {
            // 逐行可恢复失败：本行记 failed，本页其他行继续
            await txControl.rollbackToSavepoint(client, 'recipient').catch(function () {});
            await store.failRecipient(client, row.id, rowError && rowError.message, opts.scanRound).catch(function () {});
            failed++;
            await txControl.releaseSavepoint(client, 'recipient').catch(function () {});
          }
          opts.cursor = row.id;
        }
        // 收件状态、last_scan_round、游标与计数同事务提交，且批次写入受执行守卫保护
        const counts = await store.countRecipients(client, batch.notificationId);
        await writeBatch(client, opts, {
          status: 'running', cursor: opts.cursor, scanRound: opts.scanRound,
          deliveredCount: counts.delivered, skippedCount: counts.skipped,
          failedCount: counts.failed, pendingCount: counts.pending,
          remainingCount: Number(counts.pending) + Number(counts.failed),
        });
        delivered = Number(counts.delivered);
        skipped = Number(counts.skipped);
        failed = Number(counts.failed);
        await txControl.commit(client);
        pages++;
        if (rows.length < PAGE_SIZE) exhausted = true;
      } catch (pageError) {
        // 页级异常（含失去执行归属）：整页回滚，不推进本页游标，交给原框架退避
        await txControl.rollback(client).catch(function () {});
        throw pageError;
      }
    }

    if (guardLost) {
      // 令牌失配/租约过期/代次变化：立即停写，不续租、不复活旧执行
      const counts = await store.countRecipients(pool, batch.notificationId);
      return lostResult(counts, guardLost);
    }

    // 收尾事务：重新核验令牌后按实际收件状态定状态
    await txControl.begin(client);
    let result;
    try {
      const guard = await verifyExecution(client, opts);
      if (!guard.ok) {
        await txControl.rollback(client);
        const counts = await store.countRecipients(pool, batch.notificationId);
        return lostResult(counts, guard.reason);
      }
      const counts = await store.countRecipients(client, batch.notificationId);
      result = await finalize(client, opts, counts);
      await txControl.commit(client);
    } catch (e) {
      await txControl.rollback(client).catch(function () {});
      if (e && e.executionLost) {
        const counts = await store.countRecipients(pool, batch.notificationId);
        return lostResult(counts, 'write_guard_failed');
      }
      throw e;
    }

    const payload = {
      ok: result.status === 'completed',
      status: result.status,
      jobCode: JOB_CODE,
      reason: reason,
      deliveredCount: delivered,
      skippedCount: skipped,
      failedCount: failed,
      pendingCount: result.pending,
    };
    if (result.pending > 0) {
      // 还有未投递：续批，由现有框架再次领取（不新建槽位）
      payload.continuationRequired = true;
      payload.ok = true;
      payload.nextAttemptInMinutes = 1;
      return payload;
    }
    if (result.status === 'partial') {
      payload.error = `通知投递仍有 ${failed} 条失败，已保留待重试`;
      payload.retryable = true;
    }
    return payload;
  } catch (e) {
    // 页级异常：把当前进度留给下一个执行者，批次转 partial 等退避重试
    if (e && e.executionLost) {
      const counts = await store.countRecipients(pool, batch.notificationId);
      return lostResult(counts, 'write_guard_failed');
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { runNotificationDispatch, JOB_CODE, PAGE_SIZE, MAX_PAGES_PER_RUN };
