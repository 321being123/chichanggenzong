// 回归：任务槽水位查询与总览告警计数的返回契约。
// 2026-10-29 分层整改把 SQL 下沉到仓储后，仓储改为直接返回行数组，
// 但调用方仍按 { rows } 解构，拿到的 rows 是 undefined：
//   1) queryDataAsOf 抛错被 catch 吞成 null，凡靠它取水位的任务（4 个收盘任务、
//      指数每日补齐、套利公告同步）全部被判「数据日期缺失」，从 10-29 起天天降级；
//   2) getJobOverview 的 alerts 变成 undefined，后台首页告警数量卡片长期为 0。
// 两条都在这里钉死契约，只允许仓储返回数组本身。
const assert = require('assert');

const repo = require('../repositories/jobScheduleSlotsRepository');
const slotService = require('../services/jobScheduleSlots');

const originals = {
  selectDataAsOfDate: repo.selectDataAsOfDate,
  countAlertsByStatus: repo.countAlertsByStatus,
  selectSlotsToday: repo.select_ops_job_schedule_slots_9,
  selectSlotsList: repo.select_ops_job_schedule_slots_10,
  workerHeartbeats: repo.with_ops_worker_heartbeats,
};

(async () => {
  try {
    // 1) 仓储返回数组时，水位必须解析成业务日；返回空数组时必须给 null（不能把无证据当成功）。
    const seen = [];
    repo.selectDataAsOfDate = async (sql, params) => {
      seen.push({ sql, params });
      return [{ data_as_of: '2026-11-03' }];
    };
    const fresh = await slotService.queryDataAsOf('market_close:A股', '2026-11-03');
    assert.strictEqual(fresh, '2026-11-03T00:00:00.000Z', '收盘任务必须能取到当日数据日期');
    assert.strictEqual(seen.length, 1, '收盘任务应走市场覆盖度查询');
    assert.deepStrictEqual(seen[0].params, ['2026-11-03']);
    assert.match(seen[0].sql, /FROM positions p/, '收盘任务按持仓覆盖度判定水位');

    repo.selectDataAsOfDate = async () => [];
    const empty = await slotService.queryDataAsOf('market_close:A股', '2026-11-03');
    assert.strictEqual(empty, null, '查不到水位时必须是 null，交给上层判降级');

    // 2) 总览告警计数：countAlertsByStatus 返回数组，接口必须原样给出数组。
    repo.countAlertsByStatus = async () => [{ status: 'sent', count: 3 }, { status: 'pending', count: 2 }];
    repo.select_ops_job_schedule_slots_9 = async () => ({ rows: [] });
    repo.select_ops_job_schedule_slots_10 = async () => ({ rows: [] });
    repo.with_ops_worker_heartbeats = async () => ({ rows: [] });
    const overview = await slotService.getJobOverview();
    assert.ok(Array.isArray(overview.alerts), '总览 alerts 必须是数组');
    assert.strictEqual(overview.alerts.length, 2);
    assert.strictEqual(overview.alerts.reduce((sum, item) => sum + Number(item.count || 0), 0), 5);

    console.log('job slot watermark contract: data-as-of and overview alerts passed');
  } finally {
    repo.selectDataAsOfDate = originals.selectDataAsOfDate;
    repo.countAlertsByStatus = originals.countAlertsByStatus;
    repo.select_ops_job_schedule_slots_9 = originals.selectSlotsToday;
    repo.select_ops_job_schedule_slots_10 = originals.selectSlotsList;
    repo.with_ops_worker_heartbeats = originals.workerHeartbeats;
    const { pool } = require('../db/connection');
    if (pool && pool.end) await pool.end().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
