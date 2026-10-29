// shared/core-trade.js – 交易录入/持仓增删改/截图AI/扫码/导入导出（原 core.js 拆分，全局作用域不变）
// ===================== 交易录入 =====================

// 服务端 ledger 接口返回最新 data 后：恢复行情涨跌幅缓存（priceChangeMap），
// 保持渲染与加载后一致（与 loadData 中 data.changes → priceChangeMap 恢复逻辑相同）
function restorePriceChangeMap() {
  try {
    if (typeof priceChangeMap === 'undefined' || !data) return;
    priceChangeMap = {};
    if (data.changes && typeof data.changes === 'object') {
      Object.keys(data.changes).forEach(function(k) { priceChangeMap[k] = data.changes[k]; });
    }
    (data.positions || []).forEach(function(p) {
      if (p.code && p.price != null && p.price > 0 && priceChangeMap[p.code] === undefined) {
        priceChangeMap[p.code] = null;
      }
    });
  } catch (e) {}
}

// 本地秒级时间字符串 YYYY-MM-DD HH:MM:SS（用于交易/现金流精确排序，东八区）
function nowSec() {
  return CoreDate.dateTimeInZone(new Date(), 'Asia/Shanghai');
}

// 现金自动重算：现金 = 期初本金(cashBase) + 现金流净额 + 交易净额(买入减/卖出加)
// 与后端 loadAccountData 逻辑一致，是现金唯一真相源，避免刷新/覆盖导致现金丢失
function recalcCash() {
  const state = NavMath.cashAt(data, CoreDate.todayInZone('Asia/Shanghai'));
  data.cash = state.value;
  data.cashConfirmed = state.cashConfirmed;
  data.cashEstimatedDelta = state.cashEstimatedDelta;
  data.cashIncludesEstimates = state.cashIncludesEstimates;
  data.cashDataIncomplete = state.incomplete;
}

// 初始化交易录入日期/时间为当前北京时间（打开页面或保存后调用）
function initTradeDateTime() {
  const dateEl = document.getElementById('trade-date');
  const timeEl = document.getElementById('trade-time');
  if (!dateEl || !timeEl) return;
  const now = CoreDate.dateTimeInZone(new Date(), 'Asia/Shanghai');
  if (!now) return;
  const [date, time] = now.split(' ');
  dateEl.value = date;
  // 时间默认填当前时分，但仅在值为空时（避免用户已手动改过被覆盖）
  if (!timeEl.value) timeEl.value = time.slice(0, 5);
}

function getTradeCurrencyMeta(subtype) {
  switch (String(subtype || '').trim()) {
    case '港股': return { code: 'HKD', symbol: 'HK$', name: '港币' };
    case '美股': return { code: 'USD', symbol: 'US$', name: '美元' };
    default: return { code: 'CNY', symbol: '¥', name: '人民币' };
  }
}

function updateTradeCurrencyLabels(subtype) {
  const subEl = document.getElementById('trade-subtype');
  const meta = getTradeCurrencyMeta(subtype || (subEl && subEl.value));
  const labels = [
    ['trade-price-label', '价格'],
    ['trade-amount-label', '成交额'],
    ['trade-commission-label', '手续费'],
    ['trade-stamp-label', '印花税'],
    ['trade-transfer-label', '过户费'],
    ['trade-other-label', '其他费']
  ];
  labels.forEach(function (item) {
    const label = document.getElementById(item[0]);
    if (!label) return;
    const hint = label.querySelector('.auto-hint');
    label.textContent = item[1] + ' (' + meta.name + ' ' + meta.symbol + ')';
    if (hint) {
      label.appendChild(document.createTextNode(' '));
      label.appendChild(hint);
    }
  });
}

// 价格/数量/方向/细类变化时：自动算成交额 + 四费用并填充（手续费/印花税/过户费/其他费可手动改）
function autoCalcTrade() {
  const priceEl = document.getElementById('trade-price');
  const qtyEl = document.getElementById('trade-qty');
  const dirEl = document.getElementById('trade-dir');
  const subEl = document.getElementById('trade-subtype');
  const amtEl = document.getElementById('trade-amount');
  if (!priceEl || !qtyEl || !dirEl || !subEl || !amtEl) return;
  updateTradeCurrencyLabels(subEl.value);
  const price = parseFloat(priceEl.value) || 0;
  const qty = parseInt(qtyEl.value) || 0;
  const amount = Math.round(price * qty * 100) / 100;
  amtEl.value = amount > 0 ? amount : '';
  if (amount <= 0) return;
  const f = calcTradeFees(dirEl.value, amount, subEl.value);
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('trade-commission', f.commission);
  setVal('trade-stamp', f.stamp_tax);
  setVal('trade-transfer', f.transfer_fee);
  setVal('trade-other', f.other_fee);
}

