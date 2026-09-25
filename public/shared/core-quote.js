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

async function fetchHKRate(realtime) {
  try {
    const r = await fetch(api('/api/hkrate' + (realtime ? '?realtime=1' : '')));
    if (r.ok) {
      const d = await r.json();
      if (d && d.rate > 0) return d.rate;
    }
  } catch(e) {}
  return null;
}

// 页面内所有账户共用一次汇率快照，避免切换账户时各自使用不同的账户旧汇率。
var unifiedHkRate = null;
var unifiedHkRatePromise = null;
async function fetchUnifiedHKRate() {
  if (unifiedHkRate != null && unifiedHkRate > 0) return unifiedHkRate;
  if (!unifiedHkRatePromise) {
    var hasHK = typeof data !== 'undefined' && data && Array.isArray(data.positions)
      && data.positions.some(function (p) { return p.subtype === '港股'; });
    var realtime = hasHK && typeof isHkMarketTradingNow === 'function' && isHkMarketTradingNow();
    unifiedHkRatePromise = fetchHKRate(realtime).then(function (rate) {
      if (rate != null && rate > 0) unifiedHkRate = rate;
      return unifiedHkRate;
    }).catch(function () { return unifiedHkRate; });
  }
  return unifiedHkRatePromise;
}

async function refreshAllPrices(marketsToRefresh) {
  window._priceSaveError = null;
  var allowedMarkets = Array.isArray(marketsToRefresh) ? new Set(marketsToRefresh) : null;
  const requestedPositions = data.positions.filter(function (position) {
    return !allowedMarkets || allowedMarkets.has(marketForPosition(position));
  });
  const codes = [...new Set(requestedPositions.map(p => p.code).filter(Boolean))];
  if (codes.length === 0) { showToast('没有持仓需要刷新'); return; }
  if (typeof refreshMarketStateSnapshot === 'function') await refreshMarketStateSnapshot();
  var today = todayCN();
  showToast('正在获取 ' + codes.length + ' 只行情...');
  let ok = 0, reused = 0, fail = 0;
  var reusedCodes = new Set();
  // 导入日按行情增量更新券商持仓总值；次日起直接切到系统绝对持仓市值。
  var systemPositionValueBeforeRefresh = getSystemPositionValue();

  // 批量拉取行情（A股走Tushare实时，港股走腾讯）
  // 页面刷新只允许一次批量请求；批量异常时最多再做一次同样的批量重试，
  // 禁止退化成“批量失败后逐只请求”的 N+1 模式。
  const fetchQuoteBatch = async function (batchCodes) {
    if (!batchCodes.length) return {};
    try {
      const rr = await fetch(api('/api/quotes?codes=' + encodeURIComponent(batchCodes.join(','))));
      if (rr.ok) return await rr.json() || {};
    } catch (e) {}
    return {};
  };
  let allQuotes = await fetchQuoteBatch(codes);
  const retryCodes = codes.filter(function (code) {
    // 搜特退债是已知退市标的，无实时价格，不应触发无意义的二次请求。
    return code !== '404002' && (!allQuotes[code] || !(Number(allQuotes[code].price) > 0));
  });
  if (retryCodes.length) {
    const retryQuotes = await fetchQuoteBatch(retryCodes);
    Object.keys(retryQuotes).forEach(function (code) { allQuotes[code] = retryQuotes[code]; });
  }

  // 港股交易时段请求实时汇率；非交易时段只读最近一次已落库值。
  var hasHK = requestedPositions.some(function (p) { return marketForPosition(p) === 'HK'; });
  var hkRate = await fetchHKRate(hasHK && typeof isHkRealtimeRefreshAllowed === 'function' && isHkRealtimeRefreshAllowed());
  if (!hkRate || hkRate <= 0) hkRate = (Number(data.hkRate) > 0 ? Number(data.hkRate) : 0.868);
  unifiedHkRate = hkRate;
  unifiedHkRatePromise = Promise.resolve(hkRate);
  data.hkRate = hkRate; // 全局汇率，供 getMarketValue 使用
  
  // 并发请求，每次10只
  const concurrency = 10;
  var validatedPriceQuotes = new Map();
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (c) => {
      return allQuotes[c] || null;
    }));
    results.forEach((result, idx) => {
      const c = batch[idx];
      const matchingPositions = data.positions.filter(p => p.code === c);
      const pos = matchingPositions[0];
      if (pos) {
        if (result && result.price) {
          var market = marketForPosition(pos);
          var marketState = marketStateSnapshot && marketStateSnapshot.markets && marketStateSnapshot.markets[market];
          var quoteDate = quoteDateCN(result.quote_time);
          var quoteIsToday = quoteDate === today;
          var marketOpenToday = marketState && marketState.businessDate === today && marketState.status === 'open';
          // 市场休市或日历未知时，不用旧行情覆盖页面上的最新价格；开市时只采纳当日行情。
          if (marketOpenToday && quoteIsToday) {
            var price = result.price;
            matchingPositions.forEach(function(position) {
              position.price = price;
              if (result.name && !position.name) position.name = result.name;
            });
            priceChangeMap[c] = result.change;
            validatedPriceQuotes.set(c, { price: price, name: result.name || pos.name || '', quote_time: result.quote_time, quote_currency: market === 'HK' ? 'HKD' : 'CNY' });
            ok++;
          } else if (marketState && marketState.businessDate === today && marketState.status !== 'open' && quoteDate && quoteDate <= today) {
            // 休市或日历未知时，手动刷新仍可读取最近有效价参与估值，但不伪装成今日涨跌或收盘价。
            matchingPositions.forEach(function(position) {
              position.price = result.price;
              if (result.name && !position.name) position.name = result.name;
            });
            priceChangeMap[c] = null;
            reused++;
            reusedCodes.add(c);
          } else {
            priceChangeMap[c] = null;
            fail++;
          }
        } else {
          if (c === '404002') priceChangeMap['404002'] = null;
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
  // 指数对比线同步已移至渲染之后（见下方 renderAll 之后），不再阻塞总资产计算
  applyAuthoritativeMarketDelta(systemPositionValueBeforeRefresh);
  data.totalAsset = calcSummary().total;
  if (typeof TOTAL_ASSET !== 'undefined') TOTAL_ASSET = data.totalAsset;
  // 行情到齐后立即显示新价格和总资产；保存价格、记录净值等网络请求不再阻塞页面。
  renderAll();
  // 阶段二-5：行情价格用局部 PATCH 接口，不触发 saveData 全量保存
  var requestedCodes = new Set(codes);
  var pricesToSave = data.positions.filter(function(p) { return requestedCodes.has(p.code); })
    .map(function(p) { return { code: p.code, price: p.price }; }).filter(function(p) { return p.code && p.price != null; });
  var pricesSaved = false;
  try {
    var pr = await fetch(api('/api/positions/prices?version=' + (dataVersion != null ? dataVersion : '')), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: currentAccount, prices: pricesToSave })
    });
    var pj = await pr.json().catch(function(){ return {}; });
    // 2026-08-04 阻断修复：必须检查保存状态，否则 400/500 时仍提示"刷新完成"，下次打开价格回退旧值
    if (!pr.ok) {
      console.warn('[refreshAllPrices] 价格保存失败', pr.status, pj.error || '');
      var saveError = '行情已获取，但价格保存失败：' + (pj.error || ('HTTP ' + pr.status)) + '（请刷新后重试）';
      showToast(saveError);
      window._priceSaveError = saveError;
    } else if (typeof pj.version === 'number') {
      // 同步新版本号，避免紧接着的第二次操作误报"其他窗口已修改"（2026-08-04 第二轮修复）
      dataVersion = pj.version;
      pricesSaved = true;
    } else {
      pricesSaved = true;
    }
  } catch(e) {
    console.warn('[refreshAllPrices] 价格保存异常', e);
      var saveError = '行情已获取，但价格保存失败（' + (e.message || e) + '）';
      showToast(saveError);
      window._priceSaveError = saveError;
  }
  // 净值必须在新价格成功落库后记录，防止保存旧持仓价对应的新总资产。
  if (pricesSaved) await recordNav();
  // recordNav 会返回最新归因；重新绑定总资产浮框，使首次口径切换说明立即生效。
  if (pricesSaved && typeof renderStats === 'function') renderStats();
  renderReturnsChart();
  // 指数对比线由 Worker 的 index_recent 任务增量入库，页面只读取账户数据快照。
  const failedCodes = codes.filter(c => fail > 0 && !validatedPriceQuotes.has(c) && !reusedCodes.has(c));
  if (window._priceSaveError) {
    showToast(window._priceSaveError);
    window._priceSaveError = null;
  } else if (failedCodes.length > 0 || reused > 0) {
    showToast('行情刷新: ' + ok + ' 只当日行情, ' + reused + ' 只旧价或日期未确认, ' + fail + ' 只未取得当日行情: ' +
      failedCodes.slice(0, 6).join(',') +
      (failedCodes.length > 6 ? '...' : ''));
  } else {
    showToast('行情刷新完成: ' + ok + ' 只已取得当日行情');
  }
  // 记录每日收盘价
  saveDailyPricesToDB(validatedPriceQuotes);
}

