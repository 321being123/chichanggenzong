const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('public/shared/core-returns.js', 'utf8').split('// ===================== 基金净值法收益')[0];
function setup(storage = new Map()) {
  const elements = { 'cf-amount': {value:'380000'}, 'cf-note': {value:''}, 'cf-confirm': {disabled:false} };
  const calls = [], toasts = [], updates = [];
  const c = { window:{__cfDir:'in'}, document:{getElementById:id=>elements[id] || null},
    sessionStorage:{getItem:k=>storage.get(k) || null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k)},
    currentAccount:'A', username:'u', accountIdentity:'i', data:{}, dataVersion:1,
    uid:(()=>{let n=0;return()=>String(++n)})(), todayCN:()=> '2026-10-29',
    showToast:s=>toasts.push(s), refreshDataFromServer:d=>updates.push(d), closeCashFlowModal:()=>{},
    renderAll:()=>{}, fmt:String, captureSmartImportScope:()=>({generation:c.generation}),
    isSmartImportScopeCurrent:s=>s.generation===c.generation, generation:0 };
  c.window.siteApi = { requestRaw:(url,opts)=>{ calls.push({url,body:JSON.parse(opts.body)}); return c.request(); } };
  vm.createContext(c); vm.runInContext(source,c);
  return {c,elements,calls,toasts,updates};
}
(async()=>{
  let t=setup(), resolve;
  t.c.request=()=>new Promise(r=>resolve=r);
  const first=t.c.addCashFlow(); await t.c.addCashFlow();
  assert.equal(t.calls.length,1,'提交中双击不能发出第二次请求');
  resolve({response:{ok:true,status:200,json:async()=>({ok:true,data:{version:2}})}}); await first;
  assert.equal(t.updates.length,1); assert(t.toasts.some(s=>s.includes('已记录')));

  t=setup(); t.c.request=async()=>({error:'timeout'}); await t.c.addCashFlow();
  assert(t.toasts.some(s=>s.includes('待确认')));
  const original=t.calls[0].body.cashFlow;
  t.c.request=async()=>({response:{ok:true,status:200,json:async()=>({ok:true,data:{version:2}})}});
  await t.c.addCashFlow();
  assert.deepStrictEqual(t.calls[1].body.cashFlow,original,'未知结果重试必须复用同一ID与载荷');

  const storage = new Map(); t=setup(storage); t.c.request=async()=>({error:'timeout'}); await t.c.addCashFlow();
  const beforeReload=t.calls[0].body.cashFlow;
  const reloaded=setup(storage); reloaded.c.uid=()=> 'new-after-reload'; reloaded.c.request=async()=>({response:{ok:true,status:200,json:async()=>({ok:true,data:{}})}});
  await reloaded.c.addCashFlow();
  assert.deepStrictEqual(reloaded.calls[0].body.cashFlow,beforeReload,'刷新后重试仍必须使用原ID');
  assert.equal(storage.size,0,'确认成功后清除未确认请求');

  t=setup(); t.c.request=async()=>({error:'timeout'}); await t.c.addCashFlow();
  t.elements['cf-amount'].value='10'; await t.c.addCashFlow();
  assert.equal(t.calls.length,1,'未知结果未核对不能变更金额后重试');

  t=setup(); t.c.request=async()=>({response:{ok:false,status:500,json:async()=>({error:'内部错误'})}});
  await t.c.addCashFlow(); await t.c.addCashFlow();
  assert.equal(t.calls[0].body.cashFlow.id,t.calls[1].body.cashFlow.id,'服务端错误也可能已提交，重试保留原ID');

  t=setup(); t.c.request=async()=>({error:'timeout'}); await t.c.addCashFlow();
  t.c.request=async()=>({response:{ok:false,status:409,json:async()=>({error:'版本冲突'})}});
  await t.c.addCashFlow(); t.elements['cf-amount'].value='20'; await t.c.addCashFlow();
  assert.equal(t.calls.length,2,'先前结果不明时，重试冲突不能清除原ID并允许新金额');
  assert(t.toasts.some(s=>s.includes('待确认')));

  t=setup(); t.c.request=async()=>({response:{ok:true,status:200,json:async()=>({})}});
  await t.c.addCashFlow(); await t.c.addCashFlow();
  assert.equal(t.calls[0].body.cashFlow.id,t.calls[1].body.cashFlow.id,'缺少明确成功标识时结果仍待确认');

  t=setup(); t.c.request=()=>new Promise(r=>resolve=r); const old=t.c.addCashFlow();
  t.c.currentAccount='B'; t.c.generation++; t.c.data={};
  resolve({response:{ok:true,status:200,json:async()=>({ok:true,data:{version:2}})}}); await old;
  assert.equal(t.updates.length,0,'旧账户响应不能覆盖新账户');

  t=setup(); t.c.request=async()=>({response:{ok:false,status:400,json:async()=>({error:'无效金额'})}});
  await t.c.addCashFlow(); t.elements['cf-amount'].value='20'; await t.c.addCashFlow();
  assert.notEqual(t.calls[0].body.cashFlow.id,t.calls[1].body.cashFlow.id,'明确拒绝后允许纠正并创建新记录');
  t=setup(); t.c.window.__cfDir='out'; t.c.request=async()=>({response:{ok:true,status:200,json:async()=>({ok:true,data:{}})}});
  await t.c.addCashFlow(); assert.equal(t.calls[0].body.cashFlow.amount,-380000);
  t=setup(); t.c.refreshDataFromServer=()=>{throw new Error('UI');};
  t.c.request=async()=>({response:{ok:true,status:200,json:async()=>({ok:true,data:{}})}});
  await t.c.addCashFlow(); assert(t.toasts.some(s=>s.includes('已记录')),'界面刷新失败不能误报流水失败');
  t=setup(); t.c.renderAll=()=>{throw new Error('render')};
  t.c.request=async()=>({response:{ok:true,status:200,json:async()=>({ok:true,data:{}})}});
  await t.c.addCashFlow(); assert(t.toasts.some(s=>s.includes('已记录')),'确认后渲染失败不得提示重试');
  console.log('资金流水前端：确认、幂等重试、重复点击与账户隔离通过');
})().catch(e=>{console.error(e);process.exitCode=1});


