// ========== 打新日历前端（读取 /api/ipo/*） ==========
// 依赖：utils.js 的 api()/escapeHtml()，core-quote.js 的 showToast()

function ipoFmt(v, unit) {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'string' && (/^nan$/i.test(v.trim()) || /^NaN$/i.test(v.trim()))) return '-';
  if (typeof v === 'number' && !isFinite(v)) return '-';
  if (v instanceof Date) v = v.toISOString().slice(0, 10);  // 防御：pg DATE 可能返回 Date 对象
  return unit ? (v + unit) : v;
}

// 数字保留固定小数位（如发行规模保留3位）
function ipoNumFixed(v, d) {
  if (v === null || v === undefined || v === '') return '-';
  var n = Number(v);
  if (isNaN(n) || !isFinite(n)) return '-';
  return n.toFixed(d);
}

// 交易所标识：北交所=京 / 上交所=沪 / 深交所=深（用于名称前缀）
function ipoExchange(code) {
  var c = String(code || '').trim();
  if (/^(8|92|43|87|83|88|89)/.test(c)) return '京';   // 北交所
  if (/^(6|11|5)/.test(c)) return '沪';                 // 沪市（含科创板688 / 转债11x）
  return '深';                                          // 深市（0/3/12x 等）
}

function ipoExBadge(code) {
  var ex = ipoExchange(code);
  var color = ex === '京' ? '#e8830c' : (ex === '沪' ? '#d93025' : '#1a8a3a');
  return '<span style="display:inline-block;min-width:18px;text-align:center;font-size:11px;color:#fff;background:' +
    color + ';border-radius:3px;padding:0 4px;margin-right:5px;font-weight:600;">' + ex + '</span>';
}

// 板块标识：新债按其代码段对应的正股板块判断。
function ipoBoard(code, type) {
  var c = String(code || '').trim();
  if (type === '新债') {
    if (/^118/.test(c)) return '科创板';
    if (/^123/.test(c)) return '创业板';
    if (/^(110|111|113)/.test(c)) return '沪市主板';
    if (/^(127|128)/.test(c)) return '深市主板';
    return '';
  }
  if (/^688/.test(c)) return '科创板';
  if (/^(300|301)/.test(c)) return '创业板';
  if (/^(000|001|002|003)/.test(c)) return '深市主板';
  if (/^(600|601|603|605)/.test(c)) return '沪市主板';
  return '';
}

function ipoBoardBadge(code, type) {
  var board = ipoBoard(code, type);
  if (!board) return '';
  return ' <span style="display:inline-block;font-size:10px;color:#666;background:#f1f3f4;border-radius:3px;padding:1px 5px;margin-left:4px;vertical-align:1px;">' +
    escapeHtml(board) + '</span>';
}

// 名称 + 交易所前缀
function ipoNameCell(name, code) {
  return ipoExBadge(code) + escapeHtml(name || '-');
}

// 涨跌颜色（红涨绿跌）
function ipoPctCell(val, decimals) {
  if (val === null || val === undefined || val === '') return '<span>-</span>';
  var n = Number(val);
  if (isNaN(n)) return '<span>-</span>';
  var s = (n >= 0 ? '+' : '') + n.toFixed(decimals || 2) + '%';
  var cls = n >= 0 ? 'positive' : 'negative';
  return '<span class="' + cls + '">' + s + '</span>';
}

// 新股历史预测涨幅：有预测且有证券代码时，点击进入该股票的打新详情。
function ipoStockPredictionCell(it) {
  var cell = it.has_prediction ? ipoPctCell(it.pred_return) : '无历史预测';
  if (!it.has_prediction || !it.security_code) return cell;
  return '<a href="ipo-report.html?code=' + encodeURIComponent(it.security_code) +
    '" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none;white-space:nowrap;" title="查看打新详情">' +
    cell + '</a>';
}