/**
 * 完整刷新：拉行情 + 反推现金 + 保存 + 重渲染
 * 供"刷新按钮/F5/自动刷新"统一调用
 */
var _priceRefreshInFlight = null;

async function doRefresh(marketsToRefresh) {
  if (_priceRefreshInFlight) return _priceRefreshInFlight;
  _priceRefreshInFlight = (async function () {
  // 手动刷新即使休市也使用最近交易日收盘价；自动刷新由 doAutoRefresh 统一控制。
  // refreshAllPrices 内部统一即时渲染、保存价格、记录净值和刷新收益图。
    await refreshAllPrices(marketsToRefresh);
  })();
  try {
    return await _priceRefreshInFlight;
  } finally {
    _priceRefreshInFlight = null;
  }
}

function shanghaiClockNumber() {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  var p = Object.fromEntries(parts.map(function (item) { return [item.type, item.value]; }));
  return Number(p.hour) * 100 + Number(p.minute);
}

function isChinaTradingDayNow() {
  var day = new Date(todayCN() + 'T00:00:00Z').getUTCDay();
  return day >= 1 && day <= 5 && !isCnHoliday(todayCN());
}

function isAfterHoldingMarketClose() {
  var states = holdingMarketStates();
  var markets = Object.keys(states);
  var knownMarkets = markets.filter(function (market) {
    var state = states[market];
    return state && state.businessDate === todayCN() && state.status !== 'unknown';
  });
  var openMarkets = knownMarkets.filter(function (market) { return states[market].status === 'open'; });
  return openMarkets.length > 0 && openMarkets.every(function (market) {
    return states[market].isAfterMarketClose === true;
  }) && !knownMarkets.some(function (market) { return states[market].isTradingNow === true; });
}

