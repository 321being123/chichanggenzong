// ========== DATA-02 数据集②③④⑤：股票/可转债/打新/市场周期 统一读取双读核对 ==========
// 合并原 data-convergence-stock-valuation / bond-master / ipo-read / market-cycle 4 个同构测试。
// 依赖本地 PostgreSQL（测试隔离库）；连不上时按设计跳过（CI 仍判失败）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  let pool = null;
  try {
    const db = require('../../server/db');
    pool = db.pool;
    const stockSvc = require('../../server/services/stockDataService');
    const bondSvc = require('../../server/services/bondDataService');
    const mcm = require('../../server/services/marketCycleMetrics');

    // ---------- 数据集②：股票行情/估值/财务事实 双读核对 ----------
    {
      const CODE_A = '999911.SH';
      const CODE_B = '999912.SZ';
      const DATE_OLD = '2099-01-01';
      const DATE_NEW = '2099-01-02';
      const CAP_A_OLD = 1200000000000;
      const CAP_A_NEW = 1300000000000;
      const CAP_B_NEW = 500000000000;

      const srcRows = await pool.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`);
      const srcId = srcRows.rows.length ? srcRows.rows[0].source_id : 1;

      async function cleanup() {
        await pool.query(`DELETE FROM market.daily_valuations WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code IN ($1,$2))`, [CODE_A, CODE_B]);
        await pool.query(`DELETE FROM core.instruments WHERE canonical_code IN ($1,$2)`, [CODE_A, CODE_B]);
      }
      await cleanup();
      const ia = await pool.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code) VALUES ($1,'DC测试股票A','stock','CN','SSE') RETURNING instrument_id`, [CODE_A]);
      const ib = await pool.query(
        `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code) VALUES ($1,'DC测试股票B','stock','CN','SZSE') RETURNING instrument_id`, [CODE_B]);
      const idA = ia.rows[0].instrument_id, idB = ib.rows[0].instrument_id;
      await pool.query(
        `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap) VALUES
         ($1,$3,$5,$6), ($1,$4,$5,$7), ($2,$4,$5,$8)`,
        [idA, idB, DATE_OLD, DATE_NEW, srcId, CAP_A_OLD, CAP_A_NEW, CAP_B_NEW]);

      try {
        const capNew = await stockSvc.getTotalMarketCap(DATE_NEW);
        const { rows: oldAgg } = await pool.query(
          `SELECT COALESCE(SUM(dv.total_market_cap),0)::double precision AS total_cap, COUNT(*)::int AS stock_count
           FROM market.daily_valuations dv
           JOIN core.instruments i ON i.instrument_id = dv.instrument_id
           WHERE i.asset_class='stock' AND i.market='CN' AND dv.currency_code='CNY' AND dv.trade_date=$1 AND dv.total_market_cap>0`, [DATE_NEW]);
        const expectCap = CAP_A_NEW + CAP_B_NEW;
        check('数据集② 双读核对：getTotalMarketCap 与权威聚合 SQL 总市值一致（单位：元）', () => {
          assert.strictEqual(capNew.total_cap, oldAgg[0].total_cap, '总市值不一致');
          assert.strictEqual(capNew.total_cap, expectCap, '总市值应为 ' + expectCap + ' 元');
        });
        check('数据集② 双读核对：getTotalMarketCap 与权威聚合 SQL 证券数量一致', () => {
          assert.strictEqual(capNew.stock_count, oldAgg[0].stock_count, '证券数不一致');
          assert.strictEqual(capNew.stock_count, 2, '证券数应为 2');
        });

        const capOld = await stockSvc.getTotalMarketCap(DATE_OLD);
        check('数据集② 双读核对：按目标日聚合仅含当日分区（DATE_OLD 只算 A）', () => {
          assert.strictEqual(capOld.total_cap, CAP_A_OLD, 'DATE_OLD 总市值应为 ' + CAP_A_OLD);
          assert.strictEqual(capOld.stock_count, 1, 'DATE_OLD 证券数应为 1');
        });

        const { rows: su } = await pool.query(
          `SELECT COALESCE(SUM(total_market_cap),0)::double precision AS total_cap
           FROM public.stock_unified WHERE stock_code IN ($1,$2)`, [CODE_A, CODE_B]);
        check('数据集② 反例：stock_unified（单券最新）≠ 跨日聚合，证明不可混用', () => {
          assert.notStrictEqual(Number(su[0].total_cap), capOld.total_cap,
            'stock_unified 与跨日聚合结果相同，说明语义被错误替代');
        });
      } finally {
        await cleanup();
      }
    }

    // ---------- 数据集③：可转债主档/正股关联/行情统一层核对 ----------
    {
      const svcCodes = await bondSvc.getActiveBondCodes();
      const { rows: sqlRows } = await pool.query(
        `SELECT bond_code FROM public.bond_unified
          WHERE status='listed' AND (issue_type IS NULL OR issue_type NOT IN ('定向','私募'))
          ORDER BY bond_code`);
      const sqlCodes = sqlRows.map(r => r.bond_code);
      check('数据集③ 双读核对：getActiveBondCodes() ≡ 权威 SQL（bond_unified 在市债券集合一致）', () => {
        assert.deepStrictEqual(svcCodes.slice().sort(), sqlCodes.slice().sort(),
          '统一读取者与权威 SQL 返回的在市可转债集合不一致');
      });

      const missing = await pool.query(
        `SELECT count(*)::int AS n FROM public.bond_unified bu
         JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=bu.instrument_id
         WHERE p.stock_instrument_id IS NOT NULL AND (bu.stock_code IS NULL OR bu.stock_code='')`);
      check('数据集③ 正股关联完整性：标准档案有正股代码的债券视图缺失数为 0', () => {
        assert.strictEqual(missing.rows[0].n, 0, `仍有 ${missing.rows[0].n} 条正股关联缺失`);
      });

      const list = await bondSvc.getBondList({ limit: 1 });
      check('数据集③ 主档读取者：getBondList 经 bond_unified 返回结构化主档', () => {
        assert.ok(Array.isArray(list), 'getBondList 应返回数组');
      });
    }

    // ---------- 数据集④：打新统一读取核对 ----------
    {
      const list = await bondSvc.getBondHistoryList(100000);
      const { rows: histRows } = await pool.query(
        `SELECT security_code FROM public.bond_unified
         WHERE issue_type IS NULL OR issue_type NOT IN ('定向', '私募')`);
      const newCodes = list.map(r => r.security_code);
      const oldCodes = histRows.map(r => r.security_code);
      check('数据集④ 统一读取核对：标准视图证券均被读取者覆盖（无遗漏）', () => {
        const missing = oldCodes.filter(c => !newCodes.includes(c));
        assert.strictEqual(missing.length, 0,
          '以下标准视图证券未被统一读取者覆盖: ' + missing.slice(0, 10).join(','));
      });
      check('数据集④ 兼容编码：security_code 六位纯数字 + canonical_code 带后缀', () => {
        for (const row of list) {
          assert.match(String(row.security_code), /^\d{6}$/, `非六位: ${row.security_code}`);
          assert.ok(String(row.canonical_code).includes('.'), `canonical_code 缺后缀: ${row.canonical_code}`);
        }
      });
      check('数据集④ 兼容读取：已过滤定向/私募发行', () => {
        for (const row of list) {
          assert.notStrictEqual(row.issue_type, '定向');
          assert.notStrictEqual(row.issue_type, '私募');
        }
      });
    }

    // ---------- 数据集⑤：市场周期 双读核对 ----------
    {
      const newRows = await mcm.getHistory('m2_market_cap', 'CN', 'CSIALL', 'all');
      const { rows: oldRows } = await pool.query(
        `SELECT trade_date::text AS date, ratio_pct::float8 AS value,
                m2_100m_yuan::float8 AS m2_100m_yuan, total_market_cap_100m_yuan::float8 AS total_market_cap_100m_yuan
         FROM analytics.m2_market_cap_daily ORDER BY trade_date`);
      check('数据集⑤ 双读核对：市场周期行数一致', () => {
        assert.strictEqual(newRows.length, oldRows.length,
          '统一读取者与权威表行数不一致：' + newRows.length + ' vs ' + oldRows.length);
      });
      if (newRows.length) {
        check('数据集⑤ 双读核对：市场周期日期序列一致', () => {
          assert.deepStrictEqual(newRows.map(r => r.date), oldRows.map(r => r.date), '日期序列不一致');
        });
        check('数据集⑤ 双读核对：ratio_pct（市值比，单位 %）数值一致', () => {
          for (let i = 0; i < newRows.length; i++) {
            assert.ok(Math.abs(Number(newRows[i].value) - Number(oldRows[i].value)) < 1e-6,
              `第 ${i} 行 ratio_pct 不一致: ${newRows[i].value} vs ${oldRows[i].value}`);
          }
        });
        check('数据集⑤ 双读核对：M2 与市值单位一致（亿元 → 100m_yuan）', () => {
          for (let i = 0; i < newRows.length; i++) {
            assert.ok(Math.abs(Number(newRows[i].m2_100m_yuan) - Number(oldRows[i].m2_100m_yuan)) < 1e-6, 'm2 不一致');
            assert.ok(Math.abs(Number(newRows[i].total_market_cap_100m_yuan) - Number(oldRows[i].total_market_cap_100m_yuan)) < 1e-6, '市值不一致');
          }
        });
        const sample = Number(newRows[newRows.length - 1].value);
        check('数据集⑤ 单位铁律：ratio_pct 为百分比（非小数比例）', () => {
          assert.ok(sample > 0 && sample < 1000, 'ratio_pct 疑似单位错误（应为 %）: ' + sample);
        });
      }
    }
  } catch (e) {
    if (!pool || e.code === 'ECONNREFUSED' || e.name === 'AggregateError') {
      console.log('  [SKIP] 无可用 PostgreSQL，跳过 DATA-02 双读核对');
      results.push(['SKIP', 'SKIP-DATA-02']);
    } else {
      results.push(['FAIL', '异常: ' + (e && e.message ? e.message : e)]);
      console.log('  [FAIL] 异常: ' + (e && e.stack ? e.stack : e));
    }
  } finally {
    if (pool) { try { await pool.end(); } catch (_) {} }
  }

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  const skip = results.filter(r => r[0] === 'SKIP').length;
  console.log('\n===== DATA-02 合并双读核对汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();
