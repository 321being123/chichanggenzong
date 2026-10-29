// 财务三表 Presenter（批次4：View／Presenter 分离）。
// 职责：持有三表缓存与请求序号、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。
var stockStatementState = { type:'balance', loadedCode:'', cache:{}, requestToken:0 };

async function stockAnalysisLoadStatements(type) {
  type = ['balance','income','cashflow'].includes(type) ? type : 'balance';
  stockStatementState.type = type;
  var code = stockAnalysisState.selected;
  if (!code) return;
  var requestToken = ++stockStatementState.requestToken;
  var selectToken = stockAnalysisState.selectToken;
  var key = code + ':' + type;
  if (stockStatementState.cache[key]) return stockAnalysisRenderStatements(stockStatementState.cache[key]);
  stockAnalysisShowStatementsLoading();
  try {
    var response = await stockAnalysisApi.getStatements(code, type);
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
