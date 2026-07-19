(function () {
  function renderStabilityChart(s, selectedRange) {
    var el=document.getElementById('stock-analysis-stability');if(!el)return;
    var allRows=(s.years||[]).slice().reverse(),historyMap={};(s.dividend_history||[]).forEach(function(r){var key=[r.end_date,r.cash_div,r.stk_bo_rate,r.stk_co_rate].join('|'),stage=/实施/.test(r.div_proc||'')?3:/股东大会通过/.test(r.div_proc||'')?2:/预案/.test(r.div_proc||'')?1:0,current=historyMap[key],currentStage=current?(/实施/.test(current.div_proc||'')?3:/股东大会通过/.test(current.div_proc||'')?2:/预案/.test(current.div_proc||'')?1:0):-1;if(!current||stage>currentStage||(stage===currentStage&&String(r.ann_date||'')>String(current.ann_date||'')))historyMap[key]=r;});var allHistory=Object.keys(historyMap).map(function(key){return historyMap[key]});
    function normalizeDate(v){return String(v||'').replace(/-/g,'').slice(0,8);}
    function displayDate(v){v=normalizeDate(v);return /^\d{8}$/.test(v)?v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8):(v||'--');}
    function inputDate(v){return displayDate(v)==='--'?'':displayDate(v);}
    function amountLabel(v){return Number.isFinite(v)?stockAnalysisNumber(v/1e8,2)+'亿元':'--';}
    var today=new Date(),endDefault=today.toISOString().slice(0,10),startDefault=(today.getFullYear()-10)+'-'+endDefault.slice(5);
    var range=selectedRange||{start:startDefault,end:endDefault,activeYears:10},startKey=normalizeDate(range.start),endKey=normalizeDate(range.end);
    var rows=allRows.filter(function(r){var d=r.year+'1231';return d>=startKey&&d<=endKey;});
    var history=allHistory.filter(function(r){var d=normalizeDate(r.ann_date||r.ex_date||r.end_date);return d>=startKey&&d<=endKey;});

    function controls(){return DateRangeControl.render({id:'stock-analysis-dividend-range',label:'查看分红时间',start:inputDate(range.start),end:inputDate(range.end),activeYears:range.activeYears,presets:[50,30,20,10,5,3]});}
    var totalDividend=history.reduce(function(sum,r){return sum+(Number.isFinite(Number(r.amount))?Number(r.amount):0);},0);
    var totalProfit=rows.reduce(function(sum,r){return sum+(Number.isFinite(Number(r.profit))?Number(r.profit):0);},0);
    var cumulativeRatio=totalProfit===0?null:totalDividend/totalProfit;
    function summary(){return '<div class="stock-analysis-period-summary"><div><span>筛选区间</span><strong>'+escapeHtml(displayDate(startKey))+' 至 '+escapeHtml(displayDate(endKey))+'</strong></div><div><span>累计分红金额</span><strong>'+escapeHtml(amountLabel(totalDividend))+'</strong></div><div><span>归母净利润合计</span><strong>'+escapeHtml(amountLabel(totalProfit))+'</strong></div><div><span>累计分红率</span><strong>'+escapeHtml(stockAnalysisPercent(cumulativeRatio))+'</strong></div></div>';}
    function historyTable(){
      var historyByYear={};history.forEach(function(r){(historyByYear[r.year]||(historyByYear[r.year]=[])).push(r);});
      var tableRows=[];rows.slice().reverse().forEach(function(yearRow){var records=historyByYear[yearRow.year]||[];if(records.length)tableRows=tableRows.concat(records);else tableRows.push({year:yearRow.year,end_date:yearRow.year+'1231',ann_date:yearRow.report_ann_date,div_proc:'未分红',stk_bo_rate:0,stk_co_rate:0,cash_div:0,amount:0,profit:yearRow.profit,payout_ratio:0,annual_payout_ratio:0,no_dividend:true});});
      if(!tableRows.length)return '<h4 class="stock-analysis-history-title">历史分红记录</h4><div class="stock-analysis-chart-empty">所选时间内暂无年度记录</div>';
      var counts={};tableRows.forEach(function(r){counts[r.year]=(counts[r.year]||0)+1;});var shown={};
      function perTen(v){return Number.isFinite(Number(v))?stockAnalysisNumber(Number(v)*10,3):'--';}
      function reportPeriod(v){if(!v)return '--';var m=String(v).slice(4,8),q=m==='0331'?'Q1':m==='0630'?'Q2':m==='0930'?'Q3':m==='1231'?'Q4':'';return String(v).slice(0,4)+(q?'-'+q:'');}
      var body=tableRows.map(function(r){var annual='';if(!shown[r.year]){shown[r.year]=true;annual='<td rowspan="'+counts[r.year]+'" class="stock-analysis-history-annual">'+escapeHtml(stockAnalysisPercent(r.annual_payout_ratio))+'</td>';}
        return '<tr class="'+(r.no_dividend?'stock-analysis-no-dividend':'')+'"><td>'+escapeHtml(displayDate(r.ann_date))+'</td><td>'+escapeHtml(perTen(r.stk_bo_rate))+'</td><td>'+escapeHtml(perTen(r.stk_co_rate))+'</td><td>'+escapeHtml(perTen(r.cash_div))+'元</td><td>'+escapeHtml(displayDate(r.record_date))+'</td><td>'+escapeHtml(displayDate(r.ex_date))+'</td><td>'+escapeHtml(r.div_proc||'--')+'</td><td>'+escapeHtml(reportPeriod(r.end_date))+'</td><td>'+escapeHtml(amountLabel(Number(r.amount)))+'</td><td>'+escapeHtml(amountLabel(Number(r.profit)))+'</td><td>'+escapeHtml(stockAnalysisPercent(r.payout_ratio))+'</td>'+annual+'</tr>';}).join('');
      return '<h4 class="stock-analysis-history-title">历史分红记录</h4><div class="stock-analysis-history-wrap"><table class="stock-analysis-table stock-analysis-history"><thead><tr><th rowspan="2">公告日期</th><th colspan="3">分红方案（每10股）</th><th rowspan="2">股权登记日</th><th rowspan="2">除权除息日</th><th rowspan="2">状态</th><th rowspan="2">财报时间</th><th rowspan="2">分红总金额</th><th rowspan="2">归母净利润</th><th rowspan="2">分红率</th><th rowspan="2">年度分红率</th></tr><tr><th>送股</th><th>转增</th><th>分红</th></tr></thead><tbody>'+body+'</tbody></table></div>';
    }
    function bindFilters(){
      DateRangeControl.bind(el,{id:'stock-analysis-dividend-range',onChange:function(nextRange){renderStabilityChart(s,nextRange);}});
    }
    if(!rows.length){el.innerHTML=controls()+summary()+'<div class="stock-analysis-chart-empty">所选时间内暂无年度数据</div>'+historyTable();bindFilters();return;}

    var yearWidth=rows.length<=10?74:rows.length<=20?48:rows.length<=30?30:26;
    var W=Math.max(900,rows.length*yearWidth+116),H=310,left=58,right=58,top=28,bottom=42,plotW=W-left-right,plotH=H-top-bottom,amounts=[];
    rows.forEach(function(r){if(Number.isFinite(Number(r.profit)))amounts.push(Number(r.profit));if(Number.isFinite(Number(r.dividend)))amounts.push(Number(r.dividend));});
    var minAmount=Math.min.apply(null,amounts.concat([0])),maxAmount=Math.max.apply(null,amounts.concat([0]));if(minAmount===maxAmount)maxAmount=minAmount+1;
    var ratios=rows.map(function(r){return Number(r.payout_ratio);}).filter(Number.isFinite),minRatio=Math.min.apply(null,ratios.concat([0])),maxRatio=Math.max.apply(null,ratios.concat([1]));if(minRatio===maxRatio)maxRatio=minRatio+1;
    function yAmount(v){return top+(maxAmount-v)/(maxAmount-minAmount)*plotH;}function yRatio(v){return top+(maxRatio-v)/(maxRatio-minRatio)*plotH;}
    var zeroY=yAmount(0),group=plotW/rows.length,barW=Math.max(5,Math.min(24,group*.28)),svg=[],hits=[];
    for(var g=0;g<=4;g++){var gy=top+plotH*g/4,av=maxAmount-(maxAmount-minAmount)*g/4,rv=maxRatio-(maxRatio-minRatio)*g/4;svg.push('<line class="grid" x1="'+left+'" y1="'+gy+'" x2="'+(W-right)+'" y2="'+gy+'"/><text x="'+(left-7)+'" y="'+(gy+4)+'" text-anchor="end">'+escapeHtml(stockAnalysisNumber(av/1e8,1))+'</text><text x="'+(W-right+7)+'" y="'+(gy+4)+'">'+escapeHtml(stockAnalysisNumber(rv*100,0))+'%</text>');}
    svg.push('<line class="axis" x1="'+left+'" y1="'+zeroY+'" x2="'+(W-right)+'" y2="'+zeroY+'"/>');var points=[];
    rows.forEach(function(r,i){var cx=left+group*(i+.5),profit=Number(r.profit),dividend=Number(r.dividend),ratio=Number(r.payout_ratio);function bar(value,x,cls){if(!Number.isFinite(value))return;var y=yAmount(value),h=Math.max(1,Math.abs(zeroY-y));svg.push('<rect class="'+cls+'" x="'+x+'" y="'+Math.min(y,zeroY)+'" width="'+barW+'" height="'+h+'"/>');}bar(profit,cx-barW-2,'profit');bar(dividend,cx+2,'dividend');svg.push('<text x="'+cx+'" y="'+(H-18)+'" text-anchor="middle">'+escapeHtml(r.year)+'</text>');if(Number.isFinite(ratio))points.push({x:cx,y:yRatio(ratio)});hits.push('<rect class="year-hit" data-year-index="'+i+'" x="'+(left+group*i)+'" y="'+top+'" width="'+group+'" height="'+plotH+'"/>');});
    if(points.length)svg.push('<polyline class="ratio" points="'+points.map(function(p){return p.x+','+p.y;}).join(' ')+'"/>'+points.map(function(p){return '<circle class="ratio-dot" cx="'+p.x+'" cy="'+p.y+'" r="4"/>';}).join(''));svg=svg.concat(hits);
    var legend='<div class="stock-analysis-chart-legend"><span><i style="background:#67b463"></i>归母净利润</span><span><i style="background:#ef6b67"></i>现金分红</span><span><i style="height:2px;background:#348bd4"></i>分红率</span></div>';
    var oldTooltip=document.querySelector('.stock-analysis-chart-tooltip[data-stock-analysis-tooltip]');if(oldTooltip)oldTooltip.remove();el.innerHTML=controls()+summary()+'<div class="stock-analysis-chart">'+legend+'<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;min-width:'+W+'px" role="img" aria-label="盈利与分红稳定性图表">'+svg.join('')+'</svg><div class="stock-analysis-chart-tooltip" data-stock-analysis-tooltip="1"></div></div>'+historyTable();bindFilters();
    var chart=el.querySelector('.stock-analysis-chart'),tooltip=el.querySelector('.stock-analysis-chart-tooltip');document.body.appendChild(tooltip);
    function tooltipHtml(r){var details=r.dividend_details||[],html='<strong>'+escapeHtml(r.year+'年报'+(r.report_ann_date?'（于'+displayDate(r.report_ann_date)+'公告）':''))+'</strong><div class="tip-row"><i class="tip-color" style="background:#67b463"></i><span>归母净利润：'+escapeHtml(amountLabel(Number(r.profit)))+'</span></div><div class="tip-row"><i class="tip-color" style="background:#ef6b67"></i><span>分红总金额：'+escapeHtml(amountLabel(Number(r.dividend)))+'</span></div>';if(details.length)details.forEach(function(d){html+='<div class="tip-detail">'+escapeHtml((d.div_proc?d.div_proc+' · ':'')+displayDate(d.ex_date||d.pay_date||d.ann_date)+' 每股分红'+stockAnalysisNumber(d.cash_div,4)+'元，总分红：'+amountLabel(Number(d.amount)))+'</div>';});else html+='<div class="tip-detail">本年度无现金分红记录</div>';return html+'<div class="tip-row"><i class="tip-color" style="background:#348bd4"></i><span>分红率：'+escapeHtml(stockAnalysisPercent(r.payout_ratio))+'</span></div>';}
    Array.prototype.forEach.call(el.querySelectorAll('.year-hit'),function(hit){hit.addEventListener('mouseenter',function(){tooltip.innerHTML=tooltipHtml(rows[Number(hit.getAttribute('data-year-index'))]);tooltip.style.display='block';});hit.addEventListener('mousemove',function(e){var x=Math.min(e.clientX+14,window.innerWidth-tooltip.offsetWidth-8),above=e.clientY-tooltip.offsetHeight-14,y=above>=8?above:Math.min(e.clientY+14,window.innerHeight-tooltip.offsetHeight-8);tooltip.style.left=Math.max(8,x)+'px';tooltip.style.top=Math.max(8,y)+'px';});hit.addEventListener('mouseleave',function(){tooltip.style.display='none';});});
  }
  window.stockAnalysisRenderStability=renderStabilityChart;
})();
