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
  w.eval(source('shared/mobile-ui.js'));w.eval(source('shared/cash-income-panel.js'));await tick();
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
w.currentAccount='A';w.api=s=>s;let release;w.fetch=()=>new Promise(r=>release=r);w.eval(source('shared/cash-income-panel.js'));
const opened=w.openCashIncomePanel();w.closeCashIncomePanel();w.currentAccount='B';release({ok:true,json:async()=>({rows:[]})});await opened;assert(!w.document.getElementById('cash-income-panel'));w.close();
console.log('cash income panel: nine viewport DOMs, form amounts, keyboard, focus, resize and stale response passed (no visual/device claims)');
})().catch(e=>{console.error(e);process.exitCode=1;});
