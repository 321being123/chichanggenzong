var mvState = { market: 'CN', benchmark: 'CSI300', range: '20y', overview: null, history: [], draft: null, loading: false };
function mvNum(v, d) { return Number.isFinite(Number(v)) ? Number(v).toFixed(d == null ? 2 : d) : '--'; }
function mvPct(v) { return Number.isFinite(Number(v)) ? mvNum(v, 2) + '%' : '--'; }
function mvLadder(lower, upper) { var l=Number(lower),u=Number(upper); if(!Number.isFinite(l)||!Number.isFinite(u)||l<=0||u<=l)return []; var out=[]; for(var i=0;i<7;i++) out.push({value:Number((l+(u-l)*i/6).toFixed(4)),position:20+i*10}); return out; }
function mvDefaultSetting() { var current=mvState.overview&&mvState.overview.current, value=current&&Number(current.graham_index_pct); if(!Number.isFinite(value)||value<=0)return null; var lower=Number((value*.75).toFixed(4)),upper=Number((value*1.25).toFixed(4)); return {lower:lower,upper:upper,version:0,ladder:mvLadder(lower,upper),isDefault:true}; }
function mvRecommended(value, lower, upper) { if(!Number.isFinite(Number(value))||Number(value)<=0)return 20; var ladder=mvLadder(lower,upper); for(var i=ladder.length-1;i>=0;i--)if(Number(value)>=ladder[i].value)return ladder[i].position; return 20; }
function mvAccount() { return (typeof username === 'string' && username && typeof currentAccount === 'string' && currentAccount) ? currentAccount : ''; }
function mvEsc(v) { return typeof escapeHtml === 'function' ? escapeHtml(v) : String(v); }
function mvRateLabel() { return mvState.market === 'HK' ? '美国十年期国债收益率（港股代理）' : '10年期国债收益率'; }

