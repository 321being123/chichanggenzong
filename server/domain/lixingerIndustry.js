// 理杏仁行业分类的纯判定：从官方 cn/company/industries 返回行里选出申万2021的完整层级。
//
// 官方接口把多家分类体系混在一次返回里（sw / sw_2021 / cni），且 stockCode 是行业代码，
// 不是证券代码。这里只做"选体系 + 判级 + 判歧义"，不访问网络、不读写数据库：
// 层级重复（同一级出现多行）视为歧义，返回 null 交给调用方保留原来源，不猜。
const SYSTEM_LABELS = Object.freeze({ sw_2021: '申万2021' });

function levelOf(industryCode) {
  if (industryCode.endsWith('0000')) return 1;
  if (industryCode.endsWith('00')) return 2;
  return 3;
}

function selectIndustryPath(rows, options = {}) {
  const system = String(options.system || 'sw_2021');
  const areaCode = String(options.areaCode || 'cn');
  const nodes = (Array.isArray(rows) ? rows : [])
    .filter(row => row && row.source === system && String(row.areaCode || areaCode) === areaCode)
    .map(row => {
      const code = String(row.stockCode || '').trim();
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      return { code, name, level: levelOf(code) };
    })
    .filter(node => /^\d{6}$/.test(node.code) && node.name)
    .sort((a, b) => a.level - b.level);
  if (!nodes.length) return null;
  if (new Set(nodes.map(node => node.level)).size !== nodes.length) return null;
  const deepest = nodes[nodes.length - 1];
  return {
    industry: deepest.name,
    industry_system: SYSTEM_LABELS[system] || system,
    industry_level: `${deepest.level}级`,
    industry_path: nodes.map(node => node.name),
    industry_code: deepest.code,
  };
}

module.exports = { selectIndustryPath, SYSTEM_LABELS };
