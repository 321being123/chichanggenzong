var stockAnalysisState = { loaded:false, stocks:[], selected:'', data:null, loading:false };

function stockAnalysisNumber(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 2 : digits });
}
function stockAnalysisMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  var n = Number(value), abs = Math.abs(n);
  if (abs >= 1e8) return stockAnalysisNumber(n / 1e8, 2) + '亿元';
  if (abs >= 1e4) return stockAnalysisNumber(n / 1e4, 2) + '万元';
  return stockAnalysisNumber(n, 2) + '元';
}
function stockAnalysisPercent(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '--' : stockAnalysisNumber(Number(value) * 100, 2) + '%';
}
function stockAnalysisDate(value) {
  var text=String(value||'').replace(/-/g,'').slice(0,8);
  return /^\d{8}$/.test(text)?text.slice(0,4)+'-'+text.slice(4,6)+'-'+text.slice(6,8):'--';
}
function stockAnalysisMetric(label, value, note, negative) {
  var cls = negative ? ' class="stock-analysis-negative"' : '';
  return '<div class="stock-analysis-metric"><span>' + escapeHtml(label) + '</span><strong' + cls + '>' + escapeHtml(String(value)) + '</strong>' +
    (note ? '<small>' + escapeHtml(note) + '</small>' : '') + '</div>';
}
function stockAnalysisSetMessage(text, error) {
  var el = document.getElementById('stock-analysis-message');
  if (!el) return;
  el.style.display = text ? 'block' : 'none';
  el.style.color = error ? '#b42318' : '#777';
  el.textContent = text || '';
}

async function loadStockAnalysis(force) {
  if (window.securityAnalysisLoadList) window.securityAnalysisLoadList(force);
  if (stockAnalysisState.loaded && !force) return;
  try {
    var response = await fetch(api('/api/stock-analysis/stocks'));
    if (!response.ok) throw new Error((await response.json()).error || '股票列表加载失败');
    var payload = await response.json();
    stockAnalysisState.stocks = payload.data || [];
    stockAnalysisState.loaded = true;
    var select = document.getElementById('stock-analysis-select');
    if (select) {
      select.innerHTML = '<option value="">选择持仓或自选股</option>' + stockAnalysisState.stocks.map(function(row) {
        var tags = (row.held ? '持仓' : '') + (row.watchlisted ? (row.held ? ' / 自选' : '自选') : '');
        return '<option value="' + escapeHtml(row.ts_code) + '">' + escapeHtml((row.name || row.ts_code) + ' · ' + row.ts_code + (tags ? '（' + tags + '）' : '')) + '</option>';
      }).join('');
      if (stockAnalysisState.selected) select.value = stockAnalysisState.selected;
    }
  } catch (error) { stockAnalysisSetMessage(error.message || String(error), true); }
}

async function stockAnalysisSelect(tsCode) {
  stockAnalysisState.selected = tsCode || '';
  stockAnalysisState.data = null;
  if (typeof stockAnalysisSwitchView === 'function') stockAnalysisSwitchView('analysis');
  var remove = document.getElementById('stock-analysis-remove');
  var row = stockAnalysisState.stocks.find(function(item) { return item.ts_code === tsCode; });
  if (remove) remove.style.display = row && row.watchlisted ? '' : 'none';
  if (!tsCode) { stockAnalysisSetMessage('从持仓或自选股中选择一只股票开始分析。'); document.getElementById('stock-analysis-content').style.display='none'; return; }
  stockAnalysisSetMessage('正在读取分析结果...');
  try {
    var response = await fetch(api('/api/stock-analysis/' + encodeURIComponent(tsCode)));
    if (response.status === 404) return stockAnalysisRefresh();
    var payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '分析读取失败');
    stockAnalysisRender(payload);
  } catch (error) { stockAnalysisSetMessage(error.message || String(error), true); }
}

async function stockAnalysisRefresh() {
  var tsCode = stockAnalysisState.selected;
  if (!tsCode || stockAnalysisState.loading) return;
  stockAnalysisState.loading = true;
  var button = document.getElementById('stock-analysis-refresh');
  if (button) { button.disabled = true; button.textContent = '刷新中...'; }
  stockAnalysisSetMessage('首次建档会抓取上市以来财报及历史估值，请稍候...');
  try {
    if (typeof stockAnalysisInvalidateStatements === 'function') stockAnalysisInvalidateStatements(tsCode);
    var response = await fetch(api('/api/stock-analysis/' + encodeURIComponent(tsCode) + '/refresh'), { method:'POST' });
    var payload = await response.json();
    var analysis = payload.analysis;
    if (!response.ok && !analysis) throw new Error(payload.error || '刷新失败');
    if (analysis) stockAnalysisRender(analysis);
    if (!response.ok && payload.error) showToast('刷新失败，已显示上一份有效数据：' + payload.error);
  } catch (error) { stockAnalysisSetMessage(error.message || String(error), true); }
  finally { stockAnalysisState.loading = false; if (button) { button.disabled=false; button.textContent='刷新数据'; } }
}

