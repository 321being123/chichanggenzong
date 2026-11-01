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
