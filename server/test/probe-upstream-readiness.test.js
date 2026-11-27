// 上游就绪探针（阶段 0）：理杏仁股票代码必须转换为官方纯数字口径，--dry-run 不得联网/连库。
// 运行：npm.cmd run test:file -- server/test/probe-upstream-readiness.test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { stockCodeOf } = require('../dataAccess/adapters/lixingerDatasetAdapter');
const lixingerOfficial = require('../services/lixingerOfficial');
const probe = require('../scripts/probeUpstreamReadiness');

async function main() {
  // A 股 6 位、港股 5 位补零；带 .SH/.HK 的站内代码绝不能直接外发。
  assert.strictEqual(stockCodeOf('600519.SH'), '600519');
  assert.strictEqual(stockCodeOf('000001.SZ'), '000001');
  assert.strictEqual(stockCodeOf('00700.HK'), '00700');
  assert.strictEqual(stockCodeOf('700.HK'), '00700');
  assert.strictEqual(stockCodeOf('600519'), '600519');
  assert.strictEqual(stockCodeOf('bad-code'), null);

  const original = lixingerOfficial.callEndpoint;
  let captured = null;
  lixingerOfficial.callEndpoint = async (endpoint, params, options) => {
    captured = { endpoint, params, options };
    return { rows: [{ date: '2026-11-26', pb: 1.2 }], total: 1 };
  };
  try {
    const result = await probe.probeLixinger({
      market: 'CN', targetDate: '2026-11-26', codes: ['600519.SH', '000001.SZ'],
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(captured.params.stockCodes, ['600519', '000001']);
    assert.ok(captured.params.stockCodes.every(code => !/\./.test(code)), '理杏仁请求不得携带 .SH/.SZ 后缀');
    assert.deepStrictEqual(result.stockCodes, ['600519', '000001']);

    const hk = await probe.probeLixinger({ market: 'HK', targetDate: '2026-11-26', codes: ['00700.HK'] });
    assert.strictEqual(hk.ok, true);
    assert.deepStrictEqual(captured.params.stockCodes, ['00700']);

    const invalid = await probe.probeLixinger({ market: 'CN', targetDate: '2026-11-26', codes: ['bad-code'] });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error.code, 'NO_VALID_STOCK_CODE');
  } finally {
    lixingerOfficial.callEndpoint = original;
  }

  const output = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'probeUpstreamReadiness.js'),
    '--target-date=2026-11-26', '--market=CN', '--sources=lixinger', '--dry-run',
  ], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.strictEqual(report.mode, 'dry-run');
  assert.strictEqual(report.targetDate, '2026-11-26');
  assert.strictEqual(report.results.length, 1);
  assert.strictEqual(report.results[0].dryRun, true);
  assert.ok(/纯数字代码/.test(report.results[0].planned), '--dry-run 必须说明理杏仁使用纯数字代码');

  console.log('probe-upstream-readiness.test.js passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
