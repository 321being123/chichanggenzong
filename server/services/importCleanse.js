// ========== 智能导入识别结果清洗与校验（导入专用） ==========
// 方案《智能导入识别质量与批量录入整改方案_20261026》4.2：
// 图片与 Excel AI 兜底结果进入 normalizeImportedItems（身份归一）前的导入专用校验。
// 职责边界：数值清洗、数量单位、导入边界代码候选、币种归一、校验状态（issues）。
// 证券身份继续复用共用分类器与主档（securityIdentity），队列/去重不进本模块。
// Excel 结构化直解析（buildStructuredItems）行为保持现状，不接本模块。
//
// 校验状态：每行输出 _v = { status, issues, costSource }
//   status: 'ok'（可确认）| 'review'（待核对）| 'blocked'（无效/阻止提交）
//   issues: [{ level: 'error'|'warn', field, message }]
// 只有能够证明的格式或身份修正才在 message 中标“已纠正”；不做无证据改写。

const classifyCode = require('../../public/js/code-classify');

// ---------- 数字清洗 ----------
// 仅容忍明确格式：HK$4.155、1,234.56、300股、-5、0。
// 空白、单独“-”、多段数字、NaN/Infinity、未知单位一律 null（不得变成 0）。
const NUM_PREFIX_RE = /^(HK\$|HKD|RMB|CNY|USD|HK|港币|港幣|港元|人民币|人幣|¥|￥|\$)/i;
const NUM_SUFFIX_RE = /(港币|港幣|港元|人民币|人幣|HKD|CNY|RMB|USD|元|股数|张数|股|张|份|手|个)$/i;

function parseLooseNumber(v) {
  if (v === null || v === undefined) return { value: null, reason: 'empty' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { value: null, reason: 'not_finite' };
    return { value: v };
  }
  const raw = String(v).trim();
  if (!raw || /^[-—–－/\\]+$/.test(raw)) return { value: null, reason: 'empty' };
  // 多段数字（如 "12.3 45.6"）禁止拼接成一个数
  const segments = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/g);
  if (segments && segments.length > 1) return { value: null, reason: 'multi_segment' };
  let t = raw.replace(/[,\s，]/g, '');
  t = t.replace(NUM_PREFIX_RE, '');
  t = t.replace(NUM_SUFFIX_RE, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { value: null, reason: 'not_number' };
  const value = Number(t);
  if (!Number.isFinite(value)) return { value: null, reason: 'not_finite' };
  return { value };
}

// ---------- 数量单位 ----------
// 只识别股/张/手/份；未知单位不出现在结果里（数值会被 parseLooseNumber 拒绝或留空 unit）。
function extractQuantityUnit(raw) {
  const m = /(股数|张数|股|张|份|手)$/.exec(String(raw == null ? '' : raw).trim());
  return m ? m[1].replace(/数$/, '') : null;
}

// 上交所债券（可转债 11x/113x、信用债 13x）“手 → 张”换算（1 手 = 10 张），与其他单位不换算。
// 只在导入边界换算一次；前端导入确认必须跳过券商配置的重复换算。
function isShBondUnitCode(code) {
  const info = classifyCode(code);
  return !!(info && info.market === 'sh' && info.type === '债权');
}

function convertLotToPieces(code, quantity) {
  if (!isShBondUnitCode(code)) return null;
  return Math.round(quantity * 10 * 10000) / 10000;
}

// ---------- 代码导入边界归一 ----------
// H + 1—5 位数字只在导入边界解析为港股候选（去 H 后交共用规则补零归类）；
// 全局不做“删字母猜代码”。返回 { code, hint }。
function stripImportMarketHints(rawCode) {
  const s = String(rawCode == null ? '' : rawCode).trim();
  const m = /^H(\d{1,5})$/i.exec(s);
  if (m) return { code: m[1], hint: 'HK' };
  return { code: s, hint: null };
}

// ---------- 币种归一 ----------
// 明确文字才归一：HK$/HKD/港币 → HKD；CNY/RMB/人民币 → CNY。
// 单独 ¥/￥/元/$ 或其他币种不足以确认 → null（标待核对，禁止猜）。
function normalizeCurrency(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { value: null, reason: 'empty' };
  if (/^(HKD|HK\$|港币|港幣|港元)$/i.test(s)) return { value: 'HKD' };
  if (/^(CNY|RMB|人民币|人幣)$/i.test(s)) return { value: 'CNY' };
  return { value: null, reason: 'unconfirmed' };
}

