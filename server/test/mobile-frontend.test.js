// DOM 行为回归：不启动浏览器，不访问外部数据，不代替真机排版验收。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let checks = 0;
function ok(value, message) { checks++; assert.ok(value, message); }
const tick = () => new Promise(resolve => setTimeout(resolve, 35));

async function fixture(html, width = 390) {
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, media = [];
  w.innerWidth = width;
  w.matchMedia = query => {
    const listeners = [];
    const m = { media: query, matches: width <= Number(query.match(/\d+/)[0]), addEventListener: (_, fn) => listeners.push(fn) };
    media.push({ m, listeners }); return m;
  };
  let requests = 0;
  w.fetch = () => { requests++; throw new Error('纯界面交互不允许请求数据'); };
  w.resizeToWidth = next => {
    w.innerWidth = next;
    media.forEach(({ m, listeners }) => {
      const matches = next <= Number(m.media.match(/\d+/)[0]);
      if (m.matches !== matches) { m.matches = matches; listeners.forEach(fn => fn({ matches })); }
    });
    w.dispatchEvent(new w.Event('resize'));
  };
  w.requests = () => requests;
  await tick();
  return dom;
}
function load(w, file) { w.eval(read('public/' + file)); }
function pointer(w, el, type, x, y) {
  const e = new w.Event(type, { bubbles: true });
  Object.assign(e, { pointerType: 'touch', pointerId: 1, clientX: x, clientY: y }); el.dispatchEvent(e);
}

async function navigation() {
  const dom = await fixture(read('public/index.html'));
  const w = dom.window, d = w.document, originalNav = d.querySelector('.main-nav'), account = d.querySelector('#account-select');
  load(w, 'js/utils.js'); load(w, 'js/access-policy.js'); load(w, 'js/session.js'); load(w, 'js/navigation.js');
  w.loadHomeDashboard = () => {}; w.loadIpo = () => {}; w.loadProfile = () => {};
  w.setupMainNav(); load(w, 'shared/mobile-ui.js');
  const panel = d.querySelector('.mobile-nav-panel'), toggle = d.querySelector('.mobile-nav-toggle');
  ok(panel.querySelector('.main-nav') === originalNav, '手机复用原导航，不复制栏目');
  ok(panel.querySelectorAll('[data-main]').length === 9, '9 个原有栏目完整保留');
  ok(d.querySelector('.mobile-account-tools #account-select') === account, '账户控件移动时保留原节点和状态');
  w.renderTopUser(null);
  ok(panel.querySelector('.guest-avatar') && !panel.querySelector('[href="/admin.html"]'), '游客保持登录入口与原权限');
  w.renderTopUser({ username: 'member', role: 'user' });
  ok(!panel.querySelector('[href="/admin.html"]'), '会员不能因菜单适配获得后台入口');
  w.renderTopUser({ username: 'staff', role: 'admin' });
  ok(panel.querySelector('[href="/admin.html"]'), '管理员原后台入口保留');
  toggle.click();
  ok(!panel.hidden && toggle.getAttribute('aria-expanded') === 'true' && d.body.classList.contains('mobile-overlay-open'), '菜单展开、ARIA 与背景锁定同步');
  panel.querySelector('[data-main="ipo"]').click();
  ok(panel.hidden && d.querySelector('#main-ipo.active') && w.location.search === '?main=ipo', '原 switchMain 和地址更新保持正常，选中后关闭菜单');
  ok(d.querySelector('.mobile-current-page').textContent === '打新日历', '当前栏目标题同步');
  toggle.click();
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(panel.hidden && d.activeElement === toggle, 'Esc 关闭后恢复菜单触发点');
  toggle.click(); w.resizeToWidth(1024);
  ok(d.querySelector('.nav-left .main-nav') === originalNav && !d.body.classList.contains('mobile-overlay-open'), '切回桌面恢复原节点和页面滚动');
  ok(d.querySelector('.holdings-header #account-select') === account, '切回桌面恢复账户工具条');
  w.resizeToWidth(390);
  d.querySelector('#mobile-knowledge-categories').click();
  ok(d.querySelector('#ks-sidebar-content.mobile-expanded'), '分类展开复用完整分类树容器');
  d.querySelector('#mobile-knowledge-outline').click();
  ok(d.querySelector('#ks-read-outline.mobile-expanded'), '手机目录可展开');
  const safetyFilter = d.getElementById('bond-val-safety'), moreFilters = d.querySelector('.mobile-filter-toggle');
  safetyFilter.selectedIndex = 1;
  const selectedSafety = safetyFilter.value;
  safetyFilter.dispatchEvent(new w.Event('change', { bubbles: true })); moreFilters.click();
  ok(moreFilters.textContent.includes('已选 1 项') && d.querySelector('.mobile-filter-details.mobile-expanded'), '次要筛选展开并提示已有选择');
  moreFilters.click(); w.resizeToWidth(1440);
  ok(d.getElementById('bond-val-safety') === safetyFilter && safetyFilter.value === selectedSafety, '收起筛选与旋转不清空原值、不重建控件');
  ok(w.requests() === 0, '菜单、身份渲染和旋转不额外取数');
  dom.window.close();
}