async function addTrade() {
  const code = classifyCode.normalizeCode(document.getElementById('trade-code').value.trim());
  const name = document.getElementById('trade-name').value.trim() || code;
  const direction = document.getElementById('trade-dir').value;
  const price = parseFloat(document.getElementById('trade-price').value);
  const qty = parseInt(document.getElementById('trade-qty').value);
  const type = document.getElementById('trade-type').value;
  const subtype = document.getElementById('trade-subtype').value;
  const note = document.getElementById('trade-note').value.trim();
  // 保存前强制重算费用（双保险：即使前面交互未触发也保证印花税/佣金等正确）
  autoCalcTrade();
  const amount = parseFloat(document.getElementById('trade-amount').value) || price * qty;
  const commission = parseFloat(document.getElementById('trade-commission').value) || 0;
  const stamp_tax = parseFloat(document.getElementById('trade-stamp').value) || 0;
  const transfer_fee = parseFloat(document.getElementById('trade-transfer').value) || 0;
  const other_fee = parseFloat(document.getElementById('trade-other').value) || 0;

  if (!code || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('请填写代码、价格和数量');
    return;
  }

  // 从日期+时间选择器取值，缺省当前时间
  const dateEl = document.getElementById('trade-date');
  const timeEl = document.getElementById('trade-time');
  const pickedDate = dateEl && dateEl.value ? dateEl.value : todayCN();
  const pickedTime = timeEl && timeEl.value ? timeEl.value : '';
  const tradeDate = pickedTime ? (pickedDate + ' ' + pickedTime) : pickedDate;

  const trade = {
    id: uid(), // 幂等键：重复点击/网络重试不会重复建仓（2026-08-04 修复）
    code: code, name: name, direction: direction,
    price: price, quantity: qty, amount: amount,
    commission: commission, stamp_tax: stamp_tax, transfer_fee: transfer_fee, other_fee: other_fee,
    type: type, subtype: subtype, note: note,
    date: tradeDate
  };

  // 服务端统一账本事务（2026-08-03 整改）：持仓/现金由服务端重算并返回，前端不再自行计算
  try {
    const r = await window.tradeLedgerApi.addTrade(currentAccount, dataVersion, trade);
    const j = r.payload;
    if (!r.ok) {
      showToast(j.error || '保存交易失败');
      return;
    }
    if (j.data) {
      data = j.data;
      dataVersion = j.data.version || dataVersion;
      if (typeof j.data.posVersion === 'number') dataPosVersion = j.data.posVersion;
      if (typeof j.data.tradeVersion === 'number') dataTradeVersion = j.data.tradeVersion;
      if (typeof j.data.navVersion === 'number') dataNavVersion = j.data.navVersion;
      if (typeof j.data.cashflowVersion === 'number') dataCashVersion = j.data.cashflowVersion;
      restorePriceChangeMap();
    }
    // 过去日期的交易：触发历史净值精确回填（Tushare 历史回补，不近似）
    if (pickedDate && pickedDate < todayCN()) {
      try {
        const rr = await window.tradeLedgerApi.recomputeNav(currentAccount, pickedDate);
        const jj = rr.payload;
        if (jj && jj.ok) data = await loadData(currentAccount);
      } catch (e) {}
    }
    renderAll();
    showToast('已记录 ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + (name || code));
  } catch (e) {
    showToast('保存失败：' + (e.message || e));
    return;
  }

  document.getElementById('trade-code').value = '';
  document.getElementById('trade-name').value = '';
  document.getElementById('trade-price').value = '';
  document.getElementById('trade-qty').value = '';
  document.getElementById('trade-amount').value = '';
  document.getElementById('trade-note').value = '';
  document.getElementById('trade-commission').value = '';
  document.getElementById('trade-stamp').value = '';
  document.getElementById('trade-transfer').value = '';
  document.getElementById('trade-other').value = '';
  initTradeDateTime(); // 重置日期时间为当前
}

async function deleteTrade(id) {
  // 服务端统一账本事务：删除交易后服务端重放持仓/现金并返回最新结果
  try {
    const r = await window.tradeLedgerApi.deleteTrade(currentAccount, dataVersion, id);
    const j = r.payload;
    if (!r.ok) { showToast(j.error || '删除交易失败'); return; }
    if (j.data) {
      data = j.data;
      dataVersion = j.data.version || dataVersion;
      if (typeof j.data.posVersion === 'number') dataPosVersion = j.data.posVersion;
      if (typeof j.data.tradeVersion === 'number') dataTradeVersion = j.data.tradeVersion;
      if (typeof j.data.navVersion === 'number') dataNavVersion = j.data.navVersion;
      if (typeof j.data.cashflowVersion === 'number') dataCashVersion = j.data.cashflowVersion;
      restorePriceChangeMap();
    }
    renderAll();
    showToast('交易已删除');
  } catch (e) {
    showToast('删除失败：' + (e.message || e));
  }
}

// ===================== 持仓增删改 =====================

let editingId = null;
let deleteTargetId = null;

function editPosition(id) {
  const p = data.positions.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  // 恢复正常编辑模式，启用所有字段
  ['modal-code','modal-name','modal-price','modal-qty','modal-cost','modal-note'].forEach(function(fid) {
    document.getElementById(fid).disabled = false;
  });
  document.getElementById('modal-title').textContent = '编辑持仓';
  document.getElementById('modal-save-btn').textContent = '更新';
  document.getElementById('modal-code').value = p.code || '';
  document.getElementById('modal-name').value = p.name || '';
  document.getElementById('modal-price').value = p.price || '';
  document.getElementById('modal-qty').value = p.quantity || '';
  document.getElementById('modal-cost').value = p.cost || '';
  document.getElementById('modal-note').value = p.note || '';
  document.getElementById('modal-type').value = p.type || '股权';
  document.getElementById('modal-subtype').value = p.subtype || '深市';
  document.getElementById('modal-add').classList.add('show');
}

function editCash() {
  editingId = 'cash';
  // 禁用非类型/细类字段
  ['modal-code','modal-name','modal-price','modal-qty','modal-cost','modal-note'].forEach(function(fid) {
    document.getElementById(fid).disabled = true;
  });
  document.getElementById('modal-title').textContent = '编辑现金';
  document.getElementById('modal-save-btn').textContent = '更新';
  document.getElementById('modal-code').value = '';
  document.getElementById('modal-name').value = '现金';
  document.getElementById('modal-price').value = '';
  document.getElementById('modal-qty').value = '';
  document.getElementById('modal-cost').value = '';
  document.getElementById('modal-note').value = '';
  document.getElementById('modal-type').value = data.cashType || '现金';
  document.getElementById('modal-subtype').value = data.cashSubtype || '现金';
  document.getElementById('modal-add').classList.add('show');
}

function savePosition() {
  const type = document.getElementById('modal-type').value;
  const subtype = document.getElementById('modal-subtype').value;

  // 现金编辑：只更新类型和细类
  if (editingId === 'cash') {
    (async function () {
      try {
        var r = await window.accountNavApi.saveSettings(currentAccount, dataVersion, { cashType: type, cashSubtype: subtype });
        var j = r.payload;
        if (!r.ok) { showToast(j.error || '更新失败'); return; }
        // 同步新版本号（2026-08-04 第二轮修复）
        if (typeof j.version === 'number') dataVersion = j.version;
      } catch(e) { showToast('更新失败：' + (e.message || e)); return; }
      data.cashType = type;
      data.cashSubtype = subtype;
      closeModal('modal-add');
      renderAll();
      showToast('现金已更新');
    })();
    return;
  }

  const code = classifyCode.normalizeCode(document.getElementById('modal-code').value.trim());
  const name = document.getElementById('modal-name').value.trim();
  const price = parseFloat(document.getElementById('modal-price').value);
  const qty = parseInt(document.getElementById('modal-qty').value);
  const cost = parseFloat(document.getElementById('modal-cost').value) || price;
  const note = document.getElementById('modal-note').value.trim();

  if (!code || !price || !qty) { showToast('请填写代码、价格和数量'); return; }

  // P1-6 验收修复：持仓编辑转成「adjust 调整事件」走服务端账本（不再直接改 data.positions + 全量保存）
  if (editingId) {
    const p = data.positions.find(x => x.id === editingId);
    if (!p) { closeModal('modal-add'); return; }
    const delta = qty - (p.quantity || 0);
    // 先更新名称/类型/细类/备注（这些不参与账本，直接改内存后随整包保存）
    var changedMeta = false;
    if (p.name !== name || p.type !== type || p.subtype !== subtype || p.note !== note) {
      p.name = name; p.type = type; p.subtype = subtype; p.note = note;
      changedMeta = true;
    }
    if (delta !== 0) {
      (async function () {
        try {
          var r = await window.holdingsQuoteApi.addPosition(currentAccount, dataVersion,
              {
                id: uid(), // 幂等键：重复点击/网络重试不会重复写入（2026-08-04 修复）
                code: code, name: name || code,
                direction: 'adjust',
                price: cost || price,
                quantity: qty, // adjust 语义 = 调整后目标数量（绝对设置）
                type: type, subtype: subtype,
                date: todayCN(), note: note || ('持仓调整至 ' + qty)
              });
          var j = r.payload;
          if (!r.ok) { showToast(j.error || '保存持仓失败'); return; }
          if (j.data) {
            data = j.data;
            dataVersion = j.data.version || dataVersion;
            if (typeof j.data.posVersion === 'number') dataPosVersion = j.data.posVersion;
            if (typeof j.data.tradeVersion === 'number') dataTradeVersion = j.data.tradeVersion;
            if (typeof j.data.navVersion === 'number') dataNavVersion = j.data.navVersion;
            if (typeof j.data.cashflowVersion === 'number') dataCashVersion = j.data.cashflowVersion;
            restorePriceChangeMap();
          }
          closeModal('modal-add');
          renderAll();
          showToast('已保存 ' + (name || code));
        } catch (e) {
          showToast('保存失败：' + (e.message || e));
        }
      })();
    } else {
      // 数量未变：仅元数据变化，走局部接口
      (async function () {
        try {
          var r2 = await window.holdingsQuoteApi.updatePositionMetadata(editingId, dataVersion,
            { account: currentAccount, name: name, type: type, subtype: subtype, note: note });
          var j2 = r2.payload;
          if (!r2.ok) { showToast(j2.error || '保存失败'); return; }
          // 同步新版本号，防止紧接着的第二次操作误报"其他窗口已修改"（2026-08-04 第二轮修复）
          if (typeof j2.version === 'number') dataVersion = j2.version;
        } catch(e) { showToast('保存失败：' + (e.message || e)); return; }
        closeModal('modal-add');
        renderAll();
        showToast('已保存 ' + (name || code));
      })();
    }
    return;
  }

  // 新增持仓（手动添加新代码）：用 open 期初建仓事件
  (async function () {
    try {
      var r2 = await window.holdingsQuoteApi.addPosition(currentAccount, dataVersion,
          {
            id: uid(), // 幂等键：重复点击/网络重试不会重复建仓（2026-08-04 修复）
            code: code, name: name || code,
            direction: 'open',
            price: cost || price, quantity: qty,
            type: type, subtype: subtype,
            date: todayCN(), note: note || '手动建仓'
          });
      var j2 = r2.payload;
      if (!r2.ok) { showToast(j2.error || '添加持仓失败'); return; }
      if (j2.data) {
        data = j2.data;
        dataVersion = j2.data.version || dataVersion;
        if (typeof j2.data.posVersion === 'number') dataPosVersion = j2.data.posVersion;
        if (typeof j2.data.tradeVersion === 'number') dataTradeVersion = j2.data.tradeVersion;
        if (typeof j2.data.navVersion === 'number') dataNavVersion = j2.data.navVersion;
        if (typeof j2.data.cashflowVersion === 'number') dataCashVersion = j2.data.cashflowVersion;
        restorePriceChangeMap();
      }
      closeModal('modal-add');
      renderAll();
      showToast('已保存 ' + (name || code));
    } catch (e) {
      showToast('添加失败：' + (e.message || e));
    }
  })();
}

function deletePosition(id) {
  const p = data.positions.find(x => x.id === id);
  if (!p) return;
  deleteTargetId = id;
  document.getElementById('delete-msg').textContent =
    '确定删除「' + (p.name || p.code) + '」的持仓记录吗？';
  document.getElementById('delete-confirm-btn').onclick = confirmDelete;
  document.getElementById('modal-delete').classList.add('show');
}

function confirmDelete() {
  if (deleteTargetId) {
    const p = data.positions.find(x => x.id === deleteTargetId);
    deleteTargetId = null;
    // P0-2 验收修复：删除持仓生成「adjust 清仓事件」（目标数量 0），保留账本可追溯性，
    // 不再直接删除持仓快照（否则交易重放与持仓再次不一致）
    if (p && p.code) {
      (async function () {
        try {
          var r = await window.holdingsQuoteApi.addPosition(currentAccount, dataVersion,
              {
                id: uid(), // 幂等键（2026-08-04 修复）
                code: p.code, name: p.name || p.code,
                direction: 'adjust',
                price: p.cost || p.price || 0,
                quantity: 0, // 清仓
                type: p.type || '股权', subtype: p.subtype || '',
                date: todayCN(), note: '删除持仓（清仓）'
              });
          var j = r.payload;
          if (!r.ok) { showToast(j.error || '删除持仓失败'); return; }
          if (j.data) {
            data = j.data;
            dataVersion = j.data.version || dataVersion;
            if (typeof j.data.posVersion === 'number') dataPosVersion = j.data.posVersion;
            if (typeof j.data.tradeVersion === 'number') dataTradeVersion = j.data.tradeVersion;
            if (typeof j.data.navVersion === 'number') dataNavVersion = j.data.navVersion;
            if (typeof j.data.cashflowVersion === 'number') dataCashVersion = j.data.cashflowVersion;
            restorePriceChangeMap();
          }
          renderAll();
          showToast('持仓已删除（记录为清仓调整）');
        } catch (e) {
          showToast('删除失败：' + (e.message || e));
        }
      })();
      closeModal('modal-delete');
      return;
    }
    // 无代码的异常持仓：无法通过 position-events 删除，刷新页面同步服务器数据
    showToast('无法删除该持仓，请刷新页面后重试');
  }
  closeModal('modal-delete');
}

// ===================== 弹窗通用 =====================

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ===================== 截图识别（AI视觉） =====================

var tradeMode = 'manual';

function switchTradeMode(mode) {
  if (tradeMode === 'smart' && mode !== 'smart') invalidateSmartImportScope();
  tradeMode = mode;
  document.getElementById('mode-manual').classList.toggle('active', mode === 'manual');
  document.getElementById('mode-smart').classList.toggle('active', mode === 'smart');
  var tms = document.getElementById('trade-manual-section'); if (tms) { tms.classList.remove('js-hidden'); tms.style.display = mode === 'manual' ? '' : 'none'; }
  var tss = document.getElementById('trade-smart-section'); if (tss) { tss.classList.remove('js-hidden'); tss.style.display = mode === 'smart' ? '' : 'none'; }
  if (mode === 'smart') { initVisionQr(); } else { stopVisionQr(); }
}

// ===================== 智能导入：多图队列 / 合并 / 预览 / 确认 =====================
// 方案 4.3/4.4：多图逐张识别（复用单图接口、并发固定 1）、持仓有条件合并、稳定 rowId、
// 提交结果语义（已保存/已存在/失败/待确认）、幂等 id 复用。
var _visionQueue = [];        // [{ imageId, name, preview, base64, status, items, error, parse }]
var _smartParsed = [];        // 合并后的预览行（每行带 _rowId/_eventId/_imageTags/_v）
var _smartBatchId = null;
var _smartSubmitting = false;
var _visionClearWhenComplete = false;
var _smartRowSeq = 0;
var _smartScopeGeneration = 0;
var _smartBoundScope = '';
var VISION_MAX_IMAGES = 6;            // 每批最多 6 张（与服务端一致）
var VISION_MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 单张原始文件 ≤ 6MiB（与服务端一致）

function captureSmartImportScope() {
  return { generation: _smartScopeGeneration, user: typeof username === 'string' ? username : '',
    identity: typeof accountIdentity === 'string' ? accountIdentity : '', account: typeof currentAccount === 'string' ? currentAccount : '' };
}

function isSmartImportScopeCurrent(scope) {
  var now = captureSmartImportScope();
  return !!scope && scope.generation === now.generation && scope.user === now.user &&
    scope.identity === now.identity && scope.account === now.account;
}

function invalidateSmartImportScope() {
  _smartScopeGeneration++;
  _smartBoundScope = '';
  _visionQueue = [];
  _visionClearWhenComplete = false;
  _smartParsed = [];
  _smartBatchId = null;
  _smartSubmitting = false;
  _visionPaused = false;
  window._smartAccount = null;
  if (typeof _qrPollTimer !== 'undefined' && _qrPollTimer) clearInterval(_qrPollTimer);
  _qrPollTimer = null;
  _qrToken = null;
  _qrGeneration = (_qrGeneration || 0) + 1;
  var qr = document.getElementById('qr-image'); if (qr) qr.src = '';
  var qrStatus = document.getElementById('qr-status');
  if (qrStatus) qrStatus.innerHTML = '二维码已暂停 <button class="btn btn-outline btn-sm" data-act="initVisionQr">重新生成二维码</button>';
  var loading = document.getElementById('smart-loading'); if (loading) loading.style.display = 'none';
  setSmartButtonsDisabled(false);
  renderVisionQueue();
  renderSmartItems();
}

function bindSmartImportScope() {
  var scope = captureSmartImportScope();
  var key = JSON.stringify([scope.user, scope.identity, scope.account]);
  if (_smartBoundScope !== key) {
    invalidateSmartImportScope();
    _smartBoundScope = key;
    window._smartAccount = scope.account;
  }
  return captureSmartImportScope();
}

function newSmartRowId() {
  _smartRowSeq += 1;
  return 'row' + _smartRowSeq + Math.random().toString(36).slice(2, 6);
}

function smartRowById(rowId) {
  for (var i = 0; i < (_smartParsed || []).length; i++) {
    if (_smartParsed[i]._rowId === rowId) return { item: _smartParsed[i], index: i };
  }
  return null;
}

async function handleVisionFile(event) {
  // 只处理 change：input/click 代理事件也会命中本入口，重复入队会让同批图片识别两次
  if (event && event.type && event.type !== 'change') return;
  var files = Array.prototype.slice.call(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  enqueueVisionFiles(files);
}

async function handleExcelFile(event) {
  var file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  await doSmartParse(file, 'excel');
}

// 图片入队（选择/拖拽/粘贴/扫码统一入口）：读取文件前校验，不让新结果直接覆盖已有预览
function enqueueVisionFiles(files) {
  // 文件读取也绑定账号实体、账户和本次切换代数。
  var scope = bindSmartImportScope();
  var added = 0;
  var pending = [];
  var overCount = 0;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!file || (file.type && file.type.indexOf('image') !== 0)) continue;
    if (_visionQueue.length + added >= VISION_MAX_IMAGES) {
      showToast('每批最多 ' + VISION_MAX_IMAGES + ' 张图片，多余的未加入');
      break;
    }
    if (file.size > VISION_MAX_IMAGE_BYTES) {
      overCount++;
      continue;
    }
    added++;
    pending.push(file);
  }
  // 超限合并为一条提示：多选时逐张弹提示会被冲掉，用户看不出有几张没进来
  if (overCount) showToast(overCount + ' 张图片超过 6MB 未加入，请重新截图或分批上传');
  if (!pending.length) return;
  Promise.all(pending.map(function(file) {
    return fileToBase64(file).then(function(base64) {
      return { file: file, base64: base64 };
    }, function() {
      // 单张读取失败只跳过该张，不拖垮整批（原 Promise.all 一张失败整批静默卡死）
      showToast('「' + (file.name || '图片') + '」读取失败，已跳过');
      return null;
    });
  })).then(function(results) {
    if (!isSmartImportScopeCurrent(scope)) return;
    var dupCount = 0;
    var fullCount = 0;
    (results || []).forEach(function(r) {
      if (!r) return;
      if (_visionQueue.length >= VISION_MAX_IMAGES) { fullCount++; return; }
      // 同一张图片不允许重复导入（2026-10-27 反馈）：与队列已有图片内容相同直接跳过
      if (isDuplicateVisionImage(r.base64)) { dupCount++; return; }
      _visionQueue.push({
        imageId: 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: r.file.name || '截图',
        preview: r.base64,
        base64: r.base64,
        status: 'queued',
        items: null,
        error: null
      });
    });
    if (dupCount) showToast(dupCount + ' 张与队列中已有图片相同，未重复导入');
    if (fullCount) showToast('队列已满，' + fullCount + ' 张图片未加入');
    if (!isSmartImportScopeCurrent(scope)) return;
    renderVisionQueue();
    processVisionQueue();
  });
}