function initMarketVolatility() {
  if (window.__mvReady) return; window.__mvReady = true;
  document.querySelectorAll('[data-mv-market]').forEach(function (button) { button.onclick = function () {
    mvState.market = button.dataset.mvMarket; mvState.benchmark = mvState.market === 'CN' ? 'CSI300' : 'HSI'; mvReload(); updateMarketCycleHomeButtons();
  }; });
  document.querySelectorAll('[data-mv-benchmark]').forEach(function (button) { button.onclick = function () { mvState.benchmark = button.dataset.mvBenchmark; mvReload(); updateMarketCycleHomeButtons(); }; });
  document.getElementById('mv-range').onchange = function (e) { mvState.range = e.target.value; loadMarketVolatility(); };
  document.getElementById('mv-save').onclick = mvSaveDraft;
  document.getElementById('mv-home').onclick = function () { setMarketCycleHome('graham',mvState.market,mvState.benchmark); };
  document.getElementById('mv-cancel').onclick = function () { mvState.draft = null; document.getElementById('mv-draft').hidden=true; document.getElementById('mv-save').disabled=true; document.getElementById('mv-cancel').disabled=true; mvRender(); };
  loadMarketCycleHomeConfig();
}
function mvReload() { mvState.overview = null; mvState.history = []; mvState.draft = null; loadMarketVolatility(); }
async function loadMarketVolatility() {
  initMarketVolatility(); if (mvState.loading) return;
  var account = mvAccount(), status = document.getElementById('mv-status');
  mvState.loading = true; status.textContent = '正在读取数据...';
  try {
    var qs = 'market=' + encodeURIComponent(mvState.market) + '&benchmark=' + encodeURIComponent(mvState.benchmark);
    var both = await Promise.all([fetch(api('/api/market-volatility/overview?' + qs + '&account=' + encodeURIComponent(account))), fetch(api('/api/market-volatility/history?' + qs + '&range=' + encodeURIComponent(mvState.range)))]);
    if (!both[0].ok || !both[1].ok) throw new Error('接口返回 ' + (!both[0].ok ? both[0].status : both[1].status));
    mvState.overview = await both[0].json(); mvState.history = (await both[1].json()).history || [];
    mvState.draft = null; mvRender();
  } catch (e) { status.textContent = '数据加载失败：' + (e.message || e); document.getElementById('mv-content').style.display = 'none'; }
  finally { mvState.loading = false; }
}
function mvRender() {
  var o = mvState.overview, current = o && o.current, status = document.getElementById('mv-status');
  document.querySelectorAll('[data-mv-market]').forEach(function (b) { b.classList.toggle('active', b.dataset.mvMarket === mvState.market); });
  var benchmarkBox = document.getElementById('mv-benchmark-controls'); benchmarkBox.style.display = mvState.market === 'CN' ? '' : 'none';
  document.querySelectorAll('[data-mv-benchmark]').forEach(function (b) { b.classList.toggle('active', b.dataset.mvBenchmark === mvState.benchmark); });
  if (!current) { status.textContent = '数据源尚未接入或未完成首次回填，当前不生成仓位信号。'; document.getElementById('mv-content').style.display = 'none'; document.getElementById('mv-updated').textContent = '暂无可用数据'; return; }
  document.getElementById('mv-content').style.display = ''; document.getElementById('mv-updated').textContent = '数据日期：' + current.trade_date + ' · ' + ({normal:'正常',carried_forward:'沿用',stale:'过期',missing:'缺失'}[current.data_status] || current.data_status);
  status.textContent = o.setting ? (o.hasUsPosition ? '账户含美股持仓，实际仓位未完成汇率核算，仅供参考。' : '') : (username ? '已按当前指数生成默认边界；可拖动红色虚线调整并保存。' : '已按当前指数生成默认边界；登录后可保存设置并关联账户持仓。');
  document.getElementById('mv-graham').textContent = mvPct(current.graham_index_pct); document.getElementById('mv-pe').textContent = mvNum(current.pe);
  document.getElementById('mv-earnings').textContent = mvPct(current.earnings_yield_pct); document.getElementById('mv-yield').textContent = mvPct(current.sovereign_yield_pct); document.getElementById('mv-yield-label').textContent = mvRateLabel();
  var activeSetting=mvActiveSetting(), recommended=o.recommendedPosition == null && activeSetting ? mvRecommended(current.graham_index_pct,activeSetting.lower,activeSetting.upper) : o.recommendedPosition;
  document.getElementById('mv-recommended').textContent = recommended == null ? '--' : recommended + '%'; var actual=document.getElementById('mv-actual'),actualLabel=actual.previousElementSibling; if(!username){actual.innerHTML='<a class="mv-login-link" href="'+api('/login.html?redirect='+encodeURIComponent('/?main=market-volatility'))+'">登录</a>';if(actualLabel)actualLabel.textContent='实际股票仓位';}else{actual.textContent=mvPct(o.actualPosition);if(actualLabel)actualLabel.textContent=mvAccount()?'实际股票仓位（'+mvAccount()+'）':'实际股票仓位';}
  var d = o.deviation; if(!d&&o.actualPosition!=null&&recommended!=null){var delta=Number((o.actualPosition-recommended).toFixed(2));d={value:delta,status:Math.abs(delta)<=5?'符合':delta>0?'偏高':'偏低'};} document.getElementById('mv-deviation').textContent = d ? (d.value > 0 ? '高出 ' : d.value < 0 ? '低出 ' : '') + Math.abs(d.value) + ' 个百分点（' + d.status + '）' : '--';
  mvRenderLadder(); mvRenderChart(); updateMarketCycleHomeButtons();
}
function mvActiveSetting() { return mvState.draft || (mvState.overview && mvState.overview.setting) || mvDefaultSetting(); }
function mvRenderLadder() {
  var setting = mvActiveSetting(), root = document.getElementById('mv-ladder'); if (!setting) { root.innerHTML = '<div class="mv-empty">' + (username ? '尚未设置仓位边界' : '登录后可设置仓位边界') + '</div>'; return; }
  var rows = setting.ladder || mvLadder(setting.lower,setting.upper); root.innerHTML = '<table><thead><tr><th>格雷厄姆指数阈值</th><th class="text-right">建议股票仓位</th></tr></thead><tbody>' + rows.map(function (r) { return '<tr><td>' + mvNum(r.value, 4) + '%</td><td class="text-right">' + r.position + '%</td></tr>'; }).join('') + '</tbody></table>';
}
function mvRenderLadder() {
  var setting=mvActiveSetting(),root=document.getElementById('mv-ladder'); if(!setting){root.innerHTML='<div class="mv-empty">暂无仓位边界</div>';return;}
  var rows=setting.ladder||mvLadder(setting.lower,setting.upper),o=mvState.overview||{},current=o.current||{},point=o.indexPoint,indexName=mvState.benchmark==='CSI300'?'沪深300':mvState.benchmark==='CSIALL'?'中证全指':'恒生指数';
  root.innerHTML='<table><thead><tr><th>格雷厄姆指数阈值</th><th class="text-right">对应 PE</th><th class="text-right">对应'+indexName+'点位</th><th class="text-right">建议股票仓位</th></tr></thead><tbody>'+rows.map(function(r){var pe=Number(current.sovereign_yield_pct)>0?100/(Number(r.value)+Number(current.sovereign_yield_pct)):null,level=pe&&point&&Number(current.pe)>0?Number(point.value)*pe/Number(current.pe):null;return '<tr><td>'+mvNum(r.value,4)+'%</td><td class="text-right">'+mvNum(pe)+'</td><td class="text-right">'+mvNum(level,2)+'</td><td class="text-right">'+r.position+'%</td></tr>';}).join('')+'</tbody></table><div class="mv-ladder-note">对应点位按当前指数点位、当前 PE 与'+mvRateLabel()+'换算。</div>';
}
function mvRenderChart() {
  var root = document.getElementById('mv-chart'), setting = mvActiveSetting(), data = mvState.history || [], current = mvState.overview.current;
  if (!setting) { root.innerHTML = '<div class="mv-empty">暂无可用于生成边界的格雷厄姆指数。</div>'; return; }
  var values = data.map(function (item) { return Number(item.value); }).filter(Number.isFinite); values.push(Number(setting.lower), Number(setting.upper), Number(current.graham_index_pct));
  var min = Math.min.apply(null, values), max = Math.max.apply(null, values), pad = Math.max((max - min) * .12, .1); min -= pad; max += pad;
  var W=1000,H=320,L=55,R=20,T=18,B=36,ph=H-T-B; function x(i){return L+i*(W-L-R)/Math.max(data.length-1,1)} function y(v){return T+(max-v)*ph/(max-min)};
  var valid = data.map(function(item,i){ return Number.isFinite(Number(item.value)) ? {x:x(i),y:y(Number(item.value))}:null; }).filter(Boolean);
  var path = valid.map(function(point,i){return (i?'L':'M')+point.x.toFixed(1)+' '+point.y.toFixed(1)}).join(' '), svg=['<path class="mv-line" d="'+path+'"/>'];
  for(var g=0;g<5;g++){var gy=T+g*ph/4; svg.push('<line class="mv-grid" x1="'+L+'" y1="'+gy+'" x2="'+(W-R)+'" y2="'+gy+'"/><text x="4" y="'+(gy+4)+'" class="mv-axis">'+mvNum(max-g*(max-min)/4,2)+'%</text>');}
  (setting.ladder || mvLadder(setting.lower,setting.upper)).forEach(function(row, i){ var yy=y(row.value), edge=i===0?'lower':i===6?'upper':''; svg.push('<line class="mv-boundary '+edge+'" data-ladder="'+i+'" x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'"/><text data-ladder-label="'+i+'" x="'+(W-R-4)+'" y="'+(yy-5)+'" text-anchor="end" class="mv-label">'+row.position+'%</text>'); if(edge) svg.push('<line class="mv-boundary-hit" data-boundary="'+edge+'" x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'"/>'); });
  if(data.length){[0,Math.floor((data.length-1)/2),data.length-1].forEach(function(i){svg.push('<text x="'+x(i)+'" y="'+(H-10)+'" text-anchor="middle" class="mv-axis">'+mvEsc(String(data[i].date).slice(0,7))+'</text>');});}
  root.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="格雷厄姆指数历史图">'+svg.join('')+'</svg><div class="mv-tooltip" hidden></div>';
  var chart=root.querySelector('svg'); root.querySelectorAll('[data-boundary]').forEach(function(line){ line.addEventListener('pointerdown', function(e){ mvBeginDrag(e, line.dataset.boundary, min, max); }); });
  chart.addEventListener('pointermove', function(e){ mvShowTooltip(e, chart, data, L, R, W); }); chart.addEventListener('pointerleave', function(){ root.querySelector('.mv-tooltip').hidden=true; });
}
function mvShowTooltip(e, chart, data, left, right, width) {
  if (!data.length || chart.classList.contains('mv-dragging')) return; var box=chart.getBoundingClientRect(), svgX=(e.clientX-box.left)*width/box.width, ratio=Math.max(0,Math.min(1,(svgX-left)/(width-left-right))), index=Math.round(ratio*Math.max(data.length-1,1)), item=data[index], tip=document.querySelector('#mv-chart .mv-tooltip');
  if(!item||!tip)return; var indexName=mvState.benchmark==='HSI'?'恒生指数':mvState.benchmark==='CSIALL'?'中证全指':'沪深300'; tip.innerHTML='<strong>'+mvEsc(item.date)+'</strong><br>格雷厄姆指数：'+mvPct(item.value)+'<br>'+indexName+' PE：'+mvNum(item.pe)+'<br>'+mvRateLabel()+'：'+mvPct(item.sovereign_yield_pct); tip.style.left=Math.min(Math.max(e.clientX-box.left+12,8),box.width-210)+'px'; tip.style.top=Math.max(e.clientY-box.top+12,8)+'px'; tip.hidden=false;
}
function mvBeginDrag(e, boundary, min, max) {
  e.preventDefault(); e.stopPropagation(); var chart=document.querySelector('#mv-chart svg'), setting=mvActiveSetting(); if(!chart||!setting)return; chart.classList.add('mv-dragging'); chart.setPointerCapture(e.pointerId); var previewLower=Number(setting.lower),previewUpper=Number(setting.upper);
  function preview(ev) { var box=chart.getBoundingClientRect(), svgY=(ev.clientY-box.top)*320/box.height, ratio=Math.max(0,Math.min(1,(svgY-18)/266)), value=max-ratio*(max-min); if(boundary==='lower')previewLower=Math.min(Math.max(.0001,value),previewUpper-.0001); else previewUpper=Math.max(value,previewLower+.0001); var rows=mvLadder(previewLower,previewUpper); for(var i=0;i<7;i++){var yy=18+(max-rows[i].value)*266/(max-min); chart.querySelector('[data-ladder="'+i+'"]').setAttribute('y1',yy); chart.querySelector('[data-ladder="'+i+'"]').setAttribute('y2',yy); chart.querySelector('[data-ladder-label="'+i+'"]').setAttribute('y',yy-5); } var lowerY=18+(max-previewLower)*266/(max-min),upperY=18+(max-previewUpper)*266/(max-min); chart.querySelector('[data-boundary="lower"]').setAttribute('y1',lowerY); chart.querySelector('[data-boundary="lower"]').setAttribute('y2',lowerY); chart.querySelector('[data-boundary="upper"]').setAttribute('y1',upperY); chart.querySelector('[data-boundary="upper"]').setAttribute('y2',upperY); document.querySelector('#mv-chart .mv-tooltip').hidden=true; document.getElementById('mv-draft').hidden=false; document.getElementById('mv-draft').textContent=(boundary==='upper'?'最高':'最低')+'边界预览：'+mvNum(boundary==='upper'?previewUpper:previewLower,2)+'%'; }
  function done(ev) { chart.removeEventListener('pointermove',preview); chart.removeEventListener('pointerup',done); chart.removeEventListener('pointercancel',done); chart.classList.remove('mv-dragging'); if(Number.isFinite(previewLower)&&Number.isFinite(previewUpper)){mvState.draft={lower:Number(previewLower.toFixed(4)),upper:Number(previewUpper.toFixed(4)),version:(mvState.overview.setting||{version:0}).version}; document.getElementById('mv-cancel').disabled=false; document.getElementById('mv-save').disabled=false; mvRender();} }
  chart.addEventListener('pointermove',preview); chart.addEventListener('pointerup',done); chart.addEventListener('pointercancel',done); preview(e);
}
async function mvSaveDraft() {
  var d=mvState.draft,account=mvAccount(),button=document.getElementById('mv-save');
  if(!d){showToast('请先拖动边界后再保存');return;}
  if(!username){
    window.location.href=api('/login.html?redirect='+encodeURIComponent('/?main=market-volatility&metric=graham'));
    return;
  }
  if(!account){showToast('请先选择账户后再保存');return;}
  button.disabled=true;button.textContent='保存中...';
  try {
    var r=await fetch(api('/api/market-volatility/settings'),{
      method:'PUT',headers:{'Content-Type':'application/json'},credentials:'same-origin',
      body:JSON.stringify({market:mvState.market,benchmark:mvState.benchmark,lowerBoundaryPct:d.lower,upperBoundaryPct:d.upper,accountName:account,version:d.version})
    });
    var json=await r.json();if(!r.ok)throw new Error(json.error||r.status);
    mvState.draft=null;document.getElementById('mv-cancel').disabled=true;document.getElementById('mv-draft').hidden=true;
    await loadMarketVolatility();showToast('边界保存成功');
  } catch(e) {
    button.disabled=false;showToast('保存失败：'+(e.message||e));
  } finally {
    button.textContent='保存边界';
  }
}