function autoQuoteRefreshDoneToday(market) {
  var today = todayCN();
  if (data && data._autoQuoteRefreshDates && data._autoQuoteRefreshDates[market] === today) return true;
  try { return localStorage.getItem('_autoQuoteRefresh_' + currentAccount + '_' + market) === today; } catch (e) { return false; }
}

function markAutoQuoteRefreshDoneToday(markets) {
  var today = todayCN();
  if (!data._autoQuoteRefreshDates) data._autoQuoteRefreshDates = {};
  (markets || []).forEach(function (market) {
    data._autoQuoteRefreshDates[market] = today;
    try { localStorage.setItem('_autoQuoteRefresh_' + currentAccount + '_' + market, today); } catch (e) {}
  });
}

// 自动行情规则：交易时段允许刷新；最终收盘后当天只刷新一次；周末/节假日不刷新。
async function doAutoRefresh() {
  if (!data || !Array.isArray(data.positions) || !data.positions.length) {
    return { ok: true, skipped: true, reason: 'market_closed' };
  }
  if (typeof refreshMarketStateSnapshot === 'function') await refreshMarketStateSnapshot();
  var states = holdingMarketStates();
  var markets = Object.keys(states);
  var today = todayCN();
  var hasUnknownMarket = !markets.length || markets.some(function (market) {
    return !states[market] || states[market].businessDate !== today || states[market].status === 'unknown';
  });
  var openMarkets = markets.filter(function (market) {
    return states[market] && states[market].businessDate === today && states[market].status === 'open';
  });
  var tradingMarkets = openMarkets.filter(function (market) { return states[market].isTradingNow === true; });
  var marketOpen = tradingMarkets.length > 0;
  var afterClose = isAfterHoldingMarketClose();
  var afterCloseMarkets = afterClose ? openMarkets.filter(function (market) {
    return !autoQuoteRefreshDoneToday(market);
  }) : [];
  if (!marketOpen && afterCloseMarkets.length === 0) {
    return { ok: true, skipped: true, reason: hasUnknownMarket ? 'market_calendar_unknown' : 'market_closed' };
  }
  var refreshMarkets = marketOpen ? tradingMarkets : afterCloseMarkets;
  var result = await doRefresh(refreshMarkets);
  if (afterClose) markAutoQuoteRefreshDoneToday(refreshMarkets);
  return result;
}

