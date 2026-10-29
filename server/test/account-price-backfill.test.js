// 导入后补当日行情：只补「今天有持仓但没有当日价格」的代码，失败不抛。
const assert = require('assert');
const repo = require('../repositories/accountPriceBackfillRepository');
const svc = require('../services/accountPriceBackfill');

(async () => {
  const origin = repo.selectPositionCodesMissingPrice;
  try {
    // 1) 正常补齐：两只里一只成功一只失败
    let limitSeen = null;
    repo.selectPositionCodesMissingPrice = async ([username, accountName, today, limit]) => {
      assert.strictEqual(username, 'u1');
      assert.strictEqual(accountName, 'A');
      assert.strictEqual(today, '2026-10-29');
      limitSeen = limit;
      return { rows: [{ code: '601995', name: '中金公司' }, { code: '00546', name: '阜丰集团' }] };
    };
    const calls = [];
    let r = await svc.backfillMissingTodayPrices('u1', 'A', {
      today: '2026-10-29',
      backfill: async (username, accountName, code) => { calls.push(code); return code === '601995'; },
    });
    assert.deepStrictEqual(calls, ['601995', '00546'], '两只都要尝试');
    assert.strictEqual(r.checked, 2);
    assert.strictEqual(r.filled, 1);
    assert.deepStrictEqual(r.failed, ['00546'], '失败的代码要如实返回');
    assert.ok(limitSeen > 0 && limitSeen <= 80, '查询必须带数量上限');

    // 2) 没有缺价代码时不调用采集
    let touched = false;
    repo.selectPositionCodesMissingPrice = async () => ({ rows: [] });
    r = await svc.backfillMissingTodayPrices('u1', 'A', {
      today: '2026-10-29', backfill: async () => { touched = true; return true; },
    });
    assert.strictEqual(r.checked, 0);
    assert.strictEqual(touched, false, '无缺失时不得发起外部请求');

    // 3) 采集抛错必须被吞掉，不能影响保存流程
    repo.selectPositionCodesMissingPrice = async () => ({ rows: [{ code: '601995' }] });
    r = await svc.backfillMissingTodayPrices('u1', 'A', {
      today: '2026-10-29', backfill: async () => { throw new Error('tushare down'); },
    });
    assert.strictEqual(r.filled, 0);
    assert.deepStrictEqual(r.failed, ['601995'], '异常也要计入失败而不是抛出');

    // 4) 缺少账户范围直接返回，不查库
    let queried = false;
    repo.selectPositionCodesMissingPrice = async () => { queried = true; return { rows: [] }; };
    r = await svc.backfillMissingTodayPrices('', 'A');
    assert.strictEqual(r.reason, 'missing_scope');
    assert.strictEqual(queried, false);
  } finally {
    repo.selectPositionCodesMissingPrice = origin;
  }
  console.log('导入后补当日行情回归通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
