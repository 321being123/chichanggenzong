// 股息税务条款的纯解析（无取数、无默认税率、无数据库）。
// 从 server/services/cashDividendSettlement.js 抽出，供结算内核与分红事实采集共用。
const VERSION = 'dividend-settlement-v1';
const TAX_RULE = 'https://www.chinatax.gov.cn/n810341/n810755/c1797427/content.html';
const HK_TAX_RULE = 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5203646/content.html';

function parseCnTaxTreatment(body) {
  const flat = String(body || '').replace(/\s+/g, '');
  const excerpt = flat.match(/(?:自然人股东|个人投资者|个人股东)[\s\S]{0,350}?暂不扣缴个人所得税/)?.[0];
  if (!excerpt || !/(?:2015.{0,8}101|财税.{0,12}101)/.test(flat)) return null;
  return {
    version: VERSION,
    kind: 'CN_personal_deferred_2015',
    investor: 'mainland_personal_unrestricted',
    initialWithholdingRate: '0',
    sourceExcerpt: excerpt,
    rule: TAX_RULE,
    brokerVerified: false,
  };
}

function parseHkTaxTreatment(body) {
  const flat = String(body || '').replace(/\s+/g, '');
  const none = flat.match(/股息所涉及的代扣所得[稅税]不適用/);
  if (none) {
    return {
      kind: 'HK_connect_personal',
      amountBasis: 'gross',
      issuerWithholding: 'none_in_event_announcement',
      sourceExcerpt: none[0],
      layers: [{ rate: '0.20', base: 'gross', sourceRef: HK_TAX_RULE }],
      brokerVerified: false,
    };
  }
  for (const m of flat.matchAll(/20[%％]/g)) {
    const excerpt = flat.slice(Math.max(0, m.index - 80), m.index + 180);
    if (/(?:內地|内地)(?:個人|个人)/.test(excerpt) && /(?:滬港通|沪港通|深港通|港股通)/.test(excerpt)) {
      return {
        kind: 'HK_connect_personal',
        amountBasis: 'gross',
        sourceExcerpt: excerpt,
        layers: [{ rate: '0.20', base: 'gross', sourceRef: 'event_announcement_connect_personal_20_percent' }],
        brokerVerified: false,
      };
    }
  }
  return null;
}

module.exports = { parseCnTaxTreatment, parseHkTaxTreatment };