// 中签率：数据单位为百分比(如 0.05 表示 0.05%)，转为"万分之几" = 值×100，保留3位小数。
function ipoWanfenCell(v) {
  if (v === null || v === undefined || v === '') return '<span>-</span>';
  var n = Number(v);
  if (isNaN(n)) return '<span>-</span>';
  var wan = n * 100; // 万分之
  if (wan === 0) return '<span>0</span>';
  var s = wan.toFixed(3);
  return '<span>' + s + '</span>';
}

function ipoPending(v, formatter) {
  if (v === null || v === undefined || v === '') return '<span>待补全</span>';
  return formatter ? formatter(v) : ipoFmt(v);
}

function ipoBondField(it, field, value, formatter) {
  if (value !== null && value !== undefined && value !== '') {
    return formatter ? formatter(value) : ipoFmt(value);
  }
  var status = it.field_status && it.field_status[field];
  if (status === 'pending') return '<span>待公告</span>';
  if (status === 'missing') return '<span>待补全</span>';
  return '<span>-</span>';
}

function ipoFirstDayStatus(it) {
  if (it.ld_close_change !== null && it.ld_close_change !== undefined && it.ld_close_change !== '') {
    return ipoPctCell(it.ld_close_change);
  }
  if (it.history_stage === 'subscribed') return '<span>待上市</span>';
  var listing = String(it.listing_date || '').slice(0, 10);
  var today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return listing === today ? '<span>收盘后更新</span>' : '<span>待补全</span>';
}

function ipoHistoryListingCell(it) {
  var listing = String(it.listing_date || '').slice(0, 10);
  if (listing) return escapeHtml(listing);
  if (it.history_stage === 'subscribed') return '<span>待上市</span>';
  return '<span>待补全</span>';
}

// 方案进展：只显示当前所处的一个阶段（董事会预案→发行公告→申购日→上市日 中的“一个”）。
// 阶段优先级（进度从高到低）：上市日 > 申购日 > 发行公告 > 董事会预案。
// 日期字段：listing_date=上市日 / onl_date=申购日 / ann_date=发行公告日(申购日前)
//   注意：res_ann_date 是「发行结果公告日」(申购日之后，用于股东配售率/中签率公告)，
//        不是进展公告日，绝不作为「方案进展」日期展示（否则会出现未来日期）。
function _ipoProgress(it) {
  function ymd(s) {
    s = String(s || '');
    if (s.length >= 10) return s.slice(0, 10);
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6);
    return '';
  }
  var today = _ipoTodayStr().replace(/-/g, '');   // YYYYMMDD，用于比较
  var ld = ymd(it.listing_date);
  var od = ymd(it.onl_date);
  var ad = ymd(it.ann_date);
  if (ld) return { stage: '上市日', date: ld, color: '#137333' };
  // 已有申购日且未上市 → 当前处于「申购」阶段（含即将申购），显示申购日而非发行公告
  if (od) return { stage: '申购日', date: od, color: '#d93025' };
  if (ad) return { stage: '发行公告', date: ad, color: '#1a73e8' };
  return { stage: '董事会预案', date: ad, color: '#5f6368' };
}

function ipoCurrentStage(it) {
  var p = _ipoProgress(it);
  return '<span style="font-size:11px;color:' + p.color + ';font-weight:600;white-space:nowrap;">' + p.stage + '</span>';
}

// 进展公告日：展示「当前所处阶段」对应的日期（绝不用未来的发行结果公告日）
function ipoProgressDate(it) {
  var p = _ipoProgress(it);
  return p.date ? p.date : '-';
}

// 发行结果公告是否已出（res_ann_date 存在且 <= 今天）：股东配售率/上网上限此时才公布
function ipoAnnounced(it) {
  var s = String(it.res_ann_date || '').replace(/-/g, '').trim();
  if (s.length !== 8) return false;
  return s <= _ipoTodayStr().replace(/-/g, '');
}

