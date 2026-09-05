const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { effectiveConversionPrice, classifyProgress } = require('../services/convertibleBondRedemptionService');
const { classifyCallEvent, eventParseComplete, pickInstrument } = require('../services/convertibleBondRedemptionSync');

assert.strictEqual(effectiveConversionPrice(10, [{ change_date: '2026-08-10', price_before: 10, price_after: 9 }], '2026-08-09'), 10);
assert.strictEqual(effectiveConversionPrice(10, [{ change_date: '2026-08-10', price_before: 10, price_after: 9 }], '2026-08-10'), 9);
assert.strictEqual(classifyProgress({ matchedDays: 15, requiredDays: 15, observationDays: 30, bars: Array(30).fill({}), triggerPrice: 12, closePrice: 13 }).status, 'met');
assert.strictEqual(classifyProgress({ matchedDays: 3, requiredDays: 15, observationDays: 30, bars: Array(30).fill({}), triggerPrice: 12, closePrice: 11 }).status, 'tracking');
assert.strictEqual(classifyProgress({ matchedDays: 3, requiredDays: 15, observationDays: 30, bars: [], triggerPrice: 12, closePrice: 11 }).dataStatus, 'incomplete');
assert.strictEqual(classifyProgress({ matchedDays: 3, requiredDays: 15, observationDays: 30, expectedObservationDays: 28,
  bars: Array(28).fill({}), triggerPrice: 12, closePrice: 11,
  missingDates: ['2026-07-14', '2026-07-15'], suspendedDates: ['2026-07-14', '2026-07-15'] }).dataStatus, 'complete');
assert.strictEqual(eventParseComplete('implementation', { lastTradeDate: '2026-08-31', lastConversionDate: '2026-09-03' }), true);
assert.strictEqual(eventParseComplete('implementation', { lastTradeDate: '2026-08-31' }), false);
assert.strictEqual(classifyCallEvent('南方航空关于“南航转债”到期兑付暨摘牌的第三次提示性公告'), 'implementation');
assert.strictEqual(pickInstrument({ title: '关于转债的公告' }, [
  { instrument_id: 1, bond_name: '甲转债', security_code: '123001' },
  { instrument_id: 2, bond_name: '乙转债', security_code: '123002' },
]), null);

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'js', 'bond-redemption.js'), 'utf8');
const redemptionCss = fs.readFileSync(path.join(root, 'public', 'css', 'bond-redemption.css'), 'utf8');
const safetyCss = fs.readFileSync(path.join(root, 'public', 'css', 'bond-safety.css'), 'utf8');
const cycle = fs.readFileSync(path.join(root, 'public', 'js', 'bond-cycle.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'server', 'db', 'migrations.js'), 'utf8');
const stockAnalysis = fs.readFileSync(path.join(root, 'server', 'services', 'stockAnalysis.js'), 'utf8');
const list = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondListService.js'), 'utf8');
const analysis = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondAnalysis.js'), 'utf8');
const valuation = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondValuationService.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'server', 'services', 'jobRunners.js'), 'utf8');

