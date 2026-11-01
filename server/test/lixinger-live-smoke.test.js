// 理杏仁实源合同验证的受控入口回归（验收 T-002 / S-004）。
//
// 只验证"开关/凭据/分类/告警接线"这些不联网就能证明的部分：
// 真实抽样必须在显式开关下人工执行，不在自动测试里发真实请求。
// 运行：node server/test/lixinger-live-smoke.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');
const smoke = require('../scripts/lixingerLiveSmoke');

const cases = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    cases.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  }).catch(error => {
    cases.push(['FAIL', name + ' :: ' + (error && error.message)]);
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message));
  });
}

function sourceError(code) {
  return Object.assign(new Error(code), { code });
}

(async () => {
  console.log('A. 开关与凭据');

  await check('没有显式开关时不发任何真实请求', async () => {
    let calls = 0;
    const result = await smoke.runSmoke({
      callEndpoint: async () => { calls += 1; return { rows: [] }; },
      env: { LIXINGER_TOKEN: 'x' },
    });
    assert.strictEqual(result.status, 'SMOKE_SKIPPED');
    assert.strictEqual(calls, 0, '默认必须完全不动网络');
  });

  await check('有开关但没有凭据时标"未运行"，不当通过也不当失败', async () => {
    let calls = 0;
    const result = await smoke.runSmoke({
      callEndpoint: async () => { calls += 1; return { rows: [] }; },
      env: { LIXINGER_LIVE_SMOKE: '1' },
    });
    assert.strictEqual(result.status, 'SMOKE_NOT_RUN');
    assert.strictEqual(calls, 0);
  });

  console.log('B. 结果分类');

  await check('成功样例判 OK，空结果判 EMPTY_OK（合法空不冒充失败）', async () => {
    const ok = await smoke.runSmoke({
      callEndpoint: async () => ({ rows: [{ stockCode: '600519', pe_ttm: 21, pb: 5, mc: 1e12, dyr: 0.02 }] }),
      env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
      code: '600519', date: '2026-10-30',
    });
    assert.strictEqual(ok.status, 'OK');
    const empty = await smoke.runSmoke({
      callEndpoint: async () => ({ rows: [] }),
      env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
    });
    assert.strictEqual(empty.status, 'EMPTY_OK');
  });

  await check('结构或单位异常判 CONTRACT_CHANGED，而不是空数据或普通失败', async () => {
    const bad = await smoke.runSmoke({
      callEndpoint: async () => ({ rows: [{ pe_ttm: 20 }] }),
      env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
    });
    assert.strictEqual(bad.status, 'CONTRACT_CHANGED', '缺少 stockCode 属于合同变化');
    const unit = await smoke.runSmoke({
      callEndpoint: async () => ({ rows: [{ stockCode: '600519', mc: 174017, pe_ttm: 20 }] }),
      env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
    });
    assert.strictEqual(unit.status, 'CONTRACT_CHANGED', '总市值明显不是元口径');
    const noMetric = await smoke.runSmoke({
      callEndpoint: async () => ({ rows: [{ stockCode: '600519' }] }),
      env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
    });
    assert.strictEqual(noMetric.status, 'CONTRACT_CHANGED', '估值指标全缺不能算 OK');
  });

  // 复验 RV-05：Number(null)=0、Number('')=0、Number(true)=1 让"五项全空"也能判 OK。
  await check('指标为空/空串/布尔/结构异常都不得判 OK，合法零要保留', async () => {
    const base = { stockCode: '600519', pe_ttm: 21, pb: 5, dyr: 0.02, mc: 1e12, cmc: 9e11 };
    const allNull = { stockCode: '600519', pe_ttm: null, pb: null, dyr: null, mc: null, cmc: null };
    assert.strictEqual(smoke.classifySmokeResult([allNull]).status, 'CONTRACT_CHANGED', '五项全 null 不能算 OK');

    const allEmpty = { stockCode: '600519', pe_ttm: '', pb: '', dyr: '', mc: '', cmc: '' };
    assert.strictEqual(smoke.classifySmokeResult([allEmpty]).status, 'CONTRACT_CHANGED', '空串不能被 Number() 成 0');

    const bools = { ...base, pe_ttm: true, pb: false };
    assert.strictEqual(smoke.classifySmokeResult([bools]).status, 'CONTRACT_CHANGED', '布尔值不是数值');

    const objects = { ...base, mc: { value: 1e12 } };
    assert.strictEqual(smoke.classifySmokeResult([objects]).status, 'CONTRACT_CHANGED', '对象不是数值');

    const missingMc = { stockCode: '600519', pe_ttm: 21, pb: 5, dyr: 0.02 };
    assert.strictEqual(smoke.classifySmokeResult([missingMc]).status, 'CONTRACT_CHANGED', '缺市值无法证明口径');

    const onlyRatioMissing = { stockCode: '600519', mc: 1e12, cmc: 9e11 };
    assert.strictEqual(smoke.classifySmokeResult([onlyRatioMissing]).status, 'CONTRACT_CHANGED', '估值比率全缺不能算 OK');

    // 合法零：不分红、pb/pe 为 0 也要认。
    assert.strictEqual(smoke.classifySmokeResult([{ ...base, dyr: 0 }]).status, 'OK', '股息率 0 是合法值');
    assert.strictEqual(smoke.classifySmokeResult([{ ...base, pe_ttm: 0 }]).status, 'OK', 'pe_ttm 为 0 是合法数值（不猜语义）');
    assert.strictEqual(smoke.classifySmokeResult([{ ...base, mc: '1740176092672' }]).status, 'OK', '纯数字文本按数值接受');

    const array = smoke.classifySmokeResult([['600519']]);
    assert.strictEqual(array.status, 'CONTRACT_CHANGED', '行不是对象属于结构异常');
  });

  await check('权限/限流/网络/阻断分别归类，不混成一个"失败"', async () => {
    const mapped = [
      ['INVALID_CREDENTIAL', 'PERMISSION'],
      ['ACCESS_FORBIDDEN', 'PERMISSION'],
      ['RATE_LIMIT', 'RATE_LIMIT'],
      ['NETWORK_TIMEOUT', 'NETWORK'],
      ['UPSTREAM_5XX', 'NETWORK'],
      ['INVALID_RESPONSE', 'CONTRACT'],
      ['POLICY_NOT_CONFIGURED', 'BLOCKED'],
      ['DEADLINE_EXCEEDED', 'BLOCKED'],
    ];
    for (const [code, expected] of mapped) {
      const result = await smoke.runSmoke({
        callEndpoint: async () => { throw sourceError(code); },
        env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
      });
      assert.strictEqual(result.status, expected, `${code} 应归为 ${expected}，实际 ${result.status}`);
      assert.strictEqual(result.errorCode, code, '原始错误码要保留');
    }
  });

  console.log('C. 告警与恢复接线');

  await check('失败接既有告警链路，成功按恢复证据收敛来源告警', async () => {
    const mailer = require('../services/jobAlertMailer');
    const original = { notify: mailer.notifyJobFailure, resolve: mailer.resolveSourceEndpointAlerts };
    const notified = [];
    const resolved = [];
    mailer.notifyJobFailure = async input => { notified.push(input); };
    mailer.resolveSourceEndpointAlerts = async (source, apiName) => { resolved.push(`${source}:${apiName}`); return 1; };
    try {
      // 注入仓储替身：本用例只验证接线与落库内容，真实持久化恢复在 RV-04 专项里做。
      const recorded = [];
      const repository = {
        insert_ops_source_contract_verifications: async params => { recorded.push(params); return { rows: [{ verification_id: 1 }] }; },
      };
      const failed = await smoke.runSmoke({
        callEndpoint: async () => { throw sourceError('ACCESS_FORBIDDEN'); },
        env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
      });
      const exitCode = await smoke.reportResult(failed, { env: {}, repository });
      assert.strictEqual(exitCode, 1, '失败必须非零退出，不能只变黄');
      assert.strictEqual(notified.length, 1, '失败必须走既有告警入口');
      assert.match(notified[0].alertKey, /^source:lixinger_official:/, '告警要绑定来源+接口作用域');
      assert.strictEqual(notified[0].scopeType, 'source_endpoint');

      const ok = await smoke.runSmoke({
        callEndpoint: async () => ({ rows: [{ stockCode: '600519', pe_ttm: 21, mc: 1e12 }] }),
        env: { LIXINGER_LIVE_SMOKE: '1', LIXINGER_TOKEN: 'x' },
      });
      const okCode = await smoke.reportResult(ok, { env: {}, repository });
      assert.strictEqual(okCode, 0);
      assert.strictEqual(resolved.length, 1, '成功要用恢复证据关闭来源告警，而不是手工改状态');
      // 合同证据（RV-04）：只有真的跑过合同判定才落库；OK 的 contract_ok 必须是 true。
      const verdicts = recorded.filter(item => item[2] === 'OK');
      assert.strictEqual(verdicts.length, 1, '成功抽样必须留下一条合同验证记录');
      assert.strictEqual(verdicts[0][3], true, 'OK 的 contract_ok 必须为 true');
      assert.strictEqual(verdicts[0][0], 'lixinger_official', '来源要与告警作用域一致');
      assert.ok(recorded.every(item => item[2] !== 'PERMISSION'), '权限失败不是合同判定，不应写入合同证据');
    } finally {
      mailer.notifyJobFailure = original.notify;
      mailer.resolveSourceEndpointAlerts = original.resolve;
    }
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 实源合同入口结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
})().catch(error => {
  console.error('lixinger-live-smoke.test.js 失败:', (error && error.stack) || error);
  process.exit(1);
});