async function standaloneAndDialogs() {
  for (const file of fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.html'))) {
    const html = read('public/' + file), dom = await fixture(html);
    const d = dom.window.document;
    ok(/width=device-width/.test(d.querySelector('meta[name=viewport]').content), file + ' 有设备视口');
    ok(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b/.test(d.querySelector('meta[name=viewport]').content), file + ' 保留缩放');
    ok(d.querySelector('script[src^="shared/mobile-ui.js?v="]'), file + ' 接入共享移动能力');
    load(dom.window, 'shared/mobile-ui.js');
    if (file === 'admin.html') {
      const button = d.querySelector('.mobile-nav-toggle'); button.click();
      ok(d.querySelectorAll('.mobile-nav-panel .admin-menu-item').length === 9, '后台 9 个菜单保留完整名字，券商与休市日历已归入全局参数');
      d.querySelector('.admin-menu-item').click();
      ok(d.querySelector('.mobile-nav-panel').hidden, '后台选择菜单后收起');
    }
    if (file === 'login.html') ok(d.querySelector('#username').type === 'text', '登录字段未被替换');
    dom.window.close();
  }
  const dom = await fixture('<button id="trigger">打开</button>');
  const w = dom.window, d = w.document;
  load(w, 'shared/dialog.js'); load(w, 'shared/mobile-ui.js');
  const trigger = d.getElementById('trigger'); trigger.focus();
  const result = w.projectConfirm('确认保存？'); await tick();
  const overlay = d.getElementById('project-dialog');
  ok(overlay.querySelector('.mobile-dialog-header #project-dialog-close') && overlay.querySelector('.mobile-dialog-content #project-dialog-input'), '弹窗复用原关闭和输入节点');
  const cancel = d.getElementById('project-dialog-cancel'); cancel.focus();
  cancel.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  ok(overlay.classList.contains('show'), '取消按钮 Enter 不能被全局监听误确认');
  cancel.click();
  ok(await result === false, '取消沿用原结果'); await tick();
  ok(d.activeElement === trigger && !d.body.classList.contains('mobile-overlay-open'), '弹窗关闭恢复原触发点和滚动');
  const second = w.projectPrompt('名称', { value: '测试' }); await tick();
  d.getElementById('project-dialog-input').value = '新名称'; d.getElementById('project-dialog-confirm').click();
  ok(await second === '新名称', '提示输入确认值未被布局修改破坏');
  await tick(); trigger.focus();
  const dynamic = d.createElement('div'); dynamic.className = 'modal-overlay show'; dynamic.id = 'dynamic';
  const modalMarkup = '<div class="modal"><h2>编辑</h2><button class="modal-close" type="button">关闭</button><input value="待编辑"></div>';
  dynamic.innerHTML = modalMarkup; d.body.appendChild(dynamic); await tick();
  dynamic.innerHTML = modalMarkup; await tick();
  ok(dynamic.querySelectorAll('.mobile-dialog-header').length === 1 && dynamic.contains(d.activeElement), '弹窗重绘重新适配且焦点仍在当前弹窗');
  dynamic.remove(); await tick();
  ok(d.activeElement === trigger && !d.body.classList.contains('mobile-overlay-open'), '动态弹窗删除后恢复触发点并释放滚动锁');
  w.close();
}

