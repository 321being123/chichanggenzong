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
  var o = opts || {};
  var h = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
  h += '<thead><tr style="background:#f8f9fa;">';
  headers.forEach(function (hh) { h += '<th style="text-align:left;padding:7px 10px;border-bottom:2px solid #e0e0e0;font-weight:600;white-space:normal;vertical-align:top;line-height:1.25;">' + escapeHtml(hh) + '</th>'; });
  h += '</tr></thead><tbody>';
  (rows || []).forEach(function (row) {
    h += '<tr>';
    row.forEach(function (c) { h += '<td style="padding:6px 10px;border-top:1px solid #f0f0f0;white-space:nowrap;">' + c + '</td>'; });
    h += '</tr>';
  });
  h += '</tbody></table>';
  // 横向滚动容器
  if (o.scroll) h = '<div style="overflow-x:auto;max-width:100%;">' + h + '</div>';
  return h;
}

// 缓存最新报告（给打新高报用）
var _ipoLatestReport = null;
// 已生成报告的日期集合（YYYY-MM-DD），用于日历"查看详情"可用/禁用判断
var _ipoReportDates = new Set();

// 主入口
async function loadIpo() {
  var calendar = document.getElementById('ipo-calendar');
  if (calendar) calendar.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var rr = await fetch(api('/api/ipo/report'));
    var rep = await rr.json();
    _ipoLatestReport = rep;  // 缓存
    var adv = document.getElementById('ipo-advice');
    if (adv) adv.innerHTML = ipoRenderAdvice(rep && rep.md);
    // 已生成报告日期集合（用于日历"查看详情"可用/禁用判断）
    try {
      var rrep = await fetch(api('/api/ipo/reports'));
      var repRows = await rrep.json();
      _ipoReportDates = new Set((repRows || []).map(function (x) { return x.report_date; }));
    } catch (e2) { _ipoReportDates = new Set(); }
    var rc = await fetch(api('/api/ipo/calendar?days=90'));
    var cal = await rc.json();
    if (calendar) calendar.innerHTML = ipoRenderCalendar(cal.calendar || []);
    ipoLoadHistory('stock');
  } catch (e) {
    if (calendar) calendar.innerHTML = '<div class="empty-state">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

// 从最新报告 summary 构建 名称->代码 映射（用于打新建议每支的「查看详情」）
function _ipoNameCodeMap() {
  var m = {};
  var rep = _ipoLatestReport;
  if (!rep || !rep.summary) return m;
  var s = rep.summary;
  ['apply_stocks', 'apply_bonds', 'list_stocks', 'list_bonds'].forEach(function (k) {
    (s[k] || []).forEach(function (it) {
      if (it && it.code && it.name) {
        var base = String(it.name).replace(/[（(].*$/, '').split('-')[0].trim();
        if (base) m[base] = it.code;
      }
    });
  });
  return m;
}

// 打新建议：从日报 md 的「📋 结论」段解析 **上市**/**打新** 两组条目
function ipoRenderAdvice(md) {
  if (!md) return '';
  var lines = String(md).split('\n');
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('##') === 0 && lines[i].indexOf('结论') >= 0) { start = i + 1; break; }
  }
  if (start < 0) return '';
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
  if (!groups.length) return '';
  var nameCode = _ipoNameCodeMap();
  var html = '<div class="table-wrap" style="margin-top:18px;">';
  html += '<div class="table-header"><h3>打新建议</h3></div>';
  html += '<div style="padding:14px 18px;">';
  groups.forEach(function (g) {
    var isList = g.head.indexOf('上市') >= 0;
    if (isList) {
      // 「上市」保留绿色底色徽标
      html += '<div style="margin-bottom:8px;"><span style="display:inline-block;min-width:34px;text-align:center;font-size:11px;color:#fff;background:#137333;border-radius:4px;padding:1px 6px;font-weight:600;">' + escapeHtml(g.head) + '</span></div>';
    } else {
      // 「打新」不加底色、不加粗（用户要求）
      html += '<div style="margin-bottom:8px;"><span style="font-size:13px;color:#d93025;font-weight:400;">' + escapeHtml(g.head) + '</span></div>';
    }
    html += '<ul style="margin:0 0 10px;padding-left:22px;">';
    g.items.forEach(function (it) {
      var base = String(it).replace(/[（(].*$/, '').split('-')[0].trim();
      var code = nameCode[base];
      html += '<li style="margin-bottom:4px;color:#333;font-size:13px;">' + escapeHtml(it);
      if (code) {
        html += ' <a href="ipo-report.html?code=' + encodeURIComponent(code) +
          '" target="_blank" style="color:#1a73e8;text-decoration:none;white-space:nowrap;">查看详情</a>';
      }
      html += '</li>';
    });
    html += '</ul>';
  });
  html += '</div></div>';
  return html;
}

// “打新报告”查看详情链接：已生成报告(dateStr 在 _ipoReportDates 中)→可点击；否则禁用
function ipoReportLink(dateStr, hasReport) {
  if (hasReport && dateStr) {
    return '<a href="ipo-report.html?date=' + encodeURIComponent(dateStr) +
      '" target="_blank" style="color:#1a73e8;text-decoration:none;white-space:nowrap;">查看详情</a>';
  }
  return '<span style="color:#bbb;cursor:not-allowed;white-space:nowrap;" title="报告未生成">查看详情</span>';
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

    // 该日期是否已生成打新报告（用于"查看详情"可用/禁用）
    var hasReport = !!(_ipoReportDates && _ipoReportDates.has(day.date));

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
      html += ipoCalendarRow('申购', applyItems, '#d93025', day.date, hasReport);
    }
    if (listN > 0) {
      var listItems = [];
      (day.list_stocks || []).forEach(function (it) { listItems.push({ type: '新股', name: it.name, code: it.code }); });
      (day.list_bonds || []).forEach(function (it) { listItems.push({ type: '新债', name: it.name, code: it.code }); });
      html += ipoCalendarRow('上市', listItems, '#137333', day.date, hasReport);
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

function ipoCalendarRow(label, items, color, dateStr, hasReport) {
  // 申购/上市行相对日期标题首行缩进，并用左侧细线区分
  var html = '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 0 5px 18px;border-left:3px solid #eef1f6;margin-left:4px;font-size:13px;">';
  html += '<span style="display:inline-block;min-width:34px;text-align:center;font-size:11px;color:#fff;background:' + color + ';border-radius:4px;padding:1px 4px;">' + escapeHtml(label) + '</span>';
  html += '<span style="color:#666;font-size:12px;">' + items.length + ' 只：</span>';
    items.forEach(function (it, i) {
      if (i > 0) html += '<span style="color:#ddd;margin:0 2px;">｜</span>';
      html += '<span>' + ipoExBadge(it.code) + '<b>' + escapeHtml(it.name || '-') + '</b> <span style="color:#999;">' + escapeHtml(it.code || '') + '</span>';
      html += ' <span style="color:#bbb;font-size:11px;">' + escapeHtml(it.type) + '</span></span>';
    });
  html += ' <span style="margin-left:6px;">' + ipoReportLink(dateStr, hasReport) + '</span>';
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
    if (el) el.innerHTML = ipoRenderHistory(type, d.rows || []);
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
      '股东配售率', '配售10张所需股数', '股权登记日',
      '网上上限(亿)', '申请户数(万)',
      '上市涨幅%'
    ];
    var r2 = rows.map(function (it) {
      // 进展公告日 = 当前阶段日期（绝不用未来的发行结果公告日）
      var progDate = ipoProgressDate(it);
      var shdRecDate = String(it.shd_ration_record_date || '');
      if (/^\d{8}$/.test(shdRecDate)) shdRecDate = shdRecDate.slice(0,4)+'-'+shdRecDate.slice(4,6)+'-'+shdRecDate.slice(6);
      else shdRecDate = '';

      // 发行结果公告是否已出：股东配售率、网上上限此时才公布；且股东配售规模须为真实值(>100张)
      var announced = ipoAnnounced(it);
      var shdReal = Number(it.shd_ration_size);
      var shdPct = (announced && isFinite(shdReal) && shdReal > 100) ? ipoShdRatioPct(it) : '-';

      return [
        escapeHtml(it.security_code || ''),
        ipoNameCell(it.security_name, it.security_code),
        ipoCurrentStage(it),                       // 方案进展：当前所处的一个阶段
        progDate,                                  // 进展公告日 = 当前阶段日期
        ipoNumFixed(it.issue_size, 3),             // 发行规模(亿元)，保留3位小数
        it.rating ? escapeHtml(it.rating) : '-',   // 评级（已知则显示，无则 -）
        shdPct,                                    // 股东配售率(%)：仅公告后且有真实配售规模才显示
        ipoShdShares(it),                          // 配售10张所需股数 = 1000/每股配售(元)
        shdRecDate,                                // 股权登记日
        announced ? ipoFmt(it.onl_size) : '-',     // 网上上限(亿)：仅公告后
        ipoFmt(it.onl_pch_num),                    // 申请户数(万)
        ipoPctCell(it.first_day_return)            // 上市涨幅% = 上市首日收盘 - 100
      ];
    });
    return ipoTable(headers, r2, { scroll: true });
  }

  // 新股历史（集思录式列）
  var headers = [
    '代码', '名称', '申购日期', '上市日', '发行价', '发行PE', '行业PE', '行业',
    '发行总数(万股)', '顶格申购上限(万股)', '顶格申购需配市值(万)',
    '中签率(万分之)', '募资(亿)', '公开发行市值(亿)', '首日涨幅%', '单签收益(元)'
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
      ipoFmt(it.ipo_date),
      escapeHtml(String(it.listing_date || '').slice(0, 10)),
      ipoFmt(it.issue_price),
      ipoFmt(it.issue_pe),
      ipoFmt(it.industry_pe),
      escapeHtml(it.industry || '-'),
      ipoFmt(total10k),
      ipoFmt(upperWan),
      ipoFmt(mvWan),
      ipoWanfenCell(it.online_lottery_rate),
      ipoFmt(it.fund_raised),
      ipoFmt(it.circulation_mv),
      ipoPctCell(it.ld_close_change),
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
