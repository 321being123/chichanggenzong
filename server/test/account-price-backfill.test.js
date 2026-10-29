// 导入后补行情：按「最早缺口日 → 今天」补齐，缺 scope 不查库，失败不抛。
const assert = require('assert');
const repo = require('../repositories/accountPriceBackfillRepository');
const svc = require('../services/accountPriceBackfill');

(async () => {
  const origin = repo.selectPositionCodesMissingPrice;
  try {
    // 1) 正常补齐：每只按自己的最早缺口日拉区间，两只里一只成功一只失败
    let argsSeen = null;
    repo.selectPositionCodesMissingPrice = async args => {
      argsSeen = args;
      return { rows: [{ code: '601995', first_missing: '2026-10-28' }, { code: '00546', first_missing: null }] };
    };
    const calls = [];
    let r = await svc.backfillMissingTodayPrices('u1', 'A', {
      today: '2026-10-29',
      fromDate: '2026-10-20',
      backfill: async (username, accountName, code, start, end) => { calls.push([code, start, end]); return code === '601995'; },
    });
    assert.deepStrictEqual(argsSeen.slice(0, 3), ['u1', 'A', '2026-10-20'], '查询要带上账户与回看起点');
    assert.ok(argsSeen[3] > 0 && argsSeen[3] <= 80, '查询必须带数量上限');
    assert.deepStrictEqual(calls, [['601995', '2026-10-28', '2026-10-29'], ['00546', '2026-10-20', '2026-10-29']],
      '有最早缺口日的按缺口日拉，没有的回退到回看起点');
    assert.strictEqual(r.checked, 2);
    assert.strictEqual(r.filled, 1);
    assert.deepStrictEqual(r.failed, ['00546'], '失败的代码要如实返回');

    // 2) 没有缺价代码时不调用采集
    let touched = false;
    repo.selectPositionCodesMissingPrice = async () => ({ rows: [] });
    r = await svc.backfillMissingTodayPrices('u1', 'A', {
      today: '2026-10-29', backfill: async () => { touched = true; return true; },
    });
    assert.strictEqual(r.checked, 0);
    assert.strictEqual(touched, false, '无缺失时不得发起外部请求');

    // 3) 采集抛错必须被吞掉，不能影响保存流程
    repo.selectPositionCodesMissingPrice = async () => ({ rows: [{ code: '601995', first_missing: '2026-10-29' }] });
    r = await svc.backfillMissingTodayPrices('u1', 'A', {
      today: '2026-10-29', backfill: async () => { throw new Error('tencent down'); },
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
  console.log('导入后补行情（区间）回归通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