async function saveDailyPricesToDB(validatedQuotes) {
  try {
    // 按每只证券所属市场判断是否已收盘，只保存当天有效行情。
    if (typeof refreshMarketStateSnapshot === 'function') await refreshMarketStateSnapshot();
    var writeDate = todayCN();
    if (!validatedQuotes || validatedQuotes.size === 0) return;
    var pricesByMarket = { CN: [], HK: [] };
    Array.from(validatedQuotes.entries()).map(function(entry) {
      var quote = entry[1] || {};
      return { code: entry[0], name: quote.name || '', price: quote.price || 0, quote_time: quote.quote_time || null, quote_currency: quote.quote_currency || null };
    }).filter(function(p) {
      var position = data.positions.find(function (item) { return item.code === p.code; });
      var market = marketForPosition(position);
      var state = marketStateSnapshot && marketStateSnapshot.markets && marketStateSnapshot.markets[market];
      if (!p.code || !(p.price > 0) || quoteDateCN(p.quote_time) !== writeDate || !state || state.businessDate !== writeDate || state.status !== 'open' || !state.isAfterMarketClose) return false;
      var savedKey = '_dailyPricesSaved_' + currentAccount + '_' + market;
      try { if (localStorage.getItem(savedKey) === writeDate) return false; } catch (e) {}
      pricesByMarket[market].push(p);
      return true;
    });
    for (var market of ['CN', 'HK']) {
      if (!pricesByMarket[market].length) continue;
      var response = await fetch(api('/api/daily-prices/' + encodeURIComponent(currentAccount)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: pricesByMarket[market], date: writeDate })
      });
      if (!response.ok) throw new Error('收盘价保存失败：HTTP ' + response.status);
      try { localStorage.setItem('_dailyPricesSaved_' + currentAccount + '_' + market, writeDate); } catch(e) {}
    }
    if (Object.keys(holdingMarketStates()).every(function (market) {
      var state = marketStateSnapshot.markets[market];
      if (!state || state.status !== 'open') return true;
      try { return localStorage.getItem('_dailyPricesSaved_' + currentAccount + '_' + market) === writeDate; } catch (e) { return false; }
    })) data._dailyPricesSaved = writeDate;
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
        if (typeof updateTradeCurrencyLabels === 'function') updateTradeCurrencyLabels(rec.subtype);
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

async function addQuickPosition() {
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

  // 阶段二-6：快速添加走 position-events，服务端统一事务写持仓+交易
  // 幂等键：event.id 前端生成，重复点击/网络重试不会新增第二条（2026-08-04 修复）
  try {
    var r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/ledger/position-events?version=' + (dataVersion != null ? dataVersion : '')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { id: uid(), code, name, direction: 'open', price: price, quantity: qty, type, subtype, date: todayCN(), note: '快速添加' } })
    });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { showToast(j.error || '添加失败'); return; }
    if (j.data) refreshDataFromServer(j.data);
    renderAll();
  } catch(e) { showToast('添加失败：' + (e.message || e)); return; }

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

async function executePasteImport() {
  const raw = document.getElementById('paste-input').value.trim();
  if (!raw) { showToast('请粘贴数据'); return; }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const events = [];
  let skipped = 0, noPrice = 0;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) { skipped++; continue; }
    const code = parts[0].replace(/[.](SH|SZ|HK|US)$/i, '');
    const type = parts[1] === '债权' ? '债权' : '股权';
    const recognized = recognizeCode(code);
    const subtype = parts[2] || (type === '股权' ? (recognized ? recognized.subtype : '深市') : type === '现金' ? '现金' : '可转债');
    const qty = parseInt(parts[3]) || 0;
    if (qty <= 0) { skipped++; continue; }
    if (data.positions.some(p => p.code === code)) { skipped++; continue; }
    // 价格：优先第5列显式填写，否则拉行情兜底（期初建仓价格必须>0，后端会拒绝 0 价）
    let price = parseFloat(parts[4]);
    if (!price || price <= 0) {
      try {
        const q = await fetchQuote(code);
        if (q && q.price && q.price > 0) price = q.price;
      } catch(e) {}
    }
    if (!price || price <= 0) { noPrice++; continue; }
    events.push({
      id: uid(), // 幂等键：网络重试/重复点击不会重复导入（2026-08-04 修复）
      code, name: '', direction: 'open', price: price, quantity: qty,
      type, subtype, date: todayCN(), note: '粘贴导入'
    });
  }
  if (events.length === 0) {
    let msg = '没有可导入的持仓';
    if (skipped) msg += '（' + skipped + ' 只格式错误/重复）';
    if (noPrice) msg += '（' + noPrice + ' 只无法获取价格）';
    showToast(msg);
    return;
  }
  try {
    var r = await fetch(api('/api/accounts/' + encodeURIComponent(currentAccount) + '/ledger/position-events/batch?version=' + (dataVersion != null ? dataVersion : '')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: events })
    });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) { showToast(j.error || '导入失败'); return; }
    if (j.data) refreshDataFromServer(j.data);
    renderAll();
    document.getElementById('paste-import-area').style.display = 'none';
    let msg = '已导入 ' + events.length + ' 只' + (skipped > 0 ? '，' + skipped + ' 只跳过' : '') + (noPrice > 0 ? '，' + noPrice + ' 只无价格未导入' : '');
    showToast(msg);
    doRefresh();
  } catch(e) { showToast('导入失败：' + (e.message || e)); }
}
