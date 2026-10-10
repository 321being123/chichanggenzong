// 股息结算纯内核；无取数、无默认税率。实际凭证始终优先，测算不是实收。
const DateApi=require('../../public/shared/core-date');
const VERSION='dividend-settlement-v1';
const TAX_RULE='https://www.chinatax.gov.cn/n810341/n810755/c1797427/content.html';
const FIFO_RULE='https://www.chinatax.gov.cn/chinatax/n810341/n810765/n812151/n812386/c1082457/content.html';
const HK_RULE='https://www.chinaclear.cn/zdjs/editor_file/20141112162543709.pdf';
const HK_TAX_RULE='https://fgk.chinatax.gov.cn/zcfgk/c102416/c5203646/content.html';
const SCALE=1000000000000n;
function decimal(value,{signed=false}={}){if(typeof value!=='string'||!new RegExp(signed?'^-?\\d+(?:\\.\\d{1,12})?$':'^\\d+(?:\\.\\d{1,12})?$').test(value))throw new TypeError('结算数值必须是至多12位小数文本');const negative=value[0]==='-',parts=(negative?value.slice(1):value).split('.');const result=BigInt(parts[0])*SCALE+BigInt((parts[1]||'').padEnd(12,'0'));return negative?-result:result;}
function text(value){const sign=value<0n?'-':'';value=value<0n?-value:value;return sign+(value/SCALE)+'.'+(value%SCALE).toString().padStart(12,'0');}
function centFloor(value){return text(value/10000000000n*10000000000n).slice(0,-10);}
function date(value){const d=DateApi.normalizeBusinessDate(value);if(!d)throw new TypeError('无效结算日期');return d;}
function anniversary(day,months){date(day);const [y,m,d]=day.split('-').map(Number),index=y*12+m-1+months,year=Math.floor(index/12),month=index%12+1;const last=new Date(Date.UTC(year,month,0)).getUTCDate();return `${year}-${String(month).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;}
function taxRate(acquired,sold){date(acquired);date(sold);if(sold<acquired)throw new TypeError('卖出日在购入日前');return sold<=anniversary(acquired,1)?0.2:sold<=anniversary(acquired,12)?0.1:0;}
function taxEvent(parent,saleId){return parent+':tax:'+Buffer.from(String(saleId),'utf8').toString('base64url');}
function parseCnTaxTreatment(body){
  const flat=String(body||'').replace(/\s+/g,'');
  const excerpt=flat.match(/(?:自然人股东|个人投资者|个人股东)[\s\S]{0,350}?暂不扣缴个人所得税/)?.[0];
  if(!excerpt||!/(?:2015.{0,8}101|财税.{0,12}101)/.test(flat))return null;
  return {version:VERSION,kind:'CN_personal_deferred_2015',investor:'mainland_personal_unrestricted',initialWithholdingRate:'0',sourceExcerpt:excerpt,rule:TAX_RULE,brokerVerified:false};
}
function parseHkTaxTreatment(body){
  const flat=String(body||'').replace(/\s+/g,'');
  const none=flat.match(/股息所涉及的代扣所得[稅税]不適用/);
  if(none)return {kind:'HK_connect_personal',amountBasis:'gross',issuerWithholding:'none_in_event_announcement',sourceExcerpt:none[0],layers:[{rate:'0.20',base:'gross',sourceRef:HK_TAX_RULE}],brokerVerified:false};
  for(const m of flat.matchAll(/20[%％]/g)){
    const excerpt=flat.slice(Math.max(0,m.index-80),m.index+180);
    if(/(?:內地|内地)(?:個人|个人)/.test(excerpt)&&/(?:滬港通|沪港通|深港通|港股通)/.test(excerpt))return {kind:'HK_connect_personal',amountBasis:'gross',sourceExcerpt:excerpt,layers:[{rate:'0.20',base:'gross',sourceRef:'event_announcement_connect_personal_20_percent'}],brokerVerified:false};
  }
  return null;
}
function hkReceiptDate(payDate,calendar){
  date(payDate);let current=payDate;const countedDays=[];
  while(countedDays.length<3){
    const instant=new Date(current+'T12:00:00+08:00');instant.setUTCDate(instant.getUTCDate()+1);
    current=DateApi.dateInZone(instant,'Asia/Shanghai');
    const facts=calendar(current);
    if(!facts||typeof facts.isOpen!=='boolean')return {reason:'missing_hk_dividend_calendar',missingDate:current};
    if(facts.isOpen)countedDays.push({date:current,source:facts.source,evidence:facts.evidence});
  }
  return {receiptDate:current,countedDays,calendarBasis:'local_cn_holidays_and_local_hkex_calendar',settlementDateBasis:'announced_pay_date_plus_3_stock_connect_trading_days_estimate'};
}
function estimateHkAnnouncement({actions,quantity,fxRows=[],receiptDate}){
  if(!DateApi.normalizeBusinessDate(receiptDate)||actions.some(a=>receiptDate<=a.pay_date))return {reason:'missing_hk_dividend_calendar'};
  if(!Number.isSafeInteger(quantity)||quantity<0)return {reason:'unverified_share_quantity'};
  const components=new Map();
  for(const action of actions){
    const fact=action.raw_payload||{},component=[fact.period||'',fact.dividendType||'',fact.dividendNature||''].join('|');
    if(components.has(component))continue; // 最新同分派组成覆盖旧版；普通/特别股息分别保留。
    components.set(component,action);
  }
  let total=0n;const evidence=[];
  for(const action of components.values()){
    const fact=action.raw_payload||{},tax=fact.taxTreatment;
    if(!fact.documentId||!fact.contentHash||tax?.kind!=='HK_connect_personal')return {reason:'missing_event_tax_terms'};
    const currency=action.currency_code;
    const fx=currency==='CNY'?{rate:'1',rate_date:receiptDate,source_id:null}:fxRows.filter(r=>r.base_currency===currency&&r.quote_currency==='CNY'&&r.rate_date<=receiptDate).at(-1);
    if(!fx)return {reason:'missing_historical_dividend_fx'};
    const perShare=tax.amountBasis==='net'?action.cash_per_share_after_tax:action.cash_per_share_pre_tax;
    if(perShare==null)return {reason:'missing_dividend_gross_amount'};
    const originalAmount=text(decimal(String(perShare))*BigInt(quantity));
    try{
      const calculation=calculateHkNet({amountBasis:tax.amountBasis,originalAmount,layers:tax.layers||[],currency,fxRate:String(fx.rate),settlementDate:receiptDate,sourceRef:fact.url||String(fact.documentId)});
      total+=decimal(calculation.amountCny);evidence.push({actionId:action.action_id,documentId:fact.documentId,contentHash:fact.contentHash,dividendType:fact.dividendType,dividendNature:fact.dividendNature,taxTreatment:tax,fxDate:fx.rate_date,fxSourceId:fx.source_id,calculation});
    }catch(e){return {reason:'incomplete_dividend_settlement_terms',detail:e.message};}
  }
  return {amount:Number(centFloor(total)),components:evidence,receiptDate,settlementDateBasis:'announced_pay_date_plus_3_stock_connect_trading_days_estimate',fxBasis:'latest_local_historical_rate_on_or_before_estimated_receipt_date',brokerVerified:false};
}
function assessDeferredTax({trades,code,recordDate,payDate,targetDate,grossPerShare,eventKey,expectedQuantity,positionHistoryReason}){
  date(recordDate);date(payDate);date(targetDate);
  const gross=grossPerShare==null?null:decimal(String(grossPerShare)),lots=[],sales=[],gaps=[];
  if(gross===null)gaps.push({reason:'missing_dividend_gross_amount'});
  if(recordDate<'2015-09-08')gaps.push({reason:'unsupported_historical_tax_rule'});
  if(positionHistoryReason)gaps.push({reason:positionHistoryReason});
  const rows=trades.filter(t=>t.code===code&&String(t.trade_date||t.date).slice(0,10)<=targetDate).sort((a,b)=>String(a.trade_date||a.date).localeCompare(String(b.trade_date||b.date))||String(a.id).localeCompare(String(b.id)));
  const byDay=new Map();for(const r of rows){const d=date(String(r.trade_date||r.date).slice(0,10));if(!byDay.has(d))byDay.set(d,[]);byDay.get(d).push(r);}
  let recorded=false;
  const mark=()=>{for(const lot of lots)lot.entitlement=lot.quantity;recorded=true;};
  for(const [d,group] of byDay){
    if(!recorded&&d>recordDate)mark();
    let delta=0;
    for(const r of group){const q=Number(r.quantity);if(!Number.isSafeInteger(q)||q<0){gaps.push({reason:'unverified_share_quantity',tradeId:r.id});continue;}
      if(r.direction==='adjust'){gaps.push({reason:'unverified_corporate_action_or_position_adjustment',tradeId:r.id});continue;}
      if(r.direction==='open'){if(lots.length||recorded)gaps.push({reason:'unverified_opening_lot_order',tradeId:r.id});lots.push({id:r.id,quantity:q,acquired:null,entitlement:recorded?0:q});}
      else if(r.direction==='buy')delta+=q;else if(r.direction==='sell')delta-=q;else gaps.push({reason:'unsupported_share_change',tradeId:r.id});
    }
    // 税务规则以账户每日日终净增减股数计，不重复计算当日回转成交。
    if(delta>0)lots.push({id:group.filter(r=>r.direction==='buy').map(r=>r.id).join(','),quantity:delta,acquired:d,entitlement:0});
    if(delta<0){let remaining=-delta;const saleId=group.filter(r=>r.direction==='sell').map(r=>r.id).join(','),parts=[];
      for(const lot of lots){const sold=Math.min(lot.quantity,remaining);if(!sold)continue;const eligible=recorded?Math.min(sold,lot.entitlement):0;lot.quantity-=sold;lot.entitlement-=eligible;remaining-=sold;
        if(eligible){const rate=lot.acquired?taxRate(lot.acquired,d):null;parts.push({lotId:lot.id,acquired:lot.acquired,quantity:eligible,rate});}
        if(!remaining)break;
      }
      if(remaining)gaps.push({reason:'incomplete_fifo_position_history',date:d,remaining});
      if(parts.length){const known=parts.every(p=>p.rate!==null)&&gross!==null&&recordDate>='2015-09-08';const units=known?parts.reduce((sum,p)=>sum+gross*BigInt(p.quantity)*BigInt(Math.round(p.rate*100))/100n,0n):null;
        const amount=units===null?null:text((units+5000000000n)/10000000000n*10000000000n).slice(0,-10);
        sales.push({eventKey:taxEvent(eventKey,saleId),parentEventKey:eventKey,saleId,saleDate:d,notBefore:payDate>d?payDate:d,amount,parts,status:known?'calculated_pending_actual_deduction':'pending_acquisition_evidence'});
        for(const part of parts.filter(p=>p.rate===null))gaps.push({reason:'missing_acquisition_date',lotId:part.lotId,quantity:part.quantity});
      }
    }
    if(!recorded&&d===recordDate)mark();
  }
  if(!recorded)mark();
  if(expectedQuantity!=null&&lots.reduce((n,l)=>n+l.quantity,0)!==Number(expectedQuantity))gaps.push({reason:'fifo_position_does_not_reconcile'});
  const remainingEntitlement=lots.filter(l=>l.entitlement>0).map(l=>({lotId:l.id,quantity:l.entitlement,acquired:l.acquired}));
  for(const lot of remainingEntitlement.filter(l=>!l.acquired))gaps.push({reason:'missing_acquisition_date',lotId:lot.lotId,quantity:lot.quantity});
  if(gaps.length)for(const sale of sales){sale.status='pending_acquisition_evidence';sale.amount=null;}
  return {version:VERSION,code,eventKey,recordDate,payDate,targetDate,scope:'CN_personal_unrestricted_shares',rule:TAX_RULE,fifoRule:FIFO_RULE,sales,remainingEntitlement,gaps,complete:gaps.length===0,brokerVerified:false};
}
function calculateHkNet({amountBasis,originalAmount,layers=[],fxRate,currency='HKD',settlementDate,sourceRef}){
  if(!['gross','net'].includes(amountBasis)||!String(sourceRef||'').trim())throw new TypeError('必须声明股息毛额/净额及结算证据');
  date(settlementDate);let net=decimal(originalAmount),gross=net;const deductions=[];
  if(amountBasis==='net'&&layers.length)throw new TypeError('已税后净额不得重复扣税');
  if(amountBasis==='gross'&&!layers.length)throw new TypeError('毛额必须有逐层税务证据，不能默认20%');
  for(const layer of layers){if(!String(layer.sourceRef||'').trim()||!['gross','previous_net'].includes(layer.base))throw new TypeError('缺计税基数或税务证据');const rate=decimal(layer.rate);if(rate>SCALE)throw new TypeError('税率超过100%');const deduction=(layer.base==='gross'?gross:net)*rate/SCALE;if(deduction>net)throw new TypeError('扣税超过剩余股息');net-=deduction;deductions.push({...layer,amount:text(deduction)});}
  const rate=currency==='CNY'?SCALE:decimal(fxRate);if(rate<=0n)throw new TypeError('结算汇率必须大于零');
  return {version:VERSION,amountBasis,currency,originalAmount,netOriginal:text(net),layers:deductions,fxRate:text(rate),amountCny:centFloor(net*rate/SCALE),settlementDate,sourceRef,rounding:'floor_cent',rule:HK_RULE,brokerVerified:false};
}
module.exports={VERSION,assessDeferredTax,taxRate,anniversary,taxEvent,calculateHkNet,parseCnTaxTreatment,parseHkTaxTreatment,estimateHkAnnouncement,hkReceiptDate};
