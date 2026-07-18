// shared/core-quote.js – 行情/代码输入/粘贴导入（原 core.js 拆分，全局作用域不变）
// ============================================================
// shared/core.js – 持仓管理共享逻辑
// 被 仓位管理.html (localStorage) 和 index.html (fetch API) 共用
// 
// 全局变量（由 HTML 脚本定义）:
//   data             – 当前账户持仓数据对象
//   currentAccount   – 当前账户名称
//   priceChangeMap   – 行情涨跌幅缓存
//   PRICE_CACHE      – 行情报价缓存
//   accounts         – 账户列表
// ============================================================

// ===================== 安全工具 =====================

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}

// 安全设置提示文本：元素可能不存在（部分 hint 仅在部分录入区渲染），不存在则静默跳过，
// 避免对 null 赋值抛 TypeError 中断后续逻辑（如 onTradeCodeInput 中 fillQuote 前的类型提示）
function setHint(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ===================== 行情 API =====================

async function fetchQuoteFromServer(code) {
  try {
    const r = await fetch(api('/api/quote/' + encodeURIComponent(code)));
    if (r.ok) {
      const data = await r.json();
      // 即使 price 为 null（停牌/无行情），只要有 name 就返回（用于自动填充名称）
      if (data && (data.price || data.name)) return data;
    }
  } catch(e) {}
  return null;
}

async function fetchQuote(code, forceRefresh) {
  if (!code) return null;
  if (forceRefresh === undefined) forceRefresh = false;
  const key = code.trim().toUpperCase().replace(/\s/g, '');
  const now = Date.now();
  // 缓存30秒
  if (!forceRefresh && PRICE_CACHE[key] && (now - PRICE_CACHE[key].time < 30000))
    return PRICE_CACHE[key].data;

  // 特殊处理: 搜特退债
  if (key === '404002') {
    PRICE_CACHE[key] = {
      data: { price: null, name: '搜特退债', code: key, change: null },
      time: now
    };
    return PRICE_CACHE[key].data;
  }

  // 统一走服务端行情代理
  let result = await fetchQuoteFromServer(key);
  if (result) {
    PRICE_CACHE[key] = { data: result, time: now };
    // 有 price 正常返回；仅有 name（停牌等）也返回供自动填充名称
    if (result.price) return result;
    return { price: null, name: result.name || null, code: key, change: null };
  }
  return null;
}

async function fetchHKRate() {
  try {
    const r = await fetch(api('/api/hkrate'));
    if (r.ok) {
      const d = await r.json();
      if (d && d.rate > 0) return d.rate;
    }
  } catch(e) {}
  return null;
}

async function refreshAllPrices() {
  const codes = [...new Set(data.positions.map(p => p.code).filter(Boolean))];
  if (codes.length === 0) { showToast('没有持仓需要刷新'); return; }
  showToast('正在获取 ' + codes.length + ' 只行情...');
  let ok = 0, fail = 0;

  // 批量拉取行情（A股走Tushare实时，港股走腾讯）
  let allQuotes = {};
  try {
    const rr = await fetch(api('/api/quotes?codes=' + encodeURIComponent(codes.join(','))));
    if (rr.ok) allQuotes = await rr.json() || {};
  } catch (e) {}

  // 获取港币→人民币汇率（港股通用）
  var hkRate = await fetchHKRate();
  if (!hkRate || hkRate <= 0) hkRate = 0.868;
  data.hkRate = hkRate; // 全局汇率，供 getMarketValue 使用
  
  // 并发请求，每次10只
  const concurrency = 10;
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (c) => {
      if (allQuotes[c] && allQuotes[c].price) return allQuotes[c];
      return await fetchQuote(c, true);
    }));
    results.forEach((result, idx) => {
      const c = batch[idx];
      const pos = data.positions.find(p => p.code === c);
      if (pos) {
        if (result && result.price) {
          var price = result.price;
          // 港股存港币价格，不转汇率
          pos.price = price;
          if (result.name && !pos.name) pos.name = result.name;
          priceChangeMap[c] = result.change;
          ok++;
        } else {
          if (c === '404002') priceChangeMap['404002'] = 0;
          if (!pos.type) {
            const rec = recognizeCode(c);
            if (rec) { pos.type = rec.type; pos.subtype = rec.subtype; }
          }
          fail++;
        }
        if (!pos.type) {
          const rec = recognizeCode(c);
          if (rec) { pos.type = rec.type; pos.subtype = rec.subtype; }
        }
      }
    });
  }
  // 保存涨跌幅到数据文件，页面刷新后自动恢复
  data.changes = {}; Object.keys(priceChangeMap).forEach(function(k) { data.changes[k] = priceChangeMap[k]; });
  await syncIndexPoints();
  data.totalAsset = calcSummary().total;
  recordNav();
  saveData(); renderAll(); renderReturnsChart();
  const failedCodes = codes.filter(c => {
    const p = data.positions.find(x => x.code === c);
    return p && (!p.price || !p.name);
  });
  if (failedCodes.length > 0) {
    showToast('行情刷新: ' + ok + ' 只成功, ' + fail + ' 只暂无数据: ' +
      failedCodes.slice(0, 6).join(',') +
      (failedCodes.length > 6 ? '...' : ''));
  } else {
    showToast('行情刷新完成: ' + ok + ' 只全部成功');
  }
  // 记录每日收盘价
  saveDailyPricesToDB();
}

