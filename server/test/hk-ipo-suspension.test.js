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
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
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
