// 本轮稳定性整改的不变量反例（F06 / F08 / F09 / F10 / F11）。
//
// 这里只放"能用纯函数或隔离真库直接证明"的判据；涉及事务/并发的用例在
// nav-import-ownership.test.js 与各 run-control 专项里。
// 原则：断言必须能在旧写法下失败（破坏性验证见各条目注释），不做"源码里出现某个字符串"的伪测试。
'use strict';
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { classifyTestResult } = require('./lib/testResultVerdict');
const RULES = require('../domain/stockSelectionRules');

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + (error && error.message));
    console.log('  ✗ ' + name + ' —— ' + (error && error.message));
  }
}

async function runner() {
  // ---------- F11：结果裁决顺序 ----------
  await test('F11 退出码 1 且输出含 [SKIP]：必须判失败，不能降级成跳过', () => {
    const verdict = classifyTestResult({ status: 1 }, '[SKIP] 某段未执行\n[FAIL] 一条断言失败\nPASS=0 FAIL=1');
    assert.strictEqual(verdict.verdict, 'fail', '非零退出优先于文本跳过标记');
  });

  await test('F11 超时/启动失败/被信号结束都判失败', () => {
    assert.strictEqual(classifyTestResult({ status: null, timedOut: true }, '').verdict, 'timeout');
    assert.strictEqual(classifyTestResult({ status: null, spawnError: 'ENOENT' }, '').verdict, 'spawn_error');
    assert.strictEqual(classifyTestResult({ status: null, signal: 'SIGKILL' }, '').verdict, 'signal');
    // 没有退出码也没有信号信息，仍是"不知道"→ 不能算通过
    assert.strictEqual(classifyTestResult({ status: null }, '').verdict, 'signal');
  });

  await test('F11 只有正常退出（0）才识别跳过', () => {
    assert.strictEqual(classifyTestResult({ status: 0 }, '  [SKIP] 某段\n全部通过').verdict, 'partial_skip');
    assert.strictEqual(classifyTestResult({ status: 0 }, '  ✓ 全部通过').verdict, 'pass');
  });

  // ---------- F06：阻塞原因 ----------
  const slots = require('../services/jobScheduleSlots');
  await test('F06 只有依赖原因可以被依赖恢复解除', () => {
    assert.strictEqual(slots.blockReasonOf({ last_error: '依赖任务未成功：a=failed' }), 'dependency');
    assert.strictEqual(slots.blockReasonOf({ last_error: '依赖数据分区未发布：x:2026-09-30' }), 'dependency');
    // 续批止损与人工标记：即使依赖已经就绪也不能自动放行
    assert.strictEqual(slots.blockReasonOf({ last_error: '续批已超过 24 小时仍未清空剩余工作', result_summary: { continuationBlocked: true } }), 'continuation_stop');
    assert.strictEqual(slots.blockReasonOf({ last_error: '外部来源返回无权限', result_summary: { permissionDenied: true, requiresManualAction: true } }), 'permission');
    assert.strictEqual(slots.blockReasonOf({ last_error: '外部来源连续 3 次未提供恢复时间', result_summary: { missingRecoverAtCount: 3 } }), 'external_no_recovery_time');
    assert.strictEqual(slots.blockReasonOf({ last_error: '数据集 a,b 连续 3 次未完成，任务已暂停，等待人工处理' }), 'dataset');
    // 无法识别的原因一律不放行（修复前会被"无依赖模式"直接释放）
    assert.strictEqual(slots.blockReasonOf({ last_error: '未知原因' }), 'unknown');
    assert.notStrictEqual(slots.blockReasonOf({ last_error: '未知原因' }), 'dependency');
  });

  // ---------- F08：数据集证据判据 ----------
  const { isPublishedDatasetEvidence } = require('../services/datasetPartitionRegistry');
  await test('F08 query_status=failed 且无 quality 的分区不能当作恢复证据', () => {
    const row = { status: 'published', is_stale: false, diagnostics: { query_status: 'failed' } };
    assert.strictEqual(isPublishedDatasetEvidence(row, 'stock_selection_inputs'), false);
    // 明确成功才是证据
    assert.strictEqual(isPublishedDatasetEvidence({ ...row, diagnostics: { query_status: 'success' } }, 'stock_selection_inputs'), true);
  });
  await test('F08 质量强校验数据集缺 quality_status 判不通过', () => {
    const base = { status: 'published', is_stale: false, diagnostics: {} };
    assert.strictEqual(isPublishedDatasetEvidence(base, 'ipo_history'), false);
    assert.strictEqual(isPublishedDatasetEvidence({ ...base, diagnostics: { quality_status: 'passed' } }, 'ipo_history'), true);
    assert.strictEqual(isPublishedDatasetEvidence({ ...base, is_stale: true }, 'ipo_history'), false);
  });

  await test('F08 同槽位恢复范围必须同时匹配批次/目标日/季度身份', () => {
    const { sameSlotRecoveryScope } = require('../services/jobRecoveryEvidence');
    const base = { job_code: 'notification_dispatch', business_date: '2026-09-30', request_payload: { mode: 'core', batchId: 'B1' } };
    assert.strictEqual(sameSlotRecoveryScope(base, { ...base, request_payload: { mode: 'core', batchId: 'B1' } }), true);
    assert.strictEqual(sameSlotRecoveryScope(base, { ...base, request_payload: { mode: 'core', batchId: 'B2' } }), false);
    const quarterA = { job_code: 'stock_analysis_refresh', business_date: '2026-09-30', request_payload: { mode: 'selection_quarterly', market: 'CN', quarter: '2026Q3' } };
    assert.strictEqual(sameSlotRecoveryScope(quarterA, { ...quarterA, request_payload: { mode: 'selection_quarterly', market: 'CN', quarter: '2026Q4' } }), false);
    const dayA = { job_code: 'hk_company_financial_sync', business_date: '2026-09-30', request_payload: { mode: 'core', targetDate: '2026-09-30' } };
    assert.strictEqual(sameSlotRecoveryScope(dayA, { ...dayA, request_payload: { mode: 'core', targetDate: '2026-09-29' } }), false);
  });

  // ---------- F09：股息币种闭合 ----------
  await test('F09 混币股息不能算出股息率（0.5USD + 0.5HKD ÷ 10HKD 的旧反例）', () => {
    const result = RULES.evaluateDividendYield({
      price: 10, priceCurrency: 'HKD',
      dividend: { ttmPerShare: 1, count: 2, currency: 'USD', currencyMixed: true },
    }, {});
    assert.strictEqual(result.yield, null, '混币必须不产出数值');
    assert.strictEqual(result.rule.reason, 'dividend_currency_mixed_not_evaluable');
  });

  await test('F09 单一外币但与价格币种不同：不换算就不出数值', () => {
    const result = RULES.evaluateDividendYield({
      price: 10, priceCurrency: 'HKD',
      dividend: { ttmPerShare: 0.5, count: 1, currency: 'USD' },
    }, {});
    assert.strictEqual(result.yield, null);
    assert.strictEqual(result.rule.reason, 'dividend_currency_mismatch_not_evaluable');
  });

  await test('F09 同币种正常算出股息率（不能误伤）', () => {
    const result = RULES.evaluateDividendYield({
      price: 10, priceCurrency: 'HKD',
      dividend: { ttmPerShare: 0.5, count: 1, currency: 'HKD' },
    }, {});
    assert.strictEqual(result.yield, 0.05);
    assert.strictEqual(result.rule.status, 'PASS');
  });

  // ---------- F15：本地测试证据的代码树指纹必须与发布侧算法一致 ----------
  await test('F15 代码树指纹：Node 与发布脚本（Python）必须算出同一个值', async () => {
    const { codeTreeHash } = require('./lib/codeTreeHash');
    const { spawnSync } = require('child_process');
    const path = require('path');
    const root = path.join(__dirname, '..', '..');
    const nodeHash = codeTreeHash('HEAD', root);
    assert.ok(/^[0-9a-f]{64}$/.test(nodeHash), '指纹必须是 sha256 十六进制：' + nodeHash);
    const candidates = [
      process.env.PYTHON,
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'bin', 'python'),
    ].filter(Boolean);
    const python = candidates.find(candidate => require('fs').existsSync(candidate))
      || spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0 && 'python';
    if (!python) {
      console.log('  [SKIP] 未找到 Python，跨语言指纹一致性未验证');
      return;
    }
    const probe = spawnSync(python, ['-c',
      'import sys;sys.path.insert(0,"deploy");from deploy_password import code_tree_hash;print(code_tree_hash("HEAD"))',
    ], { cwd: root, encoding: 'utf8' });
    if (probe.status !== 0) {
      console.log('  [SKIP] 发布脚本依赖不可用，跨语言指纹一致性未验证：' + String(probe.stderr || '').slice(0, 200));
      return;
    }
    assert.strictEqual(String(probe.stdout).trim(), nodeHash,
      '两侧算法必须一致，否则"证据属于哪份代码"的判据在部署时会永远对不上');
  });

  // ---------- F10：空候选池的质量结构 ----------
  let pool = null;
  try {
    pool = require('../db/connection').pool;
    await pool.query('SELECT 1');
  } catch (error) {
    pool = null;
    console.log('  [SKIP] 本地 PostgreSQL 不可用（' + error.message + '），空池质量用例未验证');
  }
  if (pool) {
    await require('../db/migrations').runMigrations();
    const service = require('../services/stockSelectionService');
    const slots = require('../services/jobScheduleSlots');
    await test('F07 旧执行令牌不能覆盖已接管的新执行（真实 PG）', async () => {
      const created = await slots.ensureSlot('stock_analysis_refresh', new Date(Date.now() - 60 * 1000),
        '2026-09-30', 'manual', { mode: 'selection_quarterly', market: 'CN', quarter: '2026Q3' });
      assert.ok(created && created.slot_id, '必须建出选股槽');
      const slotId = created.slot_id;
      try {
        const claimedA = await slots.claimSlot(slotId);
        assert.ok(claimedA && claimedA.execution_token, '第一次领取必须拿到执行令牌');
        // 模拟 A 租约过期、B 接管：令牌换成 B，槽仍 running。
        await pool.query(
          `UPDATE ops.job_schedule_slots SET execution_token=$2, lease_until=now()+interval '5 minutes' WHERE slot_id=$1`,
          [slotId, 'token-B']);
        const stale = await slots.completeSlot(slotId, 'blocked',
          { ok: false, datasetBreaker: { blockedDatasets: ['stock_selection_inputs_cn'] } },
          '数据集 stock_selection_inputs_cn 连续 3 次未完成', null, claimedA.execution_token);
        assert.strictEqual(stale, null, '旧令牌必须收尾失败（0 行）');
        const after = await pool.query('SELECT status, execution_token FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
        assert.strictEqual(after.rows[0].status, 'running', '新执行的状态不能被旧执行改写');
        assert.strictEqual(after.rows[0].execution_token, 'token-B', '新执行的令牌不能被旧执行清掉');
        // 合法拥有者仍能正常收尾。
        const fresh = await slots.completeSlot(slotId, 'blocked',
          { ok: false, datasetBreaker: { blockedDatasets: ['stock_selection_inputs_cn'] } },
          '数据集 stock_selection_inputs_cn 连续 3 次未完成', null, 'token-B');
        assert.ok(fresh, '当前令牌持有者必须能按阈值止损');
        assert.strictEqual(fresh.status, 'blocked');
      } finally {
        await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]).catch(() => {});
      }
    });

    await test('F10 空候选池必须同时给出 reason 与 reasons（回测只读 reasons）', async () => {
      // 用一个必然没有证券的市场日构造空池：把该市场约束在没有任何行情的日期上。
      const computed = await service.computeSelection({ market: 'HK', asOfDate: '1999-01-04' });
      assert.strictEqual((computed.universe || []).length, 0, '前提：该日期没有可评估对象');
      assert.strictEqual(computed.quality.publishable, false);
      assert.strictEqual(computed.quality.reason, 'universe_empty');
      assert.ok(Array.isArray(computed.quality.reasons), 'reasons 必须是数组，否则回测会当成"没有质量阻断"');
      assert.deepStrictEqual(computed.quality.reasons, ['universe_empty']);
    });
  }
}

runner()
  .catch(error => { fail += 1; failures.push('运行异常 :: ' + (error && error.message)); console.error(error); })
  .then(async () => {
    if (require('../db/connection')) { try { await require('../db/connection').pool.end(); } catch (_) { /* 已关闭 */ } }
    console.log('稳定性不变量反例：' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
    if (fail) {
      failures.forEach(item => console.log('  失败：' + item));
      process.exitCode = 1;
    } else {
      console.log('全部通过 ✅');
    }
  });
