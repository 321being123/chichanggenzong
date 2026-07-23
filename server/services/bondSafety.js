// 可转债安全性核心算法。
// 目标：与 scripts/generate_excel_v2.py 的“三指标打分法”保持一致，且不依赖 HTTP/数据库。

const RATINGS = ['安全', '低风险', '中风险', '高风险', '未评级'];

function cleanValue(value) {
  if (typeof value !== 'string') return value;
  let text = value.trim();
  if (text.startsWith('=')) text = text.slice(1);
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
}

function finiteNumber(value) {
  const cleaned = cleanValue(value);
  return typeof cleaned === 'number' && Number.isFinite(cleaned) ? cleaned : null;
}

function hasConvertibleBond(value) {
  const cleaned = cleanValue(value);
  return Number.isFinite(Number(cleaned)) && Number(cleaned) === 1;
}

function rateCompany(row) {
  if (row.financial_available === false) {
    return { rating: '未评级', score: 0, forced: false, missing_fields: ['financial_data'], checks: null, metrics: null };
  }
  const industry = String(row.industry == null ? '' : row.industry).trim();
  if (industry === '银行' || industry === '非银金融') {
    return { rating: '安全', score: 3, forced: true, missing_fields: [], checks: { interest: null, liquidity: null, leverage: null }, metrics: null };
  }

  const fields = {
    interest_expense: finiteNumber(row.interest_expense),
    ebit: finiteNumber(row.ebit),
    cash: finiteNumber(row.cash),
    trading_fin_assets: finiteNumber(row.trading_fin_assets),
    interest_bearing_debt: finiteNumber(row.interest_bearing_debt),
    total_liability: finiteNumber(row.total_liability),
    current_liability: finiteNumber(row.current_liability),
    market_cap: finiteNumber(row.market_cap),
  };
  const directInterestRatio = finiteNumber(row.interest_coverage);
  const missingFields = Object.keys(fields).filter(key => fields[key] === null &&
    !(directInterestRatio !== null && (key === 'ebit' || key === 'interest_expense')));

  let score = 0;
  let interestPassed = false;
  let interestRatio = null;
  if (directInterestRatio !== null || (fields.ebit !== null && fields.interest_expense !== null && fields.interest_expense !== 0)) {
    interestRatio = directInterestRatio !== null ? directInterestRatio : fields.ebit / fields.interest_expense;
    if (interestRatio >= 7) { score += 1; interestPassed = true; }
  }

  const cashSum = (fields.cash || 0) + (fields.trading_fin_assets || 0);
  const coverageRatios = [fields.current_liability, fields.interest_bearing_debt]
    .filter(value => value !== null && value > 0)
    .map(value => cashSum / value);
  const liquidityRatio = coverageRatios.length ? Math.max(...coverageRatios) : null;
  const liquidityPassed = coverageRatios.some(value => value >= 1);
  if (liquidityPassed) score += 1;

  let leveragePassed = false;
  let leverageRatio = null;
  if (fields.market_cap !== null && fields.market_cap > 0 && fields.total_liability !== null) {
    leverageRatio = fields.total_liability / fields.market_cap;
    if (leverageRatio <= 1.5) { score += 1; leveragePassed = true; }
  }

  const ratingByScore = ['高风险', '中风险', '低风险', '安全'];
  return { rating: ratingByScore[score], score, forced: false, missing_fields: missingFields,
    checks: { interest: interestPassed, liquidity: liquidityPassed, leverage: leveragePassed },
    metrics: { interest: interestRatio, liquidity: liquidityRatio, leverage: leverageRatio } };
}