// ---------- 校验状态工具 ----------
function makeValidation() {
  return { status: 'ok', issues: [], costSource: null };
}

function addIssue(v, level, field, message) {
  v.issues.push({ level, field, message });
}

function refreshStatus(v) {
  v.status = v.issues.some(i => i.level === 'error') ? 'blocked'
    : v.issues.length ? 'review' : 'ok';
  return v.status;
}

// ---------- 清洗主流程（进入身份归一前） ----------
function cleanseImportedItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const rawItem of list) {
    const item = rawItem && typeof rawItem === 'object' ? { ...rawItem } : null;
    if (!item) continue;
    const v = makeValidation();
    item._v = v;

    // kind
    if (item.kind !== 'trade' && item.kind !== 'position') {
      addIssue(v, 'error', 'kind', '无法判断该行是交易还是持仓，请选择类型');
    }

    // 代码：导入边界处理 H 前缀；保留原样提取的前导零/后缀（交共用规则归一）
    const stripped = stripImportMarketHints(item.code);
    item.code = stripped.code;
    if (stripped.hint && !item.market_hint) item.market_hint = stripped.hint;
    if (!String(item.code || '').trim()) {
      addIssue(v, 'error', 'code', '缺少证券代码');
    }

    // 名称
    if (item.name != null) item.name = String(item.name).trim();

    const isTrade = item.kind === 'trade';

    // 数值清洗
    const priceRes = parseLooseNumber(item.price);
    item.price = priceRes.value;
    if (priceRes.value === null && priceRes.reason !== 'empty') {
      addIssue(v, 'error', 'price', '价格无法识别为数字（不猜测、不补 0）');
    }

    const qtyRes = parseLooseNumber(item.quantity);
    item.quantity = qtyRes.value;
    if (qtyRes.value === null && qtyRes.reason !== 'empty') {
      addIssue(v, 'error', 'quantity', '数量无法识别为数字（不猜测、不补 0）');
    }
    // 单位：识别结果原样记录；明确“手”才换算一次，其他单位不换算
    let unit = extractQuantityUnit(item.quantity_unit || item.quantityUnit || '');
    if (!unit && item.quantity_unit == null && item.quantityUnit == null) unit = extractQuantityUnit(rawItem.quantity != null && typeof rawItem.quantity === 'string' ? rawItem.quantity : '');
    if (unit === '手' && item.quantity != null && isShBondUnitCode(item.code)) {
      item.quantity = convertLotToPieces(item.code, item.quantity);
      unit = '张';
      addIssue(v, 'warn', 'quantity_unit', '数量单位“手”已换算为“张”（×10，已纠正）');
    } else if (unit === '手') {
      addIssue(v, 'warn', 'quantity_unit', '数量单位为“手”，请核对是否需要换算');
    }
    item.quantity_unit = unit;
    if (item.quantity != null && item.quantity < 0) {
      addIssue(v, 'warn', 'quantity', '数量带负号，请核对后确认（不自动取绝对值）');
    }
    if (!isTrade && item.quantity != null && item.quantity === 0) {
      addIssue(v, 'warn', 'quantity', '数量为 0，确认后将生成清仓调整');
    }

    // 成本/市价（持仓）
    if (!isTrade) {
      for (const f of ['cost', 'avg_buy_price', 'market_price', 'market_value']) {
        const r = parseLooseNumber(item[f]);
        item[f] = r.value;
        if (r.value === null && r.reason !== 'empty') {
          addIssue(v, 'warn', f, f + ' 无法识别为数字，保持空值');
        }
      }
    }

    // 交易数值
    if (isTrade) {
      const amountRes = parseLooseNumber(item.amount);
      item.amount = amountRes.value;
      for (const f of ['commission', 'stamp_tax', 'transfer_fee', 'other_fee',
        'commission_rate', 'stamp_tax_rate', 'transfer_fee_rate', 'other_fee_rate', 'commission_min']) {
        const r = parseLooseNumber(item[f]);
        item[f] = r.value; // 缺失保持 null；明确 0 仍为 0
        if (r.value === null && r.reason !== 'empty' && r.reason !== undefined) {
          addIssue(v, 'warn', f, f + ' 无法识别为数字，保持空值');
        } else if (r.value !== null && r.value < 0) {
          // 费用/费率/最低佣金不得为负（账本同样拒绝），不静默转 0（2026-10-26 验收 P3）
          addIssue(v, 'error', f, f + ' 不能为负数，请核对');
        }
      }
      // 方向
      if (item.direction !== 'buy' && item.direction !== 'sell') {
        addIssue(v, 'error', 'direction', '缺少买卖方向，请选择');
      }
      if (item.price != null && item.price <= 0) {
        addIssue(v, 'error', 'price', '成交价必须为正数');
      }
      if (item.quantity != null && item.quantity <= 0) {
        addIssue(v, 'error', 'quantity', '成交数量必须为正数');
      }
      if (item.amount != null && item.price != null && item.quantity != null) {
        const expect = Math.round(item.price * item.quantity * 100) / 100;
        if (Math.abs(item.amount - expect) > 0.02) {
          addIssue(v, 'warn', 'amount', '成交金额与 价格×数量 不一致，请核对');
        }
      }
    } else {
      // 持仓：价格列不直接写回；成本映射在 finalize（cost 优先，其次 avg_buy_price，均缺空值）
      if (item.price != null && item.cost == null && item.avg_buy_price == null) {
        // 兼容仅给 price 的来源（如旧指令/结构化表）：price 即成本
        item.cost = item.price;
      }
    }

    // 日期：缺失一律阻止提交——交易待补全、持仓显式选择快照日期，不默认今天（方案 4.1 第 6 条）
    const dateStr = item.date == null ? '' : String(item.date).trim();
    item.date = dateStr;
    if (!dateStr) {
      addIssue(v, 'error', 'date', isTrade ? '缺少交易日期，请补全' : '缺少快照日期，请选择（不默认今天）');
    }

    // 币种（识别证据）
    const curRes = normalizeCurrency(item.currency);
    item.currency = curRes.value;
    if (curRes.reason === 'unconfirmed') {
      addIssue(v, 'warn', 'currency', '币种无法确认，请核对');
    }

    refreshStatus(v);
    out.push(item);
  }
  return { items: out };
}

