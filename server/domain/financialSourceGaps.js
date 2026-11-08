// 财务源端缺口登记读取（方案 27.5 第 6 条）。
//
// 为什么要有登记表：年度异常要区分「源端先天不给」与「我们没采到」。
// 前者标 NOT_APPLICABLE（不入选、不进补数队列、不阻断整批发布），后者必须继续 PENDING。
// 判据不能靠代码猜，只能靠一次性核实的结果落成登记：
//   - 只有登记在案、且缺口年份**全部**被登记覆盖时，才允许判 NOT_APPLICABLE；
//   - 未登记、只登记了部分年份、登记被撤销的，一律维持 PENDING；
//   - 登记必须带证据与核查日期，便于复核；拿不准的不要登记。
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'governance', 'financial-source-gaps.json');

let cache = null;

/** 读取登记 → Map<canonical_code, Set<fiscalYear>>；文件缺失或损坏按"无登记"处理并留痕。 */
function loadFinancialSourceGaps({ registryPath = REGISTRY_PATH, reload = false } = {}) {
  if (cache && !reload && registryPath === REGISTRY_PATH) return cache;
  const map = new Map();
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(raw);
    for (const entry of (parsed && parsed.entries) || []) {
      const code = String((entry && entry.code) || '').trim().toUpperCase();
      const year = Number(entry && entry.fiscalYear);
      if (!code || !Number.isInteger(year) || entry.reason !== 'source_unrecoverable') continue;
      if (!map.has(code)) map.set(code, new Set());
      map.get(code).add(year);
    }
  } catch (error) {
    // 登记表读不到不等于"全部不可恢复"：宁可按待补处理，也不能静默放行。
    console.error('财务源端缺口登记读取失败，按无登记处理：' + error.message);
  }
  if (registryPath === REGISTRY_PATH) cache = map;
  return map;
}

/** 取某证券已登记的不可恢复财年（升序数组）。 */
function sourceGapYearsOf(map, code) {
  const set = map && map.get(String(code || '').trim().toUpperCase());
  return set ? Array.from(set).sort((a, b) => a - b) : [];
}

module.exports = { loadFinancialSourceGaps, sourceGapYearsOf, REGISTRY_PATH };
