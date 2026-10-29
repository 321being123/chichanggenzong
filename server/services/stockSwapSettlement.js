// ========== 套利 → 持仓：换股吸收合并结算服务 ==========
// 目的：换股吸收合并完成后，被合并方退市、持仓失去行情，需要按公告换股比例把持仓
// 转换为合并方证券。本服务是「套利事件（event.arbitrage_cases）」到「持仓账本
// （tradeLedger adjust 事件）」的唯一桥接入口，不新增采集、不另建调度器。
//
// 判定口径：
// - 只处理 strategy_type='a_share_swap' 且换股条款完整（swap_ratio>0、合并方=reference_instrument_id）；
// - 「已实施」只认官方完成类公告标题（换股实施结果、实施情况暨新增股份上市、证券变更登记完成），
//   不从「终止上市」或风险公告推断，也不依赖 event_status 是否已被分类为 completed；
// - 结算业务日取证据公告的上海自然日，作为账本 adjust 的交易日，可回溯到具体公告。
//
// 股数口径（用户 2026-10-27 裁决）：按公告换股比例向下取整，尾数不预测、不四舍五入；
// 券商实际到账若多一股，由用户在交易记录里补一笔 adjust 即可，不在本服务里猜。
'use strict';

const CoreDate = require('../../public/shared/core-date.js');
const tradeLedger = require('./tradeLedger');
const { withTransaction } = require('../db/transaction');
const swapRepository = require('../repositories/stockSwapSettlementRepository');

const DATASET_CODE = 'stock_swap_settlements';

// 换股实施类公告标题特征：只认"已经进入实施/登记阶段"的官方公告。
const IMPLEMENTATION_TITLE_PATTERNS = [
  '换股实施结果',
  '实施情况暨新增股份上市',
  '证券变更登记完成',
];

// 浮点容差：qty*ratio 恰为整数时不能被浮点误差截成少一股。
const FLOOR_EPSILON = 1e-9;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

// PostgreSQL DATE / TIMESTAMPTZ 统一按上海自然日取业务日，禁止直接截 ISO 字符串。
function shanghaiDateText(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const text = CoreDate.dateTimeInZone(date, 'Asia/Shanghai');
  return text ? text.slice(0, 10) : null;
}

function todayShanghai(now) {
  return shanghaiDateText(now == null ? new Date() : now);
}

// positions.code 存六位裸码，主档存 601198.SH；两个口径都要能匹配。
function bareCode(code) {
  const text = String(code == null ? '' : code).trim().toUpperCase();
  if (!text) return '';
  return text.includes('.') ? text.split('.')[0] : text;
}

// A 股细类：6 开头沪市，其余深市/北交所按现有分类习惯保留空值交由账本归一。
function aShareSubtype(code) {
  const text = bareCode(code);
  if (!text) return '';
  if (/^6/.test(text)) return '沪市';
  if (/^(0|3)/.test(text)) return '深市';
  if (/^(4|8|9)/.test(text)) return '京市';
  return '';
}

// 找出「已进入实施阶段、条款完整、且与自身不是同一证券」的换股案件。
// 2026-10-27 生产核对：同一合并案在库里被拆成多条案件——旧案（如 208/209）有合并方但
// 公告链停在实施前，新案（如 294/295）挂着实施公告但 reference_instrument_id 为空，
// 另有把合并方自己当被合并方的反向案（210/296）。因此这里放宽 reference 为空，
// 允许按同一被合并方回查已知合并方，再用「被合并方已退市、合并方仍在市」做硬校验，
// 反向案与尚未退市的标的自然被排除。
async function findSettleableCases(options = {}) {
  const now = options.now == null ? new Date() : options.now;
  const today = options.targetDate || todayShanghai(now);
  const patterns = IMPLEMENTATION_TITLE_PATTERNS.map(p => '%' + p + '%');
  const implemented = await swapRepository.selectImplementedSwapCases(patterns, today);
  if (!implemented.length) return [];

  // 同一被合并方在任一同策略案件里出现过的有效合并方（用于补齐 reference 为空的实施案）。
  const pairs = await swapRepository.selectSwapPairs();
  return resolveSwapCases(implemented, pairs, today);
}

