// shared/core-fees.js – 交易费用引擎（手续费/印花税/过户费/其他费）
// 按「市场×品种」分组设置；佣金由用户设定，印花税率等默认规则随交易所调整自动更新。
// 纯逻辑，不碰 DOM；与 db.js 的 trades 四费用列一一对应。

// 内置默认费率（rate 以小数存储，= 百分比/100）。交易所真调了，改这里或走自动更新任务。
// 费用按「账户各自设置」优先（data.feeSettings），其次回退内置默认；无平台级覆盖层。
let PLATFORM_FEE = {};
const DEFAULT_FEE_SETTINGS = {
  // A股股票：佣金万2.5 + 最低5元；印花税卖出0.05%；过户费0.001%双边
  ashare_stock: { commissionRate: 0.00025, commissionMin: 5, stampTaxRate: 0.0005, transferRate: 0.00001, otherRate: 0 },
  // A股可转债：佣金万0.4 + 最低1元；免印花税、免过户费
  ashare_bond:  { commissionRate: 0.00004, commissionMin: 1, stampTaxRate: 0, transferRate: 0, otherRate: 0 },
  // A股基金/ETF：默认免佣金、免印花税、免过户费（用户可设）
  ashare_fund:   { commissionRate: 0, commissionMin: 0, stampTaxRate: 0, transferRate: 0, otherRate: 0 },
  // 港股：佣金万3 + 最低0；印花税0.1%双边；结算费0.002%(上限100港币)；其他(征费0.0027%+交易费0.005%)=0.0097%
  hk_stock:      { commissionRate: 0.0003, commissionMin: 0, stampTaxRate: 0.001, transferRate: 0.00002, transferCap: 100, otherRate: 0.000097 },
  // 美股：佣金万5 + 最低0；免印花税、免过户费
  us_stock:      { commissionRate: 0.0005, commissionMin: 0, stampTaxRate: 0, transferRate: 0, otherRate: 0 },
  // 场外基金：仅佣金(申购/赎回费率)，其余免税
  otc_fund:      { commissionRate: 0, commissionMin: 0 }
};

// 设置弹窗的分组与需展示的字段
const FEE_GROUPS = [
  { key: 'ashare_stock', label: 'A股股票',  fields: ['commission', 'stamp', 'transfer'] },
  { key: 'ashare_bond',  label: 'A股可转债', fields: ['commission'] },
  { key: 'ashare_fund',   label: 'A股基金/ETF', fields: ['commission'] },
  { key: 'hk_stock',     label: '港股',      fields: ['commission', 'stamp', 'transfer', 'other'] },
  { key: 'us_stock',     label: '美股',      fields: ['commission'] },
  { key: 'otc_fund',     label: '场外基金',  fields: ['commission'] }
];

// 细类 → 费用组别
function getFeeGroup(subtype) {
  switch ((subtype || '').trim()) {
    case '港股': return 'hk_stock';
    case '美股': return 'us_stock';
    case '可转债': return 'ashare_bond';
    case '基金/ETF':
    case 'ETF':
    case 'LOF': return 'ashare_fund';
    case '场外基金': return 'otc_fund';
    case '沪市':
    case '深市':
    case '京市':
    case 'A股': // 兼容历史数据
    default: return 'ashare_stock';
  }
}

// 取某账户的费用设置（用户设定覆盖内置默认，缺项用默认补全）
function getFeeSettings() {
  const out = {};
  const user = (data && data.feeSettings) || {};
  for (const k in DEFAULT_FEE_SETTINGS) {
    out[k] = Object.assign({}, DEFAULT_FEE_SETTINGS[k], PLATFORM_FEE[k] || {}, user[k] || {});
  }
  return out;
}

// 计算单笔交易四费用：direction('buy'|'sell')、amount(成交额)、subtype(细类)
function calcTradeFees(direction, amount, subtype) {
  const g = getFeeGroup(subtype);
  const s = (data && data.feeSettings && data.feeSettings[g]) || {};
  const cfg = Object.assign({}, DEFAULT_FEE_SETTINGS[g], PLATFORM_FEE[g] || {}, s);
  let commission = 0, stamp_tax = 0, transfer_fee = 0, other_fee = 0;

  if (cfg.commissionRate) {
    commission = amount * cfg.commissionRate;
    if (cfg.commissionMin && commission < cfg.commissionMin) commission = cfg.commissionMin;
  }
  if (cfg.stampTaxRate) {
    if (g === 'ashare_stock') stamp_tax = direction === 'sell' ? amount * cfg.stampTaxRate : 0; // A股仅卖出收
    else if (g === 'hk_stock') stamp_tax = amount * cfg.stampTaxRate; // 港股双边
  }
  if (cfg.transferRate) {
    transfer_fee = amount * cfg.transferRate;
    if (cfg.transferCap) transfer_fee = Math.min(transfer_fee, cfg.transferCap);
  }
  if (cfg.otherRate) other_fee = amount * cfg.otherRate;

  return {
    commission: round2(commission),
    stamp_tax: round2(stamp_tax),
    transfer_fee: round2(transfer_fee),
    other_fee: round2(other_fee)
  };
}

// 单笔交易费用合计（用于现金重算与历史展示）
function tradeFeeTotal(t) {
  return (t.commission || 0) + (t.stamp_tax || 0) + (t.transfer_fee || 0) + (t.other_fee || 0);
}

function round2(x) { const n = Number(x); return Math.round((isFinite(n) ? n : 0) * 100) / 100; }
function round4(x) { const n = Number(x); return Math.round((isFinite(n) ? n : 0) * 10000) / 10000; }
// 百分比显示值：去尾零，避免 0.0250
function pctShow(rate) { return rate != null ? (+round4(rate * 100).toFixed(4)).toString() : '0'; }
function pctToRate(v) { const n = parseFloat(v); return isFinite(n) ? n / 100 : 0; }

// 同时支持 Node 端 require（后端 db.js 取 DEFAULT_FEE_SETTINGS 作为单一真相源）；浏览器端 module 未定义则跳过
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_FEE_SETTINGS, FEE_GROUPS, getFeeGroup, getFeeSettings, calcTradeFees, tradeFeeTotal, pctShow, pctToRate };
}
