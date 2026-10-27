// 应用分层批次1（数据边界）专项测试。
// 覆盖退出条件：清单外无顺带改动（源码断言）、中立合同唯一选源、主源有效时备源零调用、
// 双来源同日市值不重复、子仓储失败整笔回滚、会话锁例外仍独立登记。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMarketDataGateway } = require('../dataAccess/marketDataGateway');
const stockRepository = require('../repositories/stockRepository');
const financialDataArchitecture = require('../services/financialDataArchitecture');
const { withTransaction } = require('../db/transaction');

const ROOT = path.join(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  [FAIL] ${name} :: ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  [FAIL] ${name} :: ${error.message}`);
  }
}

console.log('A. 清单内服务不再持有 SQL（无顺带改动）');
check('bondDataService 不含查询语句，只做转发与完整性判断', () => {
  const source = read('server/services/bondDataService.js');
  assert(!/pool\.query|\.query\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE)/.test(source), 'bondDataService 仍含 SQL');
  assert(/repositories\/bondRepository/.test(source), '未接入仓储');
});
check('stockDataService 不含查询语句', () => {
  const source = read('server/services/stockDataService.js');
  assert(!/pool\.query|\.query\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE)/.test(source), 'stockDataService 仍含 SQL');
  assert(/repositories\/stockRepository/.test(source), '未接入仓储');
});
check('financialDataArchitecture 不再持有 SQL 且不自行 BEGIN/COMMIT', () => {
  const source = read('server/services/financialDataArchitecture.js');
  assert(!/\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/.test(source), '编排层仍含 SQL 文本');
  assert(!/pool\.connect/.test(source), '编排层仍自行取连接');
  assert(!/'BEGIN'|'COMMIT'|'ROLLBACK'/.test(source), '编排层仍自行控制事务');
  assert(/withTransaction/.test(source), '未接入统一事务封装');
});
check('仓储层不自行开启事务', () => {
  for (const file of ['server/repositories/stockProjectionRepository.js', 'server/repositories/bondRepository.js', 'server/repositories/stockRepository.js']) {
    assert(!/'BEGIN'|'COMMIT'|'ROLLBACK'/.test(read(file)), `${file} 出现了事务控制语句`);
  }
});
check('financialDataArchitecture 导出签名保持兼容', () => {
  for (const name of ['asDate', 'finite', 'analysisMetricValues', 'hash', 'rowVersion', 'stablePayload',
    'syncReportRows', 'persistCollectedData', 'saveCollectedEvents', 'saveAnalysisResults',
    'syncStockToArchitecture', 'backfillLegacyFinancialData']) {
    assert.strictEqual(typeof financialDataArchitecture[name], 'function', `缺少导出 ${name}`);
  }
});

console.log('B. 中立网关：唯一选源与备源零调用（方案 4.1）');
const localRepository = codes => ({
  listLatestValuations: async ({ codes: wanted }) => wanted
    .map(code => (code === 'A.SH' ? { stock_code: code, pe_ttm: 10, pb: 1 } : { stock_code: code, pe_ttm: null, pb: 1 }))
    .filter(row => codes.includes(row.stock_code)),
});

(async () => {
  await checkAsync('本地事实满足需求时不触发任何外部调用', async () => {
    const calls = [];
    const gateway = createMarketDataGateway({
      repository: localRepository(['A.SH']),
      adapters: [{ source: 'tushare', fetchValuation: async () => { calls.push('tushare'); return { pe_ttm: 9 }; } }],
      allowExternal: true,
    });
    const result = await gateway.readValuation({ codes: ['A.SH'], requireFields: ['pe_ttm'] });
    assert.strictEqual(result.rows.length, 1);
    assert.deepStrictEqual(calls, [], '本地已满足仍触发外采');
    assert.strictEqual(result.strategy, 'local');
  });

  // 验收缺口的反例回归：主源"有返回但缺必需字段"与"抛异常"都必须继续备源。
  await checkAsync('主源返回缺必需字段时继续备源，不得当成成功即停', async () => {
    const calls = [];
    const gateway = createMarketDataGateway({
      repository: localRepository(['C.SH']),
      adapters: [
        { source: 'partial', fetchValuation: async () => { calls.push('partial'); return { pe_ttm: 9 }; } },
        { source: 'full', fetchValuation: async () => { calls.push('full'); return { pe_ttm: 8, pb: 1.2 }; } },
      ],
      allowExternal: true,
    });
    const result = await gateway.readValuation({ codes: ['C.SH'], requireFields: ['pe_ttm', 'pb'] });
    assert.deepStrictEqual(calls, ['partial', 'full'], '主源缺必需字段时必须继续尝试备源');
    assert.strictEqual(result.rows.find(row => row.stock_code === 'C.SH').source, 'full');
    assert.strictEqual(result.missing.length, 0);
    const partialCall = result.externalCalls.find(item => item.source === 'partial');
    assert.strictEqual(partialCall.ok, false, '缺字段的来源不得记为成功');
    assert.strictEqual(partialCall.reason, 'missing_fields');
    assert.deepStrictEqual(partialCall.missing, ['pb']);
  });

  await checkAsync('主源抛异常时继续备源，不中断整批读取', async () => {
    const calls = [];
    const gateway = createMarketDataGateway({
      repository: localRepository(['D.SH']),
      adapters: [
        { source: 'boom', fetchValuation: async () => { calls.push('boom'); throw new Error('上游 502'); } },
        { source: 'backup', fetchValuation: async () => { calls.push('backup'); return { pe_ttm: 6 }; } },
      ],
      allowExternal: true,
    });
    const result = await gateway.readValuation({ codes: ['D.SH'], requireFields: ['pe_ttm'] });
    assert.deepStrictEqual(calls, ['boom', 'backup'], '主源异常后必须继续备源，不能直接中断');
    assert.strictEqual(result.rows.find(row => row.stock_code === 'D.SH').source, 'backup');
    const failed = result.externalCalls.find(item => item.source === 'boom');
    assert.strictEqual(failed.ok, false);
    assert.match(String(failed.error), /502/);
  });

  await checkAsync('全部来源失败时不抛错，缺口如实进入 missing', async () => {
    const gateway = createMarketDataGateway({
      repository: localRepository(['E.SH']),
      adapters: [{ source: 'boom', fetchValuation: async () => { throw new Error('网络不可用'); } }],
      allowExternal: true,
    });
    const result = await gateway.readValuation({ codes: ['E.SH'], requireFields: ['pe_ttm'] });
    assert.strictEqual(result.missing.length, 1);
    assert.strictEqual(result.missing[0].code, 'E.SH');
    assert.deepStrictEqual(result.missing[0].absent, ['pe_ttm']);
    assert.strictEqual(result.rows.some(row => row.stock_code === 'E.SH'), false);
  });

  await checkAsync('实时报价：只读场景零外采', async () => {
    const calls = [];
    const gateway = createMarketDataGateway({
      quoteAdapters: [{ source: 'q', keyOf: code => code, fetchQuotes: async () => { calls.push('q'); return new Map(); } }],
    });
    const result = await gateway.readQuotes({ codes: ['600000.SH'], allowExternal: false });
    assert.deepStrictEqual(calls, [], 'readOnly 场景不得外采行情');
    assert.strictEqual(result.quotes.size, 0);
    assert.strictEqual(result.strategy, 'readonly');
  });

  await checkAsync('实时报价：来源异常按无报价降级，不抛错也不伪造价格', async () => {
    const gateway = createMarketDataGateway({
      quoteAdapters: [{ source: 'q', keyOf: code => code, fetchQuotes: async () => { throw new Error('行情源超时'); } }],
    });
    const result = await gateway.readQuotes({ codes: ['600000.SH'], allowExternal: true });
    assert.strictEqual(result.quotes.size, 0, '异常时不得返回任何价格');
    assert.strictEqual(result.externalCalls[0].ok, false);
    assert.match(String(result.externalCalls[0].error), /超时/);
    assert.deepStrictEqual(result.missing, ['600000.SH']);
  });

  await checkAsync('实时报价：业务侧按原始代码取回，无需知道来源归一规则', async () => {
    const gateway = createMarketDataGateway({
      quoteAdapters: [{
        source: 'q',
        keyOf: code => String(code).replace(/\.[A-Z]+$/, ''),
        fetchQuotes: async ({ codes }) => new Map(codes.map(code => [String(code).replace(/\.[A-Z]+$/, ''), { price: 12.5 }])),
      }],
    });
    const result = await gateway.readQuotes({ codes: ['600000.SH'], allowExternal: true });
    assert.strictEqual(result.byCode.get('600000.SH').price, 12.5);
    assert.deepStrictEqual(result.missing, []);
  });

  await checkAsync('业务真实调用网关：股票分析不再自行外采行情', async () => {
    const service = read('server/services/stockAnalysis.js');
    assert(/marketDataGateway\.defaultGateway\.readQuotes/.test(service), '股票分析未接入网关取行情');
    assert(!/fetchTencentQuotes/.test(service), '股票分析仍直接调用行情源，绕过网关');
  });

  await checkAsync('主源成功即停：备源零调用', async () => {
    const calls = [];
    const gateway = createMarketDataGateway({
      repository: localRepository(['B.SZ']),
      adapters: [
        { source: 'tushare', fetchValuation: async () => { calls.push('tushare'); return { pe_ttm: 8 }; } },
        { source: 'eastmoney', fetchValuation: async () => { calls.push('eastmoney'); return { pe_ttm: 7 }; } },
      ],
      allowExternal: true,
    });
    const result = await gateway.readValuation({ codes: ['B.SZ'], requireFields: ['pe_ttm'] });
    assert.deepStrictEqual(calls, ['tushare'], `主源成功后不得再调备源，实际 ${calls.join(',')}`);
    assert.strictEqual(result.rows[0].source, 'tushare');
  });

  await checkAsync('主源失败才按登记顺序回退备源', async () => {
    const calls = [];
    const gateway = createMarketDataGateway({
      repository: localRepository(['B.SZ']),
      adapters: [
        { source: 'tushare', fetchValuation: async () => { calls.push('tushare'); return null; } },
        { source: 'eastmoney', fetchValuation: async () => { calls.push('eastmoney'); return { pe_ttm: 7 }; } },
      ],
      allowExternal: true,
    });
    const result = await gateway.readValuation({ codes: ['B.SZ'], requireFields: ['pe_ttm'] });
    assert.deepStrictEqual(calls, ['tushare', 'eastmoney']);
    assert.strictEqual(result.rows[0].source, 'eastmoney');
  });

  await checkAsync('未登记适配器或未允许外采时只读本地，缺字段如实返回', async () => {
    const defaultGateway = require('../dataAccess/marketDataGateway').defaultGateway;
    const result = await defaultGateway.readValuation({ codes: ['B.SZ'], requireFields: ['pe_ttm'] });
    assert.deepStrictEqual(result.externalCalls, [], '默认网关不得外采');
    assert(result.missing.length === 1 || result.rows.length === 0);
    assert(['local_only', 'no_adapter'].includes(result.strategy));
  });

  console.log('C. 事务与真实数据边界（需要 PostgreSQL）');
  let pool;
  try {
    ({ pool } = require('../db/connection'));
    await pool.query('SELECT 1');
  } catch (error) {
    console.log(`[SKIP] 数据库不可用，事务与聚合用例跳过：${error.message}`);
    console.log(`PASS=${pass} FAIL=${fail}`);
    process.exit(fail ? 1 : 0);
  }

  await checkAsync('子仓储失败整笔回滚：同事务内的前一步写入不残留', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS arch_repo_probe (id int primary key)');
    await pool.query('DELETE FROM arch_repo_probe');
    const original = new Error('第二个仓储失败');
    await assert.rejects(
      withTransaction(async client => {
        await client.query('INSERT INTO arch_repo_probe (id) VALUES (1)');
        throw original;
      }),
      error => error === original,
    );
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM arch_repo_probe');
    assert.strictEqual(rows[0].count, 0, '前一步写入必须随整笔回滚');
    await pool.query('DROP TABLE IF EXISTS arch_repo_probe');
  });

  await checkAsync('双来源同日市值不重复相加，且只计一只证券', async () => {
    const probeDate = '1990-01-03';
    const instrument = (await pool.query("SELECT instrument_id FROM core.instruments WHERE asset_class='stock' LIMIT 1")).rows[0];
    if (!instrument) { console.log('  [SKIP-CASE] 测试库无股票主档，跳过聚合用例'); return; }
    await pool.query('DELETE FROM market.daily_valuations WHERE trade_date=$1', [probeDate]);
    try {
      await pool.query(
        'INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap) VALUES ($1,$2,1,100),($1,$2,4,100)',
        [instrument.instrument_id, probeDate],
      );
      const cap = await stockRepository.totalMarketCap({ tradeDate: probeDate });
      assert.strictEqual(Number(cap.total_cap), 100, `两个来源不得相加，实际 ${cap.total_cap}`);
      assert.strictEqual(cap.stock_count, 1, '同一证券只算一只');
    } finally {
      await pool.query('DELETE FROM market.daily_valuations WHERE trade_date=$1', [probeDate]);
    }
  });

  await checkAsync('无多来源时聚合结果与单来源一致（零行为变化）', async () => {
    const probeDate = '1990-01-04';
    const instrument = (await pool.query("SELECT instrument_id FROM core.instruments WHERE asset_class='stock' LIMIT 1")).rows[0];
    if (!instrument) { console.log('  [SKIP-CASE] 测试库无股票主档，跳过聚合用例'); return; }
    await pool.query('DELETE FROM market.daily_valuations WHERE trade_date=$1', [probeDate]);
    try {
      await pool.query(
        'INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap) VALUES ($1,$2,1,250)',
        [instrument.instrument_id, probeDate],
      );
      const cap = await stockRepository.totalMarketCap({ tradeDate: probeDate });
      assert.strictEqual(Number(cap.total_cap), 250);
      assert.strictEqual(cap.stock_count, 1);
    } finally {
      await pool.query('DELETE FROM market.daily_valuations WHERE trade_date=$1', [probeDate]);
    }
  });

  await checkAsync('会话锁例外仍独立登记，未被普通事务封装接管', async () => {
    const boundaries = JSON.parse(read('governance/architecture-boundaries.json'));
    const exception = (boundaries.exceptions || []).find(item => item.id === 'session-advisory-lock');
    assert(exception, '缺少会话锁例外登记');
    assert.strictEqual(exception.file, 'server/services/externalCallGuard.js');
    assert(/releasedBy/.test(JSON.stringify(exception)), '例外必须写明释放者');
    const guard = read('server/services/externalCallGuard.js');
    assert(/getPool\(\)\.connect/.test(guard), '会话锁必须仍自行持有连接，未被机械改造');
    assert(/pg_try_advisory_lock/.test(guard) && /pg_advisory_unlock/.test(guard), '会话锁的获取与释放必须成对存在');
  });

  await pool.end().catch(() => {});
  console.log(`PASS=${pass} FAIL=${fail}`);
  if (fail) process.exitCode = 1;
})();