/**
 * 完整刷新：拉行情 + 反推现金 + 保存 + 重渲染
 * 供"刷新按钮/F5/自动刷新"统一调用
 */
async function doRefresh() {
  // 总资产持久化（供净值走势展示），须在 refreshAllPrices 之前设置，
  // 使其内部的统一 saveData 一并保存，避免双重写入/重绘
  if (typeof TOTAL_ASSET !== 'undefined' && TOTAL_ASSET > 0) {
    data.totalAsset = TOTAL_ASSET;
  }
  // 休市（周末 / 法定节假日 / 非交易时段）也拉取最新可用价（= 最近交易日收盘价），
  // 保证总资产按持仓现值实时计算；实时接口收盘后回落日线收盘价，与“最近交易日收盘”一致。
  // refreshAllPrices 内部已统一 saveData + renderAll + recordNav + renderReturnsChart
  await refreshAllPrices();
}

async function saveDailyPricesToDB() {
  try {
    // 只在收盘后才记录（A股15:00 / 港股16:00），且今天已记录过就跳过
    if (isMarketOpen()) return;
    if (data._dailyPricesSaved === todayCN()) return;
    var prices = data.positions.map(function(p) {
      return { code: p.code, name: p.name, price: p.price || 0 };
    }).filter(function(p) { return p.code && p.price > 0; });
    if (prices.length === 0) return;
    await fetch(api('/api/daily-prices/' + encodeURIComponent(currentAccount)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices: prices, date: todayCN() })
    });
    data._dailyPricesSaved = todayCN();
    saveData();
  } catch(e) {}
}

// ===================== 代码输入处理 =====================

let codeInputTimer = null;

function onCodeInput(code) {
  clearTimeout(codeInputTimer);
  if (code.length < 4) return;
  codeInputTimer = setTimeout(async () => {
    const rec = recognizeCode(code);
    if (rec) {
      document.getElementById('quick-type').value = rec.type;
      document.getElementById('quick-subtype').value = rec.subtype;
    }
    const quote = await fetchQuote(code);
    if (quote) {
      document.getElementById('quick-name').value = quote.name || '';
      document.getElementById('quick-price').value = quote.price
        ? '¥' + quote.price.toFixed(3) : '获取中...';
      setHint('quick-name-hint', '已获取');
      document.getElementById('quick-price').readOnly = false;
    }
    document.getElementById('quick-detail').style.display = 'grid';
    calcQuick();
  }, 500);
}

function onTradeCodeInput(code) {
  clearTimeout(codeInputTimer);
  if (code.length < 4) return;
  codeInputTimer = setTimeout(async () => {
    try {
      const rec = recognizeCode(code);
      if (rec) {
        document.getElementById('trade-type').value = rec.type;
        document.getElementById('trade-subtype').value = rec.subtype;
        setHint('trade-type-hint', rec.type);
        setHint('trade-subtype-hint', rec.subtype);
        // 华泰上交所债券：显示数量单位提示
        if (typeof updateQtyHint === 'function') updateQtyHint(code);
      } else {
        if (typeof updateQtyHint === 'function') updateQtyHint(null);
      }
      console.log('[onTradeCodeInput] 正在获取行情:', code);
      const quote = await fetchQuote(code);
      console.log('[onTradeCodeInput] 行情结果:', JSON.stringify(quote));
      if (quote) {
        document.getElementById('trade-name').value = quote.name || '';
        setHint('trade-name-hint', '已获取');
        if (!document.getElementById('trade-price').value) {
          document.getElementById('trade-price').value = quote.price || '';
          // 价格被自动填入后，若数量也已填写则重新计算费用
          if (typeof autoCalcTrade === 'function') autoCalcTrade();
        }
      } else {
        console.warn('[onTradeCodeInput] 未获取到行情数据, code=', code);
      }
    } catch(e) {
      console.error('[onTradeCodeInput] 异常:', e);
    }
  }, 500);
}