// 股东配售率(%)：= 股东优先配售总规模(张) / (发行规模(亿)×1e6) ×100%；任一缺失则 -
// （1亿 = 1e8元 = 1e6张，故发行规模(亿)换算成张 = issue_size × 1e6）
function ipoShdRatioPct(it) {
  var s = Number(it.shd_ration_size), sz = Number(it.issue_size);
  if (!isFinite(s) || !isFinite(sz) || sz === 0) return '-';
  return (s / (sz * 1e6) * 100).toFixed(2) + '%';
}

// 配售10张所需股数：= 1000 / 每股配售(元/股)；缺失则 -
function ipoShdShares(it) {
  var r = Number(it.shd_ration_ratio);
  if (!isFinite(r) || r === 0) return '-';
  return String(Math.round(1000 / r));
}

function ipoTable(headers, rows, opts) {
  var h = '<div class="biz-table-scroll"><table class="biz-table">';
  h += '<thead><tr>';
  headers.forEach(function (hh) { h += ipoHistoryHeaderCell(hh); });
  h += '</tr></thead><tbody>';
  (rows || []).forEach(function (row) {
    h += '<tr>';
    row.forEach(function (c) { h += '<td>' + c + '</td>'; });
    h += '</tr>';
  });
  h += '</tbody></table></div>';
  return h;
}

function ipoHistoryHeaderCell(label) {
  return '<th>' + escapeHtml(label) + '</th>';
}

// 主入口
async function loadIpo() {
  var calendar = document.getElementById('ipo-calendar');
  if (calendar) calendar.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var rr = await fetch(api('/api/ipo/report'));
    if (!rr.ok) throw new Error('日报接口返回 ' + rr.status);
    var rep = await rr.json();
    var adv = document.getElementById('ipo-advice');
    var rc = await fetch(api('/api/ipo/calendar?days=90'));
    if (!rc.ok) throw new Error('日历接口返回 ' + rc.status);
    var cal = await rc.json();
    if (adv) adv.innerHTML = ipoRenderAdvice(rep && rep.md, {
      reportDate: rep && rep.report_date,
      summary: rep && rep.summary,
      calendar: cal && cal.calendar
    });
    if (calendar) calendar.innerHTML = ipoRenderCalendar(cal.calendar || []);
    ipoLoadHistory('stock');
  } catch (e) {
    var advError = document.getElementById('ipo-advice');
    if (advError) advError.innerHTML = ipoRenderAdviceStatus('打新建议暂不可用', '日报读取失败，请稍后重试或在后台补跑打新日报。');
    if (calendar) calendar.innerHTML = '<div class="empty-state">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

// 打新建议：从日报 md 的「📋 结论」段解析 **上市**/**打新** 两组条目
function ipoNormalizeDate(value) {
  var text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6) : '';
}

function ipoRenderAdviceStatus(title, message) {
  return '<div class="table-wrap ipo-advice-status" style="margin-top:18px;">' +
    '<div class="table-header"><h3>' + escapeHtml(title) + '</h3></div>' +
    '<div class="ipo-content" style="padding:14px 18px;color:#8a6d3b;background:#fffaf0;">' + escapeHtml(message) + '</div></div>';
}

