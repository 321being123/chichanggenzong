// 行业分类的纯判定：从官方 cn/hk company/industries 返回行里选出目标体系并还原完整层级。
//
// 官方接口把多家分类体系混在一次返回里（A 股：sw / sw_2021 / cni；港股：hsi），且 stockCode 是行业代码，
// 不是证券代码。这里只做"选体系 + 判级 + 判歧义"，不访问网络、不读写数据库：
// 层级重复（同一级出现多行）视为歧义，返回 null 交给调用方保留原来源，不猜。
const SYSTEM_LABELS = Object.freeze({ sw_2021: '申万2021', hsi: '恒生行业分类' });

// 申万：6 位数字行业代码，按尾部补零判级。
function swLevelOf(industryCode) {
  if (industryCode.endsWith('0000')) return 1;
  if (industryCode.endsWith('00')) return 2;
  return 3;
}

// 恒生行业分类（HSICS）：H + 2/4/6 位数字，代码位数即层级（H70 一级 / H7020 二级 / H702015 三级）。
function hsiLevelOf(industryCode) {
  const matched = /^H(\d{2})(\d{2})?(\d{2})?$/.exec(industryCode);
  if (!matched) return null;
  return matched[3] ? 3 : matched[2] ? 2 : 1;
}

function levelOf(system, industryCode) {
  return system === 'hsi' ? hsiLevelOf(industryCode) : swLevelOf(industryCode);
}

function isValidCode(system, industryCode) {
  return system === 'hsi' ? hsiLevelOf(industryCode) !== null : /^\d{6}$/.test(industryCode);
}

function selectIndustryPath(rows, options = {}) {
  const system = String(options.system || 'sw_2021');
  const areaCode = String(options.areaCode || 'cn');
  const nodes = (Array.isArray(rows) ? rows : [])
    .filter(row => row && String(row.source || '').toLowerCase() === system && String(row.areaCode || areaCode) === areaCode)
    .map(row => {
      const code = String(row.stockCode || '').trim();
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      return { code, name, level: levelOf(system, code) };
    })
    .filter(node => node.level && node.name && isValidCode(system, node.code))
    .sort((a, b) => a.level - b.level);
  if (!nodes.length) return null;
  // 同一级出现多行说明分类有歧义，不猜。
  if (new Set(nodes.map(node => node.level)).size !== nodes.length) return null;
  // 需要按一级行业控上限的调用方（港股选股）要求路径从一级起连续，缺一级宁可当未知。
  if (options.requireRoot === true && nodes[0].level !== 1) return null;
  const deepest = nodes[nodes.length - 1];
  return {
    industry: deepest.name,
    industry_system: SYSTEM_LABELS[system] || system,
    industry_level: `${deepest.level}级`,
    industry_path: nodes.map(node => node.name),
    industry_code: deepest.code,
    // 全层级节点交给标准层落库：只存最深节点会让"按一级行业控上限"读不到任何分类。
    industry_nodes: nodes.map(node => ({ code: node.code, name: node.name, level: node.level })),
  };
}

module.exports = { selectIndustryPath, SYSTEM_LABELS, swLevelOf, hsiLevelOf };