async function tables() {
  const table = '<div class="biz-table-scroll"><table class="biz-table"><thead><tr><th>代码</th><th onclick="window.sorted++">转债名称</th><th>现价</th></tr></thead><tbody><tr><td>001234</td><td>示例转债</td><td>123.456</td></tr></tbody></table></div>';
  const dom = await fixture('<div class="nav"></div><div id="main-bond-safety" class="main-page active"><div class="bond-header"></div><div id="bond-list-table">' + table + '</div></div>');
  const w = dom.window, d = w.document;
  // 几何夹具只验证滚动算法，不能作为像素排版结果。
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [this.getBoundingClientRect()]; };
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    let top = -80, height = 900, width = this.tagName === 'TABLE' ? 1200 : 390;
    if (this.classList.contains('nav')) { top = 0; height = 52; }
    if (this.classList.contains('bond-header')) { top = 52; height = 46; }
    if (/^(TH|THEAD|TR)$/.test(this.tagName)) { height = 52; if (this.tagName === 'TH') width = 112; }
    return { top, bottom: top + height, left: 0, right: width, width, height };
  };
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 390 });
  Object.defineProperty(w.HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 1200 });
  load(w, 'shared/business-table.js');
  const host = d.getElementById('bond-list-table');
  w.BusinessTable.attach(host, { page: '#main-bond-safety', top: '#main-bond-safety > .bond-header' }); await tick();
  ok(host.querySelectorAll('tbody tr')[0].cells.length === 3 && host.querySelector('td').textContent === '001234', '手机不删原代码列，保留前导零');
  ok(host.querySelector('tbody td:last-child').textContent === '123.456', '数值精度保持原样');
  ok(host.querySelector('td.biz-identity .biz-identity-code').textContent === '001234', '身份列附代码');
  ok(host.querySelectorAll('.biz-table-scroll-hint').length === 1, '自动发现与业务接入不重复提示');
  const floating = d.querySelector('.biz-table-floating-head');
  ok(floating.style.top === '98px', '表头位于当前主导航与二级导航下方');
  w.sorted = 0; host.querySelector('th.biz-identity').onclick = () => w.sorted++;
  floating.querySelector('th.biz-identity').click();
  ok(w.sorted === 1, '浮动表头点击只转发一次原排序');
  host.querySelector('.biz-table-scroll').scrollLeft = 150; w.BusinessTable.sync(); await tick();
  ok(floating.querySelector('th.biz-identity').style.transform === 'translateX(0px)', '手机浮动身份列按源表头位置对齐，不重复补偿横向偏移');
  host.innerHTML = table; w.BusinessTable.sync(); await tick();
  ok(host.querySelectorAll('.biz-table-scroll-hint').length === 1 && host.querySelector('td.biz-identity'), '筛选重绘后恢复提示与身份列');
  d.getElementById('main-bond-safety').classList.remove('active'); w.BusinessTable.sync(); await tick();
  ok(floating.hidden, '切离页面后隐藏浮动表头');
  w.close();
}

async function charts() {
  const dom = await fixture('<div id="chart"><svg></svg><div id="tip" hidden></div><input id="draft" value="原值"></div><button id="outside">关闭提示</button>');
  const w = dom.window, d = w.document, chart = d.getElementById('chart'), svg = d.querySelector('svg'), tip = d.getElementById('tip');
  tip.getBoundingClientRect = () => ({ width: 200, height: 80 });
  Object.defineProperty(chart, 'clientWidth', { get: () => w.innerWidth - 24 });
  load(w, 'shared/chart-interaction.js');
  let shows = 0, redraws = 0;
  w.ChartInteraction.bind(svg, tip, () => { shows++; tip.textContent = '2026-09-04：123.456'; tip.style.display = 'block'; });
  pointer(w, svg, 'pointerdown', 370, 300); pointer(w, svg, 'pointerup', 370, 300);
  ok(shows === 1 && !tip.hidden, '触屏点按显示数据');
  ok(parseFloat(tip.style.left) + 200 <= w.innerWidth, '提示定位夹紧视口右边缘');
  pointer(w, d.getElementById('outside'), 'pointerdown', 0, 0);
  ok(tip.hidden, '点击外部关闭提示');
  pointer(w, svg, 'pointerdown', 10, 10); pointer(w, svg, 'pointerup', 10, 100);
  ok(shows === 1, '纵向滑动不误当点按');
  pointer(w, svg, 'pointerdown', 10, 10); pointer(w, svg, 'pointercancel', 10, 10); pointer(w, svg, 'pointerup', 10, 10);
  ok(shows === 1, '取消手势不会打开提示');
  w.ChartInteraction.watch(chart, () => { redraws++; d.getElementById('draft').value = '被重绘'; });
  d.getElementById('draft').value = '未提交的输入';
  w.resizeToWidth(430); await tick();
  ok(redraws === 1 && d.getElementById('draft').value === '未提交的输入', '宽度变化只重绘并保留未提交输入');
  w.resizeToWidth(430); await tick();
  ok(redraws === 1 && w.requests() === 0, '相同宽度不重复重绘，旋转不取数');
  w.close();
}

