const assert = require('assert');
const { pool } = require('../db/connection');
const repo = require('../repositories/marketYieldRepository');
const original = pool.query;
const calls = [];
pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; };
(async () => {
  try {
    const sample = { workTime: '2026-10-27', tenYear: 2.5 };
    await repo.saveChinaYield(sample);
    // 来源由取数方传入：默认仍写 chinabond，理杏仁官方优先时写 lixinger_official。
    assert.deepStrictEqual(calls[0].params, [sample.workTime, sample.tenYear, JSON.stringify(sample), 'chinabond']);
    await repo.saveChinaYield(sample, 'lixinger_official');
    assert.strictEqual(calls[1].params[3], 'lixinger_official');
    calls.length = 0;
    await repo.saveChinaYield(sample);
    await repo.saveHsiMarketValuation('2026-10-27', 12, sample);
    await repo.saveHsiIndexHistory('2026-10-27', 12, sample);
    assert.match(calls[1].sql, /market\.market_valuation_daily/);
    assert.match(calls[2].sql, /market\.index_valuation_history/);
    // 恒指估值同样按来源入参：默认 hsi_official，理杏仁官方优先时写 lixinger_official。
    assert.deepStrictEqual(calls[2].params, ['2026-10-27', 12, JSON.stringify(sample), 'hsi_official']);
    // 中证官网（csindex）与理杏仁官方（lixinger_official）共用同一张表，来源由取数方传入：
    // 默认 csindex，换源时传 lixinger_official；source_date 与 trade_date 复用同一个参数（$2）。
    await repo.saveCsiValuations('CSI', [
      { day: '2026-10-27', pe: 14, raw: { peg: 14 } },
      { day: '2026-10-28', pe: 15, raw: { peg: 15 } },
    ]);
    assert.match(calls[3].sql, /\('CN',\$1,\$2,\$3,\$4,\$2,\$5\),\('CN',\$6,\$7,\$8,\$9,\$7,\$10\)/);
    assert.deepStrictEqual(calls[3].params, ['CSI', '2026-10-27', 14, 'csindex', '{"peg":14}', 'CSI', '2026-10-28', 15, 'csindex', '{"peg":15}']);
    // 换源场景：理杏仁官方口径写入同一张表。用 pop + 重写保持调用条数不变，后面按固定下标的断言不受影响。
    calls.pop();
    await repo.saveCsiValuations('CSIALL', [{ day: '2011-08-02', pe: 16.38, raw: { mcw: 16.38 } }], 'lixinger_official');
    assert.deepStrictEqual(calls[3].params, ['CSIALL', '2011-08-02', 16.38, 'lixinger_official', '{"mcw":16.38}']);
    assert.match(calls[3].sql, /\('CN',\$1,\$2,\$3,\$4,\$2,\$5\)/);
    await repo.saveUsYieldBatch([{ day: '2026-10-27', yieldPct: 4.1, raw: { date: '20261027' } }], 'tushare_us_tycr');
    assert.match(calls[4].sql, /VALUES \('US',10,\$1,\$2,'tushare_us_tycr',\$1,\$3\)/);
    assert.deepStrictEqual(calls[4].params, ['2026-10-27', 4.1, '{\"date\":\"20261027\"}']);
    await repo.saveMoneySupply([{ month: '2026-10-01', m2: 100, row: { month: '202610' } }]);
    assert.match(calls[5].sql, /VALUES \('CN',\$1,\$2,'nbs_via_tushare',\$3\)/);
    assert.strictEqual(calls[5].params[1], 100);
    assert.strictEqual(JSON.parse(calls[5].params[2]).m1DefinitionVersion, '2025_revised');
    await repo.saveCsi300Valuations([{ day: '2026-10-28', pe: -1, pb: 2, raw: { total_mv: '0' } }]);
    assert.match(calls[6].sql, /VALUES \('CSI300','market_cap_weighted',\$1,\$2,\$3,\$4,'tushare_index_dailybasic',\$5\)/);
    assert.deepStrictEqual(calls[6].params, ['2026-10-28', null, null, 2, '{\"total_mv\":\"0\"}']);
    await repo.saveMarketCap({ day: '2026-10-28', totalYi: 100, securityCount: 5000, fromUnified: true });
    assert.deepStrictEqual(calls[7].params.slice(0, 3), ['2026-10-28', 100, 5000]);
    assert.strictEqual(JSON.parse(calls[7].params[3]).upstreamUnit, 'CNY');
    await repo.saveMarketCap({ day: '2026-10-28', totalYi: 100, securityCount: 5000, fromUnified: false });
    assert.strictEqual(JSON.parse(calls[8].params[3]).upstreamUnit, '10000 CNY');
    const codes = ['cn_yield', 'csi300_pe', 'csi_all_pe', 'hsi_pe', 'us_treasury_yield', 'm2', 'a_share_market_cap', 'm2_market_cap', 'graham_csi300', 'graham_csi_all'];
    for (const code of codes) await repo.readSubdatasetFreshness(code);
    assert.strictEqual(calls.length, 19);
    assert.match(calls[9].sql, /source_code IN \('chinabond','lixinger_official'\)/);
    assert.match(calls[13].sql, /source_code='tushare_us_tycr'/);
    assert.match(calls[16].sql, /data_status='normal'/);
    await assert.rejects(repo.readSubdatasetFreshness('unknown'), /未知市场周期数据集/);
    console.log('market yield repository: parameter binding and write order passed');
  } finally { pool.query = original; await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