// 纯函数：从「挂实施公告的案件」和「带有效合并方的案件」解析出真正可结算的换股对。
// 不访问数据库，便于回归测试覆盖反向案、未退市、比例冲突、重复案等分支。
function resolveSwapCases(implemented, pairs, today) {
  const pairByCase = new Map((pairs || []).map(p => [String(p.case_id), p]));
  const pairByTarget = new Map();
  for (const row of (pairs || [])) {
    const key = String(row.target_instrument_id);
    if (!pairByTarget.has(key)) pairByTarget.set(key, row);
  }

  // implemented 已按实施公告日期升序，先到先得即「业务日最早」，同一持仓不会被重复换股。
  const seen = new Set();
  const resolved = [];
  for (const row of implemented) {
    const sourceId = String(row.target_instrument_id);
    const ownRef = row.reference_instrument_id ? String(row.reference_instrument_id) : '';
    const ownPair = ownRef && ownRef !== sourceId ? pairByCase.get(String(row.case_id)) : null;
    const pair = ownPair || pairByTarget.get(sourceId) || null;
    if (!pair) continue;

    const targetId = String(pair.reference_instrument_id);
    if (targetId === sourceId) continue;
    // 硬校验一：被合并方必须已退市（换股吸收合并的被合并方终止上市并注销法人资格）。
    if (String(row.source_status || '') !== 'delisted' || !row.source_delist_date) continue;
    if (row.source_delist_date > today) continue;
    // 硬校验二：合并方必须仍在市；同时排除把合并方当被合并方的反向重复案。
    if (String(pair.reference_status || '') === 'delisted' || pair.reference_delist_date) continue;

    // 比例一致性：实施案与提供合并方的案件必须给出同一换股比例，不一致不执行也不猜。
    const caseRatio = toNumber(row.swap_ratio);
    const pairRatio = toNumber(pair.swap_ratio);
    if (!caseRatio || !pairRatio || Math.abs(caseRatio - pairRatio) > 0.0001) continue;

    const dedupeKey = sourceId + '->' + targetId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    resolved.push({
      case_id: row.case_id,
      event_status: row.event_status,
      source_instrument_id: row.target_instrument_id,
      target_instrument_id: pair.reference_instrument_id,
      swap_ratio: row.swap_ratio,
      target_swap_price: row.target_swap_price,
      reference_swap_price: row.reference_swap_price,
      source_code: row.source_code,
      source_name: row.source_name,
      target_code: pair.reference_code,
      target_name: pair.reference_name,
      evidence_document_id: row.evidence_document_id,
      evidence_title: row.evidence_title,
      evidence_announced_at: row.evidence_announced_at,
      resolved_reference_case_id: pair.case_id,
    });
  }
  return resolved;
}

// 该案件涉及的、当前仍持有被合并方证券的账户持仓。
async function findSourceHoldings(caseRow) {
  const code = bareCode(caseRow.source_code);
  return swapRepository.selectSourceHoldings(caseRow.source_instrument_id, code);
}

// 当前剩余的被合并方持仓数量（用于幂等对账：已被本服务清零则不再重复执行）。
async function currentSourceQuantity(username, accountName, caseRow) {
  const code = bareCode(caseRow.source_code);
  const row = await swapRepository.selectCurrentSourceQuantity(username, accountName, caseRow.source_instrument_id, code);
  return toNumber(row && row.quantity) || 0;
}

// 账户原本已持有的合并方持仓（换股所得要与之合并，不能直接把数量设成换得股数）。
async function existingTargetHolding(username, accountName, caseRow) {
  const code = bareCode(caseRow.target_code);
  const row = (await swapRepository.selectExistingTargetHolding(username, accountName, caseRow.target_instrument_id, code)) || {};
  return {
    quantity: toNumber(row.quantity) || 0,
    costTotal: toNumber(row.cost_total) || 0,
    type: row.type || '',
    subtype: row.subtype || '',
  };
}

