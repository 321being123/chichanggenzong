// 财务三表 Presenter（批次4：View／Presenter 分离）。
// 职责：持有三表缓存与请求序号、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var stockStatementState = { type:'balance', loadedCode:'', cache:{}, requestToken:0, filters:{ periodType:'all', compare:'yoy', scope:'consolidated', limit:10 } };

function stockAnalysisStatementFilters() {
  stockStatementState.filters = stockStatementState.filters || { periodType:'all', compare:'yoy', scope:'consolidated', limit:10 };
  return stockStatementState.filters;
}

async function stockAnalysisSetStatementFilter(name, value) {
  var filters = stockStatementState.filters || (stockStatementState.filters = { periodType:'all', compare:'yoy', scope:'consolidated', limit:10 });
  if (name === 'periodType' && ['all','annual','semiannual','q1','q3','unknown'].indexOf(value) < 0) value = 'all';
  if (name === 'compare' && ['yoy','qoq','none'].indexOf(value) < 0) value = 'yoy';
  if (name === 'limit' && [5,10,20,'5','10','20'].indexOf(value) < 0) value = 10;
  if (name === 'scope' && value == null) value = 'consolidated';
  if (filters[name] === value) return;
  filters[name] = value;
  stockStatementState.requestToken++;
  Object.keys(stockStatementState.cache).forEach(function(key) {
    if (key.indexOf((stockAnalysisState.selected || '') + ':') === 0) delete stockStatementState.cache[key];
  });
  if (stockAnalysisState.selected) await stockAnalysisLoadStatements(stockStatementState.type);
}

async function stockAnalysisLoadStatements(type) {
  type = ['balance','income','cashflow'].includes(type) ? type : 'balance';
  stockStatementState.type = type;
  var code = stockAnalysisState.selected;
  if (!code) return;
  var requestToken = ++stockStatementState.requestToken;
  var selectToken = stockAnalysisState.selectToken;
  var filters = stockStatementState.filters || (stockStatementState.filters = { periodType:'all', compare:'yoy', scope:'consolidated', limit:10 });
  var key = code + ':' + type + ':' + (filters.periodType || 'all') + ':' + (filters.compare || 'yoy') + ':' + (filters.scope || '') + ':' + (filters.limit || 10);
  var detail = stockAnalysisState.data || {};
  var statementVersions = detail.display ? detail.display.statement_analysis_versions : null;
  var version = statementVersions ? statementVersions[type] : null;
  var cached = stockStatementState.cache[key];
  if (cached && (!version || cached.analysis_version === version)) {
    return stockAnalysisRenderStatements(cached);
  }
  if (cached && version && cached.analysis_version !== version) {
    delete stockStatementState.cache[key];
  }
  stockAnalysisShowStatementsLoading();
  try {
    // 版本冲突（409）最多重新读取一次整组本地内容；仍冲突则提示数据更新中，不拼接不同版本、不转外采。
    var response = await stockAnalysisApi.getStatements(code, type, version, filters);
    if (response.status === 409) {
      delete stockStatementState.cache[key];
      var refreshedDetail = await stockAnalysisApi.getSnapshot(code);
      if (requestToken !== stockStatementState.requestToken
        || selectToken !== stockAnalysisState.selectToken
        || stockAnalysisState.selected !== code) return;
      if (!refreshedDetail.ok) throw new Error((refreshedDetail.payload && refreshedDetail.payload.error) || '分析数据更新中，请稍后重试');
      stockAnalysisState.data = refreshedDetail.payload;
      var refreshedVersions = refreshedDetail.payload.display && refreshedDetail.payload.display.statement_analysis_versions;
      var refreshedVersion = refreshedVersions ? refreshedVersions[type] : null;
      response = await stockAnalysisApi.getStatements(code, type, refreshedVersion, filters);
      if (response.status === 409) throw new Error('分析数据更新中，请稍后重试');
    }
    var payload = response.payload;
    if (requestToken !== stockStatementState.requestToken || selectToken !== stockAnalysisState.selectToken) return;
    if (!response.ok) throw new Error(payload.error || '三表读取失败');
    stockStatementState.cache[key] = payload;
    stockAnalysisRenderStatements(payload);
  } catch (error) {
    if (requestToken !== stockStatementState.requestToken || selectToken !== stockAnalysisState.selectToken) return;
    stockAnalysisShowStatementsError(error);
  }
}

function stockAnalysisInvalidateStatements(code) {
  stockStatementState.requestToken++;
  Object.keys(stockStatementState.cache).forEach(function(key) {
    if (!code || key.indexOf(code + ':') === 0) delete stockStatementState.cache[key];
  });
}