// 图片内容去重：队列最多 6 张，直接比对 base64 内容即可（同一图片同一编码必相等）
function isDuplicateVisionImage(base64) {
  for (var i = 0; i < _visionQueue.length; i++) {
    if (_visionQueue[i].base64 === base64) return true;
  }
  return false;
}

// 拖拽/粘贴图片统一进队列（方案 4.3 统一入口）：多图队列重构时旧的拖拽/粘贴初始化被删，
// 2026-10-27 反馈"拖拽没生效、浏览器直接打开图片"后补回，统一走 enqueueVisionFiles
(function initVisionDropPaste() {
  var section = document.getElementById('trade-smart-section');
  var zone = document.getElementById('vision-zone');
  if (section) {
    section.addEventListener('dragover', function(e) {
      e.preventDefault(); // 不阻止默认行为时松手浏览器会直接打开图片
      if (zone) zone.classList.add('dragover');
    });
    section.addEventListener('dragleave', function() {
      if (zone) zone.classList.remove('dragover');
    });
    section.addEventListener('drop', function(e) {
      e.preventDefault();
      if (zone) zone.classList.remove('dragover');
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) enqueueVisionFiles(files); // 非图片/超限在入队校验里统一过滤提示
    });
  }
  document.addEventListener('paste', function(e) {
    if (tradeMode !== 'smart') return;
    var tradesPage = document.getElementById('page-trades');
    if (!tradesPage || !tradesPage.classList.contains('active')) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var images = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var blob = items[i].getAsFile();
        if (blob) images.push(blob);
      }
    }
    if (images.length) {
      e.preventDefault();
      enqueueVisionFiles(images);
    }
  });
})();

// 并发固定 1，逐图独立识别；成功结果本次会话复用，不重新调用模型；只重试失败图
var _visionProcessing = false;
var _visionProcessingGeneration = null;
var _visionPaused = false;
async function processVisionQueue() {
  var scope = captureSmartImportScope();
  if (_visionProcessingGeneration === scope.generation) return;
  _visionProcessingGeneration = scope.generation;
  _visionProcessing = true;
  try {
    while (true) {
      if (!isSmartImportScopeCurrent(scope)) return;
      if (_visionPaused) break;
      var job = _visionQueue.find(function(candidate) { return candidate.status === 'queued'; });
      if (!job) break;
      job.status = 'parsing';
      renderVisionQueue();
      try {
        var raw = await window.siteApi.requestRaw('/api/vision-parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: job.base64 }),
          timeoutMs: 0
        });
        if (!raw.response) throw new Error(raw.error || '网络异常');
        var r = raw.response;
        var d = await r.json().catch(function() { return {}; });
        // 账户已切换：旧响应作废，不恢复旧预览
        if (!isSmartImportScopeCurrent(scope)) return;
        if (_visionQueue.indexOf(job) < 0) continue;
        if (r.status === 429) {
          // 遇限流按服务端提示暂停，保留队列
          job.status = 'queued';
          _visionPaused = true;
          showToast(d.error || 'AI 识别请求过于频繁，稍后可点“继续识别”');
          break;
        }
        if (d.error) {
          job.status = 'failed';
          job.error = d.error;
        } else if (d.parse && d.parse.status && d.parse.status !== 'ok') {
          job.status = 'failed';
          job.error = d.parse.message || '识别不出内容';
          job.parse = d.parse;
        } else {
          job.status = 'done';
          job.items = d.items || [];
          job.parse = d.parse || null;
          mergeSmartItems(job.items, job.imageId);
        }
      } catch (e) {
        if (!isSmartImportScopeCurrent(scope)) return;
        if (_visionQueue.indexOf(job) < 0) continue;
        job.status = 'failed';
        job.error = (e && e.message) || '网络错误';
      }
      renderVisionQueue();
      renderSmartItems();
    }
  } finally {
    if (_visionProcessingGeneration === scope.generation) {
      _visionProcessingGeneration = null;
      _visionProcessing = false;
      if (isSmartImportScopeCurrent(scope)) { clearCompletedVisionBatch(); renderVisionQueue(); renderSmartItems(); }
    }
  }
}

function resumeVisionQueue() {
  _visionPaused = false;
  processVisionQueue();
}

function retryVisionImage(imageId) {
  for (var i = 0; i < _visionQueue.length; i++) {
    if (_visionQueue[i].imageId === imageId) {
      _visionQueue[i].status = 'queued';
      _visionQueue[i].error = null;
      // 失败图重新识别后，先移除该图上次贡献的行，避免重复
      removeSmartItemsByImage(imageId);
      break;
    }
  }
  renderVisionQueue();
  renderSmartItems();
  _visionPaused = false;
  processVisionQueue();
}

function removeVisionImage(imageId) {
  _visionQueue = _visionQueue.filter(function(j) { return j.imageId !== imageId; });
  removeSmartItemsByImage(imageId);
  clearCompletedVisionBatch();
  renderVisionQueue();
  renderSmartItems();
}

function removeSmartItemsByImage(imageId) {
  _smartParsed = (_smartParsed || []).filter(function(item) {
    item._imageTags = (item._imageTags || []).filter(function(t) { return t !== imageId; });
    return item._imageTags.length > 0;
  });
}

function renderVisionQueue() {
  var box = document.getElementById('vision-queue');
  if (!box) return;
  if (!_visionQueue.length) { box.innerHTML = ''; return; }
  var html = '<div data-style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">';
  _visionQueue.forEach(function(job) {
    var label = job.status === 'queued' ? '待识别' : job.status === 'parsing' ? '识别中…' : job.status === 'done' ? '已完成' : '失败';
    var color = job.status === 'failed' ? '#d93025' : job.status === 'done' ? '#137333' : '#6e6e6e';
    var errText = job.status === 'failed' && job.error ? String(job.error) : '';
    html += '<div data-style="width:96px;text-align:center;">' +
      '<img src="' + job.preview + '" data-style="width:96px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #e0e0e0;" alt="">' +
      '<div data-style="font-size:11px;color:' + color + ';"' + (errText ? ' title="' + escapeHtml(errText) + '"' : '') + '>' + label + '</div>' +
      // 失败原因直接显示（2026-10-27 反馈：只显示“失败”看不出为什么），悬停看完整原因
      (errText ? '<div data-style="font-size:10px;color:#d93025;max-height:30px;overflow:hidden;" title="' + escapeHtml(errText) + '">' + escapeHtml(errText) + '</div>' : '') +
      '<div data-style="display:flex;gap:4px;justify-content:center;">' +
      (job.status === 'failed' ? '<button class="btn btn-outline btn-sm" data-act="retryVisionImage" data-arg1="' + job.imageId + '">重试</button>' : '') +
      '<button class="btn btn-outline btn-sm" data-act="removeVisionImage" data-arg1="' + job.imageId + '">删除</button>' +
      '</div></div>';
  });
  html += '</div>';
  if (_visionPaused) {
    html += '<div data-style="margin-bottom:8px;"><button class="btn btn-primary btn-sm" data-act="resumeVisionQueue">继续识别剩余图片</button></div>';
  }
  box.innerHTML = html;
}

// 持仓合并条件（方案 4.3 第 4 条）：同一证券身份、币种、数量单位、快照日期，
// 且数量/已知成本等共同字段一致 → 合并（补齐空字段、来源合并、数量不相加）；
// 字段冲突/缺日期证据 → 保留为待核对候选，不按上传先后覆盖。
function smartMergeKey(item) {
  return [item.kind, item.code, item.name || '', item.date || '',
    item.quote_currency || item.currency || '', item.quantity_unit || '',
    item.quantity == null ? '' : String(item.quantity),
    item.cost == null ? '' : String(item.cost),
    item.avg_buy_price == null ? '' : String(item.avg_buy_price)].join('|');
}

