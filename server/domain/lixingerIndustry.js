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
  const levels = nodes.map(node => node.level);
  const maxLevel = Math.max(...levels);
  const unambiguous = new Set(levels).size === levels.length;
  let chain = null;
  let alternatives = null;
  if (unambiguous) {
    chain = nodes.slice().sort((a, b) => a.level - b.level);
  } else {
    // 同一级出现多行有两种情况，必须分开：
    //  ① 只有几个同级代码、没有下级 → 脏数据/无法判断，仍然返回 null（不猜）。
    //  ② 存在多套**完整层级链**（同一家公司被同时归入多个一级行业，例如中诚咨询 920003
    //     的申万 2021 同时有「机械设备→工程机械→工程机械整机」和「建筑装饰→工程咨询→工程咨询」）：
    //     这类不是脏数据，官方把主分类排在接口返回的前面，就取第一条完整链，
    //     其余一级行业作为备选留证，交人工复核。整条丢掉会让这些证券永远"行业未知"。
    if (maxLevel < 2) return null;
    const byCode = new Map(nodes.map(node => [node.code, node]));
    const fits = [];
    for (const node of nodes) {
      if (node.level !== maxLevel) continue;
      const path = [node];
      let cursor = node;
      while (cursor.level > 1) {
        const parentCode = cursor.level === 3 ? cursor.code.slice(0, 4) + '00' : cursor.code.slice(0, 2) + '0000';
        const parent = byCode.get(parentCode);
        if (!parent || parent.level !== cursor.level - 1) { cursor = null; break; }
        path.unshift(parent);
        cursor = parent;
      }
      if (cursor) fits.push(path);
    }
    if (!fits.length) return null;
    chain = fits[0];
    if (fits.length > 1) alternatives = fits.map(path => `${path[0].code} ${path[0].name}`);
  }
  // 需要按一级行业控上限的调用方（港股选股）要求路径从一级起连续，缺一级宁可当未知。
  if (options.requireRoot === true && chain[0].level !== 1) return null;
  const deepest = chain[chain.length - 1];
  return {
    industry: deepest.name,
    industry_system: SYSTEM_LABELS[system] || system,
    industry_level: `${deepest.level}级`,
    industry_path: chain.map(node => node.name),
    industry_code: deepest.code,
    // 全层级节点交给标准层落库：只存最深节点会让"按一级行业控上限"读不到任何分类。
    industry_nodes: chain.map(node => ({ code: node.code, name: node.name, level: node.level })),
    ...(alternatives ? { industry_ambiguous: true, industry_alternatives: alternatives } : {}),
  };
}

module.exports = { selectIndustryPath, SYSTEM_LABELS, swLevelOf, hsiLevelOf };
