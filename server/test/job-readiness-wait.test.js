const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/connection');
const repo = require('../repositories/jobScheduleSlotsRepository');
const {
  ensureSlot, waitForReadinessSlot, reconcileReadinessSlots, nextReadinessCheckpoint, readinessMoment,
  listDueSlots, claimSlot, completeSlot, isReadinessPilot,
} = require('../services/jobScheduleSlots');
const alertRepo = require('../repositories/jobAlertMailerRepository');
const { listAlerts } = require('../services/jobAlertMailer');
const { loadTerminalBar } = require('../jobs/marketClose');
const { isRatePublicationWait, NAV_PUBLISH_DATASETS } = require('../jobs/navSnapshot');
const { slotWaitingState } = require('../services/jobRecoveryEvidence');
const { getJobDefinition } = require('../services/jobDefinitions');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// 就绪等待（方案 2026-11-18 P0-A）：真实 PG 事务回归。
// 断言的是"等待不吃失败预算、超硬截止才转故障"这套账，不绑定函数名或 SQL 文本。
(async () => {
  const c = await pool.connect();
  const original = pool.query;
  let seq = 0;
  try {
    await c.query('BEGIN');
    pool.query = c.query.bind(c);

    // 业务日取次日：任务定义的 19:30 硬截止据此落在未来，测试不被"当天已过 19:30"影响。
    const insert = async (jobCode, status, extra = {}) => {
      seq += 1;
      const { rows } = await c.query(
        `INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,status,trigger_type,next_attempt_at,attempt_count,claim_count,fail_count,execution_token,lease_owner,lease_until)
         VALUES($1,now()+($7::integer * interval '1 minute'),current_date + 1,$2,'scheduled',now(),$3,$4,$5,$6,'test-worker',now() + interval '30 minutes')
         RETURNING slot_id`, [jobCode, status, extra.attemptCount || 0, extra.claimCount || 0,
          extra.failCount || 0, extra.token || `tok-${seq}`, seq]);
      return { slotId: rows[0].slot_id, token: extra.token || `tok-${seq}` };
    };
    const readSlot = async id => (await c.query('SELECT * FROM ops.job_schedule_slots WHERE slot_id=$1', [id])).rows[0];
    // 到期条件：把下一次检查推到过去，模拟"已到检查点"。
    const makeDue = id => c.query("UPDATE ops.job_schedule_slots SET next_attempt_at=now()-interval '1 minute' WHERE slot_id=$1", [id]);

    // ① 锁等待写入：进入 waiting_readiness，且不吃失败预算
    const lockSlot = await insert('market_close:可转债', 'running', { attemptCount: 1, claimCount: 1 });
    const locked = await waitForReadinessSlot(lockSlot.slotId, {
      waitKind: 'lock', errorMessage: '数据集被其他执行占用', resultSummary: { ok: false },
    }, null, lockSlot.token);
    assert(locked, '锁等待必须写入成功');
    assert.strictEqual(locked.status, 'waiting_readiness');
    assert.strictEqual(locked.fail_count, 0, '零外采的锁等待不得消耗失败预算');
    assert.strictEqual(locked.result_summary.waitKind, 'lock');
    assert(locked.next_attempt_at, '必须记录明确的下一检查点');
    assert(locked.result_summary.readinessStopAt, '必须记录硬截止，不能无限续等');
    assert.strictEqual(locked.attempt_count, 1, '新账本就绪等待不得反向扣减兼容领取计数');

    // ② 等待期间的展示口径：算等待、且免于续批止损
    const waitingState = slotWaitingState(locked);
    assert.strictEqual(waitingState.waiting, true, '就绪等待必须被识别为等待');
    assert.strictEqual(waitingState.kind, 'readiness');
    assert.strictEqual(waitingState.exempt, true, '就绪等待不得触发续批止损');
    assert.strictEqual(waitingState.waitKind, 'lock');

    // ③ 锁到期：统一重验直接放行原槽，不新开实例、不扣失败
    await makeDue(lockSlot.slotId);
    const resumed = await reconcileReadinessSlots(10);
    assert(resumed.resumed >= 1, '到期的锁等待必须被重验放行');
    const afterLock = await readSlot(lockSlot.slotId);
    assert.strictEqual(afterLock.status, 'pending', '锁到期转回原槽待执行');
    assert.strictEqual(afterLock.fail_count, 0, '放行不得增加失败预算');
    assert(!afterLock.result_summary.readinessFirstReadyAt,
      '锁等待唤醒不得伪造数据首次就绪时间');
    assert(afterLock.result_summary.readinessReadyAt,
      '锁等待唤醒仍需记录恢复时刻');
    assert.strictEqual(afterLock.result_summary.waitingReadiness, false,
      '放行后必须清掉等待标记，否则会一直被当成免于漏跑告警的等待');

    // ③b 自产终盘分区缺失不能把原 Runner 永久锁死：到检查点应唤醒一次，
    // 分区只能由唤醒后的 Runner 按实际品种取数并发布，不能由重验入口伪造 ready。
    const producerSlot = await insert('nav_snapshot', 'running', { attemptCount: 1, claimCount: 1 });
    await waitForReadinessSlot(producerSlot.slotId, {
      waitKind: 'publication', errorMessage: '终盘分区尚未发布', resultSummary: { pendingConfirmation: 1 },
    }, null, producerSlot.token);
    await makeDue(producerSlot.slotId);
    const producerWake = await reconcileReadinessSlots(20);
    assert(producerWake.resumed >= 1, '自产终盘分区缺失到检查点必须唤醒原 Runner');
    const afterProducerWake = await readSlot(producerSlot.slotId);
    assert.strictEqual(afterProducerWake.status, 'pending', '自产分区唤醒必须回到原槽 pending');
    assert(!afterProducerWake.result_summary.readinessFirstReadyAt,
      '自产分区缺失的唤醒不得伪造首次就绪时间');

    // ③c 自产分区越过升级时刻仍缺失：唤醒原 Runner 的同时必须升级告警。
    // 旧实现在唤醒分支直接 continue，18:30 之后到硬截止前一直静默，告警数始终是 0。
    const escalationProducer = await insert('nav_snapshot', 'running', { attemptCount: 1, claimCount: 1 });
    await c.query(
      `UPDATE ops.job_schedule_slots
          SET status='waiting_readiness', next_attempt_at=now()-interval '1 minute', result_summary=$2::jsonb
        WHERE slot_id=$1`,
      [escalationProducer.slotId, {
        waitingReadiness: true, waitKind: 'publication',
        readinessStopAt: new Date(Date.now() + 3 * 3600000).toISOString(),
        readinessEscalateAt: new Date(Date.now() - 60000).toISOString(),
        readinessNextCheckAt: new Date(Date.now() - 60000).toISOString(),
      }]
    );
    const producerEscalated = await reconcileReadinessSlots(20);
    assert(producerEscalated.escalated >= 1, '自产分区越过升级时刻必须升级告警');
    const afterProducerEscalation = await readSlot(escalationProducer.slotId);
    assert.strictEqual(afterProducerEscalation.status, 'pending', '升级后仍要唤醒原 Runner，不能停在等待');
    assert(afterProducerEscalation.result_summary.readinessEscalatedAt,
      '自产分区升级必须留下幂等标记，避免每个检查点重复告警');
    assert.strictEqual(afterProducerEscalation.result_summary.waitingReadiness, false,
      '唤醒后的槽不得继续保留等待标记（升级补丁不能把旧摘要的 true 写回来）');
    assert.strictEqual(afterProducerEscalation.fail_count, 0, '自产分区升级不是执行失败，不得扣失败预算');

    // ④ 依赖未就绪：只推进检查点，保持等待，不判永久失败
    const depSlot = await insert('ipo_calendar_refresh', 'pending');
    await c.query(
      `UPDATE ops.job_schedule_slots
          SET status='waiting_readiness', next_attempt_at=now()-interval '1 minute',
              result_summary=$2::jsonb
        WHERE slot_id=$1`,
      [depSlot.slotId, {
        waitingReadiness: true, waitKind: 'dependency',
        readinessStopAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        readinessEscalateAt: new Date(Date.now() + 3 * 3600000).toISOString(),
        readinessNextCheckAt: new Date(Date.now() - 60000).toISOString(),
      }]
    );
    const deferred = await reconcileReadinessSlots(10);
    assert(deferred.deferred >= 1, '分区未发布必须走延期而不是失败');
    const afterDep = await readSlot(depSlot.slotId);
    assert.strictEqual(afterDep.status, 'waiting_readiness', '未就绪仍保持等待');
    assert.strictEqual(afterDep.fail_count, 0, '未就绪不得计入失败');
    assert(new Date(afterDep.next_attempt_at).getTime() > Date.now(), '必须推进到下一个检查点');
    assert(afterDep.result_summary.readinessLastCheckedAt, '必须留下本次核验时刻');
    assert(Array.isArray(afterDep.result_summary.readinessObservations)
      && afterDep.result_summary.readinessObservations.some(item => item.datasetCode === 'ipo_history' && item.ready === false),
    '分区缺失时必须留下逐项未就绪观测');
    assert(afterDep.result_summary.readinessObservations.every(item => !item.firstReadyAt),
      '未就绪观测不得伪造首次就绪时间');
    assert(!afterDep.result_summary.readinessEscalatedAt, '未到升级时刻不得提前告警');

    // ④b 越过升级时刻仍未就绪：保持等待、只发一次升级告警，不提前扣失败预算。
    const escalationSlot = await insert('ipo_calendar_refresh', 'pending');
    await c.query(
      `UPDATE ops.job_schedule_slots
          SET status='waiting_readiness', next_attempt_at=now()-interval '1 minute',
              result_summary=$2::jsonb
        WHERE slot_id=$1`,
      [escalationSlot.slotId, {
        waitingReadiness: true, waitKind: 'dependency',
        readinessStopAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        readinessEscalateAt: new Date(Date.now() - 60000).toISOString(),
        readinessNextCheckAt: new Date(Date.now() - 60000).toISOString(),
      }]
    );
    const escalated = await reconcileReadinessSlots(10);
    assert(escalated.escalated >= 1, '超过升级时刻必须进入升级告警分支');
    const afterEscalation = await readSlot(escalationSlot.slotId);
    assert.strictEqual(afterEscalation.status, 'waiting_readiness');
    assert(afterEscalation.result_summary.readinessEscalatedAt, '升级后必须留下幂等标记');
    assert.strictEqual(afterEscalation.fail_count, 0, '升级告警不是失败，不得扣失败预算');

    // ⑤ 超过本业务日硬截止：这才升级为故障并计一次失败
    const expiredSlot = await insert('market_close:可转债', 'pending');
    await c.query(
      `UPDATE ops.job_schedule_slots
          SET status='waiting_readiness', next_attempt_at=now()-interval '1 minute',
              result_summary=$2::jsonb
        WHERE slot_id=$1`,
      [expiredSlot.slotId, {
        waitingReadiness: true, waitKind: 'publication',
        readinessStopAt: new Date(Date.now() - 60000).toISOString(),
      }]
    );
    const expired = await reconcileReadinessSlots(10);
    assert(expired.expired >= 1, '超过硬截止必须升级');
    const afterExpired = await readSlot(expiredSlot.slotId);
    assert.strictEqual(afterExpired.status, 'failed');
    // 超期是真故障，但"没执行过"就不能记一笔执行失败：这条槽一次都没被领取（claim_count=0），
    // 记 fail_count 会破坏"领取 = 失败+等待+续批+成功+其他结算+未结算"的守恒。
    assert.strictEqual(afterExpired.fail_count, 0, '零领取的就绪等待超期不得凭空增加执行失败数');
    assert.strictEqual(afterExpired.claim_count, 0, '该槽从未领取');
    assert.strictEqual(afterExpired.result_summary.waitingReadiness, false, '超期后不再计入等待，真实故障必须上报');
    assert(afterExpired.result_summary.readinessExpiredAt, '超期必须保留自动领取熔断证据');
    assert(/硬截止/.test(afterExpired.last_error || ''), '超期必须留下可查原因');
    const autoClaimAfterExpiry = await claimSlot(expiredSlot.slotId, 'test-worker', 'scheduled');
    assert.strictEqual(autoClaimAfterExpiry, null, '硬截止失败槽不得被直接 claimSlot 绕过');
    const manualReset = (await repo.update_ops_job_schedule_slots_17([expiredSlot.slotId])).rows[0];
    assert(manualReset && !manualReset.result_summary.readinessExpiredAt, '人工重试必须清除硬截止门禁');

    // ⑥b warning → critical 必须在同一逻辑告警上重新进入投递队列
    const alertKey = `test-readiness-escalation-${expiredSlot.slotId}`;
    const warning = (await alertRepo.insert_ops_alert_notifications([
      alertKey, 'failure_warning', 'warning', 'market_close:可转债', expiredSlot.slotId,
      'slot', String(expiredSlot.slotId), '等待数据就绪', '仍在等待',
    ], c)).rows[0];
    await c.query("UPDATE ops.alert_notifications SET status='sent', send_attempts=0 WHERE alert_id=$1", [warning.alert_id]);
    const critical = (await alertRepo.insert_ops_alert_notifications([
      alertKey, 'failure', 'critical', 'market_close:可转债', expiredSlot.slotId,
      'slot', String(expiredSlot.slotId), '数据就绪超期', '已超过硬截止',
    ], c)).rows[0];
    assert.strictEqual(critical.alert_type, 'failure', '升级必须保留同一逻辑告警并切换类型');
    assert.strictEqual(critical.severity, 'critical', '升级必须切换严重度');
    assert.strictEqual(critical.status, 'pending', '已送达 warning 升级后必须重新进入投递队列');
    assert.strictEqual(critical.send_attempts, 0, '升级必须重置本次严重度的投递次数');

    // ⑥c 所有收尾写入都必须保留就绪观测，不能被 Runner summary 覆盖。
    const evidenceSlot = await insert('notification_dispatch', 'pending');
    const evidenceClaim = (await repo.update_ops_job_schedule_slots_7([
      evidenceSlot.slotId, 'test-worker', 'scheduled', 3, 30, 'tok-evidence',
    ])).rows[0];
    await c.query(
      `UPDATE ops.job_schedule_slots SET result_summary=$2::jsonb WHERE slot_id=$1`,
      [evidenceSlot.slotId, {
        readinessFirstReadyAt: '2026-11-19T09:30:00.000Z',
        readinessObservations: [{ observationKey: 'dataset:CN:2026-11-19:core', firstReadyAt: '2026-11-19T09:30:00.000Z' }],
      }]
    );
    const completedEvidence = await completeSlot(
      evidenceSlot.slotId, 'succeeded', { ok: true, stageComplete: true }, null, null, evidenceClaim.execution_token,
    );
    assert(completedEvidence.result_summary.readinessFirstReadyAt, '成功收尾不得丢失首次就绪时间');
    assert.strictEqual(completedEvidence.result_summary.readinessObservations.length, 1, '成功收尾不得丢失就绪观测明细');

    // ⑦ 检查点换算按北京时间，且只取未来时刻
    const definition = getJobDefinition('market_close:可转债');
    assert.deepStrictEqual(definition.readinessCheckpoints, ['15:31', '15:33', '15:36']);
    assert.strictEqual(definition.readinessEscalateAt, '16:00');
    assert.strictEqual(definition.readinessStopAt, '17:00');
    const moment = readinessMoment('2026-11-19', '15:31');
    assert.strictEqual(moment.toISOString(), '2026-11-19T07:31:00.000Z', '15:31 北京时间等于 07:31Z');
    const next = nextReadinessCheckpoint({ business_date: '2026-11-19' }, definition, new Date('2026-11-19T07:30:00Z'));
    assert.strictEqual(next.toISOString(), '2026-11-19T07:31:00.000Z', '首查取第一个未到时刻');
    const afterAll = nextReadinessCheckpoint({ business_date: '2026-11-19' }, definition, new Date('2026-11-19T12:00:00Z'));
    assert.strictEqual(afterAll.getTime() > new Date('2026-11-19T12:00:00Z').getTime(), true, '检查点用尽后按有限兜底推进，不无限等待');

    // ⑧ 未配置就绪窗口的任务保持原合同，配置了窗口的任务才进入新状态
    const orchestrator = read('server/services/jobOrchestrator.js');
    assert(/failure\.code === 'DATASET_LOCKED'[^\n]*isReadinessPilot\(definition\)/.test(orchestrator),
      '数据集锁等待必须先判定试点任务，不能对所有任务一刀切');
    assert.deepStrictEqual(getJobDefinition('nav_snapshot').readinessCheckpoints, ['18:30'],
      '净值/逆回购缺口必须登记 18:30 检查点，不能继续按 60 分钟自行续跑');
    assert.ok(getJobDefinition('nav_snapshot').readinessEscalateAt && getJobDefinition('nav_snapshot').readinessStopAt,
      '净值就绪等待必须有升级时刻和硬截止');
    assert.strictEqual(getJobDefinition('nav_snapshot').readinessDatasetDependencies[0].datasetCode,
      'repo_daily_rates', '逆回购利率必须进入统一就绪依赖');
    assert.ok(!getJobDefinition('bond_safety_refresh').readinessCheckpoints,
      '未声明检查点的任务保持既有 blocked 合同');
    assert.deepStrictEqual(getJobDefinition('market_close:可转债').datasetDependencies, [],
      '任务自己产出的终盘分区不得成为领取前置依赖');
    assert.deepStrictEqual(getJobDefinition('market_close:可转债').readinessDatasetDependencies, [],
      '收盘腾讯报价只等待请求锁，不等待历史日线分区');
    assert.ok(getJobDefinition('ipo_calendar_refresh').readinessCheckpoints,
      'IPO 输入分区缺失必须进入有界就绪等待');
    const producedPartitionSlot = await insert('market_close:可转债', 'pending');
    await c.query("UPDATE ops.job_schedule_slots SET scheduled_for=now()-interval '1 minute' WHERE slot_id=$1", [producedPartitionSlot.slotId]);
    const dueWithMissingProducedPartition = await listDueSlots(100);
    assert(dueWithMissingProducedPartition.some(item => item.slot_id === producedPartitionSlot.slotId),
      '任务自己产出的终盘分区缺失时仍必须能够领取任务');
    const claimedWithMissingProducedPartition = await claimSlot(producedPartitionSlot.slotId, 'test-worker', 'scheduled');
    assert(claimedWithMissingProducedPartition && claimedWithMissingProducedPartition.status === 'running',
      '任务自己产出的终盘分区不得阻断原 Runner');

    const groupedAlertSlot = await insert('market_close:LOF/ETF', 'pending');
    await c.query(
      `INSERT INTO ops.alert_notifications(alert_key,alert_type,severity,status,job_code,slot_id,scope_type,scope_key,subject,summary)
       VALUES ($1,'data_quality','critical','pending','market_close:可转债',$2,'dataset','position_close_bars_cn:CN','终盘缺口','第一条')`,
      [`test-grouped-alert-${groupedAlertSlot.slotId}`, producedPartitionSlot.slotId]);
    await c.query(
      `INSERT INTO ops.alert_notifications(alert_key,alert_type,severity,status,job_code,slot_id,scope_type,scope_key,subject,summary)
       VALUES ($1,'data_quality','critical','pending','market_close:LOF/ETF',$2,'dataset','position_close_bars_cn:CN','终盘缺口','第二条')`,
      [`test-grouped-alert-${groupedAlertSlot.slotId}-2`, groupedAlertSlot.slotId]);
    const groupedAlerts = await listAlerts({ status: 'open', limit: 50 });
    const grouped = groupedAlerts.find(item => item.group_alert_ids && item.group_alert_ids.length === 2);
    assert(grouped, '同数据集作用域的活动告警必须归并为一条代表记录');
    assert.strictEqual(grouped.group_items.length, 2, '归并记录必须保留可展开明细');

    // ⑨b 净值/逆回购接线：18:30 检查点、升级与硬截止生效，依赖分区被真实读取。
    // 缺利率分区属于"本任务还没产出"，到检查点只唤醒原槽；分区发布后才写就绪观测。
    const navWakeSlot = await insert('nav_snapshot', 'pending');
    await c.query(
      `UPDATE ops.job_schedule_slots
          SET status='waiting_readiness', next_attempt_at=now()-interval '1 minute', result_summary=$2::jsonb
        WHERE slot_id=$1`,
      [navWakeSlot.slotId, {
        waitingReadiness: true, waitKind: 'dependency',
        readinessStopAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        readinessEscalateAt: new Date(Date.now() + 3 * 3600000).toISOString(),
        readinessNextCheckAt: new Date(Date.now() - 60000).toISOString(),
      }]
    );
    const navWake = await reconcileReadinessSlots(20);
    assert(navWake.resumed >= 1, '净值缺利率分区时到检查点必须唤醒原槽');
    const afterNavWake = await readSlot(navWakeSlot.slotId);
    assert.strictEqual(afterNavWake.status, 'pending', '唤醒后回到原净值槽待执行');
    assert(!afterNavWake.result_summary.readinessFirstReadyAt, '自产缺口不得伪造首次就绪时间');
    assert.strictEqual(afterNavWake.fail_count, 0, '就绪等待不得扣净值的失败预算');

    await c.query(
      `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics,published_at)
       VALUES('repo_daily_rates','CN',current_date + 1,'published',false,$1::jsonb,now())
       ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE
         SET status='published',is_stale=false,diagnostics=EXCLUDED.diagnostics,updated_at=now()`,
      [JSON.stringify({ quality_status: 'passed', query_status: 'success' })]
    );
    const navReadySlot = await insert('nav_snapshot', 'pending');
    await c.query(
      `UPDATE ops.job_schedule_slots
          SET status='waiting_readiness', next_attempt_at=now()-interval '1 minute', result_summary=$2::jsonb
        WHERE slot_id=$1`,
      [navReadySlot.slotId, {
        waitingReadiness: true, waitKind: 'dependency',
        readinessStopAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        readinessEscalateAt: new Date(Date.now() + 3 * 3600000).toISOString(),
        readinessNextCheckAt: new Date(Date.now() - 60000).toISOString(),
      }]
    );
    const navReady = await reconcileReadinessSlots(20);
    assert(navReady.resumed >= 1, '利率分区发布后必须唤醒原净值槽');
    const afterNavReady = await readSlot(navReadySlot.slotId);
    assert.strictEqual(afterNavReady.status, 'pending');
    const navObservations = afterNavReady.result_summary.readinessObservations || [];
    assert(navObservations.some(item => item.datasetCode === 'repo_daily_rates' && item.ready === true),
      '利率分区已发布时必须留下就绪观测，供三交易日观察逐项核对');

    // ⑨c 净值 Runner 与编排器接线：仅"目标分区未就绪"转就绪等待，不再 60 分钟自行续跑
    const navJobSource = read('server/jobs/navSnapshot.js');
    assert(/readinessWait\s*=\s*\{\s*waitKind:\s*'dependency'/.test(navJobSource),
      '净值 Runner 必须把利率未发布标成就绪等待，而不是 60 分钟续跑');
    assert(!/result\.continuationRequired\s*=\s*true/.test(navJobSource),
      '净值不得再自行设置 60 分钟续跑，避免两套唤醒链路同时存在');
    assert(/result\.readinessWait && isReadinessPilot\(definition\)/.test(orchestrator),
      '编排器必须把 Runner 的就绪等待转成 waiting_readiness');
    // 只有"上游尚未发布/缺行"才算就绪等待；超时等真实失败必须走失败计数与退避。
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [{ code: 'EMPTY_DATA' }] }, []), true,
      '当日利率未发布（空数据）才算就绪等待');
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [{ code: 'TIMEOUT' }] }, []), false,
      '超时不得被当作未发布，否则会绕过失败计数与退避');
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [{ code: 'INVALID_DATA' }] }, []), false,
      '上游返回了目标日记录但数据无效属于真实失败，不是未发布');
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [{ code: 'EMPTY_DATA' }, { code: 'UPSTREAM_5XX' }] }, []), false,
      '混合失败里只要有一项真实失败就不能进等待');
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [{ code: 'EMPTY_DATA' }] },
      [{ accountName: 'a', error: 'x' }]), false, '账户失败时不得把整任务判成数据未发布');
    // 落库/发布异常（例如分区写入失败）只带错误描述、没有 failures：
    // 旧实现把缺失的 failures 当成空数组，every() 恒真 → 进等待队列绕过失败预算。
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [] }, []), false,
      '没有失败证据也没有缺行时不得进就绪等待');
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [], remainingCount: 0 }, []), false,
      '明确零缺行时不得进就绪等待');
    assert.strictEqual(isRatePublicationWait({ ok: false, failures: [], remainingCount: 2 }, []), true,
      '明确缺目标日数据时才算未发布');
    assert.strictEqual(isRatePublicationWait({
      ok: false, errorCode: 'REPO_RATE_SYNC_FAILED', error: '写入分区失败',
      failures: [{ code: 'REPO_RATE_SYNC_FAILED' }],
    }, []), false, '利率落库/分区写入异常必须走失败预算，不能被当成未发布');
    const repoRatesSource = read('server/services/repoDailyRates.js');
    assert(/errorCode:code/.test(repoRatesSource) && /failures:\[\{code,message/.test(repoRatesSource),
      '利率服务捕获异常时必须保留失败分类与 failures，不能只留错误描述');
    // 净值任务不得把回购利率分区交给通用发布器：重复发布会刷新 published_at、覆盖 source_id。
    assert.deepStrictEqual([...NAV_PUBLISH_DATASETS], ['nav_snapshot'], '净值任务只发布自己的快照数据集');
    assert(!NAV_PUBLISH_DATASETS.includes('repo_daily_rates'), '回购利率分区只能由利率服务写入');
    // ⑰ 利率分区必须按目标日精确读取：补跑历史日不能被"更新日期的分区"带偏。
    const { readRepoPartitionState } = require('../services/repoDailyRates');
    const repoPartitionTarget = '2026-11-17';
    const publishRepoPartitionRow = (partitionKey, quality = 'passed') => c.query(
      `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics,published_at)
       VALUES('repo_daily_rates','CN',$1::date,'published',false,$2::jsonb,now())
       ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE
         SET status='published',is_stale=false,diagnostics=EXCLUDED.diagnostics,updated_at=now()`,
      [partitionKey, JSON.stringify({ quality_status: quality, query_status: 'success' })],
    );
    await publishRepoPartitionRow(repoPartitionTarget);
    // 更晚日期的分区也存在（补跑历史日时"最新分区"就是它）。
    await publishRepoPartitionRow('2026-11-19');
    const targetState = await readRepoPartitionState(repoPartitionTarget);
    assert.strictEqual(targetState.published, true,
      '目标日分区已发布时必须判就绪，不能被更晚日期的分区带偏');
    assert.strictEqual(targetState.partitionKey, repoPartitionTarget, '必须按目标日精确读取分区');
    await publishRepoPartitionRow(repoPartitionTarget, 'failed');
    const failedState = await readRepoPartitionState(repoPartitionTarget);
    assert.strictEqual(failedState.published, false, '同日分区质量未通过时必须判未就绪');
    // ⑱ 休市阶段收尾必须是 skipped：后台要能区分"确实采到"与"这天本来无需采集"。
    const skippedSlot = await insert('nav_snapshot', 'running', { attemptCount: 1, claimCount: 1 });
    const completedSkipped = await completeSlot(skippedSlot.slotId, 'skipped',
      { ok: true, skipDatasetPublication: true }, '目标日休市：本阶段无需发布数据集，按跳过收尾', null, skippedSlot.token);
    assert(completedSkipped && completedSkipped.status === 'skipped',
      '休市阶段必须落为 skipped，不能记成 succeeded');
    const orchestratorSource = read('server/services/jobOrchestrator.js');
    assert(/\? 'skipped' : 'succeeded'/.test(orchestratorSource), '编排器收尾必须按跳过写 skipped');
    assert(/skipDatasetPublication === true/.test(orchestratorSource), '编排器必须识别跳过发布的阶段');
    // ⑩ 运营分析与任务页共用同一待处理口径：同一归并查询、同一计数单位，同快照才能对账
    const analyticsRepo = read('server/repositories/siteAnalyticsRepository.js');
    assert(/countAlertGroupsByStatus/.test(analyticsRepo),
      '运营分析必须复用后台告警的归并组计数，不能各写一套口径');
    assert(!/COUNT\(\*\)::int AS pending_exceptions/.test(analyticsRepo),
      '运营分析不得按原始告警条数统计：任务页展示的是归并组数，同快照会对不上');
    assert(!/status NOT IN \('resolved','acknowledged','suppressed'\)/.test(analyticsRepo),
      '运营分析不得保留与任务页不同的独立待处理口径');
    const adminViewSource = read('public/js/admin.js');
    assert(/alertGroupTotal/.test(adminViewSource), '任务页告警组数必须取总览归并组合计');
    assert(!/'告警组数'[\s\S]{0,120}alerts\.length/.test(adminViewSource),
      '任务页告警组数不得取列表长度（列表有 30 条上限）');
    // 共享采集任务也不得把回购利率分区交回通用发布器：
    // 否则利率与合格分区都已存在时仍会写一次，刷新 published_at、覆盖 source_id。
    const universeDefinition = getJobDefinition('convertible_bond_universe_refresh');
    const universeSyncSource = read('server/services/convertibleBondAnalysisSync.js');
    for (const mode of ['core', 'shared_eod']) {
      const contract = universeDefinition.datasetPublicationByMode[mode];
      assert(!contract.publish.includes('repo_daily_rates'),
        `${mode} 阶段不得由通用发布器写回购利率分区`);
      assert(contract.optionalPublish.includes('repo_daily_rates'),
        `${mode} 阶段应把回购利率分区登记为可选，不再强制包含`);
    }
    assert(/publishDatasetCodes:\['bond_master','bond_daily','stock_daily','stock_valuation','stock_adj_factor','stock_suspend_calendar'\]/.test(universeSyncSource),
      '共享采集 core/shared_eod 的发布清单不得包含 repo_daily_rates');

    // ⑪ 存量兼容边界：迁移只标记合同，不把混合旧计数写进新账本
    const migrationSource = read('server/db/migrations/era16JobSlotRetryCounters.js');
    assert(/retry_contract/.test(migrationSource), '必须显式标记存量槽的计数合同，不能靠新列隐式回退');
    assert(!/claim_count\s*=\s*attempt_count/.test(migrationSource) && !/fail_count\s*=\s*attempt_count/.test(migrationSource),
      '不得把混合了领取与等待豁免的旧 attempt_count 复制进新账本');
    assert(/WHERE status IN \('pending','running','failed','blocked','degraded','waiting_external'\)/.test(migrationSource),
      '只允许标记迁移瞬间未终结的槽');

    // ⑫ 存量槽仍按旧计数判定，不被新列"清零"后重新放行
    const legacySlot = await insert('market_close:可转债', 'failed', { attemptCount: 3, claimCount: 0, failCount: 0 });
    await c.query("UPDATE ops.job_schedule_slots SET retry_contract='legacy' WHERE slot_id=$1", [legacySlot.slotId]);
    const legacyClaim = await repo.update_ops_job_schedule_slots_7([legacySlot.slotId, 'test-worker', 'scheduled', 3, 30, 'tok-legacy']);
    assert.strictEqual(legacyClaim.rows.length, 0, 'legacy 存量槽必须继续用 attempt_count 判定，不能被当成未耗尽');
    const legacyRetried = (await repo.update_ops_job_schedule_slots_17([legacySlot.slotId])).rows[0];
    assert.strictEqual(legacyRetried.retry_contract, 'counters', '人工重试是定向确认，允许把存量槽切到新合同');

    // 当前收盘价使用腾讯时间戳；接口错误分类仍在历史日线修复路径保留。
    for (const code of ['DATASET_LOCKED', 'PERMISSION_DENIED', 'RATE_LIMIT', 'UPSTREAM_5XX']) {
      const error = Object.assign(new Error('terminal ' + code), { code });
      const terminal = await loadTerminalBar({
        code: '110043', kind: 'bond', date: '2026-11-18', readPublishedBar: null,
        fetchSeries: async () => { throw error; }, persistBar: null,
      });
      assert.strictEqual(terminal.ok, false);
      assert.strictEqual(terminal.terminalError.code, code);
    }

    const slotsRepository = require('../repositories/jobScheduleSlotsRepository');
    const replaceJob = 'market_close:LOF/ETF';
    const oldAt = '2026-11-24T15:10:00+08:00';
    const newAt = '2026-11-24T15:30:00+08:00';
    const oldSlot = await ensureSlot(replaceJob, oldAt, '2026-11-24');
    const newSlot = await ensureSlot(replaceJob, newAt, '2026-11-24');
    await slotsRepository.skipReplacedScheduledSlot(replaceJob, oldAt, newSlot.slot_id, c);
    const retired = await readSlot(oldSlot.slot_id);
    assert.strictEqual(retired.status, 'skipped', '旧 15:10 自动槽随 15:30 新槽退出');
    assert.strictEqual(retired.result_summary.replacementSlotId, Number(newSlot.slot_id));
    assert.strictEqual((await readSlot(newSlot.slot_id)).status, 'pending');

    console.log('就绪等待真实PG回归：锁等待不扣预算/到期放行/依赖延期/硬截止升级/检查点换算与试点边界通过');
  } finally {
    pool.query = original;
    await c.query('ROLLBACK');
    c.release();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