async function stockAnalysisAddWatchlist() {
  var input = document.getElementById('stock-analysis-code');
  var code = (input && input.value || '').trim();
  if (!code) return showToast('请输入股票代码');
  stockAnalysisSetMessage('正在添加自选股并建立财务档案...');
  try {
    var response = await fetch(api('/api/stock-analysis/watchlist'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ts_code:code}) });
    var payload = await response.json();
    if (!response.ok && response.status !== 202) throw new Error(payload.error || '添加失败');
    stockAnalysisState.loaded = false;
    await loadStockAnalysis(true);
    stockAnalysisState.selected = payload.stock.ts_code;
    var select = document.getElementById('stock-analysis-select'); if (select) select.value = payload.stock.ts_code;
    var remove = document.getElementById('stock-analysis-remove'); if (remove) remove.style.display = '';
    if (input) input.value = '';
    if (payload.analysis) stockAnalysisRender(payload.analysis); else await stockAnalysisSelect(payload.stock.ts_code);
    if (payload.warning) showToast('已加入自选，建档稍后重试：' + payload.warning);
  } catch (error) { stockAnalysisSetMessage(error.message || String(error), true); }
}

async function stockAnalysisRemoveWatchlist() {
  if (!stockAnalysisState.selected) return;
  try {
    var response = await fetch(api('/api/stock-analysis/watchlist/' + encodeURIComponent(stockAnalysisState.selected)), { method:'DELETE' });
    var payload = await response.json(); if (!response.ok) throw new Error(payload.error || '删除失败');
    stockAnalysisState.loaded = false; stockAnalysisState.selected = ''; stockAnalysisState.data = null;
    await loadStockAnalysis(true); stockAnalysisSelect(''); showToast('已移出自选股');
  } catch (error) { showToast(error.message || String(error)); }
}