// 保留真实识别日期；仅把明确的年月日格式规范化，不把无法识别的日期猜成今天。
function normalizeSmartDate(value) {
  var raw = String(value == null ? '' : value).trim();
  var m = /^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/.exec(raw);
  var iso = m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : raw;
  return CoreDate.normalizeBusinessDate(iso) || '';
}

function updateSmartDateIssue(item, date) {
  if (!item._v) item._v = { status: 'ok', issues: [] };
  if (!Array.isArray(item._v.issues)) item._v.issues = [];
  item._v.issues = item._v.issues.filter(function(issue) { return issue.field !== 'date'; });
  if (!date) item._v.issues.push({ level: 'error', field: 'date', message: item.kind === 'trade' ? '请补全交易日期' : '请选择快照日期' });
  item._v.status = item._v.issues.some(function(issue) { return issue.level === 'error'; }) ? 'blocked' :
    (item._v.issues.length ? 'review' : 'ok');
}

function mergeSmartItems(items, imageTag) {
  if (!window._smartParsed) window._smartParsed = [];
  (items || []).forEach(function(item) {
    item.code = classifyCode.normalizeCode(item.code || '', item.name || '');
    // 持仓缺快照日期 → 默认今天，用户可在预览里改（2026-10-27 用户裁定；交易缺日期仍要求补全）
    var rawDate = String(item.date == null ? '' : item.date).trim();
    item.date = rawDate ? normalizeSmartDate(rawDate) : (item.kind === 'position' ? CoreDate.todayInZone('Asia/Shanghai') || '' : '');
    updateSmartDateIssue(item, item.date);
    item._rowId = newSmartRowId();
    item._eventId = item._eventId || uid();          // 幂等键：重试复用同一 id
    item._imageTags = [imageTag || 'image'];
    item._mergedFrom = [imageTag || 'image'];
    if (item.kind === 'position' && item.date) {
      // 只有身份/来源日期证据齐全才尝试合并
      var dup = null;
      for (var i = 0; i < _smartParsed.length; i++) {
        var ex = _smartParsed[i];
        if (ex.kind === 'position' && smartMergeKey(ex) === smartMergeKey(item)) { dup = ex; break; }
      }
      if (dup) {
        // 补齐空字段，保留来源；数量不相加
        ['cost', 'avg_buy_price', 'market_price', 'market_value', 'currency', 'quote_currency', 'quantity_unit'].forEach(function(f) {
          if ((dup[f] === null || dup[f] === undefined || dup[f] === '') && item[f] !== null && item[f] !== undefined && item[f] !== '') dup[f] = item[f];
        });
        dup._imageTags = (dup._imageTags || []).concat(item._imageTags);
        dup._mergedFrom = (dup._mergedFrom || []).concat(item._mergedFrom);
        return;
      }
    }
    _smartParsed.push(item);
  });
}

// 手机扫码传来的图片批量入队（与本地选图同一队列）
function enqueueBase64Images(images, namePrefix) {
  bindSmartImportScope();
  var dupCount = 0;
  (images || []).forEach(function(base64, i) {
    if (_visionQueue.length >= VISION_MAX_IMAGES) return;
    if (isDuplicateVisionImage(base64)) { dupCount++; return; }
    _visionQueue.push({
      imageId: 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: (namePrefix || '手机上传') + (i + 1),
      preview: base64,
      base64: base64,
      status: 'queued',
      items: null,
      error: null
    });
  });
  if (dupCount) showToast(dupCount + ' 张与队列中已有图片相同，未重复导入');
  renderVisionQueue();
  processVisionQueue();
}

function parseResultHint(d) {
  if (d && d.parse && d.parse.message) return d.parse.message;
  return null;
}

async function doSmartParse(file, source) {
  var loading = document.getElementById('smart-loading');
  if (source === 'vision') {
    // 图片统一进队列逐张识别（不直接覆盖预览）
    enqueueVisionFiles([file]);
    return;
  }
  var scope = bindSmartImportScope();
  var result = document.getElementById('smart-result');
  if (loading) loading.style.display = 'block';

  try {
    var base64 = await fileToBase64(file);
    if (!isSmartImportScopeCurrent(scope)) return;
    if (loading) loading.innerHTML = '<span class="spinner"></span>AI识别中...';
    var raw2 = await window.siteApi.requestRaw('/api/excel-parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: base64 }),
      timeoutMs: 0
    });
    if (!raw2.response) throw new Error(raw2.error || '网络异常');
    var r2 = raw2.response;
    var d = await r2.json();
    if (!isSmartImportScopeCurrent(scope)) return;

    if (loading) loading.style.display = 'none';

    if (d.error) {
      if (result) result.innerHTML = '<div class="u-c-danger u-pad-8-10">识别失败: ' + escapeHtml(d.error) + '</div>';
      return;
    }

    if (!d.items || d.items.length === 0) {
      if (result) result.innerHTML = renderSmartEmptyHint(parseResultHint(d));
      return;
    }

    // Excel 结果整表替换预览（非多图队列场景）
    _smartParsed = [];
    mergeSmartItems(d.items, file.name || 'Excel');
    renderVisionQueue();
    renderSmartItems();
  } catch(e) {
    if (!isSmartImportScopeCurrent(scope)) return;
    if (loading) loading.style.display = 'none';
    if (result) result.innerHTML = '<div class="u-c-danger u-pad-8-10">识别失败: ' + escapeHtml(e.message) + '</div>';
  }
}

// 识别为空/失败时的可操作指引（方案 4.5 第 2 条，替换原“未能识别出交易或持仓信息”单句）
function renderSmartEmptyHint(message) {
  return '<div data-style="padding:12px;border:1px dashed #d0d7e2;border-radius:8px;color:#5f6b7a;font-size:13px;line-height:1.8;">' +
    '<b>' + escapeHtml(message || '未能识别出交易或持仓信息') + '</b><br>' +
    '请改截「持仓明细」或「交割单」这类逐行列表，避免只截首页行情总览：<br>' +
    '· 持仓截图需包含：代码、名称、成本价/买入均价、持仓数量、单位、日期<br>' +
    '· 交易截图需包含：代码、名称、成交价、数量、买卖方向、日期及可见税费<br>' +
    '账号可以遮住，表头和证券字段请保留完整。</div>';
}

function renderSmartItems() {
  var result = document.getElementById('smart-result');
  if (!result) return;
  // 重渲染前先把所有行的编辑值写回状态（2026-10-27 反馈：单行确认后其他行改过的日期被刷没）
  syncAllSmartRowsFromDom();
  var items = window._smartParsed || [];
  if (items.length === 0) { result.innerHTML = ''; return; }

  window._smartFeeRates = buildSmartFeeRates(items);
  var rawCount = 0;
  (_visionQueue || []).forEach(function(j) { if (j.items) rawCount += j.items.length; });
  if (!_visionQueue.length) rawCount = items.length;
  var reviewCount = items.filter(function(it) { return it._v && it._v.status === 'review'; }).length;
  var blockedCount = items.filter(function(it) { return it._v && it._v.status === 'blocked'; }).length;
  var mergedCount = items.filter(function(it) { return (it._mergedFrom || []).length > 1; }).length;
  var okCount = items.length - reviewCount - blockedCount;
  var failedImages = (_visionQueue || []).filter(function(j) { return j.status === 'failed'; }).length;

  var html = '';
  if (_visionQueue.length) {
    html += '<div data-style="margin-bottom:8px;padding:8px 10px;background:#f4f7fd;border-radius:8px;font-size:12px;color:#4a5568;">' +
      '图片：成功 ' + (_visionQueue.length - failedImages) + ' / 失败 ' + failedImages +
      '；识别原始行 ' + rawCount + '，合并 ' + mergedCount + '，可录入 ' + okCount +
      '，待核对 ' + reviewCount + '，需处理 ' + blockedCount +
      '（合并后条数不代表识别完整，请对照原图核对）</div>';
  }
  html += renderSmartFeeRates(window._smartFeeRates) +
    '<div class="u-mb-8"><button class="btn btn-success btn-sm" id="smart-confirm-all-btn" data-act="confirmAllSmartItems">✅ 全部录入</button></div>' +
    '<div class="biz-table-scroll"><table class="biz-table biz-table--preview"><thead><tr>' +
    '<th>类型</th><th>日期</th><th>代码</th><th>名称</th><th class="text-right">价格(成本/成交价)</th><th>成本来源</th><th class="text-right">市价</th>' +
    '<th class="text-right">数量</th><th>单位</th><th>币种</th><th>方向</th><th>品种</th><th>状态</th><th>确认</th>' +
    '</tr></thead><tbody>';
  items.forEach(function(item) {
    var rid = item._rowId;
    var code = item.code || '';
    var rec = recognizeCode(code, item.name) || { type: '股权', subtype: '深市' };
    var isTrade = item.kind === 'trade';
    var v = item._v || { status: 'ok', issues: [] };
    var unit = item.quantity_unit || '';
    var cur = item.currency || item.quote_currency || '';
    html += '<tr data-row-id="' + rid + '">' +
      '<td>' + (isTrade ? '<span class="tag tag-equity">交易</span>' : '<span class="tag tag-cash">持仓</span>') + '</td>' +
      '<td><input type="date" id="s-date-' + rid + '" value="' + escapeHtml(item.date || '') + '" data-style="width:118px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td><input type="text" id="s-code-' + rid + '" value="' + escapeHtml(code) + '" data-style="width:76px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td><input type="text" id="s-name-' + rid + '" value="' + escapeHtml(item.name || '') + '" class="u-input-xs"></td>' +
      '<td><input type="number" id="s-price-' + rid + '" value="' + (item.price === null || item.price === undefined ? '' : escapeHtml(String(item.price))) + '" step="0.001" class="u-input-xs" placeholder="' + (isTrade ? '成交价' : '成本价') + '"></td>' +
      '<td data-style="font-size:11px;color:#6e6e6e;">' + (isTrade ? '-' : escapeHtml(item._v && item._v.costSource === 'avg_buy_price' ? '买入均价' : item._v && item._v.costSource === 'cost' ? '成本价' : '缺失')) + '</td>' +
      '<td class="text-right" data-style="font-size:12px;color:#6e6e6e;">' + (isTrade ? '-' : (item.market_price === null || item.market_price === undefined ? '-' : escapeHtml(String(item.market_price)))) + '</td>' +
      '<td><input type="number" id="s-qty-' + rid + '" value="' + (item.quantity === null || item.quantity === undefined ? '' : escapeHtml(String(item.quantity))) + '" step="0.0001" class="u-input-xs"></td>' +
      '<td><select id="s-unit-' + rid + '" data-style="padding:6px 4px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
        ['', '股', '张', '手', '份'].map(function(u) {
          return '<option value="' + u + '"' + (unit === u ? ' selected' : '') + '>' + (u === '' ? '未知' : u) + '</option>';
        }).join('') + '</select></td>' +
      '<td><select id="s-cur-' + rid + '" data-act="revalidateSmartRow" data-arg1="' + rid + '" data-style="padding:6px 4px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
        ['', 'CNY', 'HKD'].map(function(u) {
          return '<option value="' + u + '"' + (cur === u ? ' selected' : '') + '>' + (u === '' ? '自动' : u) + '</option>';
        }).join('') + '</select></td>' +
      '<td>' + (isTrade ? '<select id="s-dir-' + rid + '" data-style="padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
        '<option value="buy"' + (item.direction === 'buy' ? ' selected' : '') + '>买入</option>' +
        '<option value="sell"' + (item.direction === 'sell' ? ' selected' : '') + '>卖出</option>' +
        '</select>' : '-') + '</td>' +
      '<td>' + getTypeTag(rec.type) + ' ' + escapeHtml(rec.subtype || '') + '</td>' +
      '<td id="s-status-' + rid + '" data-style="font-size:11px;max-width:150px;">' + renderSmartRowStatus(item) + '</td>' +
      '<td><button class="btn btn-success btn-sm smart-row-btn" data-act="confirmSmartItem" data-arg1="' + rid + '">确认' + (isTrade ? '录入' : '导入') + '</button>' +
      '<button class="btn btn-outline btn-sm" data-act="excludeSmartRow" data-arg1="' + rid + '">移除</button></td>' +
      '</tr>';
  });
  html += '</tbody></table></div>';
  result.innerHTML = html;
  result.querySelectorAll('input[id^="s-date-"]').forEach(function(input) {
    input.addEventListener('change', function() {
      var found = smartRowById(input.id.slice('s-date-'.length));
      if (!found) return;
      found.item.date = input.value;
      updateSmartDateIssue(found.item, input.value);
      var status = document.getElementById('s-status-' + found.item._rowId);
      if (status) status.innerHTML = renderSmartRowStatus(found.item);
    });
  });
  if (window.BusinessTable) window.BusinessTable.attach(result, { page: '#page-trades', top: '#main-holdings > .holdings-header', sticky: false });
}

