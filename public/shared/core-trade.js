// shared/core-trade.js – 交易录入/持仓增删改/截图AI/扫码/导入导出（原 core.js 拆分，全局作用域不变）
// ===================== 交易录入 =====================

// 本地秒级时间字符串 YYYY-MM-DD HH:MM:SS（用于交易/现金流精确排序，东八区）
function nowSec() {
  const now = new Date();
  const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${cn.getUTCFullYear()}-${p(cn.getUTCMonth() + 1)}-${p(cn.getUTCDate())} ${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}:${p(cn.getUTCSeconds())}`;
}

// 现金自动重算：现金 = 期初本金(cashBase) + 现金流净额 + 交易净额(买入减/卖出加)
// 与后端 loadAccountData 逻辑一致，是现金唯一真相源，避免刷新/覆盖导致现金丢失
function recalcCash() {
  const cfNet = (data.cashFlows || []).reduce((s, c) => s + (c.amount || 0), 0);
  // 交易净额：买入 -(成交额+费用)，卖出 +(成交额-费用)
  const tradeNet = (data.trades || []).reduce((s, t) => {
    const fee = (t.commission || 0) + (t.stamp_tax || 0) + (t.transfer_fee || 0) + (t.other_fee || 0);
    return s + (t.direction === 'buy' ? -(t.amount || 0) - fee : (t.amount || 0) - fee);
  }, 0);
  const base = (typeof data.cashBase === 'number') ? data.cashBase : 0;
  data.cash = base + cfNet + tradeNet;
}

// 初始化交易录入日期/时间为当前北京时间（打开页面或保存后调用）
function initTradeDateTime() {
  const dateEl = document.getElementById('trade-date');
  const timeEl = document.getElementById('trade-time');
  if (!dateEl || !timeEl) return;
  const now = new Date();
  const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  dateEl.value = cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
  // 时间默认填当前时分，但仅在值为空时（避免用户已手动改过被覆盖）
  if (!timeEl.value) timeEl.value = p(cn.getUTCHours()) + ':' + p(cn.getUTCMinutes());
}

// 价格/数量/方向/细类变化时：自动算成交额 + 四费用并填充（手续费/印花税/过户费/其他费可手动改）
function autoCalcTrade() {
  const priceEl = document.getElementById('trade-price');
  const qtyEl = document.getElementById('trade-qty');
  const dirEl = document.getElementById('trade-dir');
  const subEl = document.getElementById('trade-subtype');
  const amtEl = document.getElementById('trade-amount');
  if (!priceEl || !qtyEl || !dirEl || !subEl || !amtEl) return;
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

function addTrade() {
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
    id: uid(),
    date: tradeDate,
    created_at: nowSec(),
    code: code, name: name, direction: direction,
    price: price, quantity: qty, amount: amount,
    commission: commission, stamp_tax: stamp_tax, transfer_fee: transfer_fee, other_fee: other_fee,
    type: type, subtype: subtype, note: note
  };
  data.trades.push(trade);

  // 更新持仓
  const existing = data.positions.find(p => p.code === code);
  const delta = direction === 'buy' ? qty : -qty;
  if (existing) {
    const oldMv = (existing.price || 0) * (existing.quantity || 0);
    const newMv = direction === 'buy' ? price * qty : -(price * qty);
    const totalQty = (existing.quantity || 0) + delta;
    if (totalQty > 0) {
      existing.quantity = totalQty;
      existing.price = (oldMv + newMv) / totalQty;
      existing.type = type;
      existing.subtype = subtype;
      if (!existing.name) existing.name = name;
    } else {
      data.positions = data.positions.filter(p => p.id !== existing.id);
    }
  } else if (direction === 'buy') {
    data.positions.push({
      id: uid(), code: code, name: name,
      price: price, quantity: qty,
      type: type, subtype: subtype, cost: price, note: ''
    });
  }

  // 现金由系统自动重算，这里仅刷新内存显示
  recalcCash();

  saveData();
  renderAll();
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

function deleteTrade(id) {
  data.trades = data.trades.filter(t => t.id !== id);
  saveData();
  renderAll();
}

function clearTrades() {
  if (!confirm('确定清空所有交易记录？（不会影响持仓数据）')) return;
  data.trades = [];
  saveData();
  renderAll();
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
  document.getElementById('modal-subtype').value = p.subtype || 'A股';
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
    data.cashType = type;
    data.cashSubtype = subtype;
    saveData();
    closeModal('modal-add');
    renderAll();
    showToast('现金已更新');
    return;
  }

  const code = classifyCode.normalizeCode(document.getElementById('modal-code').value.trim());
  const name = document.getElementById('modal-name').value.trim();
  const price = parseFloat(document.getElementById('modal-price').value);
  const qty = parseInt(document.getElementById('modal-qty').value);
  const cost = parseFloat(document.getElementById('modal-cost').value) || price;
  const note = document.getElementById('modal-note').value.trim();

  if (!code || !price || !qty) { showToast('请填写代码、价格和数量'); return; }

  if (editingId) {
    const p = data.positions.find(x => x.id === editingId);
    if (p) Object.assign(p, { code, name, price, quantity: qty, cost, type, subtype, note });
  }

  saveData();
  closeModal('modal-add');
  renderAll();
  showToast('已保存 ' + (name || code));
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
    data.positions = data.positions.filter(p => p.id !== deleteTargetId);
    // 仅删持仓，保留交易流水（交易用于净值计算，删持仓不应抹掉历史）
    deleteTargetId = null;
    saveData();
    renderAll();
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
  tradeMode = mode;
  document.getElementById('mode-manual').classList.toggle('active', mode === 'manual');
  document.getElementById('mode-smart').classList.toggle('active', mode === 'smart');
  document.getElementById('trade-manual-section').style.display = mode === 'manual' ? '' : 'none';
  document.getElementById('trade-smart-section').style.display = mode === 'smart' ? '' : 'none';
  if (mode === 'smart') { initVisionQr(); } else { stopVisionQr(); }
}

async function handleVisionFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doSmartParse(file, 'vision');
}

async function handleExcelFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  await doSmartParse(file, 'excel');
}

// 粘贴支持
(function initVisionPaste() {
  document.addEventListener('paste', function(e) {
    if (tradeMode !== 'smart') return;
    var tradesPage = document.getElementById('page-trades');
    if (!tradesPage || !tradesPage.classList.contains('active')) return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        if (blob) { doSmartParse(blob, 'vision'); break; }
      }
    }
  });
})();

// 拖拽支持
(function initVisionDrag() {
  var zone = document.getElementById('vision-zone');
  if (!zone) return;
  zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
  zone.addEventListener('drop', function(e) {
    e.preventDefault();
    zone.classList.remove('dragover');
    var file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) doSmartParse(file, 'vision');
  });
})();

async function doSmartParse(file, source) {
  var loading = document.getElementById('smart-loading');
  var result = document.getElementById('smart-result');
  if (loading) loading.style.display = 'block';
  if (result) result.innerHTML = '';

  try {
    var base64 = await fileToBase64(file);
    if (loading) loading.innerHTML = '<span class="spinner"></span>AI识别中...';

    var d;
    if (source === 'vision') {
      var r = await fetch(api('/api/vision-parse'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 })
      });
      d = await r.json();
    } else {
      var r2 = await fetch(api('/api/excel-parse'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: base64 })
      });
      d = await r2.json();
    }

    if (loading) loading.style.display = 'none';

    if (d.error) {
      if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">识别失败: ' + escapeHtml(d.error) + '</div>';
      return;
    }

    if (!d.items || d.items.length === 0) {
      if (result) result.innerHTML = '<div style="color:#888;padding:12px;">未能识别出交易或持仓信息，请检查内容后重试</div>';
      return;
    }

    window._smartParsed = d.items.map(function(item) {
      item.code = classifyCode.normalizeCode(item.code || '');
      return item;
    });
    renderSmartItems();
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (result) result.innerHTML = '<div style="color:#d93025;padding:12px;">识别失败: ' + escapeHtml(e.message) + '</div>';
  }
}

function renderSmartItems() {
  var result = document.getElementById('smart-result');
  if (!result) return;
  var items = window._smartParsed || [];
  if (items.length === 0) { result.innerHTML = ''; return; }

  var html = '<div style="margin-bottom:8px;"><button class="btn btn-success btn-sm" onclick="confirmAllSmartItems()">✅ 全部录入</button></div>' +
    '<table><thead><tr>' +
    '<th>类型</th><th>日期</th><th>代码</th><th>名称</th><th class="text-right">价格</th><th class="text-right">数量</th>' +
    '<th>方向</th><th>品种</th><th>确认</th>' +
    '</tr></thead><tbody>';
  items.forEach(function(item, i) {
    var code = item.code || '';
    var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
    var isTrade = item.kind === 'trade';
    html += '<tr>' +
      '<td>' + (isTrade ? '<span class="tag tag-equity">交易</span>' : '<span class="tag tag-cash">持仓</span>') + '</td>' +
      '<td>' + (isTrade ? '<input type="date" id="s-date-' + i + '" value="' + escapeHtml(item.date || '') + '" style="width:110px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' : '-') + '</td>' +
      '<td><input type="text" id="s-code-' + i + '" value="' + escapeHtml(code) + '" style="width:70px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;" oninput="onSmartCodeChange(' + i + ')"></td>' +
      '<td><input type="text" id="s-name-' + i + '" value="' + escapeHtml(item.name || '') + '" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td><input type="number" id="s-price-' + i + '" value="' + escapeHtml(item.price || '') + '" step="0.001" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td><input type="number" id="s-qty-' + i + '" value="' + escapeHtml(item.quantity || '') + '" step="1" style="width:80px;padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;"></td>' +
      '<td>' + (isTrade ? '<select id="s-dir-' + i + '" style="padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;font-size:12px;">' +
        '<option value="buy"' + (item.direction === 'buy' ? ' selected' : '') + '>买入</option>' +
        '<option value="sell"' + (item.direction === 'sell' ? ' selected' : '') + '>卖出</option>' +
        '</select>' : '-') + '</td>' +
      '<td>' + getTypeTag(rec.type) + ' ' + escapeHtml(rec.subtype || '') + '</td>' +
      '<td><button class="btn btn-success btn-sm" onclick="confirmSmartItem(' + i + ')">确认' + (isTrade ? '录入' : '导入') + '</button></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  result.innerHTML = html;
}

function onSmartCodeChange(index) {
  var code = document.getElementById('s-code-' + index).value.trim();
  if (code.length >= 4) {
    fetchQuote(code).then(function(q) {
      if (q && q.price) {
        var priceEl = document.getElementById('s-price-' + index);
        if (priceEl && !priceEl.value) priceEl.value = q.price;
        if (q.name) {
          var nameEl = document.getElementById('s-name-' + index);
          if (nameEl && !nameEl.value) nameEl.value = q.name;
        }
      }
    });
  }
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

async function confirmSmartItem(index) {
  var item = window._smartParsed[index];
  if (!item) return;

  var code = classifyCode.normalizeCode(document.getElementById('s-code-' + index).value.trim());
  var name = await ensureName(code, document.getElementById('s-name-' + index).value.trim());
  var price = parseFloat(document.getElementById('s-price-' + index).value) || 0;
  var quantity = parseInt(document.getElementById('s-qty-' + index).value) || 0;
  if (!code || !price || !quantity) { showToast('请填写代码、价格和数量'); return; }

  if (item.kind === 'trade') {
    var direction = document.getElementById('s-dir-' + index).value;
    var date = document.getElementById('s-date-' + index).value;
    addTradeInternal(code, name, direction, price, quantity, date);
  } else {
    var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
    var existing = data.positions.find(function(p) { return p.code === code; });
    if (existing) {
      existing.name = name || code;
      existing.price = price;
      existing.quantity = quantity;
      existing.cost = price;
      existing.type = existing.type || rec.type;
      existing.subtype = existing.subtype || rec.subtype;
    } else {
      data.positions.push({
        id: uid(), code: code, name: name || code,
        price: price, quantity: quantity, cost: price,
        type: rec.type, subtype: rec.subtype, note: ''
      });
    }
    recalcCash();
    saveData();
    renderAll();
    showToast('已导入持仓 ' + (name || code));
  }

  var row = document.getElementById('s-code-' + index);
  if (row && row.closest('tr')) row.closest('tr').remove();
  window._smartParsed.splice(index, 1);
}

async function confirmAllSmartItems() {
  if (!window._smartParsed || window._smartParsed.length === 0) return;
  for (var i = window._smartParsed.length - 1; i >= 0; i--) {
    await confirmSmartItem(i);
  }
}

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

function initVisionQr() {
  fetch(api('/api/vision-token'), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _qrToken = d.token;
      var img = document.getElementById('qr-image');
      if (img) img.src = d.qr || '';

      if (_qrPollTimer) clearInterval(_qrPollTimer);
      _qrPollTimer = setInterval(function() {
        fetch(api('/api/vision-check/' + d.token))
          .then(function(r) { return r.json(); })
          .then(function(result) {
            if (result.expired) {
              clearInterval(_qrPollTimer);
              _qrPollTimer = null;
              return;
            }
            if (result.image) {
              clearInterval(_qrPollTimer);
              _qrPollTimer = null;
              var file = base64ToFile(result.image, 'phone_upload.png');
              doSmartParse(file, 'vision');
            }
          });
      }, 2000);
    });
}

function stopVisionQr() {
  if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null; }
  _qrToken = null;
  var img = document.getElementById('qr-image');
  if (img) img.src = '';
}

// ===================== 交易录入增强 =====================

// 交易数量单位转换：华泰/招商证券上交所债券（可转债/信用债）以"手"为单位录入，1手=10张
// 其他券商/其他品种不需要转换（已直接用张/股）
function normalizeQuantity(quantity, code) {
  if (!quantity || !code || !data || !data._broker) return quantity;
  if (data._broker !== 'huatai' && data._broker !== 'cms') return quantity;
  const info = classifyCode(code);
  // 上交所(sh) + 债权类(可转债11x/113x + 信用债13x) → 手→张(×10)
  if (info && info.market === 'sh' && info.type === '债权') return quantity * 10;
  return quantity;
}

// 显示/隐藏数量单位提示（华泰+上交所债券时提示用户）
function updateQtyHint(code) {
  var el = document.getElementById('trade-qty-hint');
  if (!el || !code || !data || (data._broker !== 'huatai' && data._broker !== 'cms')) { if (el) el.style.display = 'none'; return; }
  var info = classifyCode(code);
  el.style.display = (info && info.market === 'sh' && info.type === '债权') ? '' : 'none';
}

async function addTradeInternal(code, name, direction, price, quantity, date) {
  code = classifyCode.normalizeCode(code);
  // 华泰/招商证券上交所债券：手→张自动转换
  quantity = normalizeQuantity(quantity, code);
  var amount = Math.round(price * quantity * 100) / 100;
  if (!code || !price || !quantity) { showToast('请填写代码、价格和数量'); return; }

  var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
  var f = calcTradeFees(direction, amount, rec.subtype);
  data.trades.push({
    id: uid(), code: code, name: name || code,
    direction: direction, price: price, quantity: quantity,
    amount: amount,
    commission: f.commission, stamp_tax: f.stamp_tax, transfer_fee: f.transfer_fee, other_fee: f.other_fee,
    type: rec.type, subtype: rec.subtype,
    date: date || todayCN(), created_at: nowSec()
  });

  var existing = data.positions.find(function(p) { return p.code === code; });
  if (existing) {
    existing.price = price;
    existing.type = existing.type || rec.type;
    if (direction === 'buy') existing.quantity += quantity;
    else existing.quantity = Math.max(0, existing.quantity - quantity);
  } else if (direction === 'buy') {
    data.positions.push({
      id: uid(), code: code, name: name || code,
      price: price, quantity: quantity, cost: price,
      type: rec.type, subtype: rec.subtype, note: ''
    });
  }

  recalcCash();
  await saveDataNow(); // 确保 PUT 落库后再回填，避免读库早于保存
  // 过去日期的交易：触发历史净值精确回填（Tushare 历史回补，不近似）
  if (date && date < todayCN()) {
    try {
      const r = await fetch(api('/api/data/' + encodeURIComponent(currentAccount) + '/recompute-nav'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDate: date })
      });
      const j = await r.json().catch(function () { return {}; });
      if (j && j.ok) data = await loadData(currentAccount); // 刷新 navHistory
    } catch (e) {}
  }
  renderAll();
  showToast('已记录 ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + (name || code));
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
  const curAcc = (document.getElementById('account-select') && document.getElementById('account-select').value) || '';
  let html = '<div style="margin-bottom:12px;padding:8px;background:#eef3ff;border-radius:6px;font-size:14px;color:#333;">⚙ 当前账户：<b>' + escapeHtml(curAcc) + '</b>（各账户费率独立保存）</div>';
  // Tab 按钮行
  html += '<div class="fee-tabs">';
  FEE_GROUPS.forEach(function(g) {
    html += '<span class="fee-tab' + (g.key === currentFeeTab ? ' active' : '') + '" data-key="' + g.key + '" onclick="switchFeeTab(\'' + g.key + '\')">' + g.label + '</span>';
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
function saveFeeSettings() {
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
  saveData();
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
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.positions && imported.trades !== undefined) {
        data = imported;
        saveData();
        renderAll();
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
