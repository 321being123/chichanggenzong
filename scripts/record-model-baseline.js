// 模型与公式输出基线（批次5 第 1 步）。
//
// 目的：批次5 要做的结构重组必须"同一输入、同一规则版本，输出逐字段相同"。没有基线就无法证明
// 重组没有改动结论，因此先在这里把确定性入口的输入→输出固化成快照，之后每次重组都用 --compare 比对。
//
// 用法：
//   node scripts/record-model-baseline.js --record    记录基线（覆盖写 server/test/fixtures/model-baseline.json）
//   node scripts/record-model-baseline.js --compare   与基线比对，任何差异、缺失或未测出都判失败
//
// 口径约束（与 architecture-golden 一致，避免"假通过"）：
//   - 比对遍历两侧并集：基线有、当前被删除的用例判失败，不允许"删掉用例就变绿"。
//   - 任一侧 status 不是 ok 判失败：未测出既不构成等价证据，也不构成基线。
//   - 差异只报 id 与期望/实际哈希，不回写基线；确认是"规则版本变化"才允许重新 --record 并写明原因。
//
// 范围：只覆盖纯函数与纯公式（交易费用、日期、股票估值/事实口径）。涉及数据库或模型的入口
// （打新预测、可转债估值引擎）不在此列——它们的基线要能重放固定样本，属批次5 后续步骤。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'server', 'test', 'fixtures', 'model-baseline.json');
const SUITE = 'model-baseline-v1';

// 交易费用读全局 data.feeSettings；Node 下没有浏览器全局，这里给一份空设置走默认口径。
global.data = global.data || { feeSettings: {} };

const fees = require(path.join(ROOT, 'public', 'shared', 'core-fees.js'));
const coreDate = require(path.join(ROOT, 'public', 'shared', 'core-date.js'));
const valuation = require(path.join(ROOT, 'server', 'domain', 'stockValuation.js'));
const facts = require(path.join(ROOT, 'server', 'domain', 'stockFacts.js'));

function mapOf(rows) {
  return new Map(rows.map(row => [row.end_date, row]));
}

const annualMap = mapOf([
  { end_date: '20251231', revenue: 1000, parent_netprofit: 120 },
  { end_date: '20241231', revenue: 900, parent_netprofit: 100 },
]);
const interimMap = mapOf([
  { end_date: '20260930', revenue: 800, parent_netprofit: 90 },
  { end_date: '20251231', revenue: 1000, parent_netprofit: 120 },
  { end_date: '20250930', revenue: 750, parent_netprofit: 85 },
]);

