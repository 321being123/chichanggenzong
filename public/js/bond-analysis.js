var securityAnalysisState = { type:'', code:'', loading:false };

async function securityAnalysisLoadList(force) {
  if (securityAnalysisState.listLoaded && !force) return;
  try {
    var response=await fetch(api('/api/bond-analysis/list/securities')), payload=await response.json();
    if(!response.ok) throw new Error(payload.error||'持仓和自选加载失败');
    var select=document.getElementById('security-analysis-select');
    if(select) select.innerHTML='<option value="">选择持仓或自选</option>'+(payload.data||[]).map(function(row){
      var tags=(row.held?'持仓':'')+(row.watchlisted?(row.held?' / 自选':'自选'):'');
      return '<option value="'+escapeHtml(row.code)+'">'+escapeHtml((row.name||row.code)+' · '+row.code+'（'+tags+'）')+'</option>';
    }).join('');
    securityAnalysisState.listLoaded=true;
  } catch(error) { stockAnalysisSetMessage(error.message||String(error),true); }
}

function securityAnalysisSelect(code) {
  if(!code) return;
  var input=document.getElementById('stock-analysis-code'); if(input) input.value=code;
  securityAnalysisSubmit();
}

function bondAnalysisText(value, suffix) {
  if (value === null || value === undefined || value === '') return '暂无数据';
  return escapeHtml(String(value)) + (suffix || '');
}
function bondAnalysisNumber(value, digits, suffix) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '暂无数据';
  return escapeHtml(Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 2 : digits })) + (suffix || '');
}
function bondAnalysisPercent(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '暂无数据' : bondAnalysisNumber(Number(value) * 100, 2, '%');
}
function bondAnalysisSourceLink(url,label) {
  return /^https:\/\/static\.cninfo\.com\.cn\//.test(String(url||'')) ? '<a href="'+escapeHtml(url)+'" target="_blank" rel="noopener">'+escapeHtml(label||'查看公告')+'</a>' : '';
}
function bondAnalysisRevisionType(row) {
  var reason=String(row&&row.reason||'');
  var before=Number(row&&row.price_before), after=Number(row&&row.price_after), floor=Number(row&&row.revision_floor_price);
  if(/送股|转增|派发新股|增发|配股|非公开发行股票|授予.{0,12}股票/.test(reason)) return '派发新股';
  if(/分红|利润分配|权益分派|派息/.test(reason)) return '分红';
  if(/回购注销/.test(reason)) return '回购注销';
  if(/向下修正|下修/.test(reason)||Number.isFinite(before)&&Number.isFinite(after)&&after<before){
    var floorTick=Math.ceil((floor-0.00000001)*100)/100;
    if(Number.isFinite(after)&&Number.isFinite(floor)) return '<span class="bond-analysis-revision-down">'+(Math.abs(after-floorTick)<=0.005?'下修到底':'下修不到底')+'</span>';
    return '<span class="bond-analysis-revision-down">下修</span>';
  }
  return '其他';
}
function bondAnalysisRevisionNote(row) {
  var reason=String(row&&row.reason||'');
  if(/送股|转增|派发新股|增发|配股|非公开发行股票|授予.{0,12}股票/.test(reason)) return '派发新股';
  if(/分红|利润分配|权益分派|派息/.test(reason)) return '分红';
  if(/回购注销/.test(reason)) return '回购注销股票导致转股价上调';
  if(reason) return bondAnalysisText(reason);
  return Number(row&&row.price_after)<Number(row&&row.price_before)?'转股价调整':'转股价变更';
}
function bondAnalysisDate(value) {
  if (!value) return '暂无数据';
  var text=String(value);
  if (/T.*Z$/.test(text)) {
    var date=new Date(text);
    if(!Number.isNaN(date.getTime())) return escapeHtml(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date));
  }
  return escapeHtml(text.slice(0,10));
}
function bondAnalysisTable(rows) {
  var cells = rows.map(function(row) { return '<th>' + escapeHtml(row[0]) + '</th><td>' + (row[1] || '暂无数据') + '</td>'; });
  var body = '';
  for (var i = 0; i < cells.length; i += 2) body += '<tr>' + cells[i] + (cells[i + 1] || '<th></th><td></td>') + '</tr>';
  return '<div class="bond-analysis-table-wrap"><table class="bond-analysis-table"><tbody>' + body + '</tbody></table></div>';
}
function bondAnalysisListTable(headers, rows) {
  if (!rows || !rows.length) return '<div class="bond-analysis-empty">暂无数据</div>';
  return '<div class="bond-analysis-table-wrap"><table class="bond-analysis-table"><thead><tr>' + headers.map(function(h){return '<th>'+escapeHtml(h)+'</th>';}).join('') +
    '</tr></thead><tbody>' + rows.map(function(row){return '<tr>'+row.map(function(value){return '<td>'+(value || '暂无数据')+'</td>';}).join('')+'</tr>';}).join('') + '</tbody></table></div>';
}
function bondAnalysisSet(id, html) { var el=document.getElementById(id); if(el) el.innerHTML=html; }
function securityAnalysisKind(code) { return /^(110|111|113|118|123|127|128)\d{3}$/.test(code) ? 'bond' : 'stock'; }

