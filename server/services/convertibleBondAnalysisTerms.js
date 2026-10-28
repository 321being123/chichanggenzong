// 可转债条款/数值纯工具与常量（数据层可安全共用的纯函数子集）。
// 拆自 convertibleBondAnalysisCore.js：不含任何 I/O。
const BOND_PREFIX = /^(110|111|113|118|123|127|128)\d{3}$/;
const CN_OFFSET_MS = 8 * 3600 * 1000;

const STOCK_STATUS_FIELDS = 'ts_code,symbol,name,area,industry,market,exchange,list_date,list_status,delist_date';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pricePairFromReason(reason) {
  const match = String(reason || '').match(/由\s*(\d+(?:\.\d+)?)\s*元?\/股\s*调整为\s*(\d+(?:\.\d+)?)\s*元?\/股/);
  return match ? { price_before: Number(match[1]), price_after: Number(match[2]) } : null;
}

function normalizePriceChange(row) {
  const pair = pricePairFromReason(row && row.reason);
  const storedAfter = finite(row && (row.price_after == null ? row.convertprice_aft : row.price_after));
  if (pair && storedAfter != null && Math.abs(storedAfter - pair.price_after) > 0.0001) return row;
  return pair ? Object.assign({}, row, pair, {
    convertprice_bef: pair.price_before,
    convertprice_aft: pair.price_after,
  }) : row;
}

function normalizePriceChanges(rows) {
  const normalized = (rows || []).map(normalizePriceChange);
  return normalized.filter((row, index) => {
    const before = finite(row.price_before);
    const after = finite(row.price_after);
    if (before == null || after == null) return true;
    const currentDate = new Date(row.change_date).getTime();
    return !normalized.slice(0, index).some(previous => {
      const previousDate = new Date(previous.change_date).getTime();
      return finite(previous.price_before) === before
        && finite(previous.price_after) === after
        && Number.isFinite(currentDate)
        && Number.isFinite(previousDate)
        && Math.abs(currentDate - previousDate) <= 14 * 86400000;
    });
  });
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const cn = new Date(value.getTime() + CN_OFFSET_MS);
    return `${cn.getUTCFullYear()}-${String(cn.getUTCMonth()+1).padStart(2,'0')}-${String(cn.getUTCDate()).padStart(2,'0')}`;
  }
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}` : null;
}

function normalizeBondCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  const digits = raw.replace(/\.(SH|SZ)$/i, '').replace(/\D/g, '');
  if (!BOND_PREFIX.test(digits)) return null;
  const exchange = /^(123|127|128)/.test(digits) ? 'SZ' : 'SH';
  return `${digits}.${exchange}`;
}

function instrumentStatus(delistDate, today = isoDate(new Date()), listDate = null, subscriptionDate = null) {
  const delist = isoDate(delistDate);
  const listed = isoDate(listDate);
  const subscribing = isoDate(subscriptionDate);
  if (delist && delist <= today) return 'delisted';
  if (listed && listed > today) return 'pending_listing';
  if (subscribing && subscribing === today) return 'subscribing';
  if (!listed) return subscribing ? 'announced' : 'listed';
  return 'listed';
}

function parseTriggerRatio(text) {
  const clause = String(text || '').replace(/\s+/g, '');
  const matches = [
    clause.match(/转股价(?:格)?的(\d+(?:\.\d+)?)%/),
    clause.match(/(\d+(?:\.\d+)?)%[^。；]{0,16}转股价/),
  ];
  const value = matches.find(Boolean);
  return value ? Number(value[1]) / 100 : null;
}

function chineseNumber(value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  const digits = { 一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  const text = String(value || '');
  if (text === '十') return 10;
  if (text.includes('十')) { const parts=text.split('十'); return (digits[parts[0]] || 1) * 10 + (digits[parts[1]] || 0); }
  return digits[text] || null;
}

function parseWindow(text, type = '') {
  const clause = String(text || '').replace(/\s+/g, '');
  // 条款常见两种顺序：“连续30个交易日中至少15个”与“任意30个连续交易日中有15个”。
  // 只在“连续 N 个交易日”窗口内取数，避免把“到期后五个交易日内”等日期描述误当观察窗口。
  const number = '[一二两三四五六七八九十百\\d]+';
  // 同一条款会写成“至少有十五个”“有十五个”或“至少十五个”，三种写法含义相同。
  // 只在“连续 N 个交易日”窗口内取数，避免把“到期后五个交易日内”等日期描述误当观察窗口。
  const requirement = '(?:(?:至少)(?:有)?|有)?';
  const patterns = [
    new RegExp(`(?:任意)?(${number})个连续交易日(?:中|内)${requirement}(${number})个交易日`, 'g'),
    new RegExp(`连续(${number})个交易日(?:中|内)${requirement}(${number})个交易日`, 'g'),
  ];
  const candidates = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(clause))) {
      candidates.push({ observation_days: chineseNumber(match[1]), required_days: chineseNumber(match[2]), index: match.index });
    }
  }
  if (!candidates.length) return { observation_days: null, required_days: null };
  // 一个公告可能同时写向上和向下修正；下修条款优先选带“低于/下修”上下文的窗口。
  const selected = type === 'reset'
    ? candidates.find(item => /(向下修正|下修|低于)/.test(clause.slice(Math.max(0, item.index - 90), item.index + 130))) || candidates[0]
    : candidates[0];
  return { observation_days: selected.observation_days, required_days: selected.required_days };
}

function hasNetAssetFloorClause(text) {
  const clause = String(text || '').replace(/\s+/g, '');
  return /(?:不得低于|不应低于|应不低于|不低于)[^。；]{0,60}(?:每股)?净资产/.test(clause);
}

function addYears(date, years) {
  const cn = new Date(date.getTime() + CN_OFFSET_MS);
  cn.setUTCFullYear(cn.getUTCFullYear() + years);
  return new Date(cn.getTime() - CN_OFFSET_MS);
}

function addDays(date, days) {
  const cn = new Date(date.getTime() + CN_OFFSET_MS);
  cn.setUTCDate(cn.getUTCDate() + days);
  return new Date(cn.getTime() - CN_OFFSET_MS);
}

function revisionDecision(title) {
  const text = String(title || '');
  if (/不向下修正|不下修|不修正.{0,12}转股价/.test(text)) return 'no_revision';
  if (/提议|建议|预计触发|可能触发|提示性|股东大会.*议案/.test(text)) return null;
  if (/向下修正.{0,30}转股价格|转股价格.{0,20}(?:向下修正结果|下修结果)/.test(text)) return 'revised';
  return /(?:可转换公司债券)?转股价格调整的公告|调整.{0,20}转股价格的公告/.test(text) ? 'adjusted' : null;
}

module.exports = {
  BOND_PREFIX,
  CN_OFFSET_MS,
  STOCK_STATUS_FIELDS,
  finite,
  pricePairFromReason,
  normalizePriceChange,
  normalizePriceChanges,
  isoDate,
  normalizeBondCode,
  instrumentStatus,
  parseTriggerRatio,
  chineseNumber,
  parseWindow,
  hasNetAssetFloorClause,
  addYears,
  addDays,
  revisionDecision,
};