function onModalCodeInput(code) {
  clearTimeout(codeInputTimer);
  if (code.length < 4) return;
  codeInputTimer = setTimeout(async () => {
    const rec = recognizeCode(code);
    if (rec) {
      document.getElementById('modal-type').value = rec.type;
      document.getElementById('modal-subtype').value = rec.subtype;
      setHint('modal-type-hint', '自动: ' + rec.type);
      setHint('modal-subtype-hint', '自动: ' + rec.subtype);
    }
    const quote = await fetchQuote(code);
    if (quote) {
      document.getElementById('modal-name').value = quote.name || '';
      document.getElementById('modal-price').value = quote.price || '';
      setHint('modal-price-hint', '实时: ¥' + quote.price.toFixed(3));
    }
  }, 500);
}

function calcQuick() {
  const price = parseFloat(document.getElementById('quick-price').value.replace('¥', '')) || 0;
  const qty = parseInt(document.getElementById('quick-qty').value) || 0;
  const mv = price * qty;
  document.getElementById('quick-mv').value = mv > 0
    ? fmt(mv).replace('¥', '')
    : '-';
}

function addQuickPosition() {
  const code = classifyCode.normalizeCode(document.getElementById('quick-code').value.trim());
  const name = document.getElementById('quick-name').value.trim();
  var qty = parseInt(document.getElementById('quick-qty').value);
  const priceVal = document.getElementById('quick-price').value.replace('¥', '').trim();
  const price = parseFloat(priceVal);
  const type = document.getElementById('quick-type').value;
  const subtype = document.getElementById('quick-subtype').value;

  // 华泰/招商证券上交所债券：手→张自动转换
  if (typeof normalizeQuantity === 'function') qty = normalizeQuantity(qty, code);

  if (!code || !qty || qty <= 0) { showToast('请填写代码和数量'); return; }
  if (isNaN(price) || price <= 0) { showToast('请输入有效价格（可手动填写）'); return; }

  data.positions.push({
    id: uid(), code, name: name,
    price: price, quantity: qty,
    cost: price, type: type, subtype: subtype, note: ''
  });
  saveData();
  renderAll();
  showToast('已添加 ' + (name || code) + ' ' + qty + (subtype === '可转债' ? '张' : '股'));

  document.getElementById('quick-code').value = '';
  document.getElementById('quick-name').value = '';
  document.getElementById('quick-qty').value = '';
  document.getElementById('quick-price').value = '';
  document.getElementById('quick-type').value = '';
  document.getElementById('quick-subtype').value = '';
  document.getElementById('quick-mv').value = '';
  document.getElementById('quick-detail').style.display = 'none';
  setHint('quick-name-hint', '自动获取');
}

// ===================== 粘贴导入 =====================

function pasteImport() {
  document.getElementById('paste-import-area').style.display = 'block';
}

function executePasteImport() {
  const raw = document.getElementById('paste-input').value.trim();
  if (!raw) { showToast('请粘贴数据'); return; }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  lines.forEach(line => {
    const parts = line.split(/\s+/);
    if (parts.length < 3) { skipped++; return; }
    const code = parts[0].replace(/[.](SH|SZ|HK|US)$/i, '');
    const type = parts[1] === '债权' ? '债权' : '股权';
    const recognized = recognizeCode(code);
    const subtype = parts[2] || (type === '股权' ? (recognized ? recognized.subtype : '深市') : type === '现金' ? '现金' : '可转债');
    const qty = parseInt(parts[3]) || 0;
    if (data.positions.some(p => p.code === code)) { skipped++; return; }
    data.positions.push({
      id: uid(), code: code, name: '', price: null,
      quantity: qty, cost: null, type: type, subtype: subtype, note: ''
    });
    added++;
  });
  saveData(); renderAll();
  document.getElementById('paste-import-area').style.display = 'none';
  showToast('已导入 ' + added + ' 只' + (skipped > 0 ? '，' + skipped + ' 只跳过' : ''));
  doRefresh();
}