async function securityAnalysisSubmit() {
  var input=document.getElementById('stock-analysis-code'), raw=String(input&&input.value||'').trim().toUpperCase();
  var code=raw.replace(/\.(SH|SZ)$/,'').replace(/\D/g,'');
  if (!/^\d{6}$/.test(code)) return stockAnalysisSetMessage('请输入6位股票或可转债代码', true);
  securityAnalysisState.type=securityAnalysisKind(code); securityAnalysisState.code=code;
  if (securityAnalysisState.type==='stock') {
    stockAnalysisState.selected=code;
    var bond=document.getElementById('bond-analysis-content'); if(bond) bond.style.display='none';
    return stockAnalysisSelect(code);
  }
  var stock=document.getElementById('stock-analysis-content'); if(stock) stock.style.display='none';
  return bondAnalysisLoad(false);
}

async function securityAnalysisRefresh() {
  if (!securityAnalysisState.code) return securityAnalysisSubmit();
  if (securityAnalysisState.type==='stock') return stockAnalysisRefresh();
  return bondAnalysisLoad(true);
}

async function bondAnalysisLoad(refresh) {
  if (securityAnalysisState.loading) return;
  securityAnalysisState.loading=true;
  var button=document.getElementById('stock-analysis-refresh');
  if(button){button.disabled=true;button.textContent='刷新中...';}
  stockAnalysisSetMessage(refresh ? '正在更新可转债数据...' : '正在读取可转债分析结果...');
  try {
    var path='/api/bond-analysis/'+encodeURIComponent(securityAnalysisState.code)+(refresh?'/refresh':'');
    var response=await fetch(api(path), refresh?{method:'POST'}:undefined);
    if(response.status===404&&!refresh){securityAnalysisState.loading=false;return bondAnalysisLoad(true);}
    var payload=await response.json(), analysis=payload.analysis||payload;
    if(!response.ok&&!payload.analysis) throw new Error(payload.error||'可转债分析失败');
    bondAnalysisRender(analysis);
    if(!response.ok&&payload.error) showToast('更新失败，已显示上一份有效数据：'+payload.error);
  } catch(error) { stockAnalysisSetMessage(error.message||String(error),true); }
  finally { securityAnalysisState.loading=false;if(button){button.disabled=false;button.textContent='刷新数据';} }
}

