// 财务三表 View（批次4：View／Presenter 分离）。
// 职责：只做三表渲染与视图切换；取数、缓存与请求序号在 presenters/stock-analysis-statements-presenter.js。
// 约定：本文件不直接发请求（静态门禁 frontend_api_client 校验），也不决定何时采集。

// #114：带虚线说明的科目文案。语义只描述通用列报含义，具体归属仍以当期报表列报和来源口径为准。
var stockAnalysisStatementFieldHelpCodes = {
  'ps.toi': '营业总收入：企业日常经营活动形成的收入总额，通常由营业收入、利息收入、已赚保费、手续费及佣金收入等按业务类型组成。',
  'ps.oi': '营业收入：企业日常经营活动形成的收入，不含营业外收入；具体构成以报表列报为准。',
  'ps.ii': '利息收入：金融、保险等业务按实际利率法确认的利息收入；非金融企业通常不单独列示。',
  'ps.ep': '已赚保费：保险公司当期已赚取的保费收入，通常为保费收入减去未到期责任准备金变动后的金额。',
  'ps.faci': '手续费及佣金收入：金融、保险等业务收取的手续费及佣金收入；非金融企业通常不单独列示。',
  'ps.toc': '营业总成本：营业成本及税金、销售、管理、研发、财务等经营费用的合计，具体构成以报表列报为准。',
  'ps.oc': '营业成本：企业日常经营活动发生的成本，通常与营业收入配比确认。',
  'ps.ie': '利息支出：企业为筹资及经营业务发生的利息支出；金融企业通常计入营业成本或利息支出，非金融企业多见于财务费用。',
  'ps.face': '手续费及佣金支出：金融、保险等业务发生的手续费及佣金支出；非金融企业通常不单独列示。',
  'ps.s': '退保金：保险公司按规定向保单持有人退还的保费；非保险企业通常不适用。',
  'ps.ce': '保险合同赔付支出：保险公司按保险合同约定支付的赔款及给付；非保险企业通常不适用。',
  'ps.iiicr': '提取保险责任准备金净额：保险公司按规定提取的保险责任准备金扣除转回后的净额；非保险企业通常不适用。',
  'ps.phdrfpip': '保单红利支出：保险公司按合同约定向保单持有人分配的保单红利支出；非保险企业通常不适用。',
  'ps.rie': '分保费用：保险公司分出业务时支付给再保险人的分保费用；非保险企业通常不适用。',
  'ps.tas': '税金及附加：企业经营活动发生的消费税、城市维护建设税、资源税、教育费附加等税费。',
  'ps.se': '销售费用：企业销售商品、提供劳务过程中发生的费用，包括运输、装卸、广告、销售人员薪酬等。',
  'ps.ae': '管理费用：企业为组织和管理生产经营活动发生的费用，包括管理人员薪酬、办公费、折旧摊销等。',
  'ps.rade': '研发费用：企业进行研究与开发活动发生的费用化支出；资本化部分通常不计入本项目。',
  'ps.fe': '财务费用：企业为筹集生产经营所需资金等发生的筹资费用，包括利息支出（减利息收入）、汇兑损益及相关手续费等；具体构成以报表列报为准。',
  'ps.ieife': '利息费用：财务费用中归属于利息支出的部分，通常作为“财务费用”的其中项列示。',
  'ps.iiife': '利息收入：财务费用中冲减利息支出的利息收入，通常作为“财务费用”的其中项列示。',
  'ps.oic': '其他收益：与企业日常活动相关、但不宜计入营业收入或投资收益的政府补助等收益。',
  'ps.ivi': '投资收益：企业对外投资取得的收益或发生的损失，包括联营合营企业投资收益、金融资产处置收益等。',
  'ps.iifaajv': '对联营企业及合营企业的投资收益：按权益法确认的联营、合营企业投资损益，通常作为“投资收益”的其中项列示。',
  'ps.iftdofamaac': '以摊余成本计量的金融资产终止确认产生的投资收益：处置或转移该类金融资产时确认的投资收益，通常作为“投资收益”的其中项列示。',
  'ps.ei': '汇兑收益：外币货币性项目折算产生的汇兑收益，损失以负号或“汇兑损失”列示。',
  'ps.op': '营业利润：营业收入减去营业成本、税金及附加、期间费用、减值损失，加上其他收益、投资收益等后的经营成果。',
  'ps.noi': '营业外收入：与企业日常经营活动无直接关系的各项收入，如非流动资产毁损报废利得、政府补助等。',
  'ps.ncadarg': '非流动资产毁损报废利得：非流动资产毁损、报废清理产生的净收益，通常作为“营业外收入”的其中项列示。',
  'ps.noe': '营业外支出：与企业日常经营活动无直接关系的各项支出，如非流动资产毁损报废损失、捐赠支出等。',
  'ps.ncadarl': '非流动资产毁损报废损失：非流动资产毁损、报废清理产生的净损失，通常作为“营业外支出”的其中项列示。',
  'ps.tp': '利润总额：营业利润加上营业外收入、减去营业外支出后的利润，尚未扣除所得税费用。',
  'ps.ite': '所得税费用：企业按税法规定确认的当期所得税和递延所得税费用。',
  'ps.np': '净利润：利润总额扣除所得税费用后的净利润，包含归属于母公司股东和少数股东的损益。',
};

function stockAnalysisStatementFieldHelpText(field) {
  if (!field) return '';
  if (field.code && stockAnalysisStatementFieldHelpCodes[field.code]) return stockAnalysisStatementFieldHelpCodes[field.code];
  return '';
}

