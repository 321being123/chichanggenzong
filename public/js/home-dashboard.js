var homeDashboardLoading = false;

function homeSetText(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value;
}

function homeEventRows(calendar) {
  var rows = [];
  (calendar || []).forEach(function(day) {
    [['apply_stocks','新股申购'],['apply_bonds','新债申购'],['list_stocks','新股上市'],['list_bonds','新债上市']].forEach(function(group) {
      (day[group[0]] || []).forEach(function(item) { rows.push({ date:day.date, name:item.name, code:item.code, type:group[1] }); });
    });
  });
  return rows.sort(function(a,b) { return String(a.date).localeCompare(String(b.date)); });
}

function renderHomeHoldings() {
  if (!username) {
    homeSetText('home-total-asset', '登录后查看');
    homeSetText('home-position-count', '个人持仓数据');
    homeSetText('home-cash-value', '点击进入登录');
    return;
  }
  if (!data || !Array.isArray(data.positions)) return;
  var summary = calcSummary();
  homeSetText('home-total-asset', fmt(summary.total));
  homeSetText('home-position-count', data.positions.length + ' 项持仓');
  homeSetText('home-cash-value', '现金 ' + fmt(summary.cash));
}

function renderHomeIpo(calendar) {
  var rows = homeEventRows(calendar);
  homeSetText('home-ipo-count', String(rows.length));
  homeSetText('home-ipo-next', rows.length ? '下一安排：' + rows[0].date + ' ' + rows[0].name : '暂无已排期事件');
  var el = document.getElementById('home-ipo-list');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="home-overview-empty">暂无已排期的申购或上市</div>'; return; }
  el.innerHTML = rows.slice(0, 5).map(function(row) {
    return '<div class="home-overview-row"><span class="home-date">' + escapeHtml(row.date) + '</span><span class="home-event-name">' + escapeHtml(row.name || '-') + ' <small>' + escapeHtml(row.code || '') + '</small></span><span class="home-event-tag">' + escapeHtml(row.type) + '</span></div>';
  }).join('');
}

function renderHomeBonds(payload) {
  var rows = payload && (payload.data || payload.rows) || [];
  var counts = { '安全':0, '低风险':0, '中风险':0, '高风险':0 };
  rows.forEach(function(row) { if (Object.prototype.hasOwnProperty.call(counts,row.safety)) counts[row.safety]++; });
  homeSetText('home-bond-count', String(rows.length));
  homeSetText('home-bond-safe', '安全 ' + counts['安全']);
  homeSetText('home-bond-risk', '高风险 ' + counts['高风险']);
  var colors = { '安全':'#19a463', '低风险':'#7bbf45', '中风险':'#f3b33d', '高风险':'#e05a47' };
  var total = rows.length || 1, el = document.getElementById('home-bond-distribution');
  if (!el) return;
  el.innerHTML = Object.keys(counts).map(function(key) {
    var pct = counts[key] / total * 100;
    return '<div class="home-risk-row"><span>' + key + '</span><div class="home-risk-track"><div class="home-risk-fill" style="width:' + pct.toFixed(1) + '%;background:' + colors[key] + '"></div></div><b>' + counts[key] + '</b></div>';
  }).join('');
}

async function loadHomeDashboard() {
  renderHomeHoldings();
  // 最新文章独立加载，不等待 IPO/债券接口，避免被大数据接口阻塞
  renderHomeArticles();
  if (homeDashboardLoading) return;
  homeDashboardLoading = true;
  try {
    var results = await Promise.all([fetch(api('/api/ipo/calendar?days=90')), fetch(api('/api/bond-safety/bonds'))]);
    if (!results[0].ok || !results[1].ok) throw new Error('首页数据读取失败');
    var calendar = await results[0].json(), bonds = await results[1].json();
    renderHomeIpo(calendar.calendar || []);
    renderHomeBonds(bonds);
  } catch (error) {
    console.error('首页数据加载失败', error);
  } finally { homeDashboardLoading = false; }
}

async function renderHomeArticles() {
  var heroBox = document.getElementById('home-hero-articles');
  if (!heroBox) return;
  try {
    var r = await fetch(api('/api/knowledge/latest?limit=5'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var list = await r.json();
    if (!Array.isArray(list)) throw new Error('返回格式错误');
    if (!list.length) {
      heroBox.innerHTML = '<span class="home-hero-article-loading">暂无已发布文章</span>';
      return;
    }
    heroBox.innerHTML = list.slice(0, 5).map(function (a) {
      var date = (a.published_at || '').toString().slice(0, 10);
      return '<button type="button" class="home-hero-article" onclick="switchMain(\'knowledge\'); ksOpenArticle(' + (a.id || 0) + ');">' +
        '<span>' + escapeHtml(a.category_name || '未分类') + '</span>' +
        '<strong>' + escapeHtml(a.title || '无标题') + '</strong>' +
        '<small>' + escapeHtml(a.summary || '点击阅读文章详情') + '</small>' +
        '<em>' + date + ' · ' + (a.view_count || 0) + ' 次阅读</em>' +
      '</button>';
    }).join('');
  } catch (e) {
    heroBox.innerHTML = '<span class="home-hero-article-loading">加载失败</span>';
  }
}