function bondAnalysisRender(d) {
  stockAnalysisSetMessage('');
  var stock=document.getElementById('stock-analysis-content'), root=document.getElementById('bond-analysis-content');
  if(stock) stock.style.display='none'; if(root) root.style.display='block';
  var q=d.quote||{}, b=d.basic||{}, terms=d.terms||{}, safety=d.safety||{}, bond=d.bond||{}, option=d.option||{}, stockData=d.stock||{}, credit=d.credit||{};
  var change=q.bond_change_pct, changeClass=Number(change)>0?'bond-analysis-up':Number(change)<0?'bond-analysis-down':'';
  bondAnalysisSet('bond-analysis-summary','<strong>'+escapeHtml(d.name||d.ts_code||'可转债')+'</strong><span>'+escapeHtml(d.ts_code||'')+'</span><span>现价：'+bondAnalysisNumber(q.bond_price,3,' 元')+'</span><span class="'+changeClass+'">涨跌：'+(change==null?'暂无数据':bondAnalysisNumber(change,2,'%'))+'</span><span>正股：'+escapeHtml(d.stock_name||d.stock_code||'暂无数据')+'</span>');
  var updated=document.getElementById('stock-analysis-updated'); if(updated) updated.textContent='数据日期：'+(d.as_of||'--')+' · '+(q.source==='tencent'?'实时行情':'收盘数据');
  bondAnalysisSet('bond-analysis-basic',bondAnalysisTable([
    ['正股价',bondAnalysisNumber(q.stock_price,3,' 元')],['转股价',bondAnalysisNumber(b.convert_price,3,' 元')],
    ['转股价值',bondAnalysisNumber(b.convert_value,3,' 元')],['转股溢价率',bondAnalysisPercent(b.convert_premium)],
    ['基金持仓',b.fund_holding?bondAnalysisNumber(b.fund_holding.fund_count,0,'只 / ')+bondAnalysisNumber(b.fund_holding.holding_quantity,2,'万张')+'（报告期 '+bondAnalysisDate(b.fund_holding.report_date)+'）<br><small>占剩余规模：'+bondAnalysisPercent(b.fund_holding.holding_ratio)+'</small>':'暂无数据'],['到期时间',bondAnalysisDate(b.maturity_date)],
    ['剩余年限',bondAnalysisNumber(b.remaining_years,2,' 年')],['剩余规模',bondAnalysisNumber(b.remain_size,2,' 亿元')],
    ['最快回售触发日',bondAnalysisDate(b.earliest_put_trigger_date)],['最快回售剩余年限',bondAnalysisNumber(b.earliest_put_remaining_years,2,' 年')],
    ['预期回售到账日',b.expected_put_payment_date?bondAnalysisDate(b.expected_put_payment_date)+'<br><small>预计触发 '+bondAnalysisDate(b.expected_put_trigger_date)+'；'+bondAnalysisText(b.expected_put_assumption)+'</small>':(b.expected_put_status==='opportunity_used'?'本计息年度回售机会已使用':(b.expected_put_status==='current_price_not_below_trigger'?'当前价未低于回售触发价，暂不估算':'暂无数据'))],['回售到账税前收益率',bondAnalysisPercent(b.put_yield_pre_tax)],
    ['回售到账税后收益率',bondAnalysisPercent(b.put_yield_after_tax)],['转债/总市值',bondAnalysisPercent(b.bond_to_market_cap)],
    ['转股起始日',bondAnalysisDate(b.conv_start_date)],['转股截止日',bondAnalysisDate(b.conv_end_date)]
  ]));
  bondAnalysisSet('bond-analysis-triggers',bondAnalysisTable([
    ['强赎触发价',bondAnalysisNumber(b.call_trigger_price,3,' 元')],['强赎天计数',b.call_day_count==null?'暂无数据':bondAnalysisNumber(b.call_day_count,0,' / '+b.call_required_days+' 天')+(b.call_met?'（已满足）':'')],
    ['下修触发价',bondAnalysisNumber(b.reset_trigger_price,3,' 元')],['下修天计数',b.reset_active===false?'不下修锁定期（至 '+bondAnalysisDate(b.reset_valid_until)+'；'+bondAnalysisDate(b.reset_restart_date)+' 重新起算）':(b.reset_day_count==null?'暂无数据':bondAnalysisNumber(b.reset_day_count,0,' / '+b.reset_required_days+' 天')+(b.reset_met?'（已满足）':'（累计）'))],
    ['回售触发价',bondAnalysisNumber(b.put_trigger_price,3,' 元')],['回售天计数',b.put_opportunity_used?'本计息年度回售机会已使用':(b.put_active?(b.put_day_count==null?'暂无数据':bondAnalysisNumber(b.put_day_count,0,' / '+b.put_required_days+' 天')+'（已观察 '+bondAnalysisNumber(b.put_observed_days,0,' 个交易日')+'）'+(b.put_met?'（已满足）':'')):'尚未进入回售期')]
  ]));
  bondAnalysisSet('bond-analysis-terms',bondAnalysisTable([
    ['募资用途','<div class="bond-analysis-purpose">'+bondAnalysisText(b.fundraising_purpose)+'</div>'+(b.fundraising_source_url?'<small>'+bondAnalysisSourceLink(b.fundraising_source_url,'查看募集说明书')+'</small>':'')],['下修条款',bondAnalysisText(terms.reset&&terms.reset.text)+(terms.reset&&terms.reset.note?'<br><small>注：'+bondAnalysisText(terms.reset.note)+'</small>':'')],
    ['强赎条款',bondAnalysisText(terms.call&&terms.call.text)],['回售条款',bondAnalysisText(terms.put&&terms.put.text)],
    ['到期赎回价',bondAnalysisText(terms.maturity_call_price)]
  ]));
  var history=d.history||{};
  bondAnalysisSet('bond-analysis-price-history',bondAnalysisListTable(['决议/公告日','生效日期','原转股价','新转股价','类型','状态','说明','公告'],(history.price_changes||[]).map(function(r){return [bondAnalysisDate(r.publish_date),bondAnalysisDate(r.change_date),bondAnalysisNumber(r.price_before,3,' 元'),bondAnalysisNumber(r.price_after,3,' 元'),bondAnalysisRevisionType(r),'成功',bondAnalysisRevisionNote(r),bondAnalysisSourceLink(r.source_url,'查看')];})));
  bondAnalysisSet('bond-analysis-no-revision',bondAnalysisListTable(['决议日','重新起算日','说明','公告'],(history.no_revision||[]).map(function(r){return [bondAnalysisDate(r.announced_at),r.next_eligible_date?bondAnalysisDate(r.next_eligible_date):'次一交易日',bondAnalysisText(r.summary||'本次不下修'),bondAnalysisSourceLink(r.source_url,'查看')];})));
  bondAnalysisSet('bond-analysis-safety',bondAnalysisTable([
    ['可转债安全性',bondAnalysisText(safety.rating)],['利息保障倍数（符合：≥7）',bondAnalysisNumber(safety.interest_coverage,2,' 倍')],
    ['现金覆盖率（符合：≥1）',bondAnalysisNumber(safety.cash_coverage,2,' 倍')],['负债/市值（符合：≤150%）',bondAnalysisPercent(safety.liability_to_market_cap)],
    ['可转债评级',bondAnalysisText(credit.newest_rating||credit.issue_rating)],['评级机构',bondAnalysisText(credit.rating_company)]
  ]));
  bondAnalysisSet('bond-analysis-bond',bondAnalysisTable([
    ['纯债价值',bondAnalysisNumber(bond.pure_bond_value,3,' 元')+(bond.pure_bond_method?'<br><small>'+bondAnalysisText(bond.pure_bond_method)+'</small>':'')],['债底溢价率',bondAnalysisPercent(bond.bond_floor_premium)],
    ['债券利息',bond.coupons&&bond.coupons.length?'详见下方逐年利息明细'+(bond.coupon_source_url?' · '+bondAnalysisSourceLink(bond.coupon_source_url,'查看募集说明书'):''):(bond.coupon_rate==null?bondAnalysisText(bond.rate_clause):bondAnalysisNumber(bond.coupon_rate,3,'%'))],['到期税前收益率（YTM）',bondAnalysisPercent(bond.maturity_yield_pre_tax)],
    ['到期税后收益率',bondAnalysisPercent(bond.maturity_yield_after_tax)],['担保',bond.guarantor||bond.guarantee_type?bondAnalysisText((bond.guarantor||'有')+(bond.guarantee_type?' / '+bond.guarantee_type:'')):'无']
  ]));
  bondAnalysisSet('bond-analysis-coupons',bondAnalysisListTable(['计息年度','票面利率','付息日','税前利息','税后利息'],(bond.coupons||[]).map(function(r){return [r.is_current?'<span class="bond-analysis-current-coupon">第'+bondAnalysisNumber(r.interest_year,0)+'年（当前）</span>':'第'+bondAnalysisNumber(r.interest_year,0)+'年',bondAnalysisNumber(r.coupon_rate,3,'%'),bondAnalysisDate(r.pay_date),bondAnalysisNumber(r.pre_tax_interest,3,' 元'),bondAnalysisNumber(r.after_tax_interest,3,' 元')];})));
  bondAnalysisSet('bond-analysis-option',bondAnalysisTable([
    ['期权价值（市价－纯债）',bondAnalysisNumber(option.option_value,3,' 元')],['BS理论期权价值',bondAnalysisNumber(option.theoretical_option_value,3,' 元')],
    ['理论价值',bondAnalysisNumber(option.theoretical_value,3,' 元')],['理论偏离度',bondAnalysisPercent(option.theoretical_deviation)],
    ['无风险利率',bondAnalysisPercent(option.risk_free_rate)],['估值模型',bondAnalysisText(option.model)]
  ]));
  bondAnalysisSet('bond-analysis-option-method',bondAnalysisText(option.method_note)+(option.volatility==null?'':'；年化波动率 '+bondAnalysisPercent(option.volatility)));
  bondAnalysisSet('bond-analysis-stock',bondAnalysisTable([
    ['正股PE',bondAnalysisNumber(stockData.pe,2,' 倍')+(stockData.pe_source?'（'+bondAnalysisText(stockData.pe_source)+'）':'')],['正股PB',bondAnalysisNumber(stockData.pb,2,' 倍')],
    ['正股年化波动率',bondAnalysisPercent(stockData.annualized_volatility)],['资产负债率',bondAnalysisPercent(stockData.asset_liability_ratio)],
    ['正股总市值',stockAnalysisMoney(stockData.total_market_cap)],['股息率',bondAnalysisPercent(stockData.dividend_yield)]
  ]));
  bondAnalysisSet('bond-analysis-ratings',bondAnalysisListTable(['评级日','公告日','评级','展望','评级机构'],(d.rating_history||[]).map(function(r){return [bondAnalysisDate(r.rating_date),bondAnalysisDate(r.announced_at),bondAnalysisText(r.rating),bondAnalysisText(r.rating_outlook),bondAnalysisText(r.rating_company)];})));
  var status=d.data_status||{}, labels={requires_5000_points:'需5000积分权限',requires_5000_points_or_report_parse:'需5000积分权限或报告解析',parsed_from_clause:'已从利率条款解析',no_matching_announcement:'未找到匹配公告',calculated:'已计算',not_yet_calculable:'当前尚不能计算',put_period_not_found:'未识别回售期',calculation_inputs_incomplete:'计算参数不完整',permission_or_unavailable:'权限不足或数据不可用',unavailable:'暂无数据',ok:'已更新'};
  bondAnalysisSet('bond-analysis-status','数据状态：'+Object.keys(status).map(function(key){return escapeHtml(key)+'：'+escapeHtml(labels[status[key]]||status[key]);}).join('；'));
}
