// 仅由明确点击读取账户已有事实；展开、旋转和表格滑动不触发外部采集。
function closeCashIncomePanel(){var p=document.getElementById('cash-income-panel');if(p){var trigger=p.__returnFocus;p.remove();if(trigger?.isConnected)trigger.focus();}}
var cashIncomeRows=[];
function incomeCell(v){return escapeHtml(v==null?'—':String(v));}
async function openCashIncomePanel(){
  closeCashIncomePanel();
  var wrap=document.createElement('div');wrap.id='cash-income-panel';wrap.className='modal-overlay show';
  var account=currentAccount;wrap.__returnFocus=document.activeElement;
  wrap.innerHTML='<div class="modal cash-income-modal" role="dialog" aria-modal="true" aria-labelledby="cash-income-title"><h2 id="cash-income-title">现金收益</h2><div class="cash-income-body"><p id="income-summary">正在读取…</p><div class="biz-table-scroll"><table class="biz-table" id="income-details"><thead><tr><th>到账日</th><th>类型</th><th>人民币金额</th><th>口径</th><th>事件</th></tr></thead><tbody></tbody></table></div><h3>待核验事项</h3><div class="biz-table-scroll"><table class="biz-table" id="income-pending"><thead><tr><th>证券</th><th>原因</th><th>原币毛额</th><th>状态</th><th>操作</th></tr></thead><tbody></tbody></table></div><details></details><p id="income-message" role="status"></p></div><div class="modal-actions"><button type="button" class="btn btn-outline" id="income-close">关闭</button></div></div>';
  document.body.appendChild(wrap);document.getElementById('income-close').onclick=closeCashIncomePanel;
  document.getElementById('income-close').classList.add('modal-close');
  var actual=wrap.querySelector('details');
  actual.innerHTML='<summary>补录实际流水（可选校正）</summary><p>选择本账户事件，按凭证填写实际到账。费用填负数；港股必须填写已扣税后的原币净额和实际人民币结算金额。</p><form id="income-actual-form" class="cash-income-form"><label>事件<select id="income-event" required></select></label><label>类型<select id="income-flow-type"><option value="dividend">股票分红</option><option value="dividend_tax">分红扣税</option><option value="repo_interest">回购利息</option><option value="repo_fee">回购费用</option></select></label><label>到账日<input id="income-date" type="date" required></label><label>人民币金额<input id="income-amount" type="text" inputmode="decimal" required></label><label>原币<select id="income-currency"><option>CNY</option><option>HKD</option><option>USD</option></select></label><label>原币金额<input id="income-original" type="text" inputmode="decimal"></label><label>凭证引用<input id="income-reference" type="text" required></label><label>记录状态<select id="income-status"><option value="confirmed">实际到账或更正</option><option value="revoked">撤销已有实际记录</option></select></label><button type="submit" class="btn btn-primary" id="income-import-actual">保存实际流水</button></form>';
  wrap.addEventListener('keydown',function(e){if(e.key==='Escape')closeCashIncomePanel();});
  document.getElementById('income-close').focus();
  try {
    var response=await fetch(api('/api/accounts/'+encodeURIComponent(account)+'/cash-income'));
    var result=await response.json();if(!response.ok)throw new Error(result.error||'读取失败');
    if(!wrap.isConnected||account!==currentAccount)return;
    cashIncomeRows=result.rows||[];
    var policy=result.cash_income_state||{};
    document.getElementById('income-summary').textContent='基准日 '+(policy.anchorDate||'未设置')+'；市场日利率 '+(policy.repoMarketRateDays||0)+' 天，历史备用估算 '+(policy.repoFallbackDays||0)+' 天。2026-10-10 后缺失日利率时待补，不套用备用利率。';
    var admission=policy.repoSourceAdmission||{};
    document.getElementById('income-summary').textContent+=' 来源准入：'+(admission.status==='admitted'?'已核验':admission.status==='rejected'?'跨源不一致，待核验':'官方同口径证据待补')+'。';
    document.getElementById('income-summary').textContent+=' 港股分红按公告派息日后3个港股通交易日估计到账，到账前不计入现金。';
    if(policy.upcomingDividends?.length)document.getElementById('income-summary').textContent+=' 待到账：'+policy.upcomingDividends.map(function(r){return r.code+'（'+r.receiptDate+'）';}).join('、')+'。';
    var taxRows=(policy.dividendTaxAssessments||[]).flatMap(function(a){return (a.sales||[]).map(function(r){return {...r,code:a.code};});});
    var tax=document.createElement('section');tax.innerHTML='<h3>卖出递延税计算</h3><p>按公告、登记日资格、日终净增减及先进先出计算并计入收益，扣款日为估计；实际流水可选校正。期初录入日不能替代购入日。</p><div class="biz-table-scroll"><table class="biz-table"><thead><tr><th>证券</th><th>卖出日</th><th>计算税额</th><th>实际扣款</th><th>状态</th></tr></thead><tbody>'+taxRows.map(function(r){return '<tr><td>'+incomeCell(r.code)+'</td><td>'+incomeCell(r.saleDate)+'</td><td>'+incomeCell(r.amount)+'</td><td>'+incomeCell(r.actualAmount)+'</td><td>'+incomeCell({broker_confirmed:'实际扣款已补录',tax_exempt:'持有期限免税',calculated_applied_estimate:'已计入收益（估算）',calculated_pending_actual_deduction:'计算依据待补',pending_acquisition_evidence:'购入批次待补'}[r.status]||r.status)+'</td></tr>';}).join('')+'</tbody></table></div>';
    if(!taxRows.length)tax.querySelector('tbody').innerHTML='<tr><td colspan="5">暂无基准后卖出扣税事件；未卖批次继续跟踪</td></tr>';
    var unknownLots=(policy.dividendTaxAssessments||[]).reduce(function(n,a){return n+(a.remainingEntitlement||[]).filter(function(l){return !l.acquired;}).length;},0);
    if(unknownLots)tax.querySelector('p').textContent+=' 另有'+unknownLots+'个未卖出的股息资格批次缺购入日期，继续待核验。';
    actual.before(tax);
    document.querySelector('#income-details tbody').innerHTML=cashIncomeRows.map(function(r){
      var type={dividend:'股票分红',dividend_tax:'分红扣税',repo_interest:'回购利息',repo_fee:'回购费用'}[r.flow_type]||r.flow_type;
      var status=r.status==='confirmed'?'券商实际':r.status==='revoked'?'已撤销':r.evidence?.rateSource==='market_daily_weighted'?'市场日加权利率计算':'估算';
      return '<tr><td>'+incomeCell(r.date)+'</td><td>'+incomeCell(type)+'</td><td>'+incomeCell(r.amount)+'</td><td>'+incomeCell(status)+'</td><td>'+incomeCell(r.event_key)+'</td></tr>';
    }).join('')||'<tr><td colspan="5">暂无收益流水</td></tr>';
    var reasons={missing_stock_connect_net_cny_settlement:'港股通净额、汇率与到账日待核验',missing_repo_daily_rate:'该交易日市场利率待补',repo_source_admission_pending:'市场利率来源未准入',dividend_window_not_verified:'分红公告窗口未核验',missing_hk_dividend_facts:'港股分红事实待补',missing_net_amount:'净额依据待核验',missing_event_tax_terms:'本次公告税务条款待补',missing_historical_dividend_fx:'派息日历史汇率待补',incomplete_dividend_settlement_terms:'公告结算条款不完整',missing_stock_connect_channel:'购入通道待核验',missing_acquisition_date:'购入批次日期待核验',deferred_tax_actual_deduction_pending:'递延税已测算，实际扣款待补',missing_position_history:'历史持仓待补',position_history_does_not_reconcile:'历史持仓不闭合'};
    reasons.missing_historical_dividend_fx='估计到账日历史汇率待补';reasons.missing_hk_dividend_calendar='T+3到账日历待核验';
    var pending=result.pending||[];
    document.querySelector('#income-pending tbody').innerHTML=pending.map(function(r,index){return '<tr><td>'+incomeCell(r.code)+'</td><td>'+incomeCell(reasons[r.reason]||r.reason)+'</td><td>'+incomeCell(r.evidence?.grossOriginal)+' '+incomeCell(r.evidence?.originalCurrency||'')+'</td><td>'+incomeCell({pending:'待核验',resolved:'已解决',excluded_by_user:'用户排除',source_blocked:'来源阻塞'}[r.state]||r.state)+'</td><td><button type="button" class="btn btn-outline" data-pending-index="'+index+'" '+(!r.event_key||r.state==='resolved'?'disabled':'')+'>'+(r.state==='excluded_by_user'?'重新打开':'不参与')+'</button></td></tr>';}).join('')||'<tr><td colspan="5">无待核验事项</td></tr>';
    document.querySelectorAll('[data-pending-index]').forEach(function(button){button.onclick=async function(){
      if(account!==currentAccount||!wrap.isConnected)return;
      var row=pending[Number(button.dataset.pendingIndex)];if(!row.event_key||row.state==='resolved')return;
      var reason=prompt(row.state==='excluded_by_user'?'填写重新打开的原因':'填写本事件不参与的原因');if(!reason)return;
      button.disabled=true;
      try {var r=await fetch(api('/api/accounts/'+encodeURIComponent(account)+'/cash-income/pending/'+row.pending_key+'?version='+dataVersion),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exclude:row.state!=='excluded_by_user',reason:reason})});var body=await r.json();if(!r.ok)throw new Error(body.error);if(account!==currentAccount||!wrap.isConnected)return;data=await loadData(account);renderAll();await openCashIncomePanel();}catch(e){if(wrap.isConnected){showToast(e.message);button.disabled=false;}}
    };});
    var events=Array.from(new Set(cashIncomeRows.map(function(r){return r.event_key;}).concat(pending.map(function(r){return r.event_key;}),(policy.upcomingDividends||[]).map(function(r){return r.eventKey;})).filter(Boolean)));
    document.getElementById('income-event').innerHTML=events.map(function(key){return '<option value="'+incomeCell(key)+'">'+incomeCell(key)+'</option>';}).join('');
    document.getElementById('income-date').value=todayCN();
    function selectIncomeType(){var key=document.getElementById('income-event').value,repo=key.startsWith('repo:'),tax=key.includes(':tax:');document.querySelectorAll('#income-flow-type option').forEach(function(o){o.hidden=o.value.startsWith('repo_')!==repo;if(tax)o.hidden=o.value!=='dividend_tax';o.disabled=o.hidden;});document.getElementById('income-flow-type').value=tax?'dividend_tax':repo?'repo_interest':'dividend';}
    document.getElementById('income-event').onchange=selectIncomeType;selectIncomeType();
    document.getElementById('income-import-actual').disabled=!events.length;
    document.getElementById('income-actual-form').onsubmit=async function(event){
      event.preventDefault();if(account!==currentAccount)return;
      var button=document.getElementById('income-import-actual');button.disabled=true;
      var currency=document.getElementById('income-currency').value,amount=document.getElementById('income-amount').value.trim();
      var record={eventKey:document.getElementById('income-event').value,date:document.getElementById('income-date').value,flow_type:document.getElementById('income-flow-type').value,amountCny:amount,currency:currency,originalAmount:document.getElementById('income-original').value.trim()||(currency==='CNY'?amount:null),sourceRef:document.getElementById('income-reference').value.trim(),status:document.getElementById('income-status').value,settlement:{amountBasis:'net'}};
      try {var response=await fetch(api('/api/accounts/'+encodeURIComponent(account)+'/cash-income/actual?version='+dataVersion),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:[record]})});var result=await response.json();if(!response.ok)throw new Error(result.error);if(account!==currentAccount||!wrap.isConnected)return;data=await loadData(account);renderAll();showToast('实际流水已保存');await openCashIncomePanel();}catch(e){if(wrap.isConnected){document.getElementById('income-message').textContent=e.message;button.disabled=false;}}
    };
  }catch(e){if(wrap.isConnected&&account===currentAccount)wrap.querySelector('#income-summary').textContent=e.message;}
}