assert.ok(html.includes('data-sub="redemption"') && html.includes('id="sub-bond-redemption"'));
assert.ok(html.includes('js/bond-redemption.js?v=4'));
assert.ok(html.includes('id="bond-redemption-search" name="bond-redemption-search"') && html.includes('data-autofill-ignore'), '强赎搜索框必须明确为非认证输入');
assert.ok(page.includes('/api/bond-redemption') && page.includes('biz-table'));
assert.ok(page.includes('/api/bond-redemption?limit=2000'), '强赎页必须读取完整的在市证券集合');
assert.ok(page.includes("'年' +") && page.includes('bondRedemptionDate(data.trade_date)'), '强赎页日期必须统一显示为中文年月日');
assert.ok(redemptionCss.includes('var(--bond-feature-gradient-start)') && redemptionCss.includes('var(--bond-feature-gradient-end)'), '强赎说明区必须沿用可转债功能页统一颜色');
assert.ok(/\.bond-list-hero \{[^}]*background:linear-gradient\(135deg,#3f51b5,#5c6bc0\)/.test(safetyCss), '上市转债说明区必须沿用安全性说明区颜色');
assert.ok(cycle.includes("sub === 'redemption'") && cycle.includes('loadBondRedemption'));
assert.ok(migration.includes('079_convertible_bond_redemption') && migration.includes('analytics.convertible_bond_call_latest'));
assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS event.convertible_bond_call_events'));
assert.ok(migration.includes('CREATE VIEW analytics.convertible_bond_call_latest'));
assert.ok(migration.includes('081_convertible_bond_redemption_unified_status'), '必须有统一状态与条款窗口修复迁移');
assert.ok(migration.includes('082_stock_suspension_calendar') && migration.includes('stock_suspend_calendar'), '必须落库存股停牌日，避免误判行情缺失');
assert.ok(migration.includes('084_convertible_bond_call_lifecycle_current_date') && migration.includes("THEN 'delisted'"), '强赎最后交易日过去后必须切换为历史退市');
assert.ok(migration.includes('085_convertible_bond_waive_announcement_status') && migration.includes('公告日不是截止日'), '最新不提前赎回公告必须覆盖触发结果');
assert.ok(migration.includes('086_convertible_bond_announcement_history_view') && migration.includes('analytics.convertible_bond_announcement_history'), '强赎、下修和转股价调整必须有统一公告事实视图');
assert.ok(migration.includes('088_convertible_bond_call_date_fallback') && migration.includes('历史公告中最近的明确日期'), '强赎日期缺失时必须从历史公告回填');
assert.ok(migration.includes('089_convertible_bond_call_formula_publication') && migration.includes('formula_version_not_published') && migration.includes("r.formula_version='call-v1'"), '强赎页面不得混用旧公式个券记录');
assert.ok(migration.includes('136_convertible_bond_redemption_status_parity') && migration.includes("THEN 'maturity_near'"), '最终强赎视图必须恢复临期状态');
assert.ok(migration.includes('087_convertible_bond_waive_same_day_validity'), '同日公司公告与核查意见必须合并有效期');
assert.ok(migration.includes('CREATE VIEW public.bond_unified'));
const redemptionService = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRedemptionService.js'), 'utf8');
const redemptionSync = fs.readFileSync(path.join(root, 'server', 'services', 'convertibleBondRedemptionSync.js'), 'utf8');
const callEventParser = fs.readFileSync(path.join(root, 'server', 'scripts', 'extractConvertibleBondCallEvent.py'), 'utf8');
assert.ok(redemptionService.includes('JOIN market.convertible_bond_daily_metrics dm'));
assert.ok(redemptionService.includes('m.trade_date=(SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics)'));
assert.ok(redemptionService.includes('PARTITION BY instrument_id,trade_date'), '正股日线必须先按交易日去重');
assert.ok(redemptionService.includes('expectedMarketDate') && redemptionService.includes('latestMarketDate < expectedMarketDate'), '强赎新鲜度必须纳入交易日历最新交易日');
assert.ok(redemptionService.includes('stock_suspend_calendar') && redemptionService.includes('suspended_dates'), '强赎计算必须区分停牌日与真正缺失日');
assert.ok(redemptionService.includes("WHEN 'announced' THEN 1 WHEN 'maturity_near' THEN 2 WHEN 'met_pending' THEN 3"), '强赎列表排序必须先公告、再临近到期、再已满足待确认');
assert.ok(redemptionSync.includes("'即将到期'") && redemptionSync.includes("'停止交易'") && redemptionSync.includes("'到期兑付'"), '强赎公告检索必须覆盖到期赎回提示公告');
assert.ok(stockAnalysis.includes('rows.length >= announceCount') && stockAnalysis.includes('!Number.isFinite(announceCount)'), '深交所公告分页必须按公告总数判断完整性');
assert.ok(redemptionSync.includes('eventParseComplete') && redemptionSync.includes('classified.length'), '强赎公告必须解析全部分类公告并按事件类型校验关键日期');
assert.ok(redemptionSync.includes('return null') && redemptionSync.includes('不能默认取第一只'), '同一正股多只转债时禁止模糊匹配');
assert.ok((redemptionCss.includes('color:#172033') || redemptionCss.includes('var(--bond-feature-text)')) && redemptionCss.includes('.bond-redemption-toolbar input,.bond-redemption-toolbar select') && redemptionCss.includes('font-size:13px'), '强赎卡片文字和输入控件必须沿用统一 UI 颜色与样式');
assert.ok(page.includes("['last_trade_date','停止交易日']") && page.includes("['last_conversion_date','停止转股日']") && !page.includes("['announcement_title','最新公告']"), '强赎表格应显示停止交易日、停止转股日并移除最新公告列');
assert.ok(callEventParser.includes('PARTIAL_DATE') && callEventParser.includes('停止交易日') && callEventParser.includes('停止转股日') && callEventParser.includes('parser_version": "2"'), '强赎公告解析必须支持不重复年份的停止交易/停止转股日期');
assert.ok(list.includes('getLatestCallStateMap') && list.includes('JOIN public.bond_unified u'));
assert.ok(analysis.includes('getLatestCallState') && analysis.includes('call_status'));
assert.ok(list.includes('call_status') && fs.readFileSync(path.join(root, 'public', 'js', 'bond-list.js'), 'utf8').includes('bondListLifecycleMarker'), '上市列表必须复用统一强赎状态并展示名称标识');
assert.ok(fs.readFileSync(path.join(root, 'public', 'js', 'bond-safety.js'), 'utf8').includes('bondSafetyLifecycleMarker'), '安全性列表必须展示名称标识');
assert.ok(valuation.includes('call_status') && fs.readFileSync(path.join(root, 'public', 'js', 'bond-valuation.js'), 'utf8').includes('bondValLifecycleMarker'), '估值列表必须复用统一强赎状态并展示名称标识');
assert.ok(analysis.includes('callDelisted') && analysis.includes('effectiveDelistDate'), '股债分析必须识别已强赎且已停止交易的历史转债');
assert.ok(runner.includes("convertible_bond_redemption_announcement_sync") && runner.includes('syncConvertibleBondCallAnnouncements'), '公告同步必须有正式调度执行入口');
assert.ok(valuation.includes('JOIN public.bond_unified u'));
console.log('convertible bond redemption tests passed');
