// 共享收盘采集契约：股票主档与市场事实必须同批全市场落库。
const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../services/convertibleBondAnalysis'), 'utf8');
const jobs = fs.readFileSync(require.resolve('../services/jobDefinitions'), 'utf8');
const migrations = fs.readFileSync(require.resolve('../db/migrations'), 'utf8');
const audit = fs.readFileSync(require.resolve('../scripts/auditInstrumentMerges'), 'utf8');
const identity = fs.readFileSync(require.resolve('../services/securityIdentity'), 'utf8');
const marketRoute = fs.readFileSync(require.resolve('../routes/market'), 'utf8');
const stockAnalysis = fs.readFileSync(require.resolve('../services/stockAnalysis'), 'utf8');
const tencentQuote = fs.readFileSync(require.resolve('../services/tencentQuote'), 'utf8');
const pythonIdentity = fs.readFileSync(require.resolve('../../ipo-report/instrument_identity.py'), 'utf8');
const pythonQuote = fs.readFileSync(require.resolve('../../ipo-report/ipo_lib_common.py'), 'utf8');
const pythonFetch = fs.readFileSync(require.resolve('../../ipo-report/ipo_lib_fetch.py'), 'utf8');
const pythonHistory = fs.readFileSync(require.resolve('../../ipo-report/ipo_history_sync.py'), 'utf8');

assert.match(source, /const STOCK_STATUS_FIELDS = 'ts_code,symbol,name,area,industry,market,exchange,list_date,list_status'/);
assert.match(source, /tushareQuery\('adj_factor', \{ trade_date: daily\.tradeDate \}/, '共享批次必须采集复权因子');
assert.match(source, /async function ensureStockUniverse\(/, '共享批次必须先建立全市场股票主档');
assert.match(source, /market\.adjustment_factors/, '复权因子必须进入标准行情层');
assert.match(source, /stock_adj_factor/, '复权因子必须发布数据分区');
assert.match(jobs, /collectorRole: 'shared_cn_market_eod'/, '不得新增平行共享采集任务');
assert.match(migrations, /118_instrument_merge_candidates/, '历史 ID 合并必须先有候选审计表');
assert.match(audit, /默认只读|--write-candidates/, '历史 ID 工具必须支持只读审计');
assert.doesNotMatch(audit, /DELETE\s+FROM\s+core\.instruments/i, '审计工具不得删除旧证券 ID');
assert.match(audit, /source_rel\.relname='instrument_merge_candidates'/, '历史 ID 影响量不得把候选审计表自身引用重复计入');
assert.match(identity, /source === 'xueqiu' && type === 'symbol'/, '雪球代码必须纳入统一供应商映射');
assert.match(stockAnalysis, /sourceCode: 'xueqiu'/, '股票分析雪球请求必须读取统一映射');
assert.match(stockAnalysis, /sourceCode: 'eastmoney', identifierType: 'guba_code'/, '股吧请求必须读取统一映射');
assert.match(tencentQuote, /resolveProviderCode/, '腾讯行情请求必须读取统一供应商映射');
assert.doesNotMatch(tencentQuote, /rawCodes\s*\|\|\s*\[\]\)\s*\.map\(describeTencentCode\)/, '腾讯行情请求不得直接按前缀拼接供应商代码');
assert.match(pythonIdentity, /_derive_provider_identifier/, 'Python 身份服务必须统一派生并落库供应商代码');
assert.match(pythonFetch, /_get_qt_symbol\(code, 'convertible_bond'\)/, 'Python 转债腾讯请求必须读取映射');
assert.match(pythonHistory, /resolve_provider_code\(code, "tencent", "quote_symbol"/, 'Python 新股历史腾讯请求必须读取映射');
assert.doesNotMatch(marketRoute, /sinaSymbol\s*\|\|\s*requestedSecid/, '指数新浪请求不得回退到前端传入代码');

console.log('stock-market-collector-contract: 全市场主档/行情/估值/复权因子与历史ID只读审计契约通过');