// --- cash-income-panel.test.js ---
{
const assert=require('assert'),fs=require('fs'),path=require('path');
const {JSDOM}=require('jsdom');
const source=f=>fs.readFileSync(path.join(__dirname,'../../public',f),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,20));
(async()=>{
for(const width of [320,360,390,430,760,768,900,1024,1440]) {
  const dom=new JSDOM('<button id="trigger">收益明细</button>',{url:'https://example.test',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,d=w.document;w.innerWidth=width;w.matchMedia=q=>({matches:width<=Number(q.match(/\d+/)[0]),addEventListener(){}});
  w.currentAccount='本账户';w.dataVersion=1;w.api=s=>s;w.todayCN=()=> '2026-10-10';w.escapeHtml=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));w.showToast=()=>{};w.renderAll=()=>{};w.loadData=async()=>({});
  let requests=[];w.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({cash_income_state:{upcomingDividends:[{code:'00546.HK',receiptDate:'2026-10-12',eventKey:'dividend:fixture'}]},rows:[{date:'2026-09-03',amount:'1.23',flow_type:'repo_interest',status:'estimated',event_key:'repo:204001.SH:2026-09-02',evidence:{rateSource:'market_daily_weighted'}}],pending:[]})};};
  w.eval(source('js/api/client.js'));w.eval(source('shared/mobile-ui.js'));w.eval(source('shared/cash-income-panel.js'));await tick();
  d.getElementById('trigger').focus();await w.openCashIncomePanel();await tick();
  assert.strictEqual(requests.length,1);assert(!d.getElementById('income-actual-json'));assert.strictEqual(d.getElementById('income-flow-type').value,'repo_interest');
  assert(d.getElementById('income-summary').textContent.includes('00546.HK（2026-10-12）'),'待到账日期展示且不新增取数');
  d.getElementById('income-amount').value='1.230000';d.getElementById('income-reference').value='实际凭证';
  d.getElementById('income-actual-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
  const posted=JSON.parse(requests.find(r=>r.options?.method==='POST').options.body).records[0];assert.strictEqual(posted.amountCny,'1.230000');assert.strictEqual(posted.originalAmount,'1.230000');
  const count=requests.length;w.dispatchEvent(new w.Event('resize'));await tick();assert.strictEqual(requests.length,count,'旋转不取数');
  d.getElementById('income-close').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();assert(!d.getElementById('cash-income-panel'));assert.strictEqual(d.activeElement.id,'trigger');
  w.close();
}
// 读取未完成时关闭弹窗，响应不得写入另一账户或已删除DOM。
const dom=new JSDOM('<button id="trigger">收益</button>',{runScripts:'outside-only'}),w=dom.window;
w.currentAccount='A';w.api=s=>s;let release;w.fetch=()=>new Promise(r=>release=r);w.eval(source('js/api/client.js'));w.eval(source('shared/cash-income-panel.js'));
const opened=w.openCashIncomePanel();w.closeCashIncomePanel();w.currentAccount='B';release({ok:true,json:async()=>({rows:[]})});await opened;assert(!w.document.getElementById('cash-income-panel'));w.close();
console.log('cash income panel: nine viewport DOMs, form amounts, keyboard, focus, resize and stale response passed (no visual/device claims)');
})().catch(e=>{console.error(e);process.exitCode=1;});

}