function stockAnalysisSwitchView(view) {
  var statements = ['balance','income','cashflow'].includes(view);
  if (!statements) stockStatementState.requestToken++;
  var analysisPane = document.getElementById('stock-analysis-analysis-pane');
  var statementsPane = document.getElementById('stock-analysis-statements-pane');
  var analysisTab = document.getElementById('stock-analysis-view-analysis');
  if (analysisPane) { analysisPane.classList.remove('js-hidden'); analysisPane.style.display = statements ? 'none' : ''; }
  if (statementsPane) { statementsPane.classList.remove('js-hidden'); statementsPane.style.display = statements ? '' : 'none'; }
  if (analysisTab) { analysisTab.classList.toggle('selected', !statements); analysisTab.setAttribute('aria-selected', String(!statements)); }
  document.querySelectorAll('[data-statement-view]').forEach(function(button) {
    var selected = statements && button.getAttribute('data-statement-view') === view;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  if (statements && stockAnalysisState.selected) stockAnalysisLoadStatements(view);
}

// View 对外入口（批次4）：Presenter 只调这些函数改界面，自己不碰 DOM。
function stockAnalysisShowStatementsLoading() {
  var message = document.getElementById('stock-analysis-statements-message');
  var wrap = document.getElementById('stock-analysis-statements-wrap');
  if (message) { message.style.display='block'; message.textContent='正在读取三表数据...'; }
  if (wrap) wrap.style.display='none';
}

function stockAnalysisStatementFilterChanged(value) {
  var id = this && this.id || '';
  var name = id === 'stock-analysis-statement-period' ? 'periodType'
    : id === 'stock-analysis-statement-compare' ? 'compare'
      : id === 'stock-analysis-statement-range' ? 'limit' : 'scope';
  if (typeof stockAnalysisSetStatementFilter === 'function') stockAnalysisSetStatementFilter(name, value);
}

function stockAnalysisFormatPeriodLabel(raw) {
  var key = String(raw || '').trim().toLowerCase();
  var map = {
    annual_report: '年报',
    annual: '年报',
    year_report: '年报',
    fourth_quarterly_report: '年报',
    q4: '年报',
    semi_annual_report: '半年报',
    semiannual_report: '半年报',
    interim_report: '半年报',
    semiannual: '半年报',
    second_quarterly_report: '半年报',
    first_quarterly_report: '一季报',
    q1: '一季报',
    third_quarterly_report: '三季报',
    q3: '三季报',
    quarterly_report: '季报',
    quarter: '季报',
    unknown: '未知',
  };
  return map[key] || (raw ? String(raw) : '');
}

function stockAnalysisRenderStatementFilters(data) {
  var periodEl = document.getElementById('stock-analysis-statement-period');
  if (periodEl) {
    var currentPeriod = typeof stockAnalysisStatementFilters === 'function' ? stockAnalysisStatementFilters().periodType : periodEl.value;
    var periodOptions = [
      { value: 'annual', label: '年报' },
      { value: 'semiannual', label: '半年报' },
      { value: 'quarter', label: '季报' },
    ];
    periodEl.innerHTML = periodOptions.map(function(opt) {
      return '<option value="' + opt.value + '">' + opt.label + '</option>';
    }).join('');
    var nextPeriod = periodOptions.some(function(opt) { return opt.value === currentPeriod; }) ? currentPeriod : 'quarter';
    periodEl.value = nextPeriod;
    if (typeof stockAnalysisStatementFilters === 'function') {
      stockAnalysisStatementFilters().periodType = nextPeriod;
    }
  }
  var scope = document.getElementById('stock-analysis-statement-scope');
  var scopes = data && data.available_filters && data.available_filters.scopes || [];
  if (!scope || !scopes.length) return;
  var current = typeof stockAnalysisStatementFilters === 'function' ? stockAnalysisStatementFilters().scope : scope.value;
  var optionScopes = ['consolidated'].concat(scopes.filter(function(value) { return value !== 'consolidated'; }));
  scope.innerHTML = '<option value="all">全部已存口径</option>' + optionScopes.map(function(value) {
    var absent = scopes.indexOf(value) < 0;
    var label = value === 'consolidated' ? '合并口径' : value;
    return '<option value="' + escapeHtml(value) + '"' + (absent ? ' disabled' : '') + '>'
      + escapeHtml(absent ? label + '（暂无）' : label) + '</option>';
  }).join('');
  scope.value = current === 'all' || scopes.indexOf(current) >= 0 ? current : 'consolidated';
}

function stockAnalysisShowStatementsError(error) {
  var message = document.getElementById('stock-analysis-statements-message');
  if (message) { message.style.display='block'; message.textContent=error.message || String(error); }
}

function stockAnalysisStatementReason(reason) {
  var reasons = {
    comparison_method_unverified: '该项目的比较口径尚未核实',
    negative_comparison_unverified: '含负数的比较口径尚未核实',
    comparable_period_missing: '缺少可确认口径一致的比较期',
    comparable_value_missing: '比较期缺少数据',
    comparison_basis_uncomparable: '会计准则、合并口径或报告期类型不同，口径不可比',
    cumulative_flow_qoq_not_supported: '累计值暂无已核实的单期环比',
    flow_period_basis_unverified: '累计报告期起始日及重述口径尚未核实',
    zero_denominator: '比较期为零，无法计算',
    source_batch_incomplete: '来源采集不完整',
    source_not_disclosed: '来源未披露',
    source_mapping_unverified: '来源字段口径尚未核实',
    source_currency_unverified: '来源金额币种尚未核实',
    metric_not_requested: '该项目尚未采集',
    metric_missing: '暂无数据'
  };
  return reasons[reason] || '暂无可用数据';
}

function stockAnalysisStatementRelationReason(relationStatus) {
  var reasons = {
    format_version_unverified: '报告列报版本尚未核实，暂按同组平列展示',
    basis_conflict: '所选报告期准则、范围或列报版本存在差异，暂按同组平列展示',
    group_conflict: '跨类型分组口径存在差异，暂归入当前分组平列展示',
    parent_conflict: '不同报告期类型对该科目的归属存在差异，暂按同组平列展示',
    unverified_context: '部分报告期类型或来源尚未核实，暂按同组平列展示',
    issuer_sample_unmatched: '该层级仅见于特定发行人样本，当前报告暂按同组平列展示',
    candidate: '候选归属关系尚未核实，暂按同组平列展示',
    undecided: '直接归属关系待核实，暂按同组平列展示'
  };
  return reasons[relationStatus] || '';
}

function stockAnalysisStatementFormatChange(rawChange, unit, source) {
  if (rawChange == null) return { text: '—', cls: '', title: '' };
  var num = Number(rawChange);
  if (!Number.isFinite(num)) return { text: '—', cls: '', title: '' };
  var title = source === 'local_derived' ? '本地推算' : (source === 'lixinger_native' ? '理杏仁原生' : '');
  if (unit === 'pct_pt') {
    // 比率/占比变动统一用百分号展示（例：+1.01%），不再暴露英文 pct。
    var ptCls = Math.abs(num) < 0.005 ? 'statement-change flat' : (num > 0 ? 'statement-change up' : 'statement-change down negative');
    var ptText = Math.abs(num) < 0.005
      ? '0.00%'
      : ((num > 0 ? '+' : '-') + Math.abs(num).toFixed(2) + '%');
    return { text: ptText, cls: ptCls, title: (title ? title + ' · ' : '') + '占比较上期变动（百分点）' };
  }
  var formatted = stockAnalysisPercent(num);
  if (/^[-+]?0(?:\.0+)?%$/.test(formatted) || Math.abs(num) < 0.00005) {
    return { text: formatted.replace(/^[-+]/, ''), cls: 'statement-change flat', title: title };
  }
  if (num > 0) {
    return { text: formatted.charAt(0) === '+' ? formatted : '+' + formatted, cls: 'statement-change up', title: title };
  }
  return { text: formatted, cls: 'statement-change down negative', title: title };
}

function stockAnalysisPeriodQuarterLabel(period) {
  var pt = String((period && period.period_type) || '').toLowerCase();
  if (pt === 'annual') return 'Q4';
  if (pt === 'q3') return 'Q3';
  if (pt === 'semiannual') return 'Q2';
  if (pt === 'q1') return 'Q1';
  var raw = (period && (period.report_type_label || period.report_type)) || '';
  return raw ? (stockAnalysisFormatPeriodLabel(raw) || raw) : '当期';
}

function stockAnalysisFormatCellValue(rawVal, field) {
  if (rawVal == null) return '—';
  var numText = stockAnalysisNumber(rawVal, 2);
  if (field && (field.measure_type === 'percent' || field.unit === '%')) {
    return numText === '--' ? '—' : (numText + '%');
  }
  return numText;
}

function stockAnalysisKeepUnitTag(field) {
  if (!field || !field.unit) return '';
  if (field.unit === '%' || /亿元$/.test(String(field.unit))) return '';
  return String(field.unit);
}

function stockAnalysisBuildRowModels(data) {
  var fields = Array.isArray(data && data.fields) ? data.fields : [];
  var presentation = data && data.presentation;
  var supportedVersions = ['2026-11-23.1'];
  if (presentation && supportedVersions.indexOf(presentation.version) >= 0
      && Array.isArray(presentation.rows) && presentation.rows.length) {
    var byCode = {};
    var fieldCount = 0;
    var allFieldsHaveCode = fields.every(function(field) {
      if (!field || !field.code || byCode[field.code]) return false;
      byCode[field.code] = field;
      fieldCount++;
      return true;
    });
    var seenCodes = {};
    var seenCount = 0;
    var valid = allFieldsHaveCode && presentation.rows.every(function(row) {
      if (!row) return false;
      if (row.kind === 'section') return Boolean(row.label);
      if (row.kind === 'field') {
        if (!row.code || !byCode[row.code] || seenCodes[row.code]) return false;
        seenCodes[row.code] = true;
        seenCount++;
        return true;
      }
      return false;
    }) && seenCount === fieldCount;
    if (valid) {
      return { byCode: byCode, rows: presentation.rows, usesPresentation: true };
    }
  }
  // 缺少或不支持新版 presentation 时回退旧 fields 渲染。
  var fallbackRows = [];
  var currentSection = '';
  fields.forEach(function(field) {
    var section = field.section || '';
    var hasValue = Array.isArray(field.values) && field.values.some(function(item) { return item && item.value != null; });
    if (section && section !== currentSection) {
      currentSection = section;
      if (!(String(field.label || '') === String(currentSection || '') && hasValue)) {
        fallbackRows.push({ kind: 'section', row_role: 'section', group_id: 'legacy:' + currentSection, label: currentSection, depth: 0 });
      }
    }
    var isSectionRep = section && String(field.label || '') === String(section) && hasValue;
    fallbackRows.push({
      kind: 'field',
      code: field.code,
      field: field,
      row_role: field.row_role || (field.is_parent ? 'total' : 'line'),
      group_id: field.group_id || ('legacy:' + section),
      parent_code: field.parent || null,
      depth: Math.max(0, Number(field.level) || 0),
      relation_status: field.relation_status || 'group_only',
      is_group_rep: Boolean(isSectionRep),
    });
  });
  return { byCode: {}, rows: fallbackRows, usesPresentation: false };
}

function stockAnalysisRenderStatements(data) {
  var title = document.getElementById('stock-analysis-statements-title');
  var message = document.getElementById('stock-analysis-statements-message');
  var wrap = document.getElementById('stock-analysis-statements-wrap');
  if (title) title.textContent = data.name || '三表';
  stockAnalysisRenderStatementFilters(data);
  var meta = document.getElementById('stock-analysis-statements-meta');
  if (meta) {
    var filterText = data.compare === 'qoq' ? '环比' : data.compare === 'none' ? '不比较' : '同比';
    var coverage = data.coverage && data.coverage.complete === false ? '采集不完整'
      : data.coverage && data.coverage.complete === true ? '来源覆盖已记录' : '覆盖证据未提供';
    var scopeText = data.scope === 'all' ? '全部已存口径' : data.scope === 'parent' ? '母公司口径' : data.scope === 'consolidated' || !data.scope ? '合并口径' : data.scope;
    meta.textContent = [data.market || '', data.standard || '', data.currency || '多币种/原币', scopeText, filterText, coverage].filter(Boolean).join(' · ');
  }
  if (!wrap) return;
  if (!data.periods || !data.periods.length || !data.fields || !data.fields.length) {
    wrap.style.display='none';
    if (message) { message.style.display='block'; message.textContent='暂无可展示的财报数据。'; }
    return;
  }
  if (message) message.style.display='none';
  var compareMode = data.compare || 'yoy';
  var showYoy = compareMode === 'yoy' || compareMode === 'both';
  var showQoq = compareMode === 'qoq' || compareMode === 'both';
  var comparisonEnabled = data.compare !== 'none';
  var comparisonLabel = compareMode === 'both' ? '同比/环比' : (compareMode === 'qoq' ? '环比' : '同比');
  var columnsPerPeriod = 1 + (showYoy ? 1 : 0) + (showQoq ? 1 : 0);
  var periodFilter = String(data.period_type || (typeof stockAnalysisStatementFilters === 'function' ? stockAnalysisStatementFilters().periodType : 'quarter') || 'quarter').toLowerCase();
  var isFlowStatement = data.type === 'income' || data.type === 'cashflow';
  var isQuarterFilter = periodFilter === 'quarter';
  // 季报筛选下 Q4（年报）也要展示单季值，因此不能只在出现半年/一季/三季时才启用单季行。
  var hasSubPeriods = isFlowStatement && (isQuarterFilter || (periodFilter !== 'annual' && (data.periods || []).some(function(p) {
    var pt = String((p && p.period_type) || '').toLowerCase();
    return pt === 'semiannual' || pt === 'q1' || pt === 'q3';
  })));
  var dualStickyCols = hasSubPeriods;
  var stickyColCount = dualStickyCols ? 2 : 1;
  var columnCount = data.periods.length * columnsPerPeriod + stickyColCount;

  var yearGroups = [];
  (data.periods || []).forEach(function(period, periodIndex) {
    var yr = String(period.fiscal_year || period.year || String(period.end_date || '').slice(0, 4) || '');
    var last = yearGroups[yearGroups.length - 1];
    if (last && last.year === yr) {
      last.span += columnsPerPeriod;
      last.endIdx = periodIndex;
    } else {
      yearGroups.push({ year: yr, span: columnsPerPeriod, startIdx: periodIndex, endIdx: periodIndex });
    }
  });
  var headLayer1 = yearGroups.map(function(g, gi) {
    var sepCls = gi < yearGroups.length - 1 ? ' statement-year-end' : '';
    return '<th class="statement-year-group' + sepCls + '" scope="colgroup" colspan="' + g.span + '">' + escapeHtml(g.year || '报告期') + '</th>';
  }).join('');

  var headLayer2 = data.periods.map(function(period, periodIndex) {
    var notes = [];
    if (period.end_date) notes.push('期末 ' + period.end_date);
    var periodText = stockAnalysisFormatPeriodLabel(period.report_type_label || period.report_type);
    if (periodText) notes.push(periodText);
    var tableTypes = { non_financial:'非金融', bank:'银行', insurance:'保险', security:'证券', other_financial:'其他金融', reit:'房地产投资信托' };
    if (tableTypes[period.fs_table_type]) notes.push('报表类型：' + tableTypes[period.fs_table_type]);
    var scopes = { consolidated:'合并口径', parent:'母公司口径' };
    notes.push(scopes[period.scope] || (period.scope ? '口径：' + period.scope : '口径待确认'));
    if (period.currency) notes.push(period.currency);
    if (period.announced_at) notes.push('公告 ' + period.announced_at);
    var qLabel = stockAnalysisPeriodQuarterLabel(period);
    var tipHtml = notes.length
      ? '<details class="statement-period-tip"><summary aria-label="查看报告期详情">' + escapeHtml(qLabel) + '</summary><div class="statement-period-tip-body">' + escapeHtml(notes.join(' · ')) + '</div></details>'
      : escapeHtml(qLabel);
    var isYearEnd = yearGroups.some(function(g, gi) { return gi < yearGroups.length - 1 && g.endIdx === periodIndex; });
    return '<th id="stmt-period-' + periodIndex + '" class="statement-period' + (isYearEnd ? ' statement-year-end' : '') + '" scope="colgroup" colspan="' + columnsPerPeriod + '">' + tipHtml + '</th>';
  }).join('');

  var subHead = data.periods.map(function(_, periodIndex) {
    var isYearEnd = yearGroups.some(function(g, gi) { return gi < yearGroups.length - 1 && g.endIdx === periodIndex; });
    var endCls = isYearEnd ? ' statement-year-end' : '';
    var cols = ['<th id="stmt-val-' + periodIndex + '" class="' + (!comparisonEnabled ? endCls.trim() : '') + '" headers="stmt-period-' + periodIndex + '" scope="col">原值</th>'];
    if (showYoy) cols.push('<th id="stmt-yoy-' + periodIndex + '" class="' + (!showQoq ? endCls.trim() : '') + '" headers="stmt-period-' + periodIndex + '" scope="col">同比</th>');
    if (showQoq) cols.push('<th id="stmt-qoq-' + periodIndex + '" class="' + endCls.trim() + '" headers="stmt-period-' + periodIndex + '" scope="col">环比</th>');
    return cols.join('');
  }).join('');

  var model = stockAnalysisBuildRowModels(data);
  function hasFiniteNum(val) {
    return val != null && Number.isFinite(Number(val));
  }
  // #112：只有“非零且有效”的原值/比较值才能证明该行有业务内容；0 与 0.00% 都不算。
  function hasNonZeroNum(val) {
    return hasFiniteNum(val) && Number(val) !== 0;
  }
  function isAbnormalStatus(status, reason) {
    if (!status || status === 'available' || status === 'source_not_disclosed') return false;
    return reason !== 'comparable_period_missing' && reason !== 'comparable_value_missing' && reason !== 'zero_denominator' && reason !== 'source_not_disclosed';
  }
  var keptRows = (function filterZeroRows(rows, byCode) {
    var fieldEntriesByCode = {};
    var keptCodes = {};
    rows.forEach(function(entry, idx) {
      if (entry.kind !== 'field') return;
      var field = entry.field || byCode[entry.code];
      var code = entry.code || (field && field.code) || ('__idx_' + idx);
      fieldEntriesByCode[code] = entry;
      // 行是否保留由“是否有实质内容”决定：
      // - 总计/分组代表行始终保留；
      // - 任一期间有非零原值或非零同比/环比，保留；
      // - 全 null 且有采集不完整/不可比等异常状态，保留并展示原因；
      // - 原值全为 0（即使比较值为 0 或比较状态异常）不保留（#112）。
      var substantive = false;
      var anyOriginal = false;
      var abnormal = false;
      (field && Array.isArray(field.values) ? field.values : []).forEach(function(item) {
        if (!item) return;
        if (hasFiniteNum(item.value) || (dualStickyCols && hasFiniteNum(item.single_value))) anyOriginal = true;
        if (hasNonZeroNum(item.value) || (dualStickyCols && hasNonZeroNum(item.single_value))) substantive = true;
        if (showYoy && (hasNonZeroNum(item.yoy) || hasNonZeroNum(item.change))) substantive = true;
        if (showQoq && hasNonZeroNum(item.qoq)) substantive = true;
        if (dualStickyCols && ((showYoy && hasNonZeroNum(item.single_yoy)) || (showQoq && hasNonZeroNum(item.single_qoq)))) substantive = true;
        if (item.status && item.status !== 'available' && item.status !== 'source_not_disclosed') abnormal = true;
        var yoyStatus = item.yoy_status !== undefined ? item.yoy_status : item.comparison_status;
        var yoyReason = item.yoy_reason !== undefined ? item.yoy_reason : item.comparison_reason;
        if (showYoy && isAbnormalStatus(yoyStatus, yoyReason)) abnormal = true;
        var qoqStatus = item.qoq_status !== undefined ? item.qoq_status : (compareMode === 'qoq' ? item.comparison_status : null);
        var qoqReason = item.qoq_reason !== undefined ? item.qoq_reason : (compareMode === 'qoq' ? item.comparison_reason : null);
        if (showQoq && isAbnormalStatus(qoqStatus, qoqReason)) abnormal = true;
      });
      var keep = entry.row_role === 'total' || Boolean(entry.is_group_rep) || substantive || (!anyOriginal && abnormal);
      if (keep) {
        keptCodes[code] = true;
      }
    });
    Object.keys(keptCodes).slice().forEach(function(code) {
      var cur = fieldEntriesByCode[code];
      var guard = 0;
      while (cur && cur.parent_code && !keptCodes[cur.parent_code] && guard++ < 16) {
        keptCodes[cur.parent_code] = true;
        cur = fieldEntriesByCode[cur.parent_code];
      }
    });
    var filtered = [];
    for (var i = 0; i < rows.length; i++) {
      var entry = rows[i];
      if (entry.kind === 'field') {
        var f = entry.field || byCode[entry.code];
        var fCode = entry.code || (f && f.code) || ('__idx_' + i);
        if (keptCodes[fCode]) filtered.push(entry);
      } else if (entry.kind === 'section') {
        var secDepth = Number(entry.depth) || 0;
        var hasChildField = false;
        for (var j = i + 1; j < rows.length; j++) {
          var next = rows[j];
          if (next.kind === 'section' && (Number(next.depth) || 0) <= secDepth) break;
          if (next.kind === 'field') {
            var nf = next.field || byCode[next.code];
            var nCode = next.code || (nf && nf.code) || ('__idx_' + j);
            if (keptCodes[nCode]) { hasChildField = true; break; }
          }
        }
        if (hasChildField) filtered.push(entry);
      }
    }
    return filtered;
  })(model.rows, model.byCode);
  // #110/#113：父行本身是普通科目（不是结构小计）时，用中性父级样式与子项区分，
  // 避免「财务费用 / 营业外收入」被误读成与「营业利润 / 利润总额」同级的小计。
  var parentCodes = {};
  model.rows.forEach(function(entry) {
    if (entry.kind === 'field' && entry.parent_code) parentCodes[entry.parent_code] = true;
  });
  var commonComparisonReasons = {};

  function renderChangeCell(rawVal, unit, source, status, reason, headersAttr, extraCls) {
    var fmt = stockAnalysisStatementFormatChange(rawVal, unit, source);
    var clsList = [fmt.cls, source === 'local_derived' ? 'statement-cmp-derived' : '', extraCls].filter(Boolean).join(' ');
    var clsAttr = clsList ? ' class="' + clsList + '"' : '';
    var reasonText = status && status !== 'available' ? stockAnalysisStatementReason(reason) : fmt.title;
    var statusAttr = status && status !== 'available'
      ? ' data-status="' + escapeHtml(status) + '" title="' + escapeHtml(reasonText) + '" aria-label="' + escapeHtml(reasonText) + '"'
      : (reasonText ? ' data-cmp-source="' + escapeHtml(source || '') + '" title="' + escapeHtml(reasonText) + '"' : '');
    return '<td' + clsAttr + ' headers="' + headersAttr + '"' + statusAttr + '>' + escapeHtml(fmt.text) + '</td>';
  }

  var rows = keptRows.map(function(entry) {
    if (entry.kind === 'section') {
      var secDepth = Math.max(0, Math.min(4, Number(entry.depth) || 0));
      var groupAttr = entry.group_id ? ' data-group-id="' + escapeHtml(entry.group_id) + '"' : '';
      // 整行分组标题独占整行：不再被固定首列宽度挤压折行（#105/#111）。
      // 一级活动分组、二级「现金流入/流出」和科目行使用不同层级样式，文字本身强制不折行。
      return '<tr class="statement-section statement-section-' + escapeHtml(data.type) + ' statement-role-section statement-level-' + secDepth + '" data-statement-level="' + (Number(entry.depth) || 0) + '"' + groupAttr + '><th scope="row" colspan="' + columnCount + '" class="statement-section-cell statement-section-title"><span class="statement-section-text">' + escapeHtml(entry.label) + '</span></th></tr>';
    }
    var field = entry.field || model.byCode[entry.code];
    if (!field) return '';
    var statusGroups = {};
    var statusOrder = [];
    function addStatusMessage(index, prefix, reason) {
      var reasonText = stockAnalysisStatementReason(reason);
      var period = data.periods[index] || {};
      var periodLabel = period.end_date || period.fiscal_year || period.year || ('第' + (index + 1) + '期');
      var scopeLabels = { consolidated: '合并口径', parent: '母公司口径' };
      var periodTypeText = stockAnalysisFormatPeriodLabel(period.report_type_label || period.report_type);
      if (periodTypeText) periodLabel += ' ' + periodTypeText;
      if (period.scope) periodLabel += ' ' + (scopeLabels[period.scope] || period.scope);
      var groupKey = prefix + '：' + reasonText;
      if (!statusGroups[groupKey]) {
        statusGroups[groupKey] = [];
        statusOrder.push(groupKey);
      }
      if (statusGroups[groupKey].indexOf(periodLabel) < 0) statusGroups[groupKey].push(periodLabel);
    }
    (field.values || []).forEach(function(item, index) {
      if (item && item.status && item.status !== 'available' && item.status !== 'source_not_disclosed') {
        addStatusMessage(index, '原值', item.reason);
      }
      var yoyStatus = item && item.yoy_status !== undefined ? item.yoy_status : (item && item.comparison_status);
      var yoyReason = item && item.yoy_reason !== undefined ? item.yoy_reason : (item && item.comparison_reason);
      if (showYoy && item && yoyStatus && yoyStatus !== 'available' && yoyStatus !== 'source_not_disclosed') {
        if (yoyReason && yoyReason !== 'comparable_period_missing' && yoyReason !== 'comparable_value_missing' && yoyReason !== 'source_not_disclosed') {
          addStatusMessage(index, '同比', yoyReason);
        }
        if (yoyReason) commonComparisonReasons[yoyReason] = (commonComparisonReasons[yoyReason] || 0) + 1;
      }
      var qoqStatus = item && item.qoq_status !== undefined ? item.qoq_status : (compareMode === 'qoq' && item ? item.comparison_status : null);
      var qoqReason = item && item.qoq_reason !== undefined ? item.qoq_reason : (compareMode === 'qoq' && item ? item.comparison_reason : null);
      if (showQoq && item && qoqStatus && qoqStatus !== 'available' && qoqStatus !== 'source_not_disclosed') {
        if (qoqReason && qoqReason !== 'comparable_period_missing' && qoqReason !== 'comparable_value_missing' && qoqReason !== 'source_not_disclosed') {
          addStatusMessage(index, '环比', qoqReason);
        }
        if (qoqReason) commonComparisonReasons[qoqReason] = (commonComparisonReasons[qoqReason] || 0) + 1;
      }
      if (dualStickyCols && ['currency', 'per_share'].includes(field.measure_type) && item && item.single_reason) {
        var ptSingle = String((data.periods[index] && data.periods[index].period_type) || '').toLowerCase();
        if ((ptSingle === 'q1' || ptSingle === 'q3') && item.single_reason !== 'source_not_disclosed') {
          addStatusMessage(index, '单季', item.single_reason);
        }
      }
    });
    var statusMessages = statusOrder.map(function(groupKey) {
      return statusGroups[groupKey].join('、') + ' ' + groupKey;
    });
    var relationReason = stockAnalysisStatementRelationReason(entry.relation_status);
    if (relationReason) statusMessages.push('层级关系：' + relationReason);
    // #114：科目含义放在说明最前；数据状态/层级降级原因随后，悬停、键盘聚焦和点按都能读到。
    // 只为已有点击说明的行、以及金融/保险专项科目补语义说明，避免给所有正常科目新增下划线。
    var fieldHelp = stockAnalysisStatementFieldHelpText(field);
    var alwaysHelp = /^ps\.(ie|face|iiicr|phdrfpip|s|ce|rie)$/.test(String(field.code || ''));
    if (fieldHelp && (statusMessages.length || alwaysHelp)) statusMessages.unshift(fieldHelp);

    var cells = (field.values || []).map(function(item, periodIndex) {
      var isYearEnd = yearGroups.some(function(g, gi) { return gi < yearGroups.length - 1 && g.endIdx === periodIndex; });
      var endCls = isYearEnd ? ' statement-year-end' : '';
      var value = stockAnalysisFormatCellValue(item.value, field);
      var valueReason = stockAnalysisStatementReason(item.reason);
      var valueStatus = item.status && item.status !== 'available' ? ' data-status="' + escapeHtml(item.status) + '" title="' + escapeHtml(valueReason) + '" aria-label="' + escapeHtml(valueReason) + '"' : '';
      var valueCell = '<td class="statement-value' + (value === '—' ? ' statement-missing' : '') + (!comparisonEnabled ? endCls : '') + '" headers="stmt-period-' + periodIndex + ' stmt-val-' + periodIndex + '"' + valueStatus + '>' + escapeHtml(value) + '</td>';
      var out = valueCell;
      if (showYoy) {
        out += renderChangeCell(item.yoy != null ? item.yoy : item.change, item.yoy_unit || item.comparison_unit, item.yoy_source || item.comparison_source, item.yoy_status || item.comparison_status, item.yoy_reason || item.comparison_reason, 'stmt-period-' + periodIndex + ' stmt-yoy-' + periodIndex, !showQoq ? endCls : '');
      }
      if (showQoq) {
        out += renderChangeCell(item.qoq, item.qoq_unit, item.qoq_source, item.qoq_status, item.qoq_reason, 'stmt-period-' + periodIndex + ' stmt-qoq-' + periodIndex, endCls);
      }
      return out;
    }).join('');

    var depth = Math.max(0, Number(entry.depth) || 0);
    var visualLevel = Math.min(4, depth);
    var rowRole = entry.row_role || 'line';
    var parentCode = entry.parent_code || null;
    var parentField = parentCode && model.byCode[parentCode] ? model.byCode[parentCode] : null;
    var hasChildren = Boolean(parentCodes[field.code]);
    var rowClass = 'statement-item statement-role-' + escapeHtml(rowRole) + ' statement-level-' + visualLevel
      + (rowRole === 'total' ? ' statement-parent statement-total' : rowRole === 'subtotal' ? ' statement-parent' : '')
      + (hasChildren ? ' statement-has-children' : '')
      + (entry.is_group_rep ? ' statement-section-total' : '');
    var branch = parentCode ? '<span class="statement-branch" aria-hidden="true">└</span>' : '';
    var parentAttr = parentCode ? ' data-parent-code="' + escapeHtml(parentCode) + '"' : '';
    var codeAttr = field.code ? ' data-statement-code="' + escapeHtml(field.code) + '"' : '';
    var groupAttr = entry.group_id ? ' data-group-id="' + escapeHtml(entry.group_id) + '"' : '';
    var roleAttr = ' data-row-role="' + escapeHtml(rowRole) + '"';
    var keepUnit = stockAnalysisKeepUnitTag(field);
    var unit = keepUnit ? '<small class="statement-unit">' + escapeHtml(keepUnit) + '</small>' : '';
    var srParent = parentField ? '<span class="statement-sr-parent">（隶属：' + escapeHtml(parentField.label) + '）</span>' : '';
    var labelHtml = statusMessages.length
      ? '<details class="statement-label-tip"><summary class="statement-label statement-label-has-tip" aria-label="' + escapeHtml(field.label + '：查看科目说明与数据状态') + '">' + escapeHtml(field.label) + '</summary><div class="statement-label-tip-body">' + escapeHtml(statusMessages.join('；')) + '</div></details>'
      : '<span class="statement-label">' + escapeHtml(field.label) + '</span>';
    var basisCell = dualStickyCols ? '<th scope="row" class="statement-col-basis">当期</th>' : '';
    // #109：当期/单季（或当期/半年）两行的指标名称共用同一单元格，垂直合并而不是留空单元格。
    var hasSubRow = dualStickyCols && ['currency', 'per_share'].includes(field.measure_type);
    var nameRowspan = hasSubRow ? ' rowspan="2"' : '';
    var primaryTr = '<tr class="' + rowClass + '" data-statement-level="' + depth + '"' + roleAttr + groupAttr + codeAttr + parentAttr + '><th scope="row" class="statement-col-name"' + nameRowspan + '>' + branch + labelHtml + srParent + unit + '</th>' + basisCell + cells + '</tr>';

    if (!hasSubRow) {
      return primaryTr;
    }
    var isSemiannualFilter = periodFilter === 'semiannual';
    // 「季报」= 全部季度粒度报告（Q1/半年报/Q3/年报），单季列按季度口径展示。
    var subRowLabel = isSemiannualFilter ? '半年' : '单季';
    var subCells = (field.values || []).map(function(item, periodIndex) {
      var period = data.periods[periodIndex] || {};
      var pt = String(period.period_type || '').toLowerCase();
      var isYearEnd = yearGroups.some(function(g, gi) { return gi < yearGroups.length - 1 && g.endIdx === periodIndex; });
      var endCls = isYearEnd ? ' statement-year-end' : '';
      // 半年报筛选展示「半年」累计值；其余（含季报筛选）一律展示单季值。
      // 季报筛选必须覆盖 Q1/半年报/Q3/年报（Q4），且 Q2、Q4 都只能用 single_value，
      // 不能把半年累计当 Q2 单季、也不能隐藏 Q4 单季值（F-07）。
      var useSemiannualRow = isSemiannualFilter && pt === 'semiannual';
      var showSubInCol = isSemiannualFilter ? (pt === 'semiannual') : true;
      var subRawVal = useSemiannualRow ? item.value : item.single_value;
      var sVal = showSubInCol ? stockAnalysisFormatCellValue(subRawVal, field) : '—';
      var subYoyVal = useSemiannualRow ? (item.yoy != null ? item.yoy : item.change) : item.single_yoy;
      var subQoqVal = useSemiannualRow ? null : item.single_qoq;
      var subSrc = useSemiannualRow ? (item.yoy_source || item.comparison_source) : item.single_source;
      var subReason = useSemiannualRow ? (item.yoy_reason || item.comparison_reason) : item.single_reason;
      var subValReasonText = showSubInCol && sVal === '—' && subReason ? stockAnalysisStatementReason(subReason) : '';
      var subValStatusAttr = subValReasonText
        ? ' data-status="not_applicable" title="' + escapeHtml(subValReasonText) + '" aria-label="' + escapeHtml(subValReasonText) + '"'
        : '';
      var out = '<td class="statement-value statement-subperiod-val' + (sVal === '—' ? ' statement-missing' : '') + (!comparisonEnabled ? endCls : '') + '"' + subValStatusAttr + '>' + escapeHtml(sVal) + '</td>';
      if (showYoy) out += renderChangeCell(showSubInCol ? subYoyVal : null, 'ratio', subSrc, showSubInCol && subYoyVal == null && subReason ? 'not_applicable' : null, subReason, 'stmt-period-' + periodIndex + ' stmt-yoy-' + periodIndex, !showQoq ? endCls : '');
      if (showQoq) out += renderChangeCell(showSubInCol ? subQoqVal : null, 'ratio', subSrc, showSubInCol && subQoqVal == null && subReason ? 'not_applicable' : null, subReason, 'stmt-period-' + periodIndex + ' stmt-qoq-' + periodIndex, endCls);
      return out;
    }).join('');
    // 名称单元格已由 primaryTr 以 rowspan=2 合并，子行只保留口径列和数值列。
    var subTr = '<tr class="' + rowClass + ' statement-subperiod-row" data-statement-level="' + depth + '"' + roleAttr + groupAttr + codeAttr + parentAttr + '><th scope="row" class="statement-col-basis">' + escapeHtml(subRowLabel) + '</th>' + subCells + '</tr>';
    return primaryTr + subTr;
  }).join('');

  var summaryHtml = '';
  if (comparisonEnabled) {
    var topReasons = Object.keys(commonComparisonReasons).filter(function(r) { return commonComparisonReasons[r] >= 3; });
    if (topReasons.length) {
      summaryHtml = '<div class="stock-analysis-statements-summary" role="note">比较口径说明：' + escapeHtml(topReasons.map(stockAnalysisStatementReason).join('；')) + '</div>';
    }
  }
  var cornerText = data.currency_mixed ? '多币种·见各期标注' : (data.unit_label || '默认单位：亿元');
  wrap.classList.add('biz-table-scroll');
  wrap.innerHTML = summaryHtml + '<table class="biz-table biz-table--matrix stock-analysis-statements-table' + (dualStickyCols ? ' has-dual-cols' : '') + '" aria-label="' + escapeHtml((data.name || '财务三表') + '，' + cornerText) + '"><thead><tr><th rowspan="3" colspan="' + stickyColCount + '" class="statement-col-corner" scope="col">' + escapeHtml(cornerText) + '</th>' + headLayer1 + '</tr><tr>' + headLayer2 + '</tr><tr>' + subHead + '</tr></thead><tbody>' + rows + '</tbody></table>';
  wrap.style.display='block';
  if (window.BusinessTable) window.BusinessTable.attach(wrap, { page: '#main-stock-analysis', sticky: true });
}