// 生成单个账户的结算计划（纯计算，不写账本）。
function buildPlan(caseRow, holding, existingTarget) {
  const ratio = toNumber(caseRow.swap_ratio);
  const sourceQty = toNumber(holding.quantity);
  if (!ratio || ratio <= 0 || !sourceQty || sourceQty <= 0) return null;

  // 向下取整：尾数不预测（官方尾数排序规则个人无法预判，用户裁决按少一股）
  const targetQty = Math.floor(sourceQty * ratio + FLOOR_EPSILON);
  const existingQty = existingTarget ? existingTarget.quantity : 0;
  const existingCostTotal = existingTarget ? existingTarget.costTotal : 0;
  const costTotalBefore = toNumber(holding.cost_total) || 0;
  const finalQty = targetQty + existingQty;
  const costUnitAfter = finalQty > 0 ? round4((costTotalBefore + existingCostTotal) / finalQty) : 0;

  return {
    case_id: caseRow.case_id,
    username: holding.username,
    account_name: holding.account_name,
    account_id: holding.account_id || null,
    source_instrument_id: caseRow.source_instrument_id,
    target_instrument_id: caseRow.target_instrument_id,
    settlement_date: shanghaiDateText(caseRow.evidence_announced_at),
    ratio_applied: ratio,
    source_quantity: sourceQty,
    target_quantity: targetQty,
    existing_target_quantity: existingQty,
    cost_total_before: round4(costTotalBefore),
    cost_unit_after: costUnitAfter,
    evidence_document_id: caseRow.evidence_document_id || null,
    source_code: bareCode(caseRow.source_code),
    target_code: bareCode(caseRow.target_code),
    source_name: caseRow.source_name || '',
    target_name: caseRow.target_name || '',
    source_cost_unit: sourceQty > 0 ? round4(costTotalBefore / sourceQty) : 0,
    source_type: holding.type || '股权',
    source_subtype: holding.subtype || aShareSubtype(caseRow.source_code),
    target_type: (existingTarget && existingTarget.type) || '股权',
    target_subtype: (existingTarget && existingTarget.subtype) || aShareSubtype(caseRow.target_code),
  };
}

// 换股结算后同步「首页资产基准」里的持仓快照：移除被合并方条目、把换得数量并入合并方。
// 基准是净值归因的持仓锚点（navAttribution 读 homepageBasis.positions），不同步会与
// 结算后的实际持仓对不上，净值任务被判 missing_nav_basis。基准缺失或版本不符时跳过，
// 不做无根据改写。
async function syncHomepageBasisAfterSwap(plan, client) {
  const latest = await swapRepository.selectLatestHomepageBasis(plan.username, plan.account_name, client);
  const basis = latest && latest.basis;
  if (!basis || basis.version !== 'homepage-v1' || !Array.isArray(basis.positions)) {
    return { updated: false, reason: 'basis_missing' };
  }
  const sourceCode = bareCode(plan.source_code);
  const targetCode = bareCode(plan.target_code);
  if (!sourceCode || !targetCode) return { updated: false, reason: 'code_missing' };

  const mergedTargetQty = (toNumber(plan.target_quantity) || 0) + (toNumber(plan.existing_target_quantity) || 0);
  const kept = [];
  let sourceRemoved = 0;
  let targetFound = false;
  let targetChanged = false;
  for (const position of basis.positions) {
    const code = bareCode(position && position.code);
    if (code === sourceCode) { sourceRemoved += 1; continue; }
    if (code === targetCode) {
      targetFound = true;
      if ((toNumber(position.quantity) || 0) !== mergedTargetQty) targetChanged = true;
      kept.push({ ...position, quantity: mergedTargetQty });
      continue;
    }
    kept.push({ ...position });
  }
  if (!targetFound && mergedTargetQty > 0) {
    const priceRow = await swapRepository.selectPositionPrice(plan.username, plan.account_name, targetCode, client);
    const price = toNumber(priceRow && priceRow.price);
    kept.push({ code: targetCode, quantity: mergedTargetQty, price: price == null ? 0 : price, subtype: aShareSubtype(targetCode) });
    targetChanged = true;
  }
  // 既没有被合并方条目、合并方数量也没变化时不写库，避免无意义改写净值诊断。
  if (!sourceRemoved && !targetChanged) return { updated: false, reason: 'no_change' };

  await swapRepository.updateHomepageBasis(plan.username, plan.account_name, latest.date, { ...basis, positions: kept }, client);
  return { updated: true, date: latest.date, source_removed: sourceRemoved, target_quantity: mergedTargetQty };
}