function buildRatingIndex(companyRows) {
  const index = new Map();
  const incompleteCompanies = [];
  const duplicateCompanies = [];
  let eligibleCompanies = 0;

  for (const row of companyRows || []) {
    if (!row || !hasConvertibleBond(row.has_cb)) continue;
    eligibleCompanies += 1;
    const company = String(row.company == null ? '' : row.company);
    if (!company) continue;
    const result = rateCompany(row);
    if (result.missing_fields.length) {
      incompleteCompanies.push({ company, fields: result.missing_fields });
    }
    if (index.has(company)) {
      const previous = index.get(company);
      duplicateCompanies.push({ company, ratings: [previous.rating, result.rating] });
      // 同名公司的冲突结果不可静默覆盖；让本次刷新失败，继续提供上一份有效快照。
      if (previous.rating !== result.rating) {
        const error = new Error(`公司数据存在冲突的重复名称：${company}`);
        error.code = 'DUPLICATE_COMPANY_CONFLICT';
        throw error;
      }
      continue;
    }
    index.set(company, result);
  }

  return { index, eligibleCompanies, incompleteCompanies, duplicateCompanies };
}

function indicatorValue(result, key) {
  if (!result || !result.checks) return null;
  if (result.forced) return '行业豁免';
  const value = result.metrics && result.metrics[key];
  return Number.isFinite(value) ? value : null;
}

function normalizeBondRow(row, rating) {
  return {
    bond_code: String(row.bond_code == null ? '' : row.bond_code),
    bond_name: String(row.bond_name == null ? '' : row.bond_name),
    stock_name: String(row.stock_name == null ? '' : row.stock_name),
    pe_ttm: cleanValue(row.pe_ttm),
    pb: cleanValue(row.pb),
    dividend_yield: cleanValue(row.dividend_yield),
    bond_price: cleanValue(row.bond_price),
    change_pct: cleanValue(row.change_pct),
    double_low: cleanValue(row.double_low),
    convert_premium: cleanValue(row.convert_premium),
    convert_price: cleanValue(row.convert_price),
    convert_value: cleanValue(row.convert_value),
    indicator_interest: indicatorValue(rating, 'interest'),
    indicator_liquidity: indicatorValue(rating, 'liquidity'),
    indicator_leverage: indicatorValue(rating, 'leverage'),
    safety: rating ? rating.rating : '未评级',
  };
}

function evaluateBondSafety(companyRows, bondRows) {
  if (!Array.isArray(companyRows) || !Array.isArray(bondRows)) {
    throw new TypeError('公司财务数据和债券行情数据必须是数组');
  }
  const ratingState = buildRatingIndex(companyRows);
  const unmatchedStocks = new Set();

  const data = bondRows
    .filter(row => row && !/数据来源于|数据来源/.test(String(row.bond_code == null ? '' : row.bond_code)))
    .map(row => {
      const stockName = String(row.stock_name == null ? '' : row.stock_name);
      const rating = ratingState.index.get(stockName);
      if (!rating && stockName) unmatchedStocks.add(stockName);
      return normalizeBondRow(row, rating || null);
    })
    .sort((a, b) => {
      const ap = finiteNumber(a.bond_price);
      const bp = finiteNumber(b.bond_price);
      if (ap === null && bp === null) return 0;
      if (ap === null) return 1;
      if (bp === null) return -1;
      return ap - bp;
    });

  const ratingCounts = Object.fromEntries(RATINGS.map(rating => [rating, 0]));
  data.forEach(row => { ratingCounts[row.safety] += 1; });

  return {
    data,
    diagnostics: {
      company_rows: companyRows.length,
      eligible_companies: ratingState.eligibleCompanies,
      bond_rows: data.length,
      rating_counts: ratingCounts,
      unmatched_stock_count: unmatchedStocks.size,
      unmatched_stocks: Array.from(unmatchedStocks).sort(),
      incomplete_company_count: ratingState.incompleteCompanies.length,
      incomplete_companies: ratingState.incompleteCompanies,
      duplicate_companies: ratingState.duplicateCompanies,
    },
  };
}

module.exports = { RATINGS, cleanValue, rateCompany, evaluateBondSafety };
