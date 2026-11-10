// 证券分析统一准入：把「代码归一 → 主档核对 → 类型/市场判定」收在一个入口。
// 复用 securityIdentity 的主档解析与 domain 的市场中立合同，不新增第二套代码规则。
// 六位数字不静默改港股；名称/歧义输入由搜索列出候选，不自动选首项。
'use strict';

const { canonicalizeSecurityCode, resolveInstrument } = require('./securityIdentity');
const contract = require('../domain/securityAnalysisContract');
const hkRepository = require('../repositories/hkSecurityAnalysisRepository');

// 名称检索：返回候选而非替用户选，候选带市场、名称与完整标准代码。SQL 在仓储层。
async function searchCandidates(rawQuery) {
  const text = String(rawQuery == null ? '' : rawQuery).trim();
  if (!text || text.length > 30) return [];
  if (/^\d{1,6}(\.(HK|SH|SZ|BJ))?$/i.test(text)) return [];
  const rows = await hkRepository.searchInstrumentCandidates(text);
  return rows.map(row => ({
    code: row.canonical_code,
    name: row.name,
    market: row.market,
    assetClass: row.asset_class,
    currency: row.currency_code,
    status: row.status,
  }));
}

/**
 * 解析证券分析对象。成功返回 { ok:true, security }；失败返回 { ok:false, status, error, ambiguous }。
 * security = { code, market, name, currency, assetClass, instrumentId, securityType, financial }
 */
async function resolveAnalysisSecurity(rawCode, options = {}) {
  const normalized = contract.normalizeAnalyzableCode(rawCode);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: normalized.ambiguous ? '代码或名称无法唯一确定，请从候选中选择完整代码' : '证券代码不合法',
      ambiguous: Boolean(normalized.ambiguous),
    };
  }
  let canonicalCode = normalized.code;
  if (normalized.reason === 'cn_code_needs_suffix') {
    canonicalCode = canonicalizeSecurityCode(normalized.digits, 'stock');
  }
  if (!canonicalCode) return { ok: false, status: 400, error: '证券代码不合法' };

  let instrument = null;
  try {
    instrument = await resolveInstrument({ canonicalCode }, options.executor);
  } catch (error) {
    return { ok: false, status: 503, error: '证券身份暂时无法校验' };
  }
  if (!instrument) return { ok: false, status: 404, error: '证券不存在或主档未就绪' };
  if (String(instrument.asset_class || '') !== 'stock') {
    return { ok: false, status: 400, error: '该代码不是股票，请使用对应分析入口' };
  }

  const market = contract.marketOf(canonicalCode) || String(instrument.market || '').toUpperCase();
  if (market === 'HK') {
    const classified = contract.classifyHkInstrument(Object.assign({}, instrument, { canonical_code: canonicalCode }));
    if (!classified.ok) {
      return { ok: false, status: 400, error: classified.reason === 'non_ordinary_security'
        ? '该证券不是本次支持的港股普通股票' : '港股证券类型无法确认，暂不展示分析' };
    }
    return {
      ok: true,
      security: {
        code: canonicalCode, market, name: instrument.name, currency: classified.currency || 'HKD',
        assetClass: instrument.asset_class, instrumentId: instrument.instrument_id,
        securityType: 'hk_ordinary_stock', financial: classified.financial,
        reportTableType: classified.reportTableType,
      },
    };
  }
  if (market !== 'CN') return { ok: false, status: 400, error: '暂不支持该市场的证券分析' };
  return {
    ok: true,
    security: {
      code: canonicalCode, market, name: instrument.name, currency: 'CNY',
      assetClass: instrument.asset_class, instrumentId: instrument.instrument_id,
      securityType: 'a_share',
    },
  };
}

// 供刷新与普通读取使用：只归一代码，不查库（需主档核对的入口用 resolveAnalysisSecurity）。
function normalizeAnalyzableStockCode(rawCode) {
  const normalized = contract.normalizeAnalyzableCode(rawCode);
  if (normalized.ok) return normalized.code;
  if (normalized.reason === 'cn_code_needs_suffix') return canonicalizeSecurityCode(normalized.digits, 'stock');
  return null;
}

function isHongKongCode(rawCode) {
  return contract.marketOf(rawCode) === 'HK';
}

module.exports = {
  resolveAnalysisSecurity,
  normalizeAnalyzableStockCode,
  searchCandidates,
  isHongKongCode,
};
