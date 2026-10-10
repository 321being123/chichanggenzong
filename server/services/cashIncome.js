// 本地账本计算；所有调用入口复用此服务，不联网。外部日终资金下一交易日投入。
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { loadCashInputs } = require('./accountCash');
const NavMath = require('../../public/shared/nav-math');
const CoreDate = require('../../public/shared/core-date');
const { loadHolidays } = require('../config/holidays');
const { resolveInstrument } = require('./securityIdentity');
const VERSION = 'cash-income-v1';
function stable(value) {
  if(value instanceof Date) return value.toJSON();
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
function userTaxExemption(policy,username,identity,action,key,holding) {
  const proof=policy?.cnDividendExemptions?.find(p=>p.eventKey===key&&p.code===identity?.code);
  return identity?.market==='CN'&&action.currency_code==='CNY'&&action.raw_payload?.documentId&&
    proof?.confirmedBy===username&&proof.holdingPeriod==='over_one_year'&&proof.allEntitledShares===true&&
    Number(proof.quantity)===holding.quantity&&holding.quantity>0&&!holding.reason ? proof : null;
}
function userScopeExclusion(policy,username,code) {
  return policy?.dividendScopeExclusions?.find(p=>p.code===code&&p.confirmedBy===username&&p.reason&&p.outsideStockDividendScope===true)||null;
}
function shiftDay(day, offset = 1) {
  const instant = new Date(day + 'T12:00:00+08:00');
  instant.setUTCDate(instant.getUTCDate() + offset);
  return CoreDate.dateInZone(instant, 'Asia/Shanghai');
}
function calendarFor(years) {
  return day => {
    if (!Array.isArray(years[day.slice(0,4)])) throw new Error('缺少逆回购清算日历年份：' + day.slice(0,4));
    const weekday = new Date(day + 'T12:00:00+08:00').getUTCDay();
    return weekday > 0 && weekday < 6 && !years[day.slice(0,4)].includes(day);
  };
}
function nextTradingDay(day, isTradingDay) {
  let next = shiftDay(day);
  while (!isTradingDay(next)) next = shiftDay(next);
  return next;
}
function hkDividendCalendar(years,rows){
  const cn=calendarFor(years),byDate=new Map(rows.map(r=>[r.trade_date,r]));
  return day=>{
    try{if(!cn(day))return {isOpen:false,source:'local_cn_holiday_calendar'};}catch(_){return null;}
    const row=byDate.get(day);
    if(row){const facts=require('./marketState').normalizeHkCalendarRow(row);return facts.qualityStatus==='passed'?{isOpen:facts.status==='open',source:facts.source,evidence:facts.evidence}:null;}
    const schedule=require('../config/hkexAnnualSchedules').scheduleForDate(day);
    return schedule?{isOpen:schedule.isOpen,source:'local_cn_holidays_and_hkex_official_schedule',evidence:schedule.evidence}:null;
  };
}
function holdingAt(trades, code, day, positions) {
  const events = trades.filter(t=>t.code===code).sort((a,b)=>
    String(a.trade_date || a.date).localeCompare(String(b.trade_date || b.date)) ||
    String(a.executed_at || a.date || '').localeCompare(String(b.executed_at || b.date || '')) || String(a.id).localeCompare(String(b.id)));
  if (!events.length || !['open','buy','adjust'].includes(events[0].direction)) return { reason:'missing_position_history' };
  let qty = 0, eligible = 0;
  for (const t of events) {
    const q = Number(t.quantity);
    if (!Number.isFinite(q) || q < 0) return { reason:'invalid_quantity' };
    qty = t.direction === 'adjust' ? q : qty + (t.direction === 'sell' ? -q : q);
    if (qty < 0) return { reason:'incomplete_position_history' };
    if (String(t.trade_date || t.date).slice(0,10) <= day) eligible = qty;
  }
  const current = positions.filter(p=>p.code===code).reduce((s,p)=>s+Number(p.quantity),0);
  if (Math.abs(qty-current)>0.00001) return { reason:'position_history_does_not_reconcile' };
  return { quantity:eligible, basis:'existing_trade_history_reconciled_to_positions', brokerVerified:false };
}
function calculateRepo(input, anchor, targetDate, isTradingDay, dividends = [], options = {}) {
  const fixed = input.cashFlows.filter(f=>f.origin !== 'system' ||
    (f.status === 'confirmed' && !['calculated_from_implemented_action','authorized_dividend_calculation'].includes(f.quality_status)));
  const generated = dividends.slice();
  const rows = [], pending=[], confirmed = new Map(fixed.filter(f=>f.event_key&&NavMath.isEffectiveFlow(f)).map(f=>[f.event_key+'|'+f.flow_type,f]));
  let processedThrough=targetDate;
  for (let day = shiftDay(anchor.date); day <= targetDate; day = shiftDay(day)) {
    if (!isTradingDay(day)) continue;
    const next = nextTradingDay(day,isTradingDay), end = nextTradingDay(next,isTradingDay);
    const previous = shiftDay(day,-1);
    const cash = NavMath.cashAt({...input,cashFlows:fixed.concat(generated)},previous);
    if (cash.incomplete) throw new Error('现金结算数据不完整，不能计算回购本金');
    const matured = generated.concat(fixed).filter(f=>f.date===day && f.flow_type==='repo_interest'&&NavMath.isEffectiveFlow(f))
      .reduce((sum,f)=>sum+Number(f.amount),0);
    const balance=cash.value+matured;
    const event_key = 'repo:204001.SH:'+day;
    if(options.excludedEvents?.includes(event_key))continue;
    if(balance<0){pending.push({code:'204001.SH',eventKey:event_key,date:day,reason:'negative_available_cash',balance});continue;}
    let principal = Math.max(0,Math.floor(balance/1000)*1000);
    // 手续费也须由可用余额承担，不能把整千余额投入后造成负现金。
    while(principal>0 && principal+round(Math.max(0.10,principal*0.000001))>balance) principal-=1000;
    if (principal < 1000) continue;
    const market=options.sourceAdmission&&options.sourceAdmission.status!=='admitted'?null:options.rates?.[day];
    const cutoff=options.fallbackThrough || '2026-10-10';
    if(!market && day>cutoff) {
      if(confirmed.has(event_key+'|repo_interest'))continue;
      pending.push({code:'204001.SH',eventKey:event_key,date:day,reason:options.sourceAdmission&&options.sourceAdmission.status!=='admitted'?'repo_source_admission_pending':'missing_repo_daily_rate'});
      processedThrough=previous;break; // 未知收益影响后续本金，不能跳过缺失日继续假完整递推。
    }
    const annualRate=market?Number(market.annualRate):0.013;
    if(!Number.isFinite(annualRate)) throw new Error('无效市场回购利率');
    const days = Math.round((new Date(end+'T12:00:00+08:00')-new Date(next+'T12:00:00+08:00'))/86400000);
    const gross = round(principal*annualRate*days/365), fee = round(Math.max(0.10,principal*0.000001));
    const evidence = {tradeDate:day,availableDate:next,interestStart:next,interestEndExclusive:end,
      principal,annualRate,rateSource:market?'market_daily_weighted':'policy_fallback_1.3_percent',rateEvidence:market||null,interestDays:days,gross,fee,
      cashPolicy:'previous_day_closing_cny_equivalent_cash_assumed_available',feePolicy:'one_day_0.000001_min_0.10',
      calendarSource:'local_cn_holiday_calendar',brokerVerified:false};
    rows.push(evidence);
    for (const [flow_type,date,amount] of [['repo_fee',day,-fee],['repo_interest',next,gross]]) {
      if (date>targetDate || confirmed.has(event_key+'|'+flow_type)) continue;
      generated.push({date,amount,flow_type,status:'estimated',origin:'system',event_key,evidence,
        quality_status:market?'market_rate_calculation':'policy_estimate',note:market?'一天期逆回购市场日加权利率计算（含费用）':'一天期逆回购估算（年化1.3%，含费用）'});
    }
  }
  return { flows:generated, trades:rows,pending,processedThrough };
}
async function readInputs(client, username, accountName, targetDate) {
  const account = (await client.query('SELECT id,cash_income_policy,cash_income_state FROM accounts WHERE username=$1 AND account_name=$2',[username,accountName])).rows[0];
  if (!account) throw Object.assign(new Error('账户不存在'),{status:404});
  const data = await loadCashInputs(username,accountName,client);
  data.trades = (await client.query('SELECT * FROM trades WHERE username=$1 AND account_name=$2 ORDER BY id',[username,accountName])).rows;
  // 文本金额保留；PG DATE 通过 ::text 消除宿主时区边界。
  data.cashFlows = (await client.query('SELECT *,date::text,anchor_date::text FROM cash_flows WHERE username=$1 AND account_name=$2 ORDER BY id',[username,accountName])).rows;
  const positions = (await client.query('SELECT code,instrument_id,quantity,type,subtype FROM positions WHERE username=$1 AND account_name=$2 ORDER BY id',[username,accountName])).rows;
  const codes = [...new Set([...positions.map(p=>p.code),...data.trades.map(t=>t.code)])];
  const identities=[];
  for (const code of codes) {
    const canonical=await require('./securityIdentity').resolveCanonicalCode(code,'stock',client.query.bind(client));
    const identity=await resolveInstrument({canonicalCode:canonical,instrumentId:positions.find(p=>p.code===code)?.instrument_id},client.query.bind(client));
    if(identity) identities.push({code,...identity});
  }
  const actions = (await client.query(`SELECT *,record_date::text,pay_date::text,ex_date::text FROM fundamental.corporate_actions
    WHERE action_type='dividend' AND instrument_id=ANY($1::bigint[]) AND pay_date <= $2::date ORDER BY action_id`,[identities.map(i=>i.instrument_id),targetDate])).rows;
  const rates=await require('./repoDailyRates').loadRepoRates(client.query.bind(client));
  const userExcluded=(await client.query("SELECT event_key FROM account_cash_income_pending WHERE account_id=$1 AND state='excluded_by_user' AND event_key IS NOT NULL",[account.id])).rows.map(r=>r.event_key);
  const coverages=(await client.query("SELECT scope_key,last_success_date::text,cursor_payload FROM ops.sync_cursors WHERE dataset_code='stock_cash_dividend_facts' AND scope_key=ANY($1::text[])",[identities.map(i=>'cash_dividend:'+i.instrument_id)])).rows;
  const sourceAdmission=await require('./repoSourceAdmission').load(client.query.bind(client));
  const dividendFx=(await client.query("SELECT base_currency,quote_currency,rate_date::text,rate::text,source_id FROM market.fx_rates WHERE quote_currency='CNY' AND rate_date <= $1 ORDER BY rate_date,source_id",[targetDate])).rows;
  const hkCalendar=(await client.query("SELECT trade_date::text,is_open,source_code,raw_payload FROM market.trade_calendar WHERE exchange='HKEX'")).rows;
  return {account,data,positions,identities,actions,rates,userExcluded,coverages,sourceAdmission,dividendFx,hkCalendar,unresolvedCodes:codes.filter(code=>!identities.some(i=>i.code===code))};
}
async function settleCashIncome(username,accountName,{targetDate=CoreDate.todayInZone('Asia/Shanghai'),enable=false,expectedVersion=null}={}) {
  if(!CoreDate.normalizeBusinessDate(targetDate) || targetDate>CoreDate.todayInZone('Asia/Shanghai')) throw Object.assign(new Error('无效收益目标日'),{status:400});
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const input=await readInputs(client,username,accountName,targetDate);
    const inputVersion=(await client.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2',[username,accountName])).rows[0]?.version || 0;
    await client.query('COMMIT');
    if(!enable && !input.account.cash_income_policy?.enabled) return {status:'not_enabled'};
    if(expectedVersion!=null && Number(expectedVersion)!==inputVersion) throw Object.assign(new Error('账户已修改，请刷新重算'),{status:409});
    const anchor=NavMath.selectCashAnchor(input.data.navHistory,targetDate);
    if(!anchor) return {status:'missing_cash_anchor'};
    const pending=[],dividends=[],excluded=[],resolutions=[],seen=new Set(),dividendTaxAssessments=[],taxSeen=new Set(),upcomingDividends=[];
    const calendar=loadHolidays(),hkCalendar=hkDividendCalendar(calendar.years,input.hkCalendar);
    // 同一资格/派息事件优先官方新版本，不能让旧供应商行先占事件键。
    const orderedActions=input.actions.slice().sort((a,b)=>Number(!!b.raw_payload?.documentId)-Number(!!a.raw_payload?.documentId)||String(b.announced_at||'').localeCompare(String(a.announced_at||''))||Number(b.action_id)-Number(a.action_id));
    for(const action of orderedActions) {
      const identity=input.identities.find(i=>String(i.instrument_id)===String(action.instrument_id));
      const key='dividend:'+action.instrument_id+':'+action.record_date+':'+action.pay_date;
      if(userScopeExclusion(input.account.cash_income_policy,username,identity?.code))continue;
      if(identity?.market==='CN'&&action.status==='实施'&&action.record_date&&!taxSeen.has(key)){
        taxSeen.add(key);
        const currentHolding=holdingAt(input.data.trades,identity.code,targetDate,input.positions);
        const assessment=require('./cashDividendSettlement').assessDeferredTax({trades:input.data.trades,code:identity.code,recordDate:action.record_date,payDate:action.pay_date,targetDate,grossPerShare:action.cash_per_share_pre_tax,eventKey:key,expectedQuantity:currentHolding.quantity,positionHistoryReason:currentHolding.reason});
        if(assessment.remainingEntitlement.length||assessment.sales.some(s=>s.notBefore>anchor.date))dividendTaxAssessments.push(assessment);
        for(const sale of assessment.sales.filter(s=>s.notBefore>anchor.date)){
          const actual=input.data.cashFlows.find(f=>f.event_key===sale.eventKey&&f.flow_type==='dividend_tax'&&f.status==='confirmed');
          if(actual){resolutions.push({code:identity.code,eventKey:sale.eventKey,flowId:actual.id,revision:actual.revision,reason:'broker_deferred_tax_deduction'});sale.actualAmount=actual.amount;sale.status='broker_confirmed';}
          else if(sale.amount==='0.00'){resolutions.push({code:identity.code,eventKey:sale.eventKey,reason:'verified_fifo_tax_exemption',assessment:sale});sale.status='tax_exempt';}
          else if(sale.amount!==null&&!input.userExcluded.includes(sale.eventKey)){
            sale.status='calculated_applied_estimate';
            dividends.push({date:sale.notBefore,amount:-Number(sale.amount),flow_type:'dividend_tax',origin:'system',status:'estimated',event_key:sale.eventKey,instrument_id:action.instrument_id,quality_status:'authorized_deferred_tax_calculation',note:'公告与FIFO卖出补税计算（估算扣款日）',evidence:{authorizedPolicy:VERSION,brokerVerified:false,dateBasis:'max_announced_pay_date_and_sale_date_estimate',assessment:sale,rule:assessment.rule,fifoRule:assessment.fifoRule}});
            resolutions.push({code:identity.code,eventKey:sale.eventKey,reason:'authorized_deferred_tax_estimate',assessment:sale,brokerVerified:false});
          }
          else pending.push({code:identity.code,eventKey:sale.eventKey,reason:sale.amount===null?'missing_acquisition_date':'deferred_tax_actual_deduction_pending',parentEventKey:key,expectedTax:sale.amount,saleDate:sale.saleDate,notBefore:sale.notBefore,sourceEvidence:assessment});
        }
      }
      if(seen.has(key)) continue;
      if(identity?.market!=='HK'&&action.pay_date<=anchor.date) {excluded.push({code:identity.code,actionId:action.action_id,reason:'before_anchor_not_backfilled'});continue;}
      if(action.status!=='实施') continue;
      seen.add(key);
      if(input.userExcluded.includes(key)) {excluded.push({code:identity.code,actionId:action.action_id,reason:'excluded_by_user'});continue;}
      const actual=input.data.cashFlows.find(f=>f.event_key===key&&f.flow_type==='dividend'&&f.status==='confirmed');
      if(actual) {excluded.push({code:identity.code,actionId:action.action_id,reason:'broker_actual_replaces_calculation'});resolutions.push({code:identity.code,eventKey:key,flowId:actual.id,revision:actual.revision,reason:'broker_actual_evidence'});continue;}
      const holding=holdingAt(input.data.trades,identity.code,action.record_date,input.positions);
      if(identity.market==='HK'){
        if(input.account.cash_income_policy?.stockConnectChannel!=='stock_connect'){pending.push({code:identity.code,eventKey:key,reason:'missing_stock_connect_channel'});continue;}
        if(holding.reason){pending.push({code:identity.code,eventKey:key,reason:holding.reason});continue;}
        if(!holding.quantity){resolutions.push({code:identity.code,eventKey:key,reason:'reconciled_zero_entitlement',holding});continue;}
        const timing=require('./cashDividendSettlement').hkReceiptDate(action.pay_date,hkCalendar);
        if(timing.reason){pending.push({code:identity.code,eventKey:key,...timing});continue;}
        if(timing.receiptDate<=anchor.date){excluded.push({code:identity.code,actionId:action.action_id,reason:'before_anchor_not_backfilled',...timing});continue;}
        if(timing.receiptDate>targetDate){upcomingDividends.push({code:identity.code,eventKey:key,payDate:action.pay_date,...timing});resolutions.push({code:identity.code,eventKey:key,reason:'scheduled_hk_t_plus_3_not_due',...timing});continue;}
        const group=orderedActions.filter(a=>String(a.instrument_id)===String(action.instrument_id)&&a.record_date===action.record_date&&a.pay_date===action.pay_date&&a.status==='实施');
        const estimate=require('./cashDividendSettlement').estimateHkAnnouncement({actions:group,quantity:holding.quantity,fxRows:input.dividendFx,receiptDate:timing.receiptDate});
        if(estimate.reason){pending.push({code:identity.code,eventKey:key,reason:estimate.reason,...timing,sourceEvidence:action.raw_payload});continue;}
        dividends.push({date:timing.receiptDate,amount:estimate.amount,flow_type:'dividend',origin:'system',status:'estimated',event_key:key,instrument_id:action.instrument_id,quality_status:'authorized_dividend_calculation',note:'港股通公告净额计算（T+3到账与历史汇率估算）',evidence:{authorizedPolicy:VERSION,quantity:holding.quantity,recordDate:action.record_date,payDate:action.pay_date,...timing,...estimate}});
        resolutions.push({code:identity.code,eventKey:key,reason:'authorized_hk_announcement_estimate',estimate,holding,brokerVerified:false});continue;
      }
      const deferredInitial=identity.market==='CN'&&action.raw_payload?.taxTreatment?.kind==='CN_personal_deferred_2015'&&action.raw_payload?.documentId&&action.raw_payload?.taxTreatment?.sourceExcerpt;
      const userExemption=userTaxExemption(input.account.cash_income_policy,username,identity,action,key,holding);
      const netValue=userExemption?action.cash_per_share_pre_tax:action.cash_per_share_after_tax??(deferredInitial?action.cash_per_share_pre_tax:null),net=Number(netValue);
      let reason=holding.reason;
      if(!action.record_date) reason='missing_record_date';
      if(action.currency_code!=='CNY' || identity.market==='HK') reason='missing_stock_connect_net_cny_settlement';
      if(netValue==null || !Number.isFinite(net) || net<0) reason='missing_net_amount';
      if(reason) {pending.push({code:identity.code,actionId:action.action_id,eventKey:key,reason,
        recordDate:action.record_date,payDate:action.pay_date,quantity:holding.quantity||null,
        originalCurrency:action.currency_code,grossOriginal:holding.quantity&&action.cash_per_share_pre_tax!=null?round(holding.quantity*Number(action.cash_per_share_pre_tax)):null,
        sourceKey:action.source_key,sourceEvidence:action.raw_payload});continue;}
      if(!holding.quantity) {excluded.push({code:identity.code,actionId:action.action_id,reason:'no_entitlement_at_record_date'});resolutions.push({code:identity.code,eventKey:key,actionId:action.action_id,reason:'reconciled_zero_entitlement',holding});continue;}
      resolutions.push({code:identity.code,eventKey:key,actionId:action.action_id,reason:'validated_calculation_inputs',holding,netPerShare:net});
      dividends.push({date:action.pay_date,amount:round(net*holding.quantity),flow_type:'dividend',origin:'system',status:'estimated',
        event_key:key,instrument_id:action.instrument_id,quality_status:'authorized_dividend_calculation',note:'已实施分红计算（待券商核对）',
        evidence:{actionId:action.action_id,recordDate:action.record_date,payDate:action.pay_date,quantity:holding.quantity,
          netPerShare:net,userTaxExemption:userExemption,taxTreatment:deferredInitial?action.raw_payload.taxTreatment:null,sourceKey:action.source_key,sourceId:action.source_id,...holding,brokerVerified:false,authorizedPolicy:VERSION}});
    }
    for(const identity of input.identities) {
      if(userScopeExclusion(input.account.cash_income_policy,username,identity.code))continue;
      const sample=input.positions.find(p=>p.code===identity.code) || input.data.trades.find(t=>t.code===identity.code) || {};
      if(identity.asset_class && identity.asset_class!=='stock' || sample.type==='债权' || sample.type==='现金' || /基金|可转债|现金/.test(sample.subtype || '')) continue;
      const reason=identity.market==='HK'?'missing_hk_dividend_facts':'dividend_window_not_verified';
      const coverage=input.coverages.find(r=>r.scope_key==='cash_dividend:'+identity.instrument_id);
      const covered=coverage?.last_success_date>=targetDate&&coverage.cursor_payload?.complete===true&&coverage.cursor_payload?.fromDate<=anchor.date&&coverage.cursor_payload?.parserVersion===require('./cashDividendFacts').PARSER;
      if(covered)resolutions.push({code:identity.code,reason,scope:'cash_dividend:'+identity.instrument_id,coverage:coverage.cursor_payload});
      if(!input.actions.some(a=>String(a.instrument_id)===String(identity.instrument_id)&&a.pay_date>anchor.date && a.status==='实施')) {
        if(!covered)pending.push({code:identity.code,reason});
      }
    }
    for(const code of input.unresolvedCodes) {
      const proof=userScopeExclusion(input.account.cash_income_policy,username,code);
      if(proof){excluded.push({code,reason:'user_confirmed_outside_stock_dividend_scope',proof});resolutions.push({code,reason:'missing_or_ambiguous_identity',excludedByUser:true,proof});}
      else pending.push({code,reason:'missing_or_ambiguous_identity'});
    }
    // 新公告缺少净额不能撤销上一份有效估算；保持原证据并留待核验，补齐后同事件替换。
    for(const gap of pending.filter(p=>['missing_net_amount','missing_event_tax_terms','missing_historical_dividend_fx','incomplete_dividend_settlement_terms'].includes(p.reason)&&p.eventKey)) {
      const previous=input.data.cashFlows.find(f=>f.event_key===gap.eventKey&&f.flow_type==='dividend'&&f.origin==='system'&&f.status==='estimated'&&NavMath.isEffectiveFlow(f));
      if(previous&&(!gap.receiptDate||previous.date===gap.receiptDate)&&!dividends.some(f=>f.event_key===previous.event_key))dividends.push({...previous,amount:Number(previous.amount)});
    }
    const computed=calculateRepo(input.data,anchor,targetDate,calendarFor(calendar.years),dividends,{rates:input.rates,sourceAdmission:input.sourceAdmission?.payload||{status:'pending_evidence'},fallbackThrough:'2026-10-10',excludedEvents:input.userExcluded});
    pending.push(...computed.pending);
    for(const trade of computed.trades.filter(r=>r.rateSource==='market_daily_weighted')) resolutions.push({code:'204001.SH',eventKey:'repo:204001.SH:'+trade.tradeDate,reason:'market_daily_rate_available',rateEvidence:trade.rateEvidence});
    await client.query('BEGIN');
    const lockedAccount=await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[input.account.id]);
    if(!lockedAccount.rowCount) throw Object.assign(new Error('账户已删除'),{status:409});
    const lockedVersion=(await client.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE',[username,accountName])).rows[0]?.version || 0;
    if(lockedVersion!==inputVersion) throw Object.assign(new Error('账户版本已变化，请重试'),{status:409});
    const fresh=await readInputs(client,username,accountName,targetDate);
    if(hash(input)!==hash(fresh)) throw Object.assign(new Error('收益输入已变化，请重试'),{status:409});
    const existing=fresh.data.cashFlows.filter(f=>f.origin==='system');
    const wanted=new Set(computed.flows.map(f=>f.event_key+'|'+f.flow_type));
    let changed=0,earliest=null;
    async function writeRevision(old,row,reason) {
      const revision=(old?.revision || 0)+1;
      await client.query(`INSERT INTO cash_flow_revisions(account_id,flow_id,event_key,revision,before_value,after_value,reason,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.account.id,row.id,row.event_key,revision,old||null,row,reason,username]);
      changed++; const affected=old?.date&&old.date<row.date?old.date:row.date;if(!earliest || affected<earliest) earliest=affected;
      return revision;
    }
    for(const flow of computed.flows) {
      const old=existing.find(f=>f.event_key===flow.event_key && f.flow_type===flow.flow_type);
      // 实收替换估算后保留实收；分红规则重建仍允许纠正原计算记录。
      if(old?.status==='confirmed' && old.quality_status!=='calculated_from_implemented_action') continue;
      if(old && old.status===flow.status && Number(old.amount)===flow.amount && old.date===flow.date && old.anchor_date===anchor.date && hash(old.evidence)===hash(flow.evidence)) continue;
      const id=old?.id || 'income_'+hash([input.account.id,flow.event_key,flow.flow_type]).slice(0,28);
      const revision=await writeRevision(old,{...flow,id},old?'recalculation':'initial_calculation');
      await client.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,amount_cny,flow_type,origin,status,event_key,
        anchor_date,instrument_id,quality_status,calculation_version,evidence,note,revision,created_at)
        VALUES($1,$2,$3,$4,$5::date,$6,$6,$7,'system',$8,$9,$10::date,$11,$12,$13,$14,$15,$16,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
        ON CONFLICT(username,account_name,id) DO UPDATE SET date=EXCLUDED.date,amount=EXCLUDED.amount,amount_cny=EXCLUDED.amount_cny,
          status=EXCLUDED.status,anchor_date=EXCLUDED.anchor_date,quality_status=EXCLUDED.quality_status,evidence=EXCLUDED.evidence,
          revision=EXCLUDED.revision,calculation_version=EXCLUDED.calculation_version,note=EXCLUDED.note`,
        [id,username,accountName,input.account.id,flow.date,flow.amount,flow.flow_type,flow.status,flow.event_key,anchor.date,flow.instrument_id||null,
          flow.quality_status,VERSION,flow.evidence,flow.note,revision]);
    }
    for(const old of existing.filter(f=>f.date>anchor.date && f.date<=computed.processedThrough && f.status!=='revoked' &&
      f.calculation_version===VERSION && !wanted.has(f.event_key+'|'+f.flow_type) && (f.status==='estimated'||f.quality_status==='calculated_from_implemented_action'))) {
      const revision=await writeRevision(old,{...old,status:'revoked'},'no_longer_eligible');
      await client.query('UPDATE cash_flows SET status=\'revoked\',revision=$2 WHERE username=$3 AND account_name=$4 AND id=$1',[old.id,revision,username,accountName]);
    }
    const last=computed.trades.at(-1);
    const state={version:VERSION,targetDate,anchorDate:anchor.date,anchorCash:Number(anchor.cashCny),changed,pending,excluded,dividendTaxAssessments,upcomingDividends,repoSourceAdmission:input.sourceAdmission?{...input.sourceAdmission.payload,rawRecordId:input.sourceAdmission.raw_record_id}:{status:'pending_evidence',gaps:['source_admission_not_recorded']},
      dividendCalculated:round(dividends.filter(f=>f.flow_type==='dividend').reduce((s,f)=>s+f.amount,0)),deferredTaxCalculated:round(dividends.filter(f=>f.flow_type==='dividend_tax').reduce((s,f)=>s+f.amount,0)),
      repoNetCalculated:round(computed.flows.filter(f=>/^repo_/.test(f.flow_type)).reduce((s,f)=>s+f.amount,0)),
      repoTrades:computed.trades.length,repoPolicy:'GC001_daily_weighted_fallback_through_2026_10_10',repoFallbackThrough:'2026-10-10',repoOccupiedPrincipal:last?.availableDate>targetDate?last.principal:0,
      status:pending.length?'partial':'calculated',brokerReconciled:false};
    state.repoMarketRateDays=computed.trades.filter(t=>t.rateSource==='market_daily_weighted').length;
    state.repoFallbackDays=computed.trades.length-state.repoMarketRateDays;
    state.progress={targetFrom:anchor.date,targetThrough:targetDate,processedThrough:computed.processedThrough,remainingStages:pending.length?['source_or_settlement_evidence']:[],nextAttemptAt:pending.length?new Date(Date.now()+86400000).toISOString():null};
    state.pendingLifecycle=await require('./cashIncomePending').syncPending(client,input.account.id,pending,inputVersion,username,resolutions);
    state.pendingCounts=Object.fromEntries(['pending','resolved','excluded_by_user','source_blocked'].map(s=>[s,state.pendingLifecycle.filter(r=>r.state===s).length]));
    await client.query('UPDATE accounts SET cash_income_policy=$2,cash_income_state=$3 WHERE id=$1',
      [input.account.id,{...input.account.cash_income_policy,enabled:true,version:VERSION,authorizedBy:username,scope:'after_latest_imported_cash',calculationBasis:'announcements_and_existing_trades',brokerStatementsRequired:false,enabledAt:input.account.cash_income_policy?.enabledAt||new Date().toISOString()},state]);
    if(changed) await require('./tradeLedger').markNavDirty(client,username,accountName,earliest,'cashflow');
    // 在原历史资产口径上增量接入收益；不伪造缺失历史价格，保留基准与原始资产值。
    // 每行保存已应用金额，重跑、更正和实际替换均从原值计算，不能再次叠加。
    const ledger=(await client.query('SELECT *,date::text FROM cash_flows WHERE account_id=$1',[input.account.id])).rows;
    const navs=(await client.query(`SELECT *,date::text FROM nav_history WHERE username=$1 AND account_name=$2
      AND date >= $3 ORDER BY date FOR UPDATE`,[username,accountName,anchor.date])).rows;
    let previous=null,navUpdated=0;
    for(const nav of navs) {
      if(nav.date>targetDate) break;
      if(nav.is_locked || nav.snapshot_source==='imported') {previous=nav;continue;}
      const amount=round(ledger.filter(f=>f.origin==='system' && f.date>anchor.date && f.date<=nav.date && NavMath.isEffectiveFlow(f))
        .reduce((sum,f)=>sum+Number(f.amount),0));
      const base=nav.diagnostics?.cashIncomeBaseAsset ?? Number(nav.total_asset);
      if(!Number.isFinite(base) || !previous) continue;
      const total=round(base+amount);
      const external=ledger.filter(f=>NavMath.isExternalTransfer(f)&&f.date>previous.date&&f.date<=nav.date).reduce((s,f)=>s+Number(f.amount),0);
      const value=Math.round(NavMath.chainNav(Number(previous.nav),Number(previous.total_asset),total,external)*1000000)/1000000;
      if(!Number.isFinite(value) || value<=0) continue;
      const diagnostics={...nav.diagnostics,cashIncomeBaseAsset:base,cashIncomeApplied:amount,cashIncomeVersion:VERSION,
        cashIncomeIncludesEstimates:true,historicalValuation:'preserved_existing_asset_basis',brokerReconciled:false};
      if(Number(nav.total_asset)!==total || Math.abs(Number(nav.nav)-value)>0.00000001 || hash(nav.diagnostics)!==hash(diagnostics)) {
        await client.query(`UPDATE nav_history SET total_asset=$4,nav=$5,calc_status='estimated',diagnostics=$6
          WHERE username=$1 AND account_name=$2 AND date=$3`,[username,accountName,nav.date,total,value,diagnostics]);
        navUpdated++;
      }
      previous={...nav,total_asset:total,nav:value};
    }
    state.navUpdated=navUpdated;
    state.historicalNavBasis='existing_asset_values_plus_cash_income';
    // 旧脏日期不清除：本阶段只应用现金收益，历史行情/持仓待办仍由既有重放处理。
    await client.query('UPDATE accounts SET cash_income_state=$2 WHERE id=$1',[input.account.id,state]);
    if(navUpdated) await client.query(`UPDATE account_data SET nav_version=COALESCE(nav_version,0)+1,
      version=COALESCE(version,0)+1 WHERE username=$1 AND account_name=$2`,[username,accountName]);
    await client.query('COMMIT');
    return state;
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}
module.exports={settleCashIncome,calculateRepo,holdingAt,calendarFor,hkDividendCalendar,shiftDay,VERSION,userTaxExemption,userScopeExclusion};
