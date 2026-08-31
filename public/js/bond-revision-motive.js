(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]; });
  }
  function value(value, digits) {
    if (value == null || value === '') return '—';
    var n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits == null ? 2 : digits) : escapeHtml(value);
  }
  function percent(number) { return number == null ? '—' : value(number * 100) + '%'; }
  function list(items) { return items && items.length ? '<ul class="motive-list">' + items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul>' : '<span>暂无触发项</span>'; }
  var DISPLAY_TEXT = {
    'true': '是', 'false': '否', 'open': '进行中', 'pass': '通过', 'locked': '锁定期',
    'floor_blocked': '底价受阻', 'insufficient_space': '下修空间不足', 'complete': '完整',
    'partial': '部分完整', 'incomplete': '不完整', 'present': '有数据', 'missing': '缺失',
    'unknown': '未知', 'no_revision': '明确不下修', 'implemented': '已实施', 'approved': '已通过',
    'rejected': '未通过', 'proposal': '已提议', 'tracking': '跟踪中', 'met': '已满足'
  };
  function displayText(item) {
    if (item == null || item === '') return '—';
    var key = String(item).toLowerCase();
    return Object.prototype.hasOwnProperty.call(DISPLAY_TEXT, key) ? DISPLAY_TEXT[key] : String(item);
  }
  function prettyValue(item, metric) {
    if (item == null || item === '') return '—';
    if (typeof item === 'boolean') return item ? '是' : '否';
    if (typeof item === 'object') return escapeHtml(JSON.stringify(item));
    var number = Number(item);
    if (['bond_price_percentile', 'remain_issue_ratio', 'remain_market_cap_ratio'].indexOf(metric) >= 0 && Number.isFinite(number)) return (number * 100).toFixed(2) + '%';
    if (['market_cap', 'remain_size', 'issue_size'].indexOf(metric) >= 0 && Number.isFinite(number)) return (number / 100000000).toFixed(2);
    if (metric === 'stock_vwap' && Number.isFinite(number)) return number.toFixed(2);
    if (metric === 'remaining_years' && Number.isFinite(number)) return number.toFixed(2);
    return escapeHtml(displayText(item));
  }
  function displayUnit(item) {
    if (['financial_metrics', 'revision_cycles', 'proposal_history'].indexOf(item && item.metric) >= 0) return '说明';
    return ['market_cap', 'remain_size', 'issue_size'].indexOf(item && item.metric) >= 0 ? '亿元' : (item && item.unit || '');
  }
  function chineseDate(date) {
    var text = String(date || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(0, 4) + '年' + text.slice(5, 7) + '月' + text.slice(8, 10) + '日' : text;
  }
  function moneyText(number) {
    if (number == null || number === '') return '暂无数据';
    var valueNumber = Number(number);
    if (!Number.isFinite(valueNumber)) return '暂无数据';
    var abs = Math.abs(valueNumber), unit = '元', divisor = 1;
    if (abs >= 100000000) { unit = '亿元'; divisor = 100000000; }
    else if (abs >= 10000) { unit = '万元'; divisor = 10000; }
    return (valueNumber / divisor).toFixed(2) + unit;
  }
  function financialText(raw) {
    try {
      var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      var fields = [
        ['cash', '账上现金', moneyText], ['trading_assets', '交易性金融资产', moneyText],
        ['total_liabilities', '负债合计', moneyText], ['total_assets', '资产合计', moneyText],
        ['current_ratio', '流动比率', function (valueNumber) { return valueNumber == null ? '暂无数据' : Number(valueNumber).toFixed(2) + '倍'; }],
        ['revenue', '营业收入', moneyText], ['interest_expense', '利息费用', moneyText],
        ['ebitda', '息税折旧摊销前利润', moneyText]
      ];
      return fields.map(function (field) { return field[1] + '：' + field[2](data && data[field[0]]); }).join('；');
    } catch (_) { return displayText(raw); }
  }
  function cycleText(raw) {
    try {
      var cycles = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(cycles) || !cycles.length) return '暂无历史下修记录';
      var outcomeText = { open: '目前还在观察中', implemented: '已经完成下修', approved: '股东大会已经通过', rejected: '下修没有通过', no_revision: '明确决定不下修' };
      return cycles.map(function (cycle, index) {
        var parts = ['第' + (cycle.cycle_no || index + 1) + '轮'];
        if (cycle.cycle_start_date) parts.push(chineseDate(cycle.cycle_start_date) + '开始');
        if (cycle.trigger_date) parts.push(chineseDate(cycle.trigger_date) + '满足下修触发条件');
        if (cycle.proposal_date) parts.push(chineseDate(cycle.proposal_date) + '提出下修');
        if (cycle.decision_date && outcomeText[cycle.outcome]) parts.push(chineseDate(cycle.decision_date) + '，' + outcomeText[cycle.outcome]);
        if (cycle.implementation_date) parts.push(chineseDate(cycle.implementation_date) + '完成实施');
        if (cycle.lock_until) parts.push('锁定期至' + chineseDate(cycle.lock_until));
        if (!cycle.decision_date && !cycle.implementation_date && outcomeText[cycle.outcome]) parts.push(outcomeText[cycle.outcome]);
        if (parts.length === 1) parts.push(outcomeText[cycle.outcome] || '暂无更多记录');
        return parts.join('，');
      }).join('；');
    } catch (_) { return displayText(raw); }
  }
  function proposalHistoryText(raw) {
    try {
      var history = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(history) || !history.length) return '暂无市场下修提议记录';
      var total = history.reduce(function (sum, item) { return sum + (Number(item) || 0); }, 0);
      var sequence = history.map(function (item) { return (Number(item) || 0) + '次'; }).join('、');
      return '这是市场按月提出下修的次数，共' + history.length + '个月，合计' + total + '次；从最早到最新依次为：' + sequence + '。';
    } catch (_) { return displayText(raw); }
  }
  function snapshotValue(item) {
    var raw = item.raw_value == null ? item.value : item.raw_value;
    if (item.metric === 'financial_metrics') return escapeHtml(financialText(raw));
    if (item.metric === 'revision_cycles') return escapeHtml(cycleText(raw));
    if (item.metric === 'proposal_history') return escapeHtml(proposalHistoryText(raw));
    return prettyValue(raw, item.metric);
  }
  function calculations(items) {
    if (!items || !items.length) return '';
    return '<details class="motive-calculations"><summary>查看计算项</summary><div class="biz-table-scroll"><table class="biz-table"><thead><tr><th>指标</th><th>原始值</th><th>单位</th><th>规则</th><th>分值变化</th></tr></thead><tbody>' + items.map(function (item) { return '<tr><td>' + escapeHtml(item.label || item.metric || '') + '</td><td>' + prettyValue(item.raw_value, item.metric) + '</td><td>' + escapeHtml(item.unit || '') + '</td><td>' + escapeHtml(item.rule || '') + '</td><td>' + prettyValue(item.delta) + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
  }
  function render(data) {
    var summary = data.score_summary || {};
    var bond = data.bond || {};
    var dimensionNames = { history:'历史行为', pressure:'财务压力', conversion:'转股约束', governance:'治理压力', market:'市场环境' };
    var dimensions = data.dimension_calculations || [];
    var dimensionScoreTotal = 0;
    var scoredDimensionCount = 0;
    dimensions.forEach(function (item) {
      var rawScore = item && item.score;
      if (rawScore == null || rawScore === '') return;
      var score = Number(rawScore);
      if (Number.isFinite(score)) {
        dimensionScoreTotal += score;
        scoredDimensionCount += 1;
      }
    });
    var totalElement = document.getElementById('motive-dimension-total');
    if (totalElement) {
      var totalText = scoredDimensionCount ? value(dimensionScoreTotal, 1) + ' / 100 分' : '—';
      if (scoredDimensionCount && scoredDimensionCount < 5) totalText += '（已计' + scoredDimensionCount + '/5项）';
      totalElement.textContent = '五项合计：' + totalText;
    }
    document.getElementById('motive-title').textContent = (bond.bond_name || bond.ts_code || '可转债') + ' · 下修博弈详情';
    document.getElementById('motive-updated').textContent = '评分日期：' + (summary.trade_date || '—') + ' · 模型：' + (data.model_version || '—') + ' · 计算时间：' + String(data.calculated_at || '—').replace('T', ' ').slice(0, 19);
    var cards = [['动机评分', value(summary.motive_score, 1) + ' / 100'], ['触发成熟度', value(summary.maturity_score, 1) + ' / 100'], ['动机等级', summary.classification || '—'], ['安全性', summary.safety_level || '未评级'], ['数据质量', displayText(summary.quality_status) + '（' + percent(summary.completeness_rate) + '）']];
    document.getElementById('motive-summary').innerHTML = cards.map(function (item) { return '<div class="bond-feature-stat motive-summary-card"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>'; }).join('');
    var core = '<div class="motive-core"><strong>核心动机</strong>' + list(data.core_motives) + '<strong>当前阻断</strong>' + list(data.blockers) + '</div>';
    document.getElementById('motive-dimensions').innerHTML = core + (dimensions.map(function (item) { return '<div class="motive-dimension"><span>' + escapeHtml(dimensionNames[item.dimension] || item.dimension) + '</span><strong>' + value(item.score, 1) + ' 分</strong>' + list(item.items) + calculations(item.calculations) + '</div>'; }).join('') || '<div>暂无维度数据</div>');
    var ex = data.executability_calculation || {};
    document.getElementById('motive-executable').innerHTML = '<div class="motive-kv">' + [['状态', displayText(ex.status)], ['估算底价', value(ex.floor_price, 3)], ['估算下修空间', percent(ex.space)], ['估算下修后转股价值', value(ex.post_conversion_value, 2)], ['转股价值提升', value(ex.value_uplift, 2)]].map(function (item) { return '<div><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1] == null ? '—' : String(item[1])) + '</strong></div>'; }).join('') + '</div>' + list(ex.blockers);
    document.getElementById('motive-inputs').innerHTML = '<div class="biz-table-scroll"><table class="biz-table motive-input-table"><thead><tr><th>指标</th><th>说明</th><th>单位</th><th>规则</th><th>变化</th><th>数据日期</th><th>状态</th></tr></thead><tbody>' + (data.input_snapshot || []).map(function (item) { return '<tr><td>' + escapeHtml(item.label || item.metric || item.field) + '</td><td class="motive-raw-value">' + snapshotValue(item) + '</td><td>' + escapeHtml(displayUnit(item)) + '</td><td>' + escapeHtml(item.rule || '—') + '</td><td>' + prettyValue(item.delta) + '</td><td>' + escapeHtml(item.data_date || '—') + '</td><td>' + escapeHtml(displayText(item.status || '')) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    document.getElementById('motive-content').hidden = false;
    document.getElementById('motive-error').hidden = true;
  }
  var code = new URLSearchParams(window.location.search).get('code') || '';
  if (!/^(110|111|113|118|123|127|128)\d{3}\.(SH|SZ)$/i.test(code)) {
    document.getElementById('motive-error').textContent = '缺少有效的可转债代码';
    return;
  }
  fetch('/api/bond-revision/' + encodeURIComponent(code) + '/motive-detail', { cache: 'no-store' })
    .then(function (response) { if (!response.ok) throw new Error(response.status === 404 ? '尚无评分数据' : '读取失败'); return response.json(); })
    .then(render)
    .catch(function (error) { document.getElementById('motive-error').textContent = error.message || '读取失败'; });
}());