// 结算单落库（幂等：唯一键冲突时返回既有行，不覆盖已执行结果）。
async function upsertSettlement(plan) {
  const inserted = await swapRepository.insertSettlement(plan);
  if (inserted) return inserted;
  return swapRepository.selectSettlementByScope(
    plan.case_id, plan.username, plan.account_name, plan.source_instrument_id
  );
}

async function markSettlement(settlementId, status, patch = {}) {
  await swapRepository.updateSettlementStatus(settlementId, status, patch);
}

// 换股结算的账本事件：先清零被合并方，再把换得股数并入合并方（同账户已有持仓时合并成本）。
// 账本事件按「实际执行日」记账：公告日只用于结算单对账。
// 若按公告日记账，晚于实施日才建仓的账户（如当日导入的 being）重放时会先换股后建仓，
// 被合并方又被加回来导致校验失败；也会把公告日到执行日之间的历史持仓改写掉，净值算不出来。
function buildLedgerEvents(plan) {
  const date = plan.ledger_date || plan.settlement_date;
  const noteSource = `套利换股结算：${plan.source_name}按1:${plan.ratio_applied}转为${plan.target_name}，本行清零（案件${plan.case_id}）`;
  const noteTarget = `套利换股结算：${plan.source_quantity}股×${plan.ratio_applied}=${plan.target_quantity}股，` +
    (plan.existing_target_quantity > 0 ? `与原持有${plan.existing_target_quantity}股合并，` : '') +
    `成本总额${plan.cost_total_before}元（案件${plan.case_id}）`;
  const events = [
    {
      code: plan.source_code, name: plan.source_name, direction: 'adjust',
      price: plan.source_cost_unit, quantity: 0, date,
      type: plan.source_type, subtype: plan.source_subtype, note: noteSource,
    },
  ];
  if (plan.target_quantity > 0) {
    events.push({
      code: plan.target_code, name: plan.target_name, direction: 'adjust',
      price: plan.cost_unit_after, quantity: plan.target_quantity + plan.existing_target_quantity, date,
      type: plan.target_type, subtype: plan.target_subtype, note: noteTarget,
    });
  }
  return events;
}