function stockAnalysisRender(d) {
  stockAnalysisState.data = d; stockAnalysisSetMessage('');
  var bondContent = document.getElementById('bond-analysis-content'); if (bondContent) bondContent.style.display = 'none';
  var content = document.getElementById('stock-analysis-content'); if (content) content.style.display = 'block';
  var updated = document.getElementById('stock-analysis-updated');
  if (updated) updated.textContent = '数据日期：' + (d.as_of || '--') + (d.quote && d.quote.quote_time ? ' · 行情：' + String(d.quote.quote_time).replace('T',' ').slice(0,19) : '');
  var summary = document.getElementById('stock-analysis-summary');
  var industryInfo=d.industry_info||{},controller=d.actual_controller||{},priceUnit=d.quote&&d.quote.unit||'元';
  var industryLabel=(industryInfo.level&&industryInfo.level!=='未标注级别'?(industryInfo.system||'')+industryInfo.level+' · ':'')+(industryInfo.name||d.industry||'--');
  if (summary) summary.innerHTML = '<strong>' + escapeHtml(d.name || d.ts_code) + '</strong><span>' + escapeHtml(d.ts_code || '') + '</span><span>当前价：' + escapeHtml(stockAnalysisNumber(d.quote && d.quote.price, 3)) + ' ' + escapeHtml(priceUnit) + '</span>';
  var v=d.valuation||{}, valuation=document.getElementById('stock-analysis-valuation');
  var report=d.latest_report||{},forecast=d.performance_forecast;
  var forecastValue=forecast?(forecast.type||'业绩预告'):'暂无有效业绩预告';
  var forecastNote=forecast?('报告期 '+stockAnalysisDate(forecast.end_date)+(forecast.profit_min!=null||forecast.profit_max!=null?' · 利润区间 '+stockAnalysisMoney(forecast.profit_min)+' 至 '+stockAnalysisMoney(forecast.profit_max):'')):'以最新已披露数据为准';
  function infoGroup(title,items){return '<div class="stock-analysis-info-group"><h4>'+escapeHtml(title)+'</h4><div class="stock-analysis-grid">'+items.join('')+'</div></div>'}
  if (valuation) valuation.innerHTML = [
    infoGroup('公司与证券资料',[
      stockAnalysisMetric('所属行业',industryLabel,'行业体系与级别以数据源为准'),
      stockAnalysisMetric('上市日期',stockAnalysisDate(d.list_date),'年-月-日'),
      stockAnalysisMetric('实际控制人',controller.name||'待核实',controller.name?(controller.type||'类型待核实'):'暂无可靠数据')
    ]),
    infoGroup('估值水平',[
    stockAnalysisMetric('滚动市盈率',stockAnalysisNumber(v.pe_ttm,2),'最近12个月利润',v.pe_ttm<0),
    stockAnalysisMetric('静态市盈率',stockAnalysisNumber(v.pe_static,2),'最新完整年报',v.pe_static<0),
    stockAnalysisMetric('动态市盈率',stockAnalysisNumber(v.pe_forecast,2),'业绩预告区间中值',v.pe_forecast<0),
    stockAnalysisMetric('三年平均市盈率',stockAnalysisNumber(v.pe_three_year_avg,2),'最近三个年报平均利润',v.pe_three_year_avg<0),
    stockAnalysisMetric('市净率',stockAnalysisNumber(v.pb,2),'最新归母净资产',v.pb<0),
    stockAnalysisMetric('扣除商誉市净率',stockAnalysisNumber(v.pb_ex_goodwill,2),'净资产扣除商誉',v.pb_ex_goodwill<0)
    ]),
    infoGroup('收益、盈利与分红',[
    stockAnalysisMetric('股息率',stockAnalysisPercent(v.dividend_yield),'最近12个月税前现金分红'),
    stockAnalysisMetric('分红率',stockAnalysisPercent(v.payout_ratio),'最新年度'),
    stockAnalysisMetric('累计分红率',stockAnalysisPercent(v.cumulative_payout_ratio),'历史累计分红 '+stockAnalysisMoney(v.cumulative_dividend)+' ÷ 历史累计盈利 '+stockAnalysisMoney(v.cumulative_profit)),
    stockAnalysisMetric('平均股息率',stockAnalysisPercent(v.average_dividend_yield),'累计分红率 × 最近12个月归母净利润 ÷ 当前市值'),
    stockAnalysisMetric('ROE',v.roe==null?'--':stockAnalysisNumber(v.roe,2)+'%','最新完整年报'),
    stockAnalysisMetric('ROA',v.roa==null?'--':stockAnalysisNumber(v.roa,2)+'%',v.roa_source||'最新完整年报'),
    stockAnalysisMetric('上市至今年化收益率',stockAnalysisPercent(v.annualized_return_since_listing),'复权价格 · 起始 '+stockAnalysisDate(v.return_start_date),v.annualized_return_since_listing<0)
    ]),
    infoGroup('市值结构',[
    stockAnalysisMetric('总市值',stockAnalysisMoney(v.market_cap),'当前价格 × 总股本'),
    stockAnalysisMetric('A股市值',stockAnalysisMoney(v.a_share_market_cap),'A股价格 × A股总股本'),
    stockAnalysisMetric('流通市值',stockAnalysisMoney(v.circulating_market_cap),'当前价格 × 流通股本'),
    stockAnalysisMetric('自由流通市值',stockAnalysisMoney(v.free_float_market_cap),'当前价格 × 自由流通股本')
    ]),
    infoGroup('报告与业绩预期',[
    stockAnalysisMetric('最新报告',stockAnalysisDate(report.end_date)+' '+(report.type||''),'公告日期 '+stockAnalysisDate(report.ann_date)),
    stockAnalysisMetric('业绩预期',forecastValue,forecastNote)
    ])
  ].join('');
  stockAnalysisRenderStability(d.stability||{}); stockAnalysisRenderPercentiles(d.percentiles||{});
  stockAnalysisRenderGrowth(d.growth||{}); stockAnalysisRenderSafety(d.safety||{}); stockAnalysisRenderCashflow(d.cashflow||{}); stockAnalysisRenderEvents(d.events||[]);
  var quality=document.getElementById('stock-analysis-quality'), q=d.data_quality||{};
  if(quality) quality.textContent='利润表 '+(q.income_rows||0)+' 条 · 资产负债表 '+(q.balance_rows||0)+' 条 · 现金流量表 '+(q.cashflow_rows||0)+' 条 · 估值 '+(q.valuation_rows||0)+' 日。'+(q.research_notice||'');
}