function ipoRenderAdvice(md, context) {
  context = context || {};
  if (!md) return ipoRenderAdviceStatus('打新建议暂不可用', '当前没有可展示的日报建议。');
  var reportDate = ipoNormalizeDate(context.reportDate);
  var calendar = Array.isArray(context.calendar) ? context.calendar : null;
  var summary = context.summary || {};
  var summaryKeys = ['apply_stocks', 'apply_bonds', 'list_stocks', 'list_bonds'];
  var emptyReport = summaryKeys.every(function (key) {
    return Array.isArray(summary[key]) && summary[key].length === 0;
  });
  var today = _ipoTodayStr();
  if (reportDate && calendar && !calendar.some(function (day) { return String(day.date || '').slice(0, 10) === reportDate; })
      && !(emptyReport && reportDate >= today)) {
    return ipoRenderAdviceStatus('打新建议暂不可用', '日报日期 ' + reportDate + ' 已落后于当前打新日历，旧建议已隐藏，等待最新日报生成。');
  }
  var lines = String(md).split('\n');
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('##') === 0 && lines[i].indexOf('结论') >= 0) { start = i + 1; break; }
  }
  if (start < 0) {
    return emptyReport && reportDate >= today
      ? ipoRenderAdviceStatus('打新建议', reportDate + ' 没有打新建议的股和债。')
      : '';
  }
  var groups = [];        // [{head, items:[]}]
  var cur = null;
  for (var j = start; j < lines.length; j++) {
    var ln = lines[j].trim();
    if (ln === '---' || ln.indexOf('## ') === 0) break;   // 结论段结束
    if (!ln) continue;
    var mHead = ln.match(/^\*\*(.+?)\*\*$/);              // **上市** / **打新**
    if (mHead) { cur = { head: mHead[1], items: [] }; groups.push(cur); continue; }
    var mItem = ln.match(/^-\s+(.+)$/);                   // - 条目
    if (mItem && cur) { cur.items.push(mItem[1]); }
  }
  if (!groups.length) {
    if (emptyReport && reportDate >= today) {
      return ipoRenderAdviceStatus('打新建议', reportDate + ' 没有打新建议的股和债。');
    }
    return ipoRenderAdviceStatus('打新建议', reportDate ? reportDate + ' 暂无申购或上市建议。' : '当前暂无申购或上市建议。');
  }
  var html = '<div class="table-wrap" style="margin-top:18px;">';
  html += '<div class="table-header"><h3>打新建议</h3>' + (reportDate ? '<span style="font-size:12px;color:#999;">建议日期：' + escapeHtml(reportDate) + '</span>' : '') + '</div>';
  html += '<div class="ipo-content" style="padding:14px 18px;">';
  groups.forEach(function (g) {
    html += '<div style="margin-bottom:8px;"><span style="font-size:13px;color:#333;font-weight:400;">' + escapeHtml(g.head) + '</span></div>';
    html += '<ul style="margin:0 0 10px;padding-left:22px;">';
    g.items.forEach(function (it) {
      html += '<li style="margin-bottom:4px;color:#333;font-size:13px;">' + escapeHtml(it);
      html += '</li>';
    });
    html += '</ul>';
  });
  html += '</div></div>';
  return html;
}

// ========== 打新日历（中间区域，按日期分组） ==========
function ipoRenderCalendar(calendar) {
  if (!calendar || !calendar.length) {
    return '<div class="empty-state"><div class="icon">📅</div>未来暂无已排期的申购 / 上市（数据每日收盘后更新）</div>';
  }
  var todayStr = _ipoTodayStr();
  var html = '';
  calendar.forEach(function (day) {
    // 正常日期分组
    var applyN = (day.apply_stocks || []).length + (day.apply_bonds || []).length;
    var listN = (day.list_stocks || []).length + (day.list_bonds || []).length;
    if (applyN === 0 && listN === 0) return;

    var isToday = (day.date === todayStr);
    var dateStyle = isToday
      ? 'font-size:15px;font-weight:700;color:#fff;background:#d93025;border-radius:6px;padding:2px 8px;'
      : 'font-size:15px;font-weight:700;color:#1a1a2e;';
    html += '<div style="margin:14px 0 6px;display:flex;align-items:baseline;gap:8px;border-bottom:1px solid #f0f0f0;padding-bottom:6px;">';
    html += '<span style="' + dateStyle + '">' + escapeHtml(day.date) + '</span>';
    if (isToday) html += '<span style="font-size:12px;color:#d93025;font-weight:600;">今天</span>';
    html += '<span style="font-size:12px;color:#888;">' + escapeHtml(day.weekday || '') + '</span>';
    html += '<span style="font-size:12px;color:#bbb;">申购 ' + applyN + ' · 上市 ' + listN + '</span>';
    html += '</div>';

    if (applyN > 0) {
      var applyItems = [];
      (day.apply_stocks || []).forEach(function (it) { applyItems.push({ type: '新股', name: it.name, code: it.code }); });
      (day.apply_bonds || []).forEach(function (it) { applyItems.push({ type: '新债', name: it.name, code: it.code }); });
      html += ipoCalendarRow('申购', applyItems, '#d93025');
    }
    if (listN > 0) {
      var listItems = [];
      (day.list_stocks || []).forEach(function (it) { listItems.push({ type: '新股', name: it.name, code: it.code }); });
      (day.list_bonds || []).forEach(function (it) { listItems.push({ type: '新债', name: it.name, code: it.code }); });
      html += ipoCalendarRow('上市', listItems, '#137333');
    }
  });
  return html;
}