function renderSmartRowStatus(item) {
  var v = item._v || { status: 'ok', issues: [] };
  if (!v.issues || v.issues.length === 0) return '<span data-style="color:#137333;">✅ 可录入</span>';
  var tip = v.issues.map(function(i) { return i.message; }).join('；');
  var mark = v.status === 'blocked' ? '⛔' : '⚠';
  var color = v.status === 'blocked' ? '#d93025' : '#b26a00';
  var first = v.issues[0] ? v.issues[0].message : '';
  return '<span data-style="color:' + color + ';" title="' + escapeHtml(tip) + '">' + mark + ' ' + escapeHtml(first) + '</span>';
}

function buildSmartFeeRates(items) {
  var current = getFeeSettings();
  var result = {};
  var rateFields = [
    { fee: 'commission', direct: 'commission_rate', setting: 'commissionRate' },
    { fee: 'stamp_tax', direct: 'stamp_tax_rate', setting: 'stampTaxRate' },
    { fee: 'transfer_fee', direct: 'transfer_fee_rate', setting: 'transferRate' },
    { fee: 'other_fee', direct: 'other_fee_rate', setting: 'otherRate' }
  ];
  (items || []).forEach(function(item) {
    if (item.kind !== 'trade') return;
    var code = item.code || '';
    var rec = recognizeCode(code, item.name) || { subtype: '深市' };
    var group = getFeeGroup(rec.subtype);
    if (!result[group]) result[group] = { config: Object.assign({}, current[group]), sums: {}, direct: {} };
    var summary = result[group];
    var quantity = normalizeQuantity(Number(item.quantity) || 0, code);
    var amount = Number(item.amount) || ((Number(item.price) || 0) * quantity);
    rateFields.forEach(function(field) {
      var directRate = Number(item[field.direct]);
      if (isFinite(directRate) && directRate >= 0 && item[field.direct] !== null && item[field.direct] !== '') {
        summary.direct[field.setting] = summary.direct[field.setting] || [];
        summary.direct[field.setting].push(directRate / 100);
        return;
      }
      var fee = Number(item[field.fee]);
      if (!isFinite(fee) || fee <= 0 || amount <= 0) return;
      if (field.fee === 'commission' && fee <= (summary.config.commissionMin || 0)) return;
      summary.sums[field.setting] = summary.sums[field.setting] || { fee: 0, amount: 0 };
      summary.sums[field.setting].fee += fee;
      summary.sums[field.setting].amount += amount;
    });
    var directMin = Number(item.commission_min);
    if (isFinite(directMin) && directMin >= 0 && item.commission_min !== null && item.commission_min !== '') {
      summary.config.commissionMin = directMin;
    }
  });
  Object.keys(result).forEach(function(group) {
    var summary = result[group];
    rateFields.forEach(function(field) {
      var direct = summary.direct[field.setting];
      var sum = summary.sums[field.setting];
      if (direct && direct.length) summary.config[field.setting] = direct.reduce(function(a, b) { return a + b; }, 0) / direct.length;
      else if (sum && sum.amount > 0) summary.config[field.setting] = sum.fee / sum.amount;
    });
  });
  return result;
}

function renderSmartFeeRates(summaries) {
  var groups = Object.keys(summaries || {});
  var html = '<div data-style="margin-bottom:10px;padding:10px;border:1px solid #d9e2ff;border-radius:8px;background:#f7f9ff;">' +
    '<div data-style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><strong>交易税费明细</strong>' +
    '<button class="btn btn-primary btn-sm" data-act="saveSmartFeeRates">保存税费明细</button></div>';
  if (groups.length === 0) return html + '<span class="u-fs-12 u-c-muted">未识别到可计算费率的交易明细</span></div>';
  groups.forEach(function(group) {
    var cfg = summaries[group].config;
    var meta = FEE_GROUPS.find(function(g) { return g.key === group; });
    var fields = (meta && meta.fields) || ['commission'];
    html += '<div data-style="display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin-top:6px;"><b data-style="font-size:12px;min-width:72px;">' + escapeHtml(meta ? meta.label : group) + '</b>';
    html += feeRateInput('佣金费率(%)', 'smart-' + group + '-commission', pctShow(cfg.commissionRate));
    html += feeRateInput('最低佣金(元)', 'smart-' + group + '-min', cfg.commissionMin || 0);
    if (fields.indexOf('stamp') >= 0) html += feeRateInput('印花税率(%)', 'smart-' + group + '-stamp', pctShow(cfg.stampTaxRate));
    if (fields.indexOf('transfer') >= 0) html += feeRateInput('过户费率(%)', 'smart-' + group + '-transfer', pctShow(cfg.transferRate));
    if (fields.indexOf('other') >= 0) html += feeRateInput('其他费率(%)', 'smart-' + group + '-other', pctShow(cfg.otherRate));
    html += '</div>';
  });
  return html + '</div>';
}

function feeRateInput(label, id, value) {
  return '<label data-style="font-size:11px;color:#666;">' + label + '<input id="' + id + '" type="number" step="any" value="' + value + '" data-style="display:block;width:100px;padding:5px 7px;margin-top:2px;border:1px solid #d8dce8;border-radius:5px;"></label>';
}

async function saveSmartFeeRates() {
  var summaries = window._smartFeeRates || {};
  var settings = Object.assign({}, data.feeSettings || {});
  Object.keys(summaries).forEach(function(group) {
    var cfg = Object.assign({}, getFeeSettings()[group]);
    var meta = FEE_GROUPS.find(function(g) { return g.key === group; });
    var fields = (meta && meta.fields) || ['commission'];
    cfg.commissionRate = pctToRate(document.getElementById('smart-' + group + '-commission').value);
    cfg.commissionMin = Math.max(0, parseFloat(document.getElementById('smart-' + group + '-min').value) || 0);
    if (fields.indexOf('stamp') >= 0) cfg.stampTaxRate = pctToRate(document.getElementById('smart-' + group + '-stamp').value);
    if (fields.indexOf('transfer') >= 0) cfg.transferRate = pctToRate(document.getElementById('smart-' + group + '-transfer').value);
    if (fields.indexOf('other') >= 0) cfg.otherRate = pctToRate(document.getElementById('smart-' + group + '-other').value);
    settings[group] = cfg;
  });
  data.feeSettings = settings;
  try {
    var r = await window.accountNavApi.saveSettings(currentAccount, dataVersion, { feeSettings: data.feeSettings });
    var j = r.payload;
    if (!r.ok) { showToast(j.error || '保存失败'); return; }
    if (typeof j.version === 'number') dataVersion = j.version; // 同步新版本号（2026-08-04 第二轮修复）
  } catch(e) { showToast('保存失败：' + (e.message || e)); return; }
  autoCalcTrade();
  showToast('税费费率已保存并更新到税费设置');
}

function getSmartItemFees(item, code, name, row) {
  var fields = ['commission', 'stamp_tax', 'transfer_fee', 'other_fee'];
  var hasRecognizedFee = fields.some(function(key) { return item[key] !== undefined && item[key] !== null && item[key] !== ''; });
  if (hasRecognizedFee) {
    // 保留截图税费（与税费设置区分）
    return {
      commission: Math.max(0, Number(item.commission) || 0),
      stamp_tax: Math.max(0, Number(item.stamp_tax) || 0),
      transfer_fee: Math.max(0, Number(item.transfer_fee) || 0),
      other_fee: Math.max(0, Number(item.other_fee) || 0)
    };
  }
  // 无识别费用 → 按当前编辑后的代码/方向/价格/标准数量/原币估算（方案 4.4 第 6 条，不引用旧 item）
  var rec = recognizeCode(code, name || item.name) || { subtype: '深市' };
  var quantity = row && row.quantity != null ? row.quantity : normalizeQuantity(Number(item.quantity) || 0, code);
  var price = row && row.price != null ? row.price : (Number(item.price) || 0);
  var amount = price * quantity;
  return calcTradeFees((row && row.direction) || item.direction || 'buy', amount, rec.subtype);
}

async function ensureName(code, currentName) {
  if (currentName && currentName !== code) return currentName;
  var pos = data.positions.find(function(p) { return p.code === code; });
  if (pos && pos.name && pos.name !== code) return pos.name;
  try {
    var q = await fetchQuote(code);
    if (q && q.name) return q.name;
  } catch(e) {}
  return currentName || code;
}

// ---------- 预览行编辑值读取 / 本地重校验 ----------
function smartField(rowId, name) {
  var el = document.getElementById('s-' + name + '-' + rowId);
  return el ? el.value : '';
}

// 提交/校验一律以 DOM 现值为准，不再引用旧 item 的价格/数量
function readSmartRow(rowId) {
  var found = smartRowById(rowId);
  if (!found) return null;
  var item = found.item;
  var priceRaw = smartField(rowId, 'price');
  var qtyRaw = smartField(rowId, 'qty');
  return {
    rowId: rowId,
    kind: item.kind,
    code: classifyCode.normalizeCode(smartField(rowId, 'code').trim(), smartField(rowId, 'name').trim()),
    name: smartField(rowId, 'name').trim(),
    date: smartField(rowId, 'date'),
    price: priceRaw === '' ? null : Number(priceRaw),
    quantity: qtyRaw === '' ? null : Number(qtyRaw),
    quantity_unit: smartField(rowId, 'unit') || null,
    currency: smartField(rowId, 'cur') || item.currency || null,
    direction: item.kind === 'trade' ? smartField(rowId, 'dir') : null,
    _item: item
  };
}