// 用例清单：id 一旦发布就不要改名（改名等同删除旧用例，比对会报缺失）。
const cases = [
  // —— 交易费用（public/shared/core-fees.js）——
  { id: 'fees.cn_stock_buy_10000', run: () => fees.calcTradeFees('buy', 10000, 'stock') },
  { id: 'fees.cn_stock_sell_10000', run: () => fees.calcTradeFees('sell', 10000, 'stock') },
  { id: 'fees.cn_stock_buy_123456.78', run: () => fees.calcTradeFees('buy', 123456.78, 'stock') },
  { id: 'fees.cn_bond_sell_123456.78', run: () => fees.calcTradeFees('sell', 123456.78, 'bond') },
  { id: 'fees.cn_etf_buy_50000', run: () => fees.calcTradeFees('buy', 50000, 'etf') },
  { id: 'fees.hk_stock_sell_50000', run: () => fees.calcTradeFees('sell', 50000, 'hk') },
  { id: 'fees.fee_groups', run: () => fees.FEE_GROUPS.map(group => group.key) },

  // —— 日期边界（public/shared/core-date.js）——
  { id: 'date.normalize_business_date.compact', run: () => coreDate.normalizeBusinessDate('20261027') },
  { id: 'date.normalize_business_date.iso', run: () => coreDate.normalizeBusinessDate('2026-10-27') },
  { id: 'date.normalize_business_date.slash', run: () => coreDate.normalizeBusinessDate('2026/10/27') },
  { id: 'date.normalize_business_date.empty', run: () => coreDate.normalizeBusinessDate('') },
  { id: 'date.compact_to_iso', run: () => coreDate.compactDateToIso('20261027') },
  { id: 'date.date_in_zone.shanghai_cross_day', run: () => coreDate.dateInZone('2026-10-27T17:30:00Z', 'Asia/Shanghai') },
  { id: 'date.date_time_in_zone.shanghai', run: () => coreDate.dateTimeInZone('2026-10-27T17:30:00Z', 'Asia/Shanghai') },
  { id: 'date.subtract_years', run: () => coreDate.subtractYears('2026-10-27', 3) },

  // —— 股票估值口径（server/domain/stockValuation.js）——
  { id: 'valuation.growth_metric.cagr', run: () => valuation.growthMetric(10, 13.31, 3) },
  { id: 'valuation.percentile.mid', run: () => valuation.percentile(20, [10, 15, 20, 25, 30], 'pe') },
  { id: 'valuation.percentile.below_all', run: () => valuation.percentile(5, [10, 15, 20, 25, 30], 'pe') },
  { id: 'valuation.quantile.median', run: () => valuation.quantile([10, 15, 20, 25, 30], 0.5, 'pe') },
  { id: 'valuation.ttm.annual_last', run: () => valuation.ttmValue(annualMap, 'revenue') },
  { id: 'valuation.ttm.interim_roll', run: () => valuation.ttmValue(interimMap, 'revenue') },
  { id: 'valuation.latest_annual_rows', run: () => valuation.latestAnnualRows(interimMap).map(row => row.end_date) },
  { id: 'valuation.comparator.pe', run: () => [valuation.valuationComparator('pe')({ pe: 10 }, { pe: 20 }), valuation.valuationComparator('pe')({ pe: 20 }, { pe: 10 })] },
  { id: 'valuation.finite.nan_text', run: () => valuation.finite('abc') },
  { id: 'valuation.iso_date.compact', run: () => valuation.isoDate('20261027') },
  { id: 'valuation.ts_date_str.utc8', run: () => valuation.tsDateStr(new Date('2026-10-27T17:30:00Z')) },

  // —— 财务事实口径（server/domain/stockFacts.js）——
  { id: 'facts.hash.sample', run: () => facts.hash({ b: 2, a: 1 }) },
  { id: 'facts.stable_payload.sample', run: () => facts.stablePayload({ b: 2, a: 1 }) },
  { id: 'facts.as_date.compact', run: () => facts.asDate('20261027') },
  { id: 'facts.period_type.q3', run: () => facts.periodType('20260930') },
  { id: 'facts.period_type.annual', run: () => facts.periodType('20251231') },
  { id: 'facts.fact_map.keys', run: () => Object.keys(facts.FACT_MAP).sort() },
];

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function collect() {
  const result = {};
  for (const item of cases) {
    try {
      const value = item.run();
      const serialized = stable(value);
      result[item.id] = { status: 'ok', hash: digest(serialized), value: JSON.parse(serialized) };
    } catch (error) {
      // 未测出不是"等价"，比对时按失败处理；记录原因便于定位。
      result[item.id] = { status: 'error', hash: null, error: String((error && error.message) || error) };
    }
  }
  return result;
}

function compare(recorded, current) {
  const diffs = [];
  const ids = new Set([...Object.keys(recorded.cases || {}), ...Object.keys(current)]);
  for (const id of [...ids].sort()) {
    const expected = (recorded.cases || {})[id];
    const actual = current[id];
    if (!expected) { diffs.push({ id, reason: '基线中没有该用例（新增用例需重新记录）' }); continue; }
    if (!actual) { diffs.push({ id, reason: '当前没有该用例（被删除或未执行）' }); continue; }
    if (expected.status !== 'ok' || actual.status !== 'ok') {
      diffs.push({ id, reason: `未测出（基线 ${expected.status}／当前 ${actual.status}）`, expected: expected.error, actual: actual.error });
      continue;
    }
    if (expected.hash !== actual.hash) {
      diffs.push({ id, reason: '输出不一致', expected: expected.value, actual: actual.value });
    }
  }
  return { ok: diffs.length === 0, diffs };
}

function main(argv) {
  const mode = argv[2];
  if (mode === '--record') {
    const payload = {
      suite: SUITE,
      recordedAt: new Date().toISOString(),
      note: '批次5 确定性入口的输入→输出基线；重组前后必须逐字段一致，差异需解释为规则版本变化才允许重录。',
      cases: collect(),
    };
    const errors = Object.entries(payload.cases).filter(([, item]) => item.status !== 'ok');
    if (errors.length) {
      console.error('存在未测出的用例，拒绝写入基线：');
      errors.forEach(([id, item]) => console.error('  ' + id + ' → ' + item.error));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`已记录基线 ${SUITE}：${Object.keys(payload.cases).length} 个用例 → ${path.relative(ROOT, BASELINE)}`);
    return;
  }
  if (mode === '--compare') {
    if (!fs.existsSync(BASELINE)) { console.error('缺少基线文件：' + path.relative(ROOT, BASELINE)); process.exit(1); }
    const recorded = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const result = compare(recorded, collect());
    if (!result.ok) {
      console.error(`基线比对失败（${result.diffs.length} 项）：`);
      result.diffs.forEach(diff => console.error('  ' + diff.id + ' → ' + diff.reason));
      process.exit(1);
    }
    console.log(`基线比对通过：${Object.keys(recorded.cases || {}).length} 个用例输出一致（${recorded.suite}）`);
    return;
  }
  console.error('用法：node scripts/record-model-baseline.js --record | --compare');
  process.exit(1);
}

if (require.main === module) main(process.argv);

module.exports = { cases, collect, compare, SUITE };