// 本地日期字符串 YYYY-MM-DD（避免 toISOString 的 UTC 偏移）
function _ipoTodayStr() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function ipoCalendarRow(label, items, color) {
  // 每只股票或转债单独一行，避免同一天多只横向挤在一起
  var html = '<div style="padding:5px 0 5px 18px;border-left:3px solid #eef1f6;margin-left:4px;font-size:13px;">';
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">';
  html += '<span style="display:inline-block;min-width:34px;text-align:center;font-size:11px;color:#fff;background:' + color + ';border-radius:4px;padding:1px 4px;">' + escapeHtml(label) + '</span>';
  html += '<span style="color:#666;font-size:12px;">' + items.length + ' 只</span></div>';
  items.forEach(function (it) {
    html += '<div style="padding:3px 0 3px 42px;">' + ipoExBadge(it.code) + '<b>' + escapeHtml(it.name || '-') + '</b> <span style="color:#999;">' + escapeHtml(it.code || '') + '</span>';
    html += ' <span style="color:#bbb;font-size:11px;">' + escapeHtml(it.type) + '</span>';
    html += ipoBoardBadge(it.code, it.type);
    html += ' <a href="ipo-report.html?code=' + encodeURIComponent(it.code || '') + '" target="_blank" style="color:#1a73e8;text-decoration:none;white-space:nowrap;margin-left:6px;">查看详情</a></div>';
  });
  html += '</div>';
  return html;
}