// 把所有行的编辑值同步回状态（删行重渲染前保存，方案 4.4 第 4 条）
function syncAllSmartRowsFromDom() {
  (window._smartParsed || []).forEach(function(item) {
    // 该行 DOM 还没渲染过（如刚识别完待首次渲染的新行）时跳过，避免用空值覆盖识别结果
    if (!document.getElementById('s-date-' + item._rowId)) return;
    var row = readSmartRow(item._rowId);
    if (!row) return;
    item.code = row.code;
    item.name = row.name;
    item.date = row.date;
    updateSmartDateIssue(item, row.date);
    item.price = row.price;
    item.quantity = row.quantity;
    item.quantity_unit = row.quantity_unit;
    item.currency = row.currency;
    if (row.direction) item.direction = row.direction;
  });
}

// 单位只转换一次（方案 4.2 第 2 条）：明确“手”且上交所债券 → ×10 转“张”；其他原样
function convertRowUnit(row) {
  if (row.quantity_unit === '手' && row.quantity != null && isFinite(row.quantity)) {
    var info = classifyCode(row.code);
    if (info && info.market === 'sh' && info.type === '债权') {
      row.quantity = Math.round(row.quantity * 10 * 10000) / 10000;
      row.quantity_unit = '张';
    }
  }
  return row;
}

// 本地轻量重校验（用户编辑后重新校验，旧问题状态不直接沿用；服务端仍是最终校验方）
function revalidateSmartRow(rowId) {
  var found = smartRowById(rowId);
  if (!found) return null;
  var item = found.item;
  var row = readSmartRow(rowId);
  if (!row) return null;
  var issues = [];
  if (!row.code) issues.push({ level: 'error', field: 'code', message: '缺少证券代码' });
  if (row.quantity === null || !isFinite(row.quantity)) {
    issues.push({ level: 'error', field: 'quantity', message: '数量无效' });
  } else if (row.kind === 'trade' && row.quantity <= 0) {
    issues.push({ level: 'error', field: 'quantity', message: '成交数量必须为正数' });
  } else if (row.quantity < 0) {
    issues.push({ level: 'warn', field: 'quantity', message: '数量带负号，请核对' });
  }
  if (row.kind === 'trade') {
    if (row.price === null || !isFinite(row.price) || row.price <= 0) {
      issues.push({ level: 'error', field: 'price', message: '成交价必须为正数' });
    }
    if (!row.date) issues.push({ level: 'error', field: 'date', message: '请补全交易日期' });
    if (row.direction !== 'buy' && row.direction !== 'sell') {
      issues.push({ level: 'error', field: 'direction', message: '请选择买卖方向' });
    }
  } else {
    // 成本允许零与负（做T摊薄）；空值阻止提交，要求补填（不用市价估算）
    if (row.price === null || !isFinite(row.price)) {
      issues.push({ level: 'error', field: 'cost', message: '请补填成本价（可为 0 或负数）' });
    }
    if (!row.date) issues.push({ level: 'error', field: 'date', message: '请选择快照日期' });
    if (row.quantity === 0) issues.push({ level: 'warn', field: 'quantity', message: '数量为 0 将生成清仓调整' });
    // 防叠加守卫：行日期不得早于该证券已有 open/adjust 事件，
    // 否则按日期重放时较晚的期初事件会叠加到目标数量上（2026-10-26 验收 E2E 实证）
    if (row.date) {
      var maxEventDate = '';
      (data.trades || []).forEach(function(t) {
        if (t.code !== row.code || (t.direction !== 'open' && t.direction !== 'adjust')) return;
        var d = String(t.trade_date || (t.date || '')).slice(0, 10);
        if (d && d > maxEventDate) maxEventDate = d;
      });
      if (maxEventDate && row.date < maxEventDate) {
        issues.push({ level: 'error', field: 'date', message: '日期早于该证券已有持仓事件（' + maxEventDate + '），请从早到晚录入或删除后重录，避免数量叠加' });
      }
    }
  }
  var info = row.code ? classifyCode(row.code, row.name) : null;
  var isHk = !!(info && info.isHK);
  if (row.currency === 'HKD' && !isHk) issues.push({ level: 'error', field: 'currency', message: '币种为港币但代码不是港股' });
  if (row.currency === 'CNY' && isHk) issues.push({ level: 'error', field: 'currency', message: '币种为人民币但代码是港股' });
  item._v = {
    status: issues.some(function(i) { return i.level === 'error'; }) ? 'blocked' : (issues.length ? 'review' : 'ok'),
    issues: issues,
    costSource: item._v ? item._v.costSource : null
  };
  var cell = document.getElementById('s-status-' + rowId);
  if (cell) cell.innerHTML = renderSmartRowStatus(item);
  return item._v;
}

function setSmartButtonsDisabled(disabled) {
  var all = document.getElementById('smart-confirm-all-btn');
  if (all) all.disabled = disabled;
  document.querySelectorAll('.smart-row-btn').forEach(function(b) { b.disabled = disabled; });
}

function applyLedgerData(jdata) {
  if (!jdata) return;
  data = jdata;
  dataVersion = jdata.version || dataVersion;
  if (typeof jdata.posVersion === 'number') dataPosVersion = jdata.posVersion;
  if (typeof jdata.tradeVersion === 'number') dataTradeVersion = jdata.tradeVersion;
  if (typeof jdata.navVersion === 'number') dataNavVersion = jdata.navVersion;
  if (typeof jdata.cashflowVersion === 'number') dataCashVersion = jdata.cashflowVersion;
  restorePriceChangeMap();
}

// 结果未知（网络异常/响应丢失）时按原 id 核对是否已落库（方案 4.4 第 5 条）
async function verifySmartEventsSaved(ids, operationScope) {
  var scope = operationScope || captureSmartImportScope();
  if (!isSmartImportScopeCurrent(scope)) return { all: false, any: false };
  try {
    var r = await window.tradeLedgerApi.accountData(scope.account);
    if (!isSmartImportScopeCurrent(scope)) return { all: false, any: false };
    if (!r.ok) return { all: false, any: false };
    var j = r.payload;
    // /api/data/:name 返回顶层账户对象；缺少有效交易列表时不得使用旧缓存冒充核对结果。
    if (!j || !Array.isArray(j.trades)) return { all: false, any: false };
    applyLedgerData(j);
    var trades = j.trades;
    var saved = (ids || []).filter(function(id) {
      return trades.some(function(t) { return t.id === id; });
    });
    return { all: (ids || []).length > 0 && saved.length === ids.length, any: saved.length > 0, saved: saved };
  } catch (e) {
    return { all: false, any: false };
  }
}

// 交易单行提交：结果语义 saved/exists/duplicate/failed/conflict/unknown
async function submitTradeRow(row, operationScope) {
  convertRowUnit(row);
  var item = row._item;
  var fees = getSmartItemFees(item, row.code, row.name, row);
  return await addTradeInternal(row.code, row.name, row.direction, row.price, row.quantity, row.date,
    fees, window._smartBatchId || null, { eventId: item._eventId, quoteCurrency: row.currency, skipUnitConversion: true, scope: operationScope });
}

// 持仓批量提交（方案 4.4 第 2 条）：复用完整账户批量接口，单事务；
// 已有证券 adjust（目标数量）/新证券 open；失败持仓全留。
async function submitPositionRows(rows, operationScope) {
  var scope = operationScope || captureSmartImportScope();
  if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
  if (!rows.length) return { status: 'saved', message: '' };
  // 同代码多行必须由【最早日期】那行做 open（其余 adjust）：账本按日期升序重放，
  // 若 open 落在较晚日期，重放会把期初事件叠加到目标数量上（2026-10-26 验收 E2E 实证）。
  var firstRowByCode = {};
  rows.forEach(function(row) {
    var cur = firstRowByCode[row.code];
    if (!cur || String(row.date || '') < String(cur.date || '')) firstRowByCode[row.code] = row;
  });
  var events = rows.map(function(row) {
    convertRowUnit(row);
    var item = row._item;
    var rec = recognizeCode(row.code, row.name) || { type: '股权', subtype: '深市' };
    var alreadyHeld = (data.positions || []).some(function(p) { return p.code === row.code; });
    var isAdjust = alreadyHeld || firstRowByCode[row.code] !== row;
    return {
      id: item._eventId, // 幂等键：重试复用同一 id
      code: row.code, name: row.name || row.code,
      direction: isAdjust ? 'adjust' : 'open',
      price: row.price, quantity: row.quantity,
      type: rec.type, subtype: rec.subtype,
      quote_currency: row.currency || undefined,
      date: row.date, // 快照日期：缺省已在预览默认今天并可改；清空则被重校验阻止，不带空日期提交
      import_batch_id: window._smartBatchId || null
    };
  });
  var ids = events.map(function(e) { return e.id; });
  try {
    var r = await window.holdingsQuoteApi.addPositions(scope.account, dataVersion, events);
    if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
    var j = r.payload;
    if (!r.ok) {
      if (r.status === 409) {
        // 409 可能是"整批已成功但响应丢失后带旧版本重试"：先按原 id 核对整组，全部存在才标已保存
        // （方案 4.4 第 5 条），不能只让刷新重试
        var verify409 = await verifySmartEventsSaved(ids, scope);
        if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
        if (verify409.all) return { status: 'saved', message: '已保存（核对确认，响应丢失后重试遇版本冲突）' };
        return { status: 'conflict', message: j.error || '数据已在其他窗口被修改，请刷新页面后重试' };
      }
      // 响应丢失/失败：按原 id 核对整组事件是否已落库，全部存在才标已保存
      var verify = await verifySmartEventsSaved(ids, scope);
      if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
      if (verify.all) return { status: 'saved', message: '已保存（核对确认，响应丢失）' };
      return { status: 'failed', message: j.error || '持仓导入失败' };
    }
    applyLedgerData(j.data);
    renderAll();
    return { status: 'saved', message: '已导入持仓' };
  } catch (e) {
    if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
    var verify2 = await verifySmartEventsSaved(ids, scope);
    if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
    if (verify2.all) return { status: 'saved', message: '已保存（网络异常后核对确认）' };
    return { status: 'unknown', message: '网络异常，结果待确认，请稍后重试（不会重复录入）：' + (e.message || e) };
  }
}

function clearCompletedVisionBatch() {
  if (!_visionClearWhenComplete || _visionProcessing || _smartParsed.length || !_visionQueue.length ||
      _visionQueue.some(function(job) { return job.status !== 'done'; })) return;
  _visionQueue = [];
  _visionClearWhenComplete = false;
  renderVisionQueue();
}

function removeSmartRows(rowIds, saved) {
  var removing = {};
  (rowIds || []).forEach(function(id) { removing[id] = true; });
  _smartParsed = (_smartParsed || []).filter(function(it) { return !removing[it._rowId]; });
  if (!_smartParsed.length) window._smartBatchId = null; // 批次在预览清空后重建
  if (saved && !_smartParsed.length) _visionClearWhenComplete = true;
  clearCompletedVisionBatch();
  renderSmartItems();
}