async function tradeHistory() {
  for (const width of [320, 360, 390, 430, 759, 760, 761, 768, 899, 900, 901, 1024, 1440]) {
    const dom = await fixture(read('public/index.html'), width), w = dom.window, d = w.document;
    const host = d.getElementById('trades-table');
    ok(!host.classList.contains('trade-list'), '交易历史不再套旧内部纵向滚动容器');
    w.data = { trades: [], positions: [], cashFlows: [
      {id:'interest',date:'2026-10-09',amount:123.22,flow_type:'repo_interest',code:'204001',name:'GC001',origin:'system',status:'estimated',note:'一天期逆回购市场日加权利率计算（含费用）'},
      {id:'fee',date:'2026-10-09',amount:-1.17,flow_type:'repo_fee',code:'204001',name:'GC001',origin:'system',status:'estimated',note:'一天期逆回购市场日加权利率计算（含费用）'},
      {id:'imported',date:'2026-10-08',amount:2,origin:'imported',note:'导入凭证'},
      {id:'manual',date:'2026-10-08',amount:3,origin:'manual',note:'用户说明（含费用）'},
      {id:'dividend',date:'2026-10-07',amount:10,flow_type:'dividend',code:'00941',name:'中国移动',origin:'system',status:'estimated'},
      {id:'tax',date:'2026-10-07',amount:-1,flow_type:'dividend_tax',code:'000672',name:'上峰水泥',origin:'system',status:'estimated'},
      {id:'unknown',date:'2026-10-06',amount:1,flow_type:'dividend',origin:'system',status:'estimated'}
    ] };
    load(w, 'js/utils.js'); w.fmt = n => '¥' + Number(n).toFixed(2);
    let attached;
    w.BusinessTable = { attach: (root, options) => { attached = {root, options}; } };
    load(w, 'shared/core-tables.js');
    const before = JSON.stringify(w.data);
    w.renderTrades();
    const rows = host.querySelectorAll('tbody tr');
    ok(attached.root === host && attached.options.top === '#main-holdings > .holdings-header', '交易历史使用当前持仓导航下的共享吸顶入口');
    ok(rows[0].cells[6].textContent === '+¥123.22' && rows[1].cells[6].textContent === '-¥1.17', '利息毛收入和费用支出分列，金额未重复扣费');
    ok(rows[0].cells[1].textContent === '204001' && rows[0].cells[2].textContent === 'GC001' && rows[1].cells[2].textContent === 'GC001', '回购利息和费用展示实际品种代码与名称');
    ok(rows[4].cells[1].textContent === '00941' && rows[4].cells[2].textContent === '中国移动' && rows[4].cells[3].textContent === '股票分红', '分红证券身份与业务方向分列');
    ok(rows[5].cells[1].textContent === '000672' && rows[5].cells[2].textContent === '上峰水泥' && rows[5].cells[3].textContent === '分红扣税', '扣税沿用对应股票身份');
    ok(rows[6].cells[1].textContent === '-' && rows[6].cells[2].textContent === '-', '缺身份不猜名称或使用流水类型冒充');
    ok(rows[2].cells[1].textContent === '现金' && rows[3].cells[1].textContent === '现金', '外部入出金仍展示现金');
    ok(rows[0].cells[9].textContent.includes('利息未扣费用，费用单列') && rows[1].cells[9].textContent.includes('手续费；单独扣除'), '存量系统回购说明区分利息与费用');
    ok(rows[0].cells[10].textContent === '系统计算 · 不可直接删除' && rows[2].cells[10].textContent === '导入记录 · 不可直接删除', '受保护来源直接可见，不依赖悬停');
    ok(host.querySelectorAll('[data-act="deleteCashFlow"]').length === 1 && rows[3].cells[9].textContent === '用户说明（含费用）', '手工流水仍可删除，用户原说明保留');
    ok(JSON.stringify(w.data) === before && w.requests() === 0, '展示修正不写数据、不取数');
    w.close();
  }
}

