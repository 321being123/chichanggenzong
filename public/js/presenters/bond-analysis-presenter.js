// 证券分析（可转债侧）Presenter（批次4：View／Presenter 分离）。
// 职责：持有证券选择/请求序号/搜索状态（securityAnalysisState）、决定何时取数、何时把结果交给 View。
// 边界：本文件不直接操作 DOM（静态门禁按 role=presenter、allowDom=false 校验），
//       需要改界面时只调用 View 暴露的入口；View 不取数，只渲染并上报用户操作。

var securityAnalysisState = { type:'', code:'', loading:false, requestToken:0, suggestions:[], suggestionIndex:-1, searchTimer:null, searchSeq:0 };

async function securityAnalysisSearchSuggestions(value, ctx) {
  var keyword=String(value||'').trim();
  if(!keyword){securityAnalysisState.suggestions=[];return securityAnalysisHideSuggestions(ctx);}
  var seq=++securityAnalysisState.searchSeq;
  try {
    var res=await window.siteApi.get('/api/bond-analysis/search/securities?q='+encodeURIComponent(keyword));
    if(seq!==securityAnalysisState.searchSeq) return;
    if(!res.ok) throw new Error(res.payload.error||'证券搜索失败');
    securityAnalysisRenderSuggestions(res.payload.data||[], ctx);
  } catch(_) {
    if(seq===securityAnalysisState.searchSeq) securityAnalysisHideSuggestions(ctx);
  }
}

async function securityAnalysisLoadList(force) {
  var user = typeof username === 'string' ? username : '';
  var identity = typeof accountIdentity === 'string' ? accountIdentity : '';
  var seq = (securityAnalysisState.listSeq || 0) + 1;
  securityAnalysisState.listSeq = seq;
  function current() { return securityAnalysisState.listSeq === seq && user === (typeof username === 'string' ? username : '') && identity === (typeof accountIdentity === 'string' ? accountIdentity : ''); }
  if(!username){
    securityAnalysisLockListSelects();
    return;
  }
  if (securityAnalysisState.listLoaded && !force) return;
  try {
    var res=await window.siteApi.get('/api/bond-analysis/list/securities'), payload=res.payload;
    if (!current()) return;
    if(!res.ok) throw new Error(payload.error||'持仓和自选加载失败');
    securityAnalysisFillListSelects(payload);
    securityAnalysisState.listLoaded=true;
  } catch(error) { if (current()) stockAnalysisSetMessage(error.message||String(error),true); }
}

function securityAnalysisSelect(code, ctx) {
  if(!code) return;
  clearTimeout(securityAnalysisState.searchTimer);
  securityAnalysisState.searchTimer=null;
  securityAnalysisState.searchSeq++;
  securityAnalysisState.suggestions=[];
  securityAnalysisHideSuggestions(ctx);
  securityAnalysisSetCodeInput(code, ctx);
  securityAnalysisSubmit(code, ctx);
}

async function securityAnalysisResolveName(keyword, ctx) {
  var query=String(keyword||'').trim(), seq=++securityAnalysisState.searchSeq;
  clearTimeout(securityAnalysisState.searchTimer);
  securityAnalysisHideSuggestions(ctx);
  stockAnalysisSetMessage('正在搜索证券...', false, ctx);
  try {
    var res=await window.siteApi.get('/api/bond-analysis/search/securities?q='+encodeURIComponent(query));
    if(seq!==securityAnalysisState.searchSeq) return;
    if(!res.ok) throw new Error(res.payload.error||'证券搜索失败');
    var payload=res.payload;
    var rows=Array.isArray(payload.data)?payload.data:[];
    var normalized=query.normalize('NFKC').toLocaleLowerCase();
    var exact=rows.filter(function(row){return String(row.name||'').normalize('NFKC').toLocaleLowerCase()===normalized;});
    if(exact.length===1 || (!exact.length && rows.length===1)) {
      var row=exact[0]||rows[0];
      securityAnalysisSetCodeInput(row.ts_code||row.code, ctx);
      return securityAnalysisSubmit(row.ts_code||row.code,ctx);
    }
    if(rows.length) {
      securityAnalysisRenderSuggestions(rows,ctx);
      stockAnalysisSetMessage('找到多个结果，请从联想列表中选择。', false, ctx);
      return;
    }
    stockAnalysisSetMessage('没有找到符合条件的股票或可转债，请检查名称或代码。', true, ctx);
  } catch(error) {
    if(seq===securityAnalysisState.searchSeq) stockAnalysisSetMessage(error.message||'证券搜索失败，请稍后重试。',true,ctx);
  }
}