// 用户主动排除行（无效/冲突行先修正或明确排除）
function excludeSmartRow(rowId) {
  syncAllSmartRowsFromDom();
  removeSmartRows([rowId]);
}

// 导入保存成功后立即刷一次行情，持仓列表当场显示今日涨跌/今日盈亏（2026-10-27 反馈）；
// 与手动"刷新行情"同链路，失败不影响已保存结果
function refreshQuotesAfterImport() {
  if (typeof doRefresh !== 'function') return;
  Promise.resolve(doRefresh()).catch(function() {});
}

async function confirmSmartItem(rowId) {
  if (_smartSubmitting) return;
  var scope = captureSmartImportScope();
  var found = smartRowById(rowId);
  if (!found) return;
  var v = revalidateSmartRow(rowId);
  if (v && v.status === 'blocked') {
    showToast('该行还有问题：' + (v.issues[0] ? v.issues[0].message : '请检查'));
    return;
  }
  var row = readSmartRow(rowId);
  if (!row) return;
  if (!window._smartBatchId) window._smartBatchId = 'imp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  _smartSubmitting = true;
  setSmartButtonsDisabled(true);
  try {
    var r = row.kind === 'trade' ? await submitTradeRow(row, scope) : await submitPositionRows([row], scope);
    if (!isSmartImportScopeCurrent(scope)) return;
    if (r.status === 'saved' || r.status === 'duplicate') {
      removeSmartRows([rowId], true);
      showToast(r.message || '已保存');
      refreshQuotesAfterImport();
    } else {
      showToast(r.message || '提交失败，行已保留');
      revalidateSmartRow(rowId);
    }
  } finally {
    if (isSmartImportScopeCurrent(scope)) {
      _smartSubmitting = false;
      setSmartButtonsDisabled(false);
    }
  }
}

function collectSmartConflicts() {
  var posCodes = {}, tradeCodes = {};
  (window._smartParsed || []).forEach(function(it) {
    if (!it.code) return;
    if (it.kind === 'trade') tradeCodes[it.code] = true; else posCodes[it.code] = true;
  });
  return Object.keys(posCodes).filter(function(c) { return tradeCodes[c]; });
}

async function confirmAllSmartItems() {
  if (_smartSubmitting) return;
  var scope = captureSmartImportScope();
  var items = window._smartParsed || [];
  if (items.length === 0) return;
  syncAllSmartRowsFromDom();
  // 同一轮确认中同证券同时含持仓快照及交易 → 先阻止并列出冲突（方案 4.4 第 3 条）
  var conflicts = collectSmartConflicts();
  if (conflicts.length) {
    showToast('以下证券同时含持仓与交易：' + conflicts.join('、') + '。请分别单独确认，明确录入范围/日期，避免快照与其中已包含的成交重复计算');
    return;
  }
  if (!window._smartBatchId) window._smartBatchId = 'imp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  _smartSubmitting = true;
  setSmartButtonsDisabled(true);
  var savedRows = [];
  var blockedCount = 0;
  var sameDateConflict = 0;
  var posSaved = 0, posFailed = 0;
  var tradeSaved = 0, tradeExists = 0, tradeFailed = 0;
  var stopped = false;
  try {
    var posRows = [], tradeRows = [];
    items.forEach(function(it) {
      var v = revalidateSmartRow(it._rowId);
      var row = readSmartRow(it._rowId);
      if (!row) return;
      if (v && v.status === 'blocked') { blockedCount++; return; }
      if (row.kind === 'trade') tradeRows.push(row); else posRows.push(row);
    });
    // 同证券同日快照的数量/成本对不上 → 整组行保留待用户选择，不参与批量
    // （方案 4.3 第 4 条"由用户选择，不按上传先后覆盖"；其余持仓照常提交）
    var posGroups = {};
    posRows.forEach(function(row) {
      var k = row.code + '|' + (row.date || '');
      (posGroups[k] = posGroups[k] || []).push(row);
    });
    posRows = posRows.filter(function(row) {
      var g = posGroups[row.code + '|' + (row.date || '')];
      if (g.length <= 1) return true;
      var identical = g.every(function(r2) { return r2.quantity === row.quantity && r2.price === row.price; });
      if (!identical) { sameDateConflict++; return false; }
      return true;
    });
    // 持仓批量（单事务）：失败全留
    if (posRows.length) {
      var pr = await submitPositionRows(posRows, scope);
      if (!isSmartImportScopeCurrent(scope)) return;
      if (pr.status === 'saved' || pr.status === 'duplicate') {
        posSaved = posRows.length;
        posRows.forEach(function(row) { savedRows.push(row.rowId); });
      } else {
        posFailed = posRows.length;
        showToast('持仓批量提交失败：' + pr.message);
        if (pr.status === 'conflict') stopped = true;
      }
    }
    // 交易逐笔：逐行失败继续；会话/版本类问题暂停队列
    for (var i = 0; i < tradeRows.length; i++) {
      if (stopped) break;
      var row = tradeRows[i];
      var r = await submitTradeRow(row, scope);
      if (!isSmartImportScopeCurrent(scope)) return;
      if (r.status === 'saved' || r.status === 'duplicate') {
        tradeSaved++;
        savedRows.push(row.rowId);
      } else if (r.status === 'exists') {
        tradeExists++;
      } else if (r.status === 'conflict') {
        tradeFailed += (tradeRows.length - i);
        showToast(r.message + '，已停止提交剩余交易行');
        stopped = true;
      } else {
        tradeFailed++;
      }
    }
  } finally {
    if (isSmartImportScopeCurrent(scope)) {
      _smartSubmitting = false;
      setSmartButtonsDisabled(false);
      if (savedRows.length) removeSmartRows(savedRows, true);
    }
  }
  var parts = [];
  if (posRowsCountable(posSaved, posFailed)) parts.push('持仓 ' + posSaved + ' 条已保存' + (posFailed ? '、' + posFailed + ' 条失败保留' : ''));
  parts.push('交易 ' + tradeSaved + ' 条已保存');
  if (tradeExists) parts.push(tradeExists + ' 条已存在（保留待处理）');
  if (tradeFailed) parts.push(tradeFailed + ' 条失败保留');
  if (blockedCount) parts.push(blockedCount + ' 条需先处理（见状态列）');
  if (sameDateConflict) parts.push(sameDateConflict + ' 行同证券同日快照对不上，已保留待你选择（逐行确认或移除）');
  if (posSaved + tradeSaved > 0) refreshQuotesAfterImport();
  showToast('完成：' + parts.join('，'));
}

function posRowsCountable(saved, failed) { return saved > 0 || failed > 0; }

function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 将 base64 data URL 转为 File 对象（URL → Blob → File）
function base64ToFile(base64, filename) {
  var arr = base64.split(',');
  var mime = arr[0].match(/:(.*?);/)[1];
  var bstr = atob(arr[1]);
  var n = bstr.length;
  var u8arr = new Uint8Array(n);
  while (n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new File([u8arr], filename || 'upload.png', { type: mime });
}

// ===================== 手机扫码上传 =====================
var _qrPollTimer = null;
var _qrToken = null;
var _qrGeneration = 0;

// 二维码下方状态文案（过期提示 + 重新生成入口，方案 4.6 第 4 条）
function setQrStatus(html) {
  var el = document.getElementById('qr-status');
  if (el) el.innerHTML = html;
}

function initVisionQr() {
  var scope = bindSmartImportScope();
  var qrGeneration = ++_qrGeneration;
  function currentQr() { return qrGeneration === _qrGeneration && isSmartImportScopeCurrent(scope); }
  window.siteApi.requestRaw('/api/vision-token', { method: 'POST', timeoutMs: 0 })
    .then(function(raw) { if (!raw.response) throw new Error(raw.error || '网络异常'); return raw.response.json(); })
    .then(function(d) {
      if (!currentQr()) return;
      _qrToken = d.token;
      var img = document.getElementById('qr-image');
      if (img) img.src = d.qr || '';
      setQrStatus('手机扫码上传图片');

      if (_qrPollTimer) clearInterval(_qrPollTimer);
      var pollTimer = setInterval(function() {
        if (!currentQr()) {
          clearInterval(pollTimer);
          if (_qrPollTimer === pollTimer) _qrPollTimer = null;
          return;
        }
        window.siteApi.requestRaw('/api/vision-check/' + d.token, { timeoutMs: 0 })
          .then(function(raw) { if (!raw.response) throw new Error(raw.error || '网络异常'); return raw.response.json(); })
          .then(function(result) {
            // 切换账户后旧轮询结果作废，不恢复旧预览
            if (!currentQr()) {
              clearInterval(pollTimer);
              if (_qrPollTimer === pollTimer) _qrPollTimer = null;
              return;
            }
            if (result.expired) {
              clearInterval(pollTimer);
              if (_qrPollTimer === pollTimer) _qrPollTimer = null;
              // 过期即时提示并给重新生成入口（断网/响应丢失后的恢复边界如实提示）
              setQrStatus('二维码已过期 <button class="btn btn-outline btn-sm" data-act="initVisionQr">重新生成二维码</button>');
              return;
            }
            var images = result.images && result.images.length ? result.images : (result.image ? [result.image] : []);
            if (images.length) {
              clearInterval(pollTimer);
              if (_qrPollTimer === pollTimer) _qrPollTimer = null;
              // 整批进入识别队列（与本地选图同一队列）
              enqueueBase64Images(images, '手机上传');
            }
          });
      }, 2000);
      _qrPollTimer = pollTimer;
    });
}

function stopVisionQr() {
  _qrGeneration++;
  if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null; }
  _qrToken = null;
  var img = document.getElementById('qr-image');
  if (img) img.src = '';
}

// ===================== 交易录入增强 =====================

// 交易数量单位转换：券商以「手」为单位录入的上交所债券（可转债/信用债），1手=10张
// 是否按「手」录入由券商的 import_unit 决定（后台券商管理可配置，华泰默认「手」）；其他券商/品种不转换
function normalizeQuantity(quantity, code) {
  if (!quantity || !code || !data || data._brokerImportUnit !== 'lot') return quantity;
  const info = classifyCode(code);
  // 上交所(sh) + 债权类(可转债11x/113x + 信用债13x) → 手→张(×10)
  if (info && info.market === 'sh' && info.type === '债权') return quantity * 10;
  return quantity;
}

// 显示/隐藏数量单位提示（该券商以「手」录入 + 上交所债券时提示用户）
function updateQtyHint(code) {
  var el = document.getElementById('trade-qty-hint');
  if (!el || !code || !data || data._brokerImportUnit !== 'lot') { if (el) el.style.display = 'none'; return; }
  var info = classifyCode(code);
  el.classList.remove('js-hidden'); el.style.display = (info && info.market === 'sh' && info.type === '债权') ? '' : 'none';
}