async function positionDailyZero() {
  for (const width of [320,360,390,430,760,768,900,1024,1440]) {
    const dom = await fixture('<div id="stats-container"></div><div id="positions-table"></div><div id="topn-table"></div>',width), w=dom.window,d=w.document;
    load(w,'js/utils.js');w.todayCN=()=> '2026-10-11';
    w.data={cash:0,hkRate:0.9,positions:[
      {code:'600000',name:'A股',subtype:'沪市',price:10.1,quantity:100},
      {code:'00700',name:'港股',subtype:'港股',price:20,quantity:100}
    ]};w.priceChangeMap={'600000':1,'00700':-2};
    w.marketStateSnapshot={businessDate:'2026-10-11',markets:{CN:{businessDate:'2026-10-11',status:'closed'},HK:{businessDate:'2026-10-11',status:'closed'}}};
    w.calcSummary=()=>({total:3010});w.getMarketValue=p=>p.price*p.quantity;w.fmt=n=>'¥'+Number(n).toFixed(2);w.fmtQty=n=>String(n);
    w.getTypeTag=w.getSubtypeTag=w.sortArrow=()=>'';w.BusinessTable={attach(){}};
    load(w,'shared/core-tables.js');
    w.renderStats();
    ok(d.getElementById('stat-change').textContent==='-','休市缺少完整归因不得猜0');
    w.bindChangeTip=()=>{};
    w.data.navAttribution={complete:true,currentDate:'2026-10-11',totalChange:0,previousTotalAsset:3010};w.renderStats();
    ok(d.getElementById('stat-change').textContent==='0' && d.querySelector('#stat-change span').style.color==='rgb(217, 48, 37)','当日实际金额为0显示红色0');
    w.data.navAttribution.totalChange=12;w.renderStats();
    ok(d.getElementById('stat-change').textContent.includes('12.00'),'非交易日非零汇率收益按实际显示');
    w.data.navAttribution=null;
    for(const id of ['positions-table','topn-table']) {
      w.renderPositionsTable(id);
      const rows=d.getElementById(id).querySelectorAll('tbody tr');
      ok(rows.length===2 && [...rows].every(r=>r.cells[4].textContent==='0.00%' && r.cells[5].textContent==='¥0.00'),'两个市场休市，明细及首页同类表均显示零');
      ok([...rows].every(r=>r.cells[4].classList.contains('positive') && r.cells[5].classList.contains('positive')),'零涨跌和零盈亏复用共享红色');
    }
    w.marketStateSnapshot.markets.HK.status='open';w.renderPositionsTable('positions-table');
    let rows=d.querySelectorAll('#positions-table tbody tr');
    ok(rows[0].cells[4].textContent==='0.00%' && rows[1].cells[4].textContent==='-2.00%' && rows[1].cells[5].classList.contains('negative'),'按证券市场判断休市，开市负数仍绿色');
    w.priceChangeMap['00700']=-0.00001;w.renderPositionsTable('positions-table');rows=d.querySelectorAll('#positions-table tbody tr');
    ok(rows[1].cells[4].textContent==='0.00%' && rows[1].cells[5].textContent==='¥0.00' && rows[1].cells[5].classList.contains('positive'),'精度范围内零值去负零并用红色');
    w.marketStateSnapshot.markets.HK.status='unknown';w.priceChangeMap['00700']=null;w.renderPositionsTable('positions-table');
    ok(d.querySelectorAll('#positions-table tbody tr')[1].cells[5].textContent==='--' && w.requests()===0,'未知行情不伪装成零，渲染不取数');
    w.close();
  }
}

(async () => {
  await navigation(); await standaloneAndDialogs(); await tables(); await charts(); await tradeHistory(); await positionDailyZero();
  console.log('移动端 DOM 行为回归：' + checks + ' 项通过（不含真机视觉验收）');
})().catch(error => { console.error(error); process.exit(1); });
