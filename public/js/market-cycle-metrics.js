var mvcState = { metric: 'pe', market: 'CN', benchmark: 'CSI300', range: '20y', overview: null, history: [], loading: false, ready: false };
var mvcMeta = {
  pe: { label: '市盈率（PE-TTM）', suffix: ' 倍', lowerIsCheaper: true },
  pb: { label: '市净率（PB）', suffix: ' 倍', lowerIsCheaper: true },
  m2_market_cap: { label: 'M2与股市市值比', suffix: '%', lowerIsCheaper: false }
};
function mvcNum(value, digits) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits == null ? 2 : digits) : '--'; }
function mvcEsc(value) { return typeof escapeHtml === 'function' ? escapeHtml(value) : String(value); }
function mvcAccount() { return typeof username === 'string' && username && typeof currentAccount === 'string' ? currentAccount : ''; }
function mvcFormat(value) { var meta=mvcMeta[mvcState.metric]; return Number.isFinite(Number(value))?mvcNum(value,2)+meta.suffix:'--'; }
function mvcLadder(lower, upper) {
  var low=Number(lower),high=Number(upper),rows=[]; if(!Number.isFinite(low)||!Number.isFinite(high)||low<=0||high<=low)return rows;
  for(var i=0;i<7;i++)rows.push({value:low+(high-low)*i/6,position:mvcMeta[mvcState.metric].lowerIsCheaper?80-i*10:20+i*10});
  return rows;
}
function mvcRecommended(value, lower, upper) {
  var rows=mvcLadder(lower,upper),number=Number(value); if(!rows.length||!Number.isFinite(number))return null;
  if(mvcMeta[mvcState.metric].lowerIsCheaper){for(var i=0;i<rows.length;i++)if(number<=rows[i].value)return rows[i].position;return 20;}
  for(var j=rows.length-1;j>=0;j--)if(number>=rows[j].value)return rows[j].position; return 20;
}
function mvcIndexLevel(threshold) {
  var overview=mvcState.overview||{},current=overview.current||{},point=overview.indexPoint,value=Number(current.value),target=Number(threshold);
  if(!point||!Number.isFinite(Number(point.value))||!(value>0)||!(target>0))return null;
  return mvcState.metric==='m2_market_cap'
    ? Number(point.value)*value/target
    : Number(point.value)*target/value;
}
function mvcInit() {
  if(mvcState.ready)return; mvcState.ready=true;
  document.querySelectorAll('[data-mvc-market]').forEach(function(button){button.onclick=function(){mvcState.market=button.dataset.mvcMarket;mvcState.benchmark=mvcState.market==='HK'?'HSI':'CSI300';mvcLoad();};});
  document.querySelectorAll('[data-mvc-benchmark]').forEach(function(button){button.onclick=function(){mvcState.benchmark=button.dataset.mvcBenchmark;mvcLoad();};});
  document.getElementById('mvc-range').onchange=function(event){mvcState.range=event.target.value;mvcLoad();};
  document.getElementById('mvc-lower').oninput=mvcRenderDraft;
  document.getElementById('mvc-upper').oninput=mvcRenderDraft;
  document.getElementById('mvc-reset').onclick=function(){mvcFillBoundaries();mvcRenderDraft();};
  document.getElementById('mvc-save').onclick=mvcSave;
}
function switchMarketCycleMetric(metric) {
  document.querySelectorAll('[data-mv-metric]').forEach(function(button){button.classList.toggle('active',button.dataset.mvMetric===metric);});
  var graham=metric==='graham'; document.getElementById('mv-sub-graham').hidden=!graham; document.getElementById('mv-sub-metric').hidden=graham;
  if(graham){loadMarketVolatility();return;}
  mvcInit(); mvcState.metric=metric;
  if(metric==='m2_market_cap'){mvcState.market='CN';mvcState.benchmark='ASHARE';}
  else if(metric==='pb'&&mvcState.benchmark==='CSIALL')mvcState.benchmark='CSI300';
  else if(mvcState.market==='HK')mvcState.benchmark='HSI';
  else if(mvcState.benchmark==='ASHARE'||mvcState.benchmark==='HSI')mvcState.benchmark='CSI300';
  mvcLoad();
}
async function mvcLoad() {
  if(mvcState.loading)return; mvcState.loading=true; var status=document.getElementById('mvc-status');status.textContent='正在读取数据...';
  try{
    var qs='metric='+encodeURIComponent(mvcState.metric)+'&market='+encodeURIComponent(mvcState.market)+'&benchmark='+encodeURIComponent(mvcState.benchmark);
    var responses=await Promise.all([
      fetch(api('/api/market-volatility/overview?'+qs+'&account='+encodeURIComponent(mvcAccount()))),
      fetch(api('/api/market-volatility/history?'+qs+'&range='+encodeURIComponent(mvcState.range)))
    ]);
    if(!responses[0].ok||!responses[1].ok)throw new Error('接口返回 '+(!responses[0].ok?responses[0].status:responses[1].status));
    mvcState.overview=await responses[0].json();mvcState.history=(await responses[1].json()).history||[];mvcRender();
  }catch(error){status.textContent='数据加载失败：'+(error.message||error);document.getElementById('mvc-content').hidden=true;}
  finally{mvcState.loading=false;}
}
function mvcRenderControls() {
  var isM2=mvcState.metric==='m2_market_cap',marketBox=document.getElementById('mvc-market-controls'),benchmarkBox=document.getElementById('mvc-benchmark-controls');
  marketBox.hidden=isM2; benchmarkBox.hidden=isM2||mvcState.market==='HK';
  document.querySelectorAll('[data-mvc-market]').forEach(function(button){button.classList.toggle('active',button.dataset.mvcMarket===mvcState.market);});
  document.querySelectorAll('[data-mvc-benchmark]').forEach(function(button){
    button.hidden=mvcState.metric==='pb'&&button.dataset.mvcBenchmark==='CSIALL';
    button.classList.toggle('active',button.dataset.mvcBenchmark===mvcState.benchmark);
  });
}
function mvcRender() {
  mvcRenderControls(); var overview=mvcState.overview||{},current=overview.current,status=document.getElementById('mvc-status'),content=document.getElementById('mvc-content');
  if(!current){content.hidden=true;status.textContent=mvcState.metric==='pb'&&mvcState.benchmark==='CSIALL'?'中证指数官网目前仅提供中证全指PE历史数据，未提供PB历史数据。':'数据源尚未完成首次回填，当前不生成仓位信号。';document.getElementById('mv-updated').textContent='暂无可用数据';return;}
  content.hidden=false;
  status.textContent=overview.setting&&overview.setting.isDefault?'当前使用历史20%与80%分位作为默认边界；可调整预览，登录后可保存。':'';
  document.getElementById('mv-updated').textContent='数据日期：'+current.date;
  document.getElementById('mvc-value-label').textContent=mvcMeta[mvcState.metric].label;
  document.getElementById('mvc-value').textContent=mvcFormat(current.value);
  document.getElementById('mvc-percentile').textContent=mvcNum(overview.stats&&overview.stats.percentile,2)+'%';
  document.getElementById('mvc-p20').textContent=mvcFormat(overview.stats&&overview.stats.p20);
  document.getElementById('mvc-p50').textContent=mvcFormat(overview.stats&&overview.stats.p50);
  document.getElementById('mvc-p80').textContent=mvcFormat(overview.stats&&overview.stats.p80);
  document.getElementById('mvc-recommended').textContent=overview.recommendedPosition==null?'--':overview.recommendedPosition+'%';
  var actual=document.getElementById('mvc-actual');actual.textContent=overview.actualPosition==null?'--':mvcNum(overview.actualPosition,2)+'%';
  if(typeof username!=='string'||!username)actual.innerHTML='<a class="mv-login-link" href="'+api('/login.html?redirect='+encodeURIComponent('/?main=market-volatility'))+'">登录</a>';
  var deviation=overview.deviation;document.getElementById('mvc-deviation').textContent=deviation?(deviation.value>0?'高出 ':deviation.value<0?'低出 ':'')+Math.abs(deviation.value)+' 个百分点（'+deviation.status+'）':'--';
  var detail=document.getElementById('mvc-detail');
  if(mvcState.metric==='m2_market_cap'){
    detail.innerHTML='M2：'+mvcNum(current.m2_100m_yuan,2)+'亿元 · A股总市值：'+mvcNum(current.total_market_cap_100m_yuan,2)+'亿元 · M2数据月份：'+mvcEsc(String(current.m2_month||'').slice(0,7))+
      '<br>数据与口径：<a href="https://data.stats.gov.cn/" target="_blank" rel="noopener">国家统计局</a>；财政统计参考：<a href="https://gks.mof.gov.cn/tongjishuju/" target="_blank" rel="noopener">财政部国库司</a>。'+
      '<br>M0＝金融系统外流通的货币；M1在2025年前为M0＋企事业单位活期存款，2025年起增加个人活期存款和非银行支付机构客户备付金；M2＝M1＋准货币。';
  }else detail.textContent='分位数按该指数全部可用历史数据计算，不跨市场直接比较绝对值。';
  mvcFillBoundaries();mvcRenderDraft();
}
function mvcFillBoundaries(){var setting=mvcState.overview&&mvcState.overview.setting;if(!setting)return;document.getElementById('mvc-lower').value=mvcNum(setting.lower,4);document.getElementById('mvc-upper').value=mvcNum(setting.upper,4);}
function mvcRenderDraft(){
  var lower=Number(document.getElementById('mvc-lower').value),upper=Number(document.getElementById('mvc-upper').value),valid=lower>0&&upper>lower;
  document.getElementById('mvc-save').disabled=!valid||typeof username!=='string'||!username;
  mvcRenderLadder(valid?lower:null,valid?upper:null);mvcRenderChart(valid?lower:null,valid?upper:null);
  if(valid&&mvcState.overview&&mvcState.overview.current){var recommended=mvcRecommended(mvcState.overview.current.value,lower,upper);document.getElementById('mvc-recommended').textContent=recommended==null?'--':recommended+'%';}
}
function mvcRenderLadder(lower,upper){
  var root=document.getElementById('mvc-ladder'),rows=mvcLadder(lower,upper);if(!rows.length){root.innerHTML='<div class="mv-empty">请输入有效边界</div>';return;}
  var indexName=(mvcState.overview&&mvcState.overview.indexName)||'指数';
  root.innerHTML='<table><thead><tr><th>'+mvcEsc(mvcMeta[mvcState.metric].label)+'阈值</th><th class="text-right">对应'+mvcEsc(indexName)+'点位</th><th class="text-right">建议股票仓位</th></tr></thead><tbody>'+rows.map(function(row){var level=mvcIndexLevel(row.value);return '<tr><td>'+mvcFormat(row.value)+'</td><td class="text-right">'+mvcNum(level,2)+'</td><td class="text-right">'+row.position+'%</td></tr>';}).join('')+'</tbody></table><div class="mv-ladder-note">对应点位按当前'+mvcEsc(indexName)+'点位和当前指标值等比例换算，仅用于估值参考。</div>';
}
function mvcRenderChart(lower,upper){
  var root=document.getElementById('mvc-chart'),source=mvcState.history||[];if(!source.length){root.innerHTML='<div class="mv-empty">暂无历史数据</div>';return;}
  var step=Math.max(1,Math.ceil(source.length/1000)),data=source.filter(function(_,index){return index%step===0||index===source.length-1;});
  var values=data.map(function(row){return Number(row.value);}).filter(Number.isFinite);if(Number.isFinite(lower))values.push(lower);if(Number.isFinite(upper))values.push(upper);
  var min=Math.min.apply(null,values),max=Math.max.apply(null,values),pad=Math.max((max-min)*.1,.01);min-=pad;max+=pad;
  var W=1000,H=320,L=58,R=20,T=18,B=36,ph=H-T-B;function x(i){return L+i*(W-L-R)/Math.max(data.length-1,1)}function y(v){return T+(max-v)*ph/Math.max(max-min,.000001)}
  var path=data.map(function(row,index){return (index?'L':'M')+x(index).toFixed(1)+' '+y(Number(row.value)).toFixed(1);}).join(' '),svg=[];
  for(var grid=0;grid<5;grid++){var gy=T+grid*ph/4;svg.push('<line class="mv-grid" x1="'+L+'" y1="'+gy+'" x2="'+(W-R)+'" y2="'+gy+'"/><text x="4" y="'+(gy+4)+'" class="mv-axis">'+mvcNum(max-grid*(max-min)/4,2)+'</text>');}
  svg.push('<path class="mv-line" d="'+path+'"/>');
  [{key:'lower',value:lower,label:'最低边界'},{key:'upper',value:upper,label:'最高边界'}].forEach(function(boundary){if(!Number.isFinite(boundary.value))return;var yy=y(boundary.value);svg.push('<line class="mv-boundary '+boundary.key+'" data-mvc-boundary-line="'+boundary.key+'" x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'"/><line class="mv-boundary-hit" data-mvc-boundary="'+boundary.key+'" x1="'+L+'" y1="'+yy+'" x2="'+(W-R)+'" y2="'+yy+'"/><text data-mvc-boundary-label="'+boundary.key+'" x="'+(W-R-4)+'" y="'+(yy-5)+'" text-anchor="end" class="mv-label">'+boundary.label+'</text>');});
  [0,Math.floor((data.length-1)/2),data.length-1].forEach(function(index){svg.push('<text x="'+x(index)+'" y="'+(H-10)+'" text-anchor="middle" class="mv-axis">'+mvcEsc(String(data[index].date).slice(0,7))+'</text>');});
  root.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+mvcEsc(mvcMeta[mvcState.metric].label)+'历史图">'+svg.join('')+'</svg><div class="mv-tooltip" hidden></div>';
  var chart=root.querySelector('svg');
  root.querySelectorAll('[data-mvc-boundary]').forEach(function(line){line.addEventListener('pointerdown',function(event){mvcBeginDrag(event,line.dataset.mvcBoundary,min,max);});});
  chart.addEventListener('pointermove',function(event){mvcShowTooltip(event,chart,data,L,R,W);});
  chart.addEventListener('pointerleave',function(){var tooltip=root.querySelector('.mv-tooltip');if(tooltip)tooltip.hidden=true;});
}
function mvcShowTooltip(event,chart,data,left,right,width){
  if(!data.length||chart.classList.contains('mv-dragging'))return;
  var box=chart.getBoundingClientRect(),svgX=(event.clientX-box.left)*width/box.width,ratio=Math.max(0,Math.min(1,(svgX-left)/(width-left-right))),index=Math.round(ratio*Math.max(data.length-1,1)),item=data[index],tooltip=document.querySelector('#mvc-chart .mv-tooltip');
  if(!item||!tooltip)return;
  var lines=['<strong>'+mvcEsc(item.date)+'</strong>',mvcEsc(mvcMeta[mvcState.metric].label)+'：'+mvcFormat(item.value)];
  if(mvcState.metric==='m2_market_cap'){
    lines.push('M2：'+mvcNum(item.m2_100m_yuan,2)+'亿元');
    lines.push('A股总市值：'+mvcNum(item.total_market_cap_100m_yuan,2)+'亿元');
  }else if(Number.isFinite(Number(item.close))){
    lines.push(mvcEsc((mvcState.overview&&mvcState.overview.indexName)||'指数')+'：'+mvcNum(item.close,2)+'点');
  }
  tooltip.innerHTML=lines.join('<br>');tooltip.style.left=Math.min(Math.max(event.clientX-box.left+12,8),box.width-220)+'px';tooltip.style.top=Math.max(event.clientY-box.top+12,8)+'px';tooltip.hidden=false;
}
function mvcBeginDrag(event,boundary,min,max){
  var chart=document.querySelector('#mvc-chart svg'),lowerInput=document.getElementById('mvc-lower'),upperInput=document.getElementById('mvc-upper');
  if(!chart)return;event.preventDefault();event.stopPropagation();chart.classList.add('mv-dragging');chart.setPointerCapture(event.pointerId);var tooltip=document.querySelector('#mvc-chart .mv-tooltip');if(tooltip)tooltip.hidden=true;
  var lower=Number(lowerInput.value),upper=Number(upperInput.value);
  function move(pointerEvent){
    var box=chart.getBoundingClientRect(),svgY=(pointerEvent.clientY-box.top)*320/box.height,ratio=Math.max(0,Math.min(1,(svgY-18)/266)),value=max-ratio*(max-min);
    if(boundary==='lower')lower=Math.min(Math.max(.000001,value),upper-.000001);else upper=Math.max(Math.min(value,max),lower+.000001);
    var active=boundary==='lower'?lower:upper,yy=18+(max-active)*266/Math.max(max-min,.000001);
    chart.querySelector('[data-mvc-boundary-line="'+boundary+'"]').setAttribute('y1',yy);chart.querySelector('[data-mvc-boundary-line="'+boundary+'"]').setAttribute('y2',yy);
    chart.querySelector('[data-mvc-boundary="'+boundary+'"]').setAttribute('y1',yy);chart.querySelector('[data-mvc-boundary="'+boundary+'"]').setAttribute('y2',yy);
    chart.querySelector('[data-mvc-boundary-label="'+boundary+'"]').setAttribute('y',yy-5);
    lowerInput.value=lower.toFixed(4);upperInput.value=upper.toFixed(4);mvcRenderLadder(lower,upper);
    var current=mvcState.overview&&mvcState.overview.current,recommended=current&&mvcRecommended(current.value,lower,upper);document.getElementById('mvc-recommended').textContent=recommended==null?'--':recommended+'%';
    document.getElementById('mvc-save').disabled=typeof username!=='string'||!username;
  }
  function done(pointerEvent){
    chart.removeEventListener('pointermove',move);chart.removeEventListener('pointerup',done);chart.removeEventListener('pointercancel',done);chart.classList.remove('mv-dragging');
    if(chart.hasPointerCapture(pointerEvent.pointerId))chart.releasePointerCapture(pointerEvent.pointerId);mvcRenderDraft();
  }
  chart.addEventListener('pointermove',move);chart.addEventListener('pointerup',done);chart.addEventListener('pointercancel',done);move(event);
}
async function mvcSave(){
  var setting=mvcState.overview&&mvcState.overview.setting,lower=Number(document.getElementById('mvc-lower').value),upper=Number(document.getElementById('mvc-upper').value);
  try{
    var response=await fetch(api('/api/market-volatility/settings'),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({metric:mvcState.metric,market:mvcState.market,benchmark:mvcState.benchmark,accountName:mvcAccount(),lowerBoundaryPct:lower,upperBoundaryPct:upper,version:setting?setting.version:0})});
    var json=await response.json();if(!response.ok)throw new Error(json.error||response.status);await mvcLoad();
  }catch(error){showToast('保存失败：'+(error.message||error));}
}
