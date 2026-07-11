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
  const tradeNet = (data.trades || []).reduce((s, t) => s + (t.direction === 'buy' ? -(t.amount || 0) : (t.amount || 0)), 0);
  const base = (typeof data.cashBase === 'number') ? data.cashBase : 0;
  data.cash = base + cfNet + tradeNet;
}

function addTrade() {
  const code = classifyCode.normalizeCode(document.getElementById('trade-code').value.trim());
  const name = document.getElementById('trade-name').value.trim() || code;
  const direction = document.getElementById('trade-dir').value;
  const price = parseFloat(document.getElementById('trade-price').value);
  const qty = parseInt(document.getElementById('trade-qty').value);
  const amount = parseFloat(document.getElementById('trade-amount').value) || price * qty;
  const type = document.getElementById('trade-type').value;
  const subtype = document.getElementById('trade-subtype').value;
  const note = document.getElementById('trade-note').value.trim();

  if (!code || isNaN(price) || isNaN(qty) || qty <= 0) {
    showToast('请填写代码、价格和数量');
    return;
  }

  const trade = {
    id: uid(),
    date: todayCN(),
    created_at: nowSec(),
    code: code, name: name, direction: direction,
    price: price, quantity: qty, amount: amount,
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
  document.getElementById('trade-price').value = '';
  document.getElementById('trade-qty').value = '';
  document.getElementById('trade-amount').value = '';
  document.getElementById('trade-note').value = '';
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

function addTradeInternal(code, name, direction, price, quantity, date) {
  code = classifyCode.normalizeCode(code);
  var amount = Math.round(price * quantity * 100) / 100;
  if (!code || !price || !quantity) { showToast('请填写代码、价格和数量'); return; }

  var rec = recognizeCode(code) || { type: '股权', subtype: 'A股' };
  data.trades.push({
    id: uid(), code: code, name: name || code,
    direction: direction, price: price, quantity: quantity,
    amount: amount, type: rec.type, subtype: rec.subtype,
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
  saveData();
  renderAll();
  showToast('已记录 ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + (name || code));
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