// 智能导入交易提交：返回明确结果语义（方案 4.4 第 1 条），
// status: saved（已保存）| duplicate（同批次已保存）| exists（本地已存在，留行待处理）
//       | failed（明确失败）| conflict（版本/会话问题，暂停）| unknown（结果待确认）
async function addTradeInternal(code, name, direction, price, quantity, date, importedFees, importBatchId, opts) {
  opts = opts || {};
  var scope = opts.scope || captureSmartImportScope();
  if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
  code = classifyCode.normalizeCode(code, name);
  // 单位只转换一次：导入路径（skipUnitConversion）已在预览换算过，不重复按券商配置换算
  if (!opts.skipUnitConversion) quantity = normalizeQuantity(quantity, code);
  if (!code || !price || !quantity) return { status: 'blocked', message: '请填写代码、价格和数量' };

  var rec = recognizeCode(code, name) || { type: '股权', subtype: '深市' };
  var f = importedFees || calcTradeFees(direction, Math.round(price * quantity * 100) / 100, rec.subtype);
  var tradeId = opts.eventId || uid(); // 幂等键：重试复用同一 id

  // 业务去重（方案阶段一第 6 条）：同 code+date+direction+price+quantity 视为已存在，留行待用户处理
  var dup = (data.trades || []).some(function (t) {
    return t.code === code &&
      (t.trade_date || (t.date || '').slice(0, 10)) === String(date || '').slice(0, 10) &&
      t.direction === direction &&
      Math.abs((Number(t.price) || 0) - price) < 0.001 &&
      Math.abs((Number(t.quantity) || 0) - quantity) < 0.001;
  });
  if (dup) return { status: 'exists', message: '该笔交易已存在（同代码/日期/方向/价格/数量），未重复录入，行保留待你处理' };

  // 服务端统一账本事务：持仓/现金由服务端重算并返回
  try {
    const r = await window.tradeLedgerApi.addTrade(scope.account, dataVersion,
        {
          id: tradeId,
          code: code, name: name || code, direction: direction,
          price: price, quantity: quantity,
          commission: f.commission, stamp_tax: f.stamp_tax, transfer_fee: f.transfer_fee, other_fee: f.other_fee,
          type: rec.type, subtype: rec.subtype,
          quote_currency: opts.quoteCurrency || undefined,
          date: date, // 日期必须显式给定（重校验已阻止缺失，不默认今天；方案 4.1 第 6 条）
          import_batch_id: importBatchId || null
        });
    if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
    const j = r.payload;
    if (!r.ok) {
      if (r.status === 409) {
        // 409 可能是"已保存但响应丢失后带旧版本重试"：先按原 id 核对，已落库才标已保存（方案 4.4 第 5 条）
        var verify409 = await verifySmartEventsSaved([tradeId], scope);
        if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
        if (verify409.all) return { status: 'saved', message: '已保存（核对确认，响应丢失后重试遇版本冲突）' };
        return { status: 'conflict', message: j.error || '数据已在其他窗口被修改，请刷新页面后重试' };
      }
      if (r.status === 401 || r.status === 403) return { status: 'conflict', message: j.error || '登录状态失效，请重新登录后继续' };
      // 失败后按原 id 核对：可能是响应丢失
      var verifyFailed = await verifySmartEventsSaved([tradeId], scope);
      if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
      if (verifyFailed.all) return { status: 'saved', message: '已保存（核对确认，响应丢失）' };
      return { status: 'failed', message: j.error || '保存交易失败' };
    }
    if (j.skipped === 'duplicate') {
      // P1-4 服务端幂等命中：同批次重复导入 = 已保存；刷新数据与版本
      if (j.data) applyLedgerData(j.data);
      renderAll();
      return { status: 'duplicate', message: '该笔交易已存在（同批次重复导入），已跳过' };
    }
    if (j.data) applyLedgerData(j.data);
    // 过去日期的交易：触发历史净值精确回填（Tushare 历史回补，不近似）；失败与交易已保存分开提示
    if (date && date < todayCN()) {
      try {
        const rr = await window.tradeLedgerApi.recomputeNav(scope.account, date);
        if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
        const jj = rr.payload;
        if (jj && jj.ok) {
          var refreshed = await loadData(scope.account);
          if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
          data = refreshed;
        }
      } catch (e) {
        if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
        renderAll();
        return { status: 'saved', message: '已记录 ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + (name || code) + '（历史净值重算失败，可稍后在净值页重试）' };
      }
    }
    renderAll();
    return { status: 'saved', message: '已记录 ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + (name || code) };
  } catch (e) {
    if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
    // 网络异常：结果未知，先按原 id 核对是否已落库
    var verify = await verifySmartEventsSaved([tradeId], scope);
    if (!isSmartImportScopeCurrent(scope)) return { status: 'scope_changed', message: '账户已切换，旧结果已丢弃' };
    if (verify.all) return { status: 'saved', message: '已保存（网络异常后核对确认）' };
    return { status: 'unknown', message: '网络异常，结果待确认（重试不会重复录入）：' + (e.message || e) };
  }
}

// ===================== 税费设置 =====================
function openFeeSettings() {
  renderFeeSettings();
  const m = document.getElementById('modal-feesettings');
  if (m) m.classList.add('show');
}
function feeField(label, id, val) {
  return '<div class="form-group"><label>' + label + '</label>' +
    '<input id="' + id + '" type="number" step="any" value="' + val + '"></div>';
}
var currentFeeTab = 'ashare_stock';
function switchFeeTab(key) {
  currentFeeTab = key;
  document.querySelectorAll('.fee-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.key === key); });
  document.querySelectorAll('.fee-panel').forEach(function(p) { p.classList.toggle('active', p.dataset.key === key); });
}
function renderFeeSettings() {
  const s = getFeeSettings();
  const curAcc = (typeof currentAccount !== 'undefined' && currentAccount) ? currentAccount : '';
  let html = '<div data-style="margin-bottom:12px;padding:8px;background:#eef3ff;border-radius:6px;font-size:14px;color:#333;">⚙ 当前账户：<b>' + escapeHtml(curAcc) + '</b>（各账户费率独立保存）</div>';
  // Tab 按钮行
  html += '<div class="fee-tabs">';
  FEE_GROUPS.forEach(function(g) {
    html += '<span class="fee-tab' + (g.key === currentFeeTab ? ' active' : '') + '" data-key="' + g.key + '" data-act="switchFeeTab" data-arg1="' + g.key + '">' + g.label + '</span>';
  });
  html += '</div>';
    // 各组面板（可见性交给 CSS：.fee-panel 默认隐藏，.active 才显示）
  FEE_GROUPS.forEach(function(g) {
    const cfg = s[g.key];
    html += '<div class="fee-panel' + (g.key === currentFeeTab ? ' active' : '') + '" data-key="' + g.key + '">';
    html += feeField('佣金费率(%)', 'fs-' + g.key + '-commission', pctShow(cfg.commissionRate));
    html += feeField('最低佣金(元)', 'fs-' + g.key + '-min', cfg.commissionMin || 0);
    if (g.fields.indexOf('stamp') >= 0) html += feeField('印花税率(%)', 'fs-' + g.key + '-stamp', pctShow(cfg.stampTaxRate));
    if (g.fields.indexOf('transfer') >= 0) {
      html += feeField('过户费率(%)', 'fs-' + g.key + '-transfer', pctShow(cfg.transferRate));
      if (g.key === 'hk_stock') html += feeField('结算费上限(港币)', 'fs-' + g.key + '-cap', cfg.transferCap || 0);
    }
    if (g.fields.indexOf('other') >= 0) html += feeField('其他费率(%) 征费+交易费', 'fs-' + g.key + '-other', pctShow(cfg.otherRate));
    html += '</div>';
  });
  const body = document.getElementById('fee-settings-body');
  if (body) body.innerHTML = html;
}
async function saveFeeSettings() {
  const groups = {};
  FEE_GROUPS.forEach(function (g) {
    const o = {};
    o.commissionRate = pctToRate(document.getElementById('fs-' + g.key + '-commission').value);
    o.commissionMin = parseFloat(document.getElementById('fs-' + g.key + '-min').value) || 0;
    if (g.fields.indexOf('stamp') >= 0) o.stampTaxRate = pctToRate(document.getElementById('fs-' + g.key + '-stamp').value);
    if (g.fields.indexOf('transfer') >= 0) {
      o.transferRate = pctToRate(document.getElementById('fs-' + g.key + '-transfer').value);
      if (g.key === 'hk_stock') o.transferCap = parseFloat(document.getElementById('fs-' + g.key + '-cap').value) || 0;
    }
    if (g.fields.indexOf('other') >= 0) o.otherRate = pctToRate(document.getElementById('fs-' + g.key + '-other').value);
    groups[g.key] = o;
  });
  data.feeSettings = groups;
  try {
    var r = await window.accountNavApi.saveSettings(currentAccount, dataVersion, { feeSettings: data.feeSettings });
    var j = r.payload;
    if (!r.ok) { showToast(j.error || '保存失败'); return; }
    if (typeof j.version === 'number') dataVersion = j.version; // 同步新版本号（2026-08-04 第二轮修复）
  } catch(e) { showToast('保存失败：' + (e.message || e)); return; }
  autoCalcTrade();
  closeModal('modal-feesettings');
  showToast('税费设置已保存');
}

// ===================== 数据导入导出 =====================

function exportData() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '仓位数据_' + todayCN() + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function exportToExcel() {
  var url = api('/api/export/' + encodeURIComponent(currentAccount));
  var a = document.createElement('a');
  a.href = url;
  a.download = currentAccount + '_持仓导出.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('正在下载...');
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.positions && imported.trades !== undefined) {
        // 全量导入走专用快照导入接口（DATA-01：替代旧整包写接口，跳过版本检查强制覆盖）
        var raw = await window.siteApi.requestRaw('/api/accounts/' + encodeURIComponent(currentAccount) + '/import-snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(imported),
          timeoutMs: 0
        });
        if (!raw.response) { showToast(raw.error || '网络异常'); return; }
        var r = raw.response;
        var j = await r.json().catch(function(){ return {}; });
        if (!r.ok) { showToast(j.error || '导入失败'); return; }
        if (j.version) {
          dataVersion = j.version;
          if (typeof j.posVersion === 'number') dataPosVersion = j.posVersion;
          if (typeof j.tradeVersion === 'number') dataTradeVersion = j.tradeVersion;
          if (typeof j.navVersion === 'number') dataNavVersion = j.navVersion;
          if (typeof j.cashflowVersion === 'number') dataCashVersion = j.cashflowVersion;
        }
        // 刷新本地数据
        try {
          var raw2 = await window.siteApi.requestRaw('/api/data/' + encodeURIComponent(currentAccount), { timeoutMs: 0 });
          if (raw2.response) { var r2 = raw2.response; if (r2.ok) { var j2 = await r2.json().catch(function(){ return {}; }); if (j2.data) refreshDataFromServer(j2.data); else { data = imported; renderAll(); } } else { data = imported; renderAll(); } }
          else { data = imported; renderAll(); }
        } catch (e2) { data = imported; renderAll(); }
        showToast('数据导入成功！');
      } else {
        showToast('数据格式不正确');
      }
    } catch (err) {
      showToast('导入失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
