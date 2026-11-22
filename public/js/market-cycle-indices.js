// 市场周期「常见指数」View（View / Presenter 分离：本文件只做渲染与事件绑定，不直接发请求）。
(function () {
  var PERIOD_LABELS = {
    '1d': '日涨跌',
    '1w': '周涨跌',
    '1m': '月涨跌',
    '1q': '季度涨跌',
    'ytd': '今年涨跌',
    'ytd_mdd': '今年最大回撤',
    '1y': '近一年',
    '3y': '三年',
    '5y': '五年',
    '10y': '十年',
  };

  function esc(v) {
    return typeof escapeHtml === 'function' ? escapeHtml(String(v == null ? '' : v)) : String(v == null ? '' : v);
  }

  function fmtNum(v, digits) {
    var n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : '--';
  }

  function fmtPct(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return '--';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function quantile(sorted, ratio) {
    if (!sorted.length) return null;
    var index = (sorted.length - 1) * ratio;
    var lower = Math.floor(index);
    var upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  function buildSparklineSvg(sparkline, baseClose, tone) {
    var pts = Array.isArray(sparkline) ? sparkline.filter(function (v) { return Number.isFinite(Number(v)); }).map(Number) : [];
    if (pts.length < 2) {
      return '<svg class="mvi-sparkline" viewBox="0 0 88 36" aria-hidden="true"></svg>';
    }
    var min = Math.min.apply(null, pts);
    var max = Math.max.apply(null, pts);
    var base = Number(baseClose);
    if (Number.isFinite(base) && base > 0) {
      min = Math.min(min, base);
      max = Math.max(max, base);
    }
    if (max === min) {
      max += 1;
      min -= 1;
    }
    var W = 88;
    var H = 36;
    var pad = 3;
    var x = function (i) { return pad + i * (W - pad * 2) / Math.max(1, pts.length - 1); };
    var y = function (v) { return pad + (max - v) * (H - pad * 2) / (max - min); };
    var strokeColor = tone === 'up' ? 'var(--up)' : (tone === 'down' ? 'var(--down)' : 'var(--text-secondary)');
    var parts = [];
    if (Number.isFinite(base) && base > 0) {
      var by = y(base).toFixed(2);
      parts.push('<line x1="' + pad + '" y1="' + by + '" x2="' + (W - pad) + '" y2="' + by + '" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 2"/>');
    }
    var d = pts.map(function (v, i) {
      return (i === 0 ? 'M' : 'L') + x(i).toFixed(2) + ' ' + y(v).toFixed(2);
    }).join(' ');
    parts.push('<path d="' + d + '" fill="none" stroke="' + strokeColor + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');
    return '<svg class="mvi-sparkline" viewBox="0 0 88 36" aria-hidden="true">' + parts.join('') + '</svg>';
  }

  window.mviSetStatus = function (text) {
    var el = document.getElementById('mvi-status');
    if (el) el.textContent = text || '';
  };

  window.mviSetLoadError = function (error) {
    window.mviSetStatus('常见指数加载失败：' + ((error && error.message) || error || '未知错误'));
    var cards = document.getElementById('mvi-cards');
    if (cards) cards.innerHTML = '';
  };

  window.mviSetChartError = function (error) {
    var chartWrap = document.getElementById('mvi-chart-box');
    if (chartWrap) {
      chartWrap.innerHTML = '<div class="stock-analysis-chart-empty">指数历史曲线加载失败：' + esc((error && error.message) || error) + '</div>';
    }
  };

  window.mviInit = function () {
    if (window.__mviReady) return;
    window.__mviReady = true;
    document.querySelectorAll('[data-mvi-period]').forEach(function (btn) {
      btn.onclick = function () {
        if (typeof mviSelectPeriod === 'function') mviSelectPeriod(btn.getAttribute('data-mvi-period'));
      };
    });
    document.querySelectorAll('[data-mvi-mode]').forEach(function (btn) {
      btn.onclick = function () {
        if (typeof mviSelectMode === 'function') mviSelectMode(btn.getAttribute('data-mvi-mode'));
      };
    });
  };

  window.mviRender = function () {
    var overview = (typeof mviState === 'object' && mviState.overview) || {};
    var asOfDate = overview.asOfDate || null;
    var updatedEl = document.getElementById('mv-updated');
    if (updatedEl) {
      updatedEl.textContent = asOfDate ? ('数据日期：' + asOfDate) : '暂无可用数据';
    }
    window.mviSetStatus(asOfDate ? '' : '常见指数尚未完成首次数据回填，请先运行同步或回填脚本。');
    window.mviRenderCards();
  };

  window.mviRenderCards = function () {
    var container = document.getElementById('mvi-cards');
    if (!container) return;
    var period = (typeof mviState === 'object' && mviState.period) || '1d';
    var selectedCode = (typeof mviState === 'object' && mviState.selectedCode) || '000300.SH';

    document.querySelectorAll('[data-mvi-period]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mvi-period') === period);
    });

    var indices = (mviState.overview && mviState.overview.indices) || [];
    if (!indices.length) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = indices.map(function (item) {
      var pm = (item.periods && item.periods[period]) || {};
      var pct = pm.pct;
      var hasPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
      var numPct = hasPct ? Number(pct) : null;
      var tone = !hasPct || numPct === 0 ? 'flat' : (period === 'ytd_mdd' || numPct < 0 ? 'down' : 'up');
      var isSelected = item.indexCode === selectedCode;
      var subText = '';
      if (pm.insufficientYears) {
        subText = '成立不足' + pm.insufficientYears + '年';
      } else if (period === 'ytd_mdd' && pm.peakDate && pm.troughDate) {
        subText = pm.peakDate.slice(2) + ' → ' + pm.troughDate.slice(2);
      } else if (item.latestDate) {
        subText = item.latestDate;
      }
      var titleAttr = period === 'ytd_mdd' && pm.peakDate && pm.troughDate
        ? ' title="回撤区间：' + esc(pm.peakDate) + ' 至 ' + esc(pm.troughDate) + '"'
        : '';
      return '<button type="button" class="mvi-card mvi-card--' + tone + (isSelected ? ' is-selected' : '') + '" data-mvi-index="' + esc(item.indexCode) + '"' + titleAttr + '>' +
        '<div class="mvi-card-main">' +
          '<div class="mvi-card-head"><span class="mvi-card-name">' + esc(item.name) + '</span><span class="mvi-card-code">' + esc(item.indexCode) + '</span></div>' +
          '<div class="mvi-card-close">' + fmtNum(item.latestClose, 2) + '</div>' +
          '<div class="mvi-card-pct">' + (hasPct ? fmtPct(numPct) : '--') + '<span class="mvi-card-sub">' + esc(subText) + '</span></div>' +
        '</div>' +
        buildSparklineSvg(pm.sparkline, pm.baseClose, tone) +
      '</button>';
    }).join('');

    container.querySelectorAll('[data-mvi-index]').forEach(function (card) {
      card.onclick = function () {
        if (typeof mviSelectIndex === 'function') mviSelectIndex(card.getAttribute('data-mvi-index'));
      };
    });
  };

  window.mviRenderChartSection = function () {
    var mode = (typeof mviState === 'object' && mviState.mode) || 'close';
    var selectedCode = (typeof mviState === 'object' && mviState.selectedCode) || '000300.SH';
    document.querySelectorAll('[data-mvi-mode]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-mvi-mode') === mode);
    });

    var payload = mviState.historyCache && mviState.historyCache[selectedCode];
    var titleEl = document.getElementById('mvi-chart-title');
    var summaryEl = document.getElementById('mvi-summary');
    var rangeEl = document.getElementById('mvi-date-range');
    var chartBox = document.getElementById('mvi-chart-box');
    if (!chartBox) return;

    var meta = ((mviState.overview && mviState.overview.indices) || []).find(function (x) { return x.indexCode === selectedCode; }) || (payload && payload.index);
    if (titleEl && meta) {
      titleEl.textContent = meta.name + '（' + meta.indexCode + '）历史走势与估值分位';
    }

    if (mviState.historyLoading && !payload) {
      chartBox.innerHTML = '<div class="stock-analysis-chart-empty">正在加载历史序列...</div>';
      if (summaryEl) summaryEl.innerHTML = '';
      return;
    }

    var history = (payload && payload.history) || [];
    if (!history.length) {
      chartBox.innerHTML = '<div class="stock-analysis-chart-empty">暂无该指数的历史数据</div>';
      if (summaryEl) summaryEl.innerHTML = '';
      return;
    }

    var lastDate = history[history.length - 1].date;
    var end = mviState.customEnd || lastDate;
    var activeYears = mviState.range === 'all' ? null : (Number(String(mviState.range || '10y').replace('y', '')) || 10);
    var start = mviState.customStart || (activeYears && window.CoreDate ? CoreDate.subtractYears(end, activeYears) : history[0].date);

    if (rangeEl && window.DateRangeControl) {
      rangeEl.innerHTML = DateRangeControl.render({
        id: 'mvi-history-range',
        label: '历史区间',
        start: start,
        end: end,
        activeYears: mviState.customStart || mviState.customEnd ? null : activeYears,
        presets: [30, 20, 10, 5, 3, 1],
      });
      DateRangeControl.bind(rangeEl, {
        id: 'mvi-history-range',
        onChange: function (next) {
          if (next && next.activeYears) {
            mviSelectRange(next.activeYears + 'y', null, null);
          } else {
            mviSelectRange('custom', next && next.start, next && next.end);
          }
        },
      });
    }

    var rows = history.filter(function (r) {
      if (r.date < start || r.date > end) return false;
      var v = Number(r[mode]);
      return Number.isFinite(v) && v > 0;
    });

    if (!rows.length) {
      chartBox.innerHTML = '<div class="stock-analysis-chart-empty">所选区间内暂无有效数据</div>';
      if (summaryEl) summaryEl.innerHTML = '';
      return;
    }

    var values = rows.map(function (r) { return Number(r[mode]); });
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var currentVal = values[values.length - 1];
    var p20 = quantile(sorted, 0.2);
    var p50 = quantile(sorted, 0.5);
    var p80 = quantile(sorted, 0.8);
    var less = sorted.filter(function (v) { return v < currentVal; }).length;
    var equal = sorted.filter(function (v) { return v === currentVal; }).length;
    var pctRank = ((less + equal * 0.5) / sorted.length) * 100;
    var rangePct = values[0] > 0 ? ((currentVal / values[0]) - 1) * 100 : null;
    var unitLabel = mode === 'close' ? '点位' : (mode === 'pe' ? 'PE-TTM' : 'PB');

    if (summaryEl) {
      summaryEl.innerHTML =
        '<div><span>当前' + esc(unitLabel) + '</span><strong>' + fmtNum(currentVal, 2) + '</strong></div>' +
        '<div><span>区间分位</span><strong>' + fmtNum(pctRank, 2) + '%</strong></div>' +
        '<div><span>20%分位（机会区）</span><strong>' + fmtNum(p20, 2) + '</strong></div>' +
        '<div><span>50%分位（中位数）</span><strong>' + fmtNum(p50, 2) + '</strong></div>' +
        '<div><span>80%分位（危险区）</span><strong>' + fmtNum(p80, 2) + '</strong></div>' +
        '<div><span>区间涨跌幅</span><strong>' + fmtPct(rangePct) + '</strong></div>' +
        '<div><span>有效样本数</span><strong>' + sorted.length + '</strong></div>';
    }

    var W = window.ChartInteraction ? ChartInteraction.width(chartBox, 1100) : 1100;
    var H = window.innerWidth <= 760 ? 260 : 340;
    var L = 58, R = 24, T = 26, B = 42;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (Number.isFinite(p20)) min = Math.min(min, p20);
    if (Number.isFinite(p80)) max = Math.max(max, p80);
    if (max === min) { max += 1; min = Math.max(0, min - 1); }
    var pad = (max - min) * 0.08;
    min = Math.max(0, min - pad);
    max += pad;

    function x(i) { return L + i * (W - L - R) / Math.max(1, rows.length - 1); }
    function y(v) { return T + (max - v) * (H - T - B) / (max - min); }

    var svg = [];
    for (var i = 0; i < 5; i++) {
      var yy = T + i * (H - T - B) / 4;
      var yVal = max - i * (max - min) / 4;
      svg.push('<line class="valuation-grid" x1="' + L + '" y1="' + yy + '" x2="' + (W - R) + '" y2="' + yy + '"/>');
      svg.push('<text x="' + (L - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + fmtNum(yVal, 2) + '</text>');
    }
    [
      { val: p20, cls: 'band20', label: '20% ' + fmtNum(p20, 2) },
      { val: p50, cls: 'band50', label: '50% ' + fmtNum(p50, 2) },
      { val: p80, cls: 'band80', label: '80% ' + fmtNum(p80, 2) },
    ].forEach(function (band) {
      if (!Number.isFinite(band.val)) return;
      var by = y(band.val);
      svg.push('<line class="' + band.cls + '" x1="' + L + '" y1="' + by + '" x2="' + (W - R) + '" y2="' + by + '"/>');
      svg.push('<text x="' + (W - R - 4) + '" y="' + (by - 4) + '" text-anchor="end">' + band.label + '</text>');
    });

    var mainPath = rows.map(function (r, idx) {
      return (idx ? 'L' : 'M') + x(idx).toFixed(2) + ' ' + y(Number(r[mode])).toFixed(2);
    }).join(' ');
    svg.push('<path class="valuation-line" d="' + mainPath + '"/>');

    var ticks = Math.min(W < 600 ? 3 : 8, Math.max(1, rows.length - 1));
    for (var t = 0; t <= ticks; t++) {
      var idx = Math.round(t * (rows.length - 1) / ticks);
      svg.push('<text x="' + x(idx) + '" y="' + (H - 14) + '" text-anchor="middle">' + esc(rows[idx].date.slice(0, 7)) + '</text>');
    }
    svg.push('<rect class="valuation-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '"/>');

    chartBox.innerHTML =
      '<div class="stock-analysis-valuation-legend"><span class="line"></span>' + esc(unitLabel) +
      ' <span class="b20"></span>20%分位 <span class="b50"></span>50%分位 <span class="b80"></span>80%分位</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(unitLabel) + '历史曲线">' + svg.join('') + '</svg>' +
      '<div class="stock-analysis-valuation-tip app-tooltip"></div>';

    var hit = chartBox.querySelector('.valuation-hit');
    var tip = chartBox.querySelector('.stock-analysis-valuation-tip');
    var chartSvg = chartBox.querySelector('svg');
    if (hit && tip && chartSvg) {
      hit.onmousemove = function (e) {
        var box = chartSvg.getBoundingClientRect();
        var ratio = Math.max(0, Math.min(1, (e.clientX - box.left - L / W * box.width) / ((W - L - R) / W * box.width)));
        var idx = Math.round(ratio * (rows.length - 1));
        var r = rows[idx];
        tip.innerHTML =
          '<strong>' + esc(r.date) + '</strong>' +
          '<span>收盘点位：' + fmtNum(r.close, 2) + '</span>' +
          '<span>PE-TTM：' + fmtNum(r.pe, 2) + '</span>' +
          '<span>PB：' + fmtNum(r.pb, 2) + '</span>';
        tip.style.display = 'block';
        tip.style.left = Math.max(8, Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 8)) + 'px';
        tip.style.top = '72px';
      };
      hit.onmouseleave = function () { tip.style.display = 'none'; };
      if (window.ChartInteraction) {
        ChartInteraction.adapt(hit, tip);
        ChartInteraction.watch(chartBox, function () { window.mviRenderChartSection(); });
      }
    }
  };
})();