async function securityAnalysisSubmit(selectedCode, ctx) {
  var raw=String(selectedCode||securityAnalysisReadCodeValue(ctx)||'').trim().toUpperCase();
  var match=raw.match(/^(\d{6})(?:\.(?:SH|SZ|BJ))?$/), code=match&&match[1];
  if (!code) return securityAnalysisResolveName(raw,ctx);
  securityAnalysisState.requestToken++;
  securityAnalysisState.loading=false;
  securityAnalysisResetRefreshButtons();
  securityAnalysisState.type=securityAnalysisKind(code); securityAnalysisState.code=code;
  if (securityAnalysisState.type==='stock') {
    stockAnalysisState.selected=code;
    securityAnalysisHideBondContent();
    if (ctx === 'bond') switchMain('stock-analysis');
    return stockAnalysisSelect(code);
  }
  // 证券分析页已内置可转债分析内容区，输入可转债代码直接在当前页渲染结果
  if (typeof stockAnalysisCancelSelection === 'function') stockAnalysisCancelSelection();
  securityAnalysisHideStockContent();
  return bondAnalysisLoad(false, ctx);
}

async function securityAnalysisRefresh(ctx) {
  if (!securityAnalysisState.code) return securityAnalysisSubmit(null, ctx);
  if (!username) return stockAnalysisSetMessage('登录后可刷新并建立分析数据。', false, ctx);
  if (securityAnalysisState.type==='stock') return stockAnalysisRefresh();
  return bondAnalysisLoad(true, ctx);
}

async function bondAnalysisLoad(refresh, ctx) {
  if (securityAnalysisState.loading) return;
  securityAnalysisState.loading=true;
  var requestToken=securityAnalysisState.requestToken, code=securityAnalysisState.code;
  function isCurrent(){return securityAnalysisState.requestToken===requestToken && securityAnalysisState.type==='bond' && securityAnalysisState.code===code;}
  var p = ctx === 'bond' ? 'bond-analysis-' : 'stock-analysis-';
  bondAnalysisSetRefreshButton(p, true, '刷新中...');
  stockAnalysisSetMessage(refresh ? '正在更新可转债数据...' : '正在读取可转债分析结果...', false, ctx);
  try {
    var path='/api/bond-analysis/'+encodeURIComponent(code)+(refresh?'/refresh':'');
    var res=await window.siteApi.request(path, refresh?{method:'POST'}:{});
    if(!isCurrent()) return;
    if(res.status===404&&!refresh){
      var shown=await bondAnalysisRenderListFallback(ctx, code, isCurrent);
      if(!isCurrent()) return;
      if(shown) return;
      return stockAnalysisSetMessage(username?'该转债暂无分析快照或上市列表资料，可登录后点击“刷新数据”尝试建立分析。':'该转债暂无详细分析快照，当前也没有可展示的上市行情资料。', false, ctx);
    }
    var payload=res.payload, analysis=payload.analysis||payload;
    if(!res.ok&&!payload.analysis) throw new Error(payload.error||'可转债分析失败');
    // 缓存版本过旧时只提示，页面读取不自动触发外部采集。
    if (!refresh && analysis.needs_refresh) {
      // 页面打开只读本地快照；外部采集必须由用户明确点击“刷新数据”触发。
      showToast('数据待更新，请点击“刷新数据”进行更新。');
    }
    bondAnalysisRender(analysis, ctx);
    if(payload.queued)showToast('已显示数据库中的分析结果，缺失资料已交后台补采。');
    if (window.SiteTelemetry && window.SiteTelemetry.trackDetail) window.SiteTelemetry.trackDetail({ page_key: 'bond.analysis', module: 'bond', entry: ctx || 'analysis', detail_key: securityAnalysisState.code || 'bond', properties: { detail_type: 'bond' } });
    if(!res.ok&&payload.error) showToast('更新失败，已显示上一份有效数据：'+payload.error);
  } catch(error) { if(isCurrent()) stockAnalysisSetMessage(error.message||String(error),true, ctx); }
  finally { if(isCurrent()){securityAnalysisState.loading=false;bondAnalysisSetRefreshButton(p, false, '刷新数据');} }
}

async function bondAnalysisRenderListFallback(ctx, code, isCurrent) {
  var res=await window.siteApi.get('/api/bond-analysis/bonds?q='+encodeURIComponent(code));
  if(!isCurrent()) return false;
  if(!res.ok) return false;
  var payload=res.payload, rows=Array.isArray(payload.data)?payload.data:[];
  var row=rows.find(function(item){return String(item.bond_code||item.ts_code||'').replace(/\D/g,'')===code;});
  if(!row) return false;
  bondAnalysisRenderListFallbackView(row, payload, ctx);
  return true;
}