// ---------- 归一后定稿（身份解析完成后再调） ----------
// 币种冲突检测、身份推导币种、成本来源映射、状态汇总。
function finalizeImportedItems(items) {
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const v = item._v || makeValidation();
    item._v = v;
    const isTrade = item.kind === 'trade';

    // 币种与身份一致性：显式币种与身份冲突时保留双方值并阻止提交，不覆盖数值。
    // 身份判定复用共用分类器（不依赖主档是否回填 subtype/market）。
    const cls = item.code ? classifyCode(item.code, item.name) : null;
    const identityHk = String(item.subtype || '') === '港股'
      || String(item.market || '').toLowerCase() === 'hk'
      || !!(cls && cls.isHK);
    if (item.currency === 'HKD' && !identityHk && item.code) {
      addIssue(v, 'error', 'currency', '识别币种为港币，但代码归属不是港股，请核对');
    } else if (item.currency === 'CNY' && identityHk && item.code) {
      addIssue(v, 'error', 'currency', '识别币种为人民币，但代码归属是港股，请核对');
    }
    // quote_currency（账本读取口径）：显式币种优先，无冲突且身份明确时由身份推导
    if (item.currency) {
      item.quote_currency = item.currency;
    } else if (item.quote_currency == null && item.code) {
      item.quote_currency = identityHk ? 'HKD' : 'CNY';
    }

    // 持仓成本映射：cost 优先（含零/负），缺失用 avg_buy_price（含零/负），均缺保持空值
    if (!isTrade) {
      let costSource = null;
      let costValue = null;
      if (item.cost !== null && item.cost !== undefined && Number.isFinite(Number(item.cost))) {
        costSource = 'cost';
        costValue = Number(item.cost);
      } else if (item.avg_buy_price !== null && item.avg_buy_price !== undefined && Number.isFinite(Number(item.avg_buy_price))) {
        costSource = 'avg_buy_price';
        costValue = Number(item.avg_buy_price);
      }
      v.costSource = costSource;
      item.price = costValue; // 拟录入成本（零/负合法）；市价不写 price
      if (costSource === null) {
        addIssue(v, 'error', 'cost', '缺少成本价/买入均价，请补填后再确认（不用市价估算）');
      }
    }

    refreshStatus(v);
  }
  return list;
}

module.exports = {
  parseLooseNumber,
  extractQuantityUnit,
  convertLotToPieces,
  stripImportMarketHints,
  normalizeCurrency,
  cleanseImportedItems,
  finalizeImportedItems,
};