// 执行单个结算：对账式幂等 —— 被合并方已清零视为已执行，避免账本重复写入导致股数翻倍。
async function settleOne(caseRow, plan, options) {
  const preview = {
    case_id: plan.case_id,
    username: plan.username,
    account_name: plan.account_name,
    source_code: plan.source_code,
    target_code: plan.target_code,
    source_quantity: plan.source_quantity,
    target_quantity: plan.target_quantity,
    existing_target_quantity: plan.existing_target_quantity,
    cost_unit_after: plan.cost_unit_after,
    settlement_date: plan.settlement_date,
    ratio_applied: plan.ratio_applied,
  };

  // 预览模式：只按当前持仓判断会不会执行，不写结算单、不写账本、不发分区。
  if (options.dryRun) {
    const remainingQty = await currentSourceQuantity(plan.username, plan.account_name, caseRow);
    let reason = 'dry_run';
    if (remainingQty <= 0) reason = 'reconciled_already_zero';
    else if (remainingQty !== plan.source_quantity) reason = 'quantity_changed';
    else if (!plan.settlement_date) reason = 'missing_settlement_date';
    return Object.assign({}, preview, { status: 'preview', reason, current_quantity: remainingQty });
  }

  try {
    return await withTransaction(async client => {
      // 对所有已接入的版本化账户写入口先持同一行锁，再读取持仓和生成计划。
      const account = await swapRepository.lockAccountVersion(plan.username, plan.account_name, client);
      if (!account) throw new Error('账户版本记录缺失，拒绝自动换股结算');
      const source = await swapRepository.selectAccountSourceHolding(plan.username, plan.account_name,
        caseRow.source_instrument_id, bareCode(caseRow.source_code), client);
      const existing = await swapRepository.selectExistingTargetHolding(plan.username, plan.account_name,
        caseRow.target_instrument_id, bareCode(caseRow.target_code), client) || {};
      const currentPlan = buildPlan(caseRow, { ...source, username: plan.username, account_name: plan.account_name }, {
        quantity: toNumber(existing.quantity) || 0, costTotal: toNumber(existing.cost_total) || 0,
        type: existing.type || '', subtype: existing.subtype || '',
      });
      if (!currentPlan) return { ...preview, status: 'skipped', reason: 'source_no_longer_held' };
      if (!currentPlan.settlement_date) throw new Error('证据公告缺少可用的上海业务日');
      // 账本记账日=实际执行日（见 buildLedgerEvents 注释），结算单 settlement_date 仍用公告日。
      currentPlan.ledger_date = todayShanghai(options.now);
      const inserted = await swapRepository.insertSettlement(currentPlan, client);
      const settlement = inserted || await swapRepository.selectSettlementByScope(
        currentPlan.case_id, currentPlan.username, currentPlan.account_name, currentPlan.source_instrument_id, client);
      if (!settlement) throw new Error('结算单写入失败');
      if (settlement.status === 'applied') return { ...preview, settlement_id: settlement.settlement_id, status: 'applied', reason: 'already_applied' };
      // 历史 pending/failed 计划可能与当前持仓不一致，禁止使用其旧快照冒充本次结果。
      if (!inserted) throw new Error('已有未完成结算单，需要核查后处理');
      const ids = [];
      // 同一事务内写入的多条账本事件 created_at 相同、id 是随机串，同日重放顺序会退化成随机；
      // 而 adjust 是绝对设置，顺序错就会互相覆盖。这里显式写入带时刻的记账时间
      // （trade_date 仍取前 10 位），按案件号定序，保证同账户多笔换股顺序稳定。
      const orderSecond = String(Math.min(58, Math.abs(Number(currentPlan.case_id) || 0) % 59)).padStart(2, '0');
      for (const rawEvent of buildLedgerEvents(currentPlan)) {
        const event = { ...rawEvent, date: `${currentPlan.ledger_date} 23:59:${orderSecond}` };
        const result = await tradeLedger.applyTrade(currentPlan.username, currentPlan.account_name, event, client);
        ids.push(result.id);
      }
      // 历史交易重放可能覆盖 adjust 的目标数量；核对实际持仓后才能提交结算。
      const sourceAfter = await swapRepository.selectCurrentSourceQuantity(currentPlan.username, currentPlan.account_name,
        currentPlan.source_instrument_id, currentPlan.source_code, client);
      const targetAfter = await swapRepository.selectExistingTargetHolding(currentPlan.username, currentPlan.account_name,
        currentPlan.target_instrument_id, currentPlan.target_code, client);
      if (Math.abs(toNumber(sourceAfter && sourceAfter.quantity) || 0) > 0.00001 ||
          Math.abs((toNumber(targetAfter && targetAfter.quantity) || 0) - (currentPlan.target_quantity + currentPlan.existing_target_quantity)) > 0.00001) {
        throw new Error('账本重放后的持仓与换股计划不一致，已回滚');
      }
      const targetQtyAfter = toNumber(targetAfter && targetAfter.quantity) || 0;
      const expectedCostTotal = currentPlan.target_quantity > 0
        ? currentPlan.cost_unit_after * targetQtyAfter : (toNumber(existing.cost_total) || 0);
      const actualCostTotal = toNumber(targetAfter && targetAfter.cost_total) || 0;
      if (Math.abs(actualCostTotal - expectedCostTotal) > Math.max(0.0001, targetQtyAfter * 0.00005)) {
        throw new Error('账本重放后的持仓成本与换股计划不一致，已回滚');
      }
      await swapRepository.updateSettlementStatus(settlement.settlement_id, 'applied', { tradeIds: ids }, client);
      // 结算成功后同步首页资产基准；基准同步失败不回滚已落地的持仓，只记录原因。
      let basisSync = { updated: false, reason: 'not_attempted' };
      try {
        basisSync = await syncHomepageBasisAfterSwap(currentPlan, client);
      } catch (basisError) {
        basisSync = { updated: false, reason: 'error:' + ((basisError && basisError.message) || String(basisError)) };
      }
      return { ...preview, source_quantity: currentPlan.source_quantity, target_quantity: currentPlan.target_quantity,
        existing_target_quantity: currentPlan.existing_target_quantity, cost_unit_after: currentPlan.cost_unit_after,
        settlement_id: settlement.settlement_id, status: 'applied', reason: 'applied', trade_ids: ids, basis_sync: basisSync };
    });
  } catch (e) {
    return { ...preview, status: 'failed', reason: 'ledger_error', error: (e && e.message) || String(e) };
  }
}

