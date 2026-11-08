// 暂停后不得新增计划、领取旧槽或通过人工入口调用上游。
const assert = require('assert');
const express = require('express');
const { pool } = require('../db/connection');
const { getJobDefinition } = require('../services/jobDefinitions');
const slots = require('../services/jobScheduleSlots');
const { runJobByCode } = require('../services/jobRunners');

(async () => {
  const original = pool.query;
  let server;
  let queries = 0;
  try {
    for (const code of ['hk_ipo_preopen', 'hk_ipo_postclose', 'hk_ipo_enrichment']) {
      assert.strictEqual(getJobDefinition(code).disabled, true);
      pool.query = async () => { queries++; return { rows: [{ job_code: code }] }; };
      assert.strictEqual(await slots.claimSlot(1), null);
      await assert.rejects(slots.enqueueManualJob(code), /暂时下线/);
      await assert.rejects(slots.retryJobSlot(1), /暂时下线/);
      assert.strictEqual((await runJobByCode(code)).reason, 'job_disabled');
      assert.strictEqual(queries, 2, '只允许查原槽，不得写状态或调用上游');
      queries = 0;
    }
    pool.query = async (sql, params) => {
      if(!params&&sql.includes("job_code='nav_snapshot'")){
        assert(sql.includes("status='blocked'"),'依赖恢复只检查阻塞净值任务');
        return {rows:[]};
      }
      assert(!JSON.parse(params[1]).some(row => row.job_code.startsWith('hk_ipo_')),
        '暂停任务不得占到期队列名额');
      return { rows: [] };
    };
    assert.deepStrictEqual(await slots.listDueSlots(), []);
    const source = require('fs').readFileSync(require.resolve('../services/jobScheduleSlots'), 'utf8');
    assert(source.includes('definition.manualOnly || definition.disabled'), '启动补漏和每日排程均排除暂停任务');
    const html = require('fs').readFileSync(require('path').join(__dirname, '../../public/index.html'), 'utf8');
    assert(!/data-ipo-market="(?:HK|ALL)"|data-ipo-hist="hk_stock"/.test(html));
    pool.query = async () => { throw new Error('暂停接口不得读库或取行情'); };
    const app = express();
    app.use('/api/ipo', require('../routes/ipo'));
    // listen(0) 拿的随机端口可能落在 undici/fetch 的禁用端口表里（6000、6665-6669、10080 等），
    // 那样 fetch 直接报 bad port，与业务无关（2026-11-08 全量偶发一次）。这里避开这些端口重取。
    const blockedPorts = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
      87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427,
      465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
      1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      server = app.listen(0);
      await new Promise(resolve => server.once('listening', resolve));
      if (!blockedPorts.has(server.address().port)) break;
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
    assert(server && server.address() && !blockedPorts.has(server.address().port), '未能取得可用于 fetch 的端口');
    for (const url of ['/calendar?market=HK', '/history?type=hk_stock', '/report/code?code=09995.HK']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ipo${url}`);
      assert.strictEqual(response.status, 503);
      assert.strictEqual((await response.json()).code, 'HK_IPO_SUSPENDED');
    }
    console.log('港股 IPO 暂停边界通过');
  } finally {
    pool.query = original;
    if (server) server.close();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