// ========== 打新历史（集思录式列表） ==========
async function ipoLoadHistory(type) {
  var el = document.getElementById('ipo-history');
  if (el) el.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var r = await fetch(api('/api/ipo/history?type=' + type + '&limit=50'));
    var d = await r.json();
    if (el) {
      el.innerHTML = ipoRenderHistory(type, d.rows || []);
      if (window.BusinessTable) window.BusinessTable.attach(el, { page: '#main-ipo', top: '.nav' });
    }
  } catch (e) {
    if (el) el.innerHTML = '<div class="empty-state">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

function ipoRenderHistory(type, rows) {
  if (!rows.length) return '<div class="empty-state">暂无打新历史记录</div>';

  if (type === 'bond') {
    // 集思录式可转债详细列（来源：Tushare cb_issue + cb_basic + cb_rating）
    var headers = [
      '代码', '名称', '方案进展', '进展公告日', '发行规模(亿)', '评级',
      '股东配售率', '配售10张所需股数',
      '网上上限(亿)', '申请户数(万)',
      '预测涨幅%', '上市涨幅%'
    ];
    var r2 = rows.map(function (it) {
      // 进展公告日 = 当前阶段日期（绝不用未来的发行结果公告日）
      var progDate = ipoProgressDate(it);
      // 发行结果公告是否已出：网上上限此时才公布
      var announced = ipoAnnounced(it);
      // 股东配售率(%)：已公告(res_ann_date<=今天)且 shd_ration_size 为真实张数(>100)时显示；
      // 真实值来自巨潮《发行结果公告》回填（placeholder 占位值不显示）
      var shdReal = Number(it.shd_ration_size);
      var shdPct = (announced && isFinite(shdReal) && shdReal > 100) ? ipoShdRatioPct(it) : '-';

      return [
        escapeHtml(it.security_code || ''),
        ipoNameCell(it.security_name, it.security_code),
        ipoCurrentStage(it),                       // 方案进展：当前所处的一个阶段
        progDate,                                  // 进展公告日 = 当前阶段日期
        ipoNumFixed(it.issue_size, 3),             // 发行规模(亿元)，保留3位小数
        it.rating ? escapeHtml(it.rating) : '-',   // 评级（已知则显示，无则 -）
        shdPct,                                   // 股东配售率(%)：= shd_ration_size/(issue_size×1e6)×100
        ipoShdShares(it),                          // 配售10张所需股数 = 1000/每股配售额(元)
        ipoBondField(it, 'onl_size', it.onl_size), // 网上上限(亿)：结果公告后才应出现
        ipoBondField(it, 'onl_pch_num', it.onl_pch_num, function (v) {
          return ipoFmt(v) + (ipoExchange(it.security_code) === '深' ? '（估算）' : '');
        }),                                        // 申请户数(万)
        ipoPctCell(it.pred_return),               // 预测涨幅%：模型预测上市涨幅（无预测则显示 -）
        ipoPctCell(it.first_day_return)            // 上市涨幅% = 上市首日收盘 - 100
      ];
    });
    return ipoTable(headers, r2, { scroll: true });
  }

  // 新股历史（集思录式列）
  var headers = [
    '代码', '名称', '申购日期', '上市日', '发行价', '发行PE', '行业PE', '行业',
    '发行总数(万股)', '网上发行量(万股)', '顶格申购上限(万股)', '顶格申购需配市值(万)',
    '中签率(万分之)', '募资(亿)', '公开发行市值(亿)', '预测涨幅%', '首日涨幅%', '单签收益(元)'
  ];
  var r3 = rows.map(function (it) {
    // 单签收益 = 500股 × 发行价 × 首日涨幅%
    var profit = null;
    if (it.issue_price && it.ld_close_change != null) {
      profit = Math.round(it.issue_price * it.ld_close_change / 100 * 500 * 100) / 100;
    }
    // total_shares/online_shares 库内为万股；subscribe_upper_limit 库内为顶格申购上限(万股)
    var total10k = (it.total_shares != null && it.total_shares !== 0) ? it.total_shares : null;
    var upperWan = (it.subscribe_upper_limit != null && it.subscribe_upper_limit !== 0) ? it.subscribe_upper_limit : null;
    // 需配市值(万)：仅沪深(沪/深)为市值申购，每1万市值可申1000股 → 顶格(万股) × 10
    // 京(北交所)为资金申购、无持仓市值要求 → 该列不适用，标记为 -
    var mvWan = null;
    if (upperWan != null && ipoExchange(it.security_code) !== '京') {
      mvWan = Math.round(upperWan * 10 * 100) / 100;
    }
    return [
      escapeHtml(it.security_code || ''),
      ipoNameCell(it.security_name, it.security_code),
      ipoPending(it.ipo_date),
      ipoHistoryListingCell(it),
      ipoPending(it.issue_price),
      it.issue_pe != null ? ipoFmt(it.issue_pe) : (it.issue_pe_status === 'loss' ? '亏损' : '待补全'),
      ipoPending(it.industry_pe),
      ipoPending(it.industry),
      ipoPending(total10k),
      ipoPending(it.online_shares),
      ipoPending(upperWan),
      ipoPending(mvWan),
      ipoPending(it.online_lottery_rate, ipoWanfenCell),
      ipoPending(it.fund_raised),
      ipoPending(it.circulation_mv, function (v) { return ipoNumFixed(v, 2); }),
      ipoStockPredictionCell(it),
      ipoFirstDayStatus(it),
      ipoFmt(profit)
    ];
  });
  return ipoTable(headers, r3, { scroll: true });
}

function ipoSwitchHist(type) {
  document.querySelectorAll('[data-ipo-hist]').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-ipo-hist') === type);
  });
  ipoLoadHistory(type);
}