function stockAnalysisRenderStability(s){var el=document.getElementById('stock-analysis-stability');if(!el)return;var reason=escapeHtml(s.reason||'');if(s.reason_url)reason+=' <a href="'+escapeHtml(s.reason_url)+'" target="_blank" rel="noopener noreferrer">查看公告</a>';el.innerHTML='<table class="stock-analysis-table"><thead><tr><th>项目</th><th>结论</th><th>异常年度</th><th>说明</th></tr></thead><tbody><tr><td>最近十年持续盈利</td><td>'+(s.profitable_each_year?'是':'否')+'</td><td>'+escapeHtml((s.no_profit_years||[]).join('、')||'无')+'</td><td>'+reason+'</td></tr><tr><td>最近十年持续现金分红</td><td>'+(s.dividend_each_year?'是':'否')+'</td><td>'+escapeHtml((s.no_dividend_years||[]).join('、')||'无')+'</td><td>'+reason+'</td></tr></tbody></table>'}
function stockAnalysisRenderPercentiles(p){var note=document.getElementById('stock-analysis-percentile-note');if(note)note.textContent=p.note||'';if(window.stockAnalysisRenderValuationChart)window.stockAnalysisRenderValuationChart(p)}
function stockAnalysisRenderGrowth(g){var el=document.getElementById('stock-analysis-growth');if(!el)return;var rows=[];var t=g.ten_year_average||{};rows.push(['十年三年均值增长',stockAnalysisPercent(t.value),t.method||'']);[3,5,10].forEach(function(n){var p=(g.periods||{})[n]||{};rows.push(['归母净利润近'+n+'年',stockAnalysisPercent(p.parent&&p.parent.value),p.parent&&p.parent.method||'']);rows.push(['扣非净利润近'+n+'年',stockAnalysisPercent(p.deducted&&p.deducted.value),p.deducted&&p.deducted.method||''])});var i=g.latest_interim_yoy;if(i){rows.push(['最新报告期归母同比',stockAnalysisPercent(i.parent),i.end_date||'']);rows.push(['最新报告期扣非同比',stockAnalysisPercent(i.deducted),i.end_date||''])}el.innerHTML='<table class="stock-analysis-table"><thead><tr><th>项目</th><th>结果</th><th>口径</th></tr></thead><tbody>'+rows.map(function(r){return '<tr><td>'+escapeHtml(r[0])+'</td><td>'+escapeHtml(r[1])+'</td><td>'+escapeHtml(r[2])+'</td></tr>'}).join('')+'</tbody></table>'}
function stockAnalysisRenderSafety(s){var el=document.getElementById('stock-analysis-safety');if(el)el.innerHTML=stockAnalysisMetric('净现金安全额',stockAnalysisMoney(s.net_cash),s.report_end_date||'')+stockAnalysisMetric('利息保障倍数',stockAnalysisNumber(s.interest_coverage,2),'EBIT ÷ 利息费用',s.interest_coverage<0)+stockAnalysisMetric('市值 / 总负债',stockAnalysisNumber(s.market_cap_to_liability,2),s.industry_note||'',s.market_cap_to_liability<0)}
function stockAnalysisRenderCashflow(c){var el=document.getElementById('stock-analysis-cashflow');if(!el)return;var y=c.latest_year||{},a3=c.average_3y||{},a5=c.average_5y||{};el.innerHTML=stockAnalysisMetric('最近一年经营现金流',stockAnalysisMoney(y.operating),y.end_date||'')+stockAnalysisMetric('最近一年自由现金流',stockAnalysisMoney(y.free),'经营现金流－资本开支')+stockAnalysisMetric('近三年平均经营现金流',stockAnalysisMoney(a3.operating),'')+stockAnalysisMetric('近三年平均自由现金流',stockAnalysisMoney(a3.free),'')+stockAnalysisMetric('近五年平均经营现金流',stockAnalysisMoney(a5.operating),'')+stockAnalysisMetric('近五年平均自由现金流',stockAnalysisMoney(a5.free),'')}
function stockAnalysisRenderEvents(events){var el=document.getElementById('stock-analysis-events');if(!el)return;if(!events.length){el.innerHTML='<div style="color:#888;">最近一年暂无已抓取事项</div>';return}el.innerHTML=events.map(function(e){var title=escapeHtml(e.title||'');var link=e.url?'<a href="'+escapeHtml(e.url)+'" target="_blank" rel="noopener noreferrer">'+title+'</a>':title;return '<div class="stock-analysis-event"><small>'+escapeHtml(e.event_date||'')+'</small><span class="stock-analysis-tag">'+escapeHtml(e.is_official?'正式公告':'市场讨论')+'</span><span class="stock-analysis-tag">'+escapeHtml(e.category||e.source||'')+'</span>'+link+'</div>'}).join('')}