// 单案件处理：找持仓 → 逐个账户生成并执行结算。
async function settleCase(caseRow, options, settlements) {
  const holdings = await findSourceHoldings(caseRow);
  for (const holding of holdings) {
    const existing = await existingTargetHolding(holding.username, holding.account_name, caseRow);
    const plan = buildPlan(caseRow, holding, existing);
    if (!plan) continue;
    settlements.push(await settleOne(caseRow, plan, options));
  }
}

// 主入口：供 arbitrage_sync 的 stock_swap_settle 模式调用。
async function runStockSwapSettlement(options = {}) {
  const startedAt = new Date();
  const targetDate = options.targetDate == null ? todayShanghai(options.now || startedAt)
    : options.targetDate instanceof Date ? CoreDate.dateInZone(options.targetDate, 'Asia/Shanghai')
    : CoreDate.normalizeBusinessDate(String(options.targetDate));
  if (!targetDate) throw new Error('换股结算目标业务日无效');
  const dryRun = Boolean(options.dryRun);
  const cases = await findSettleableCases({ targetDate });
  const unlinked = await swapRepository.selectUnlinkedImplementationCandidates(targetDate);
  const settlements = [];
  const errors = [];

  for (const caseRow of cases) {
    try {
      await settleCase(caseRow, { dryRun }, settlements);
    } catch (e) {
      errors.push({ case_id: caseRow.case_id, message: (e && e.message) || String(e) });
    }
  }

  const applied = settlements.filter(s => s.status === 'applied' && s.reason === 'applied');
  const failed = settlements.filter(s => s.status === 'failed');
  const pending = settlements.filter(s => s.status === 'pending');
  const previewed = settlements.filter(s => s.status === 'preview');
  const result = {
    ok: errors.length === 0 && failed.length === 0 && pending.length === 0 && unlinked.length === 0,
    dryRun,
    ranAt: targetDate,
    unlinkedEvidenceCount: unlinked.length,
    caseCount: cases.length,
    settlementCount: settlements.length,
    appliedCount: applied.length,
    pendingCount: pending.length + unlinked.length,
    previewCount: previewed.length,
    failedCount: failed.length,
    settlements,
    errors,
  };

  // 预览模式不发布分区，避免把未执行的判断写成数据事实。
  if (dryRun) return result;

  // 数据集分区：即使没有可结算账户也发布，显式区分「核验无变化」与「执行失败」。
  try {
    await require('./datasetPartitions').publishDatasetPartition(
      DATASET_CODE, 'GLOBAL',
      {
        partitionKey: result.ranAt,
        dataAsOf: result.ranAt,
        status: result.ok ? 'published' : 'rejected',
        rowCount: settlements.length,
        diagnostics: {
          quality_status: result.ok ? 'passed' : 'failed',
          verified_no_change: result.ok && settlements.length === 0,
          caseCount: cases.length,
          appliedCount: applied.length,
          pendingCount: pending.length + unlinked.length,
          unlinkedEvidenceCount: unlinked.length,
          failedCount: failed.length,
          errorCount: errors.length,
        },
      }
    );
  } catch (e) {
    result.datasetPublishError = (e && e.message) || String(e);
    result.ok = false;
  }

  if (!result.ok) {
    result.pendingStages = ['stockSwapSettle'];
    result.failureDetail = failed.map(s => `${s.username}/${s.account_name}:${s.error || s.reason}`)
      .concat(errors.map(e => `case${e.case_id}:${e.message}`))
      .concat(pending.map(s => `${s.username}/${s.account_name}:${s.reason}`))
      .concat(unlinked.map(s => `case${s.case_id}:官方实施结果未关联，待核查`))
      .concat(result.datasetPublishError ? [`数据集发布失败:${result.datasetPublishError}`] : [])
      .slice(0, 5);
  }
  return result;
}

module.exports = {
  runStockSwapSettlement,
  findSettleableCases,
  resolveSwapCases,
  findSourceHoldings,
  settleOne,
  buildPlan,
  buildLedgerEvents,
  shanghaiDateText,
  syncHomepageBasisAfterSwap,
  DATASET_CODE,
  IMPLEMENTATION_TITLE_PATTERNS,
};
