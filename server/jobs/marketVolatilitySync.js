// 官网数据同步：中债 10 年期、恒指历史 PE、香港金管局 10 年期。
// 不用第三方替代中证全指 PE；该数据源未拿到精确 000985 指数值时保持缺失。
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, normDate } = require('../services/market');

function request(url, binary) { return new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'portfolio-server/1.0 (+official-data-sync)' }, timeout: 60000 }, r => {
    const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => {
      if (r.statusCode < 200 || r.statusCode >= 300) return reject(new Error('HTTP ' + r.statusCode));
      const b = Buffer.concat(chunks); resolve(binary ? b : JSON.parse(b.toString('utf8')));
    });
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
}); }
function dateStr(d) { return d.toISOString().slice(0, 10); }
function parseHsiWorkbook(buffer) { return new Promise((resolve, reject) => {
  // 官方文件为旧版 xls；通过 requirements.txt 中受控的 pandas/xlrd 解析，避免引入有高危漏洞的 Node xlsx 包。
  const code = "import sys,io,json,pandas as p; print(json.dumps(p.read_excel(io.BytesIO(sys.stdin.buffer.read()),header=None).fillna('').values.tolist(),default=str))";
  const localPython = path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe');
  const python = process.env.PYTHON || (process.platform === 'win32' && fs.existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python.exe' : 'python3');
  const child = spawn(python, ['-c', code], { stdio: ['pipe', 'pipe', 'pipe'] }); let out='', err='';
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c); child.on('error', reject);
  child.on('close', n => { if (n !== 0) return reject(new Error('恒指 PE 文件解析失败（退出码 ' + n + '）：' + err)); try { resolve(JSON.parse(out)); } catch(e) { reject(e); } }); child.stdin.end(buffer);
}); }
async function syncChinaYield(start, end) {
  async function queryRange(from, to) {
    const u = 'https://yield.chinabond.com.cn/cbweb-mn/pgxh/historyQuery?startDate=' + from + '&&endDate=' + to + '&&gjqx=10&&locale=cn_ZH';
    return new Promise((resolve, reject) => { const req = https.request(u, { method: 'POST', headers: { 'User-Agent': 'portfolio-server/1.0', Referer: 'https://yield.chinabond.com.cn/cbweb-mn/pgxh/showHistory' } }, r => { let b=''; r.on('data', c => b += c); r.on('end', () => { try { const data=JSON.parse(b); if (!Array.isArray(data)) throw new Error('中债返回格式错误'); resolve(data); } catch(e) { reject(new Error('中债 ' + from + ' 至 ' + to + ' 查询失败：' + e.message)); } }); }); req.on('error', reject); req.end(); });
  }
  let count = 0, cursor = new Date(start + 'T00:00:00Z'), last = new Date(end + 'T00:00:00Z');
  while (cursor <= last) {
    const rangeEnd = new Date(Date.UTC(cursor.getUTCFullYear() + 1, cursor.getUTCMonth(), cursor.getUTCDate() - 1));
    const to = rangeEnd < last ? rangeEnd : last; const rows = await queryRange(dateStr(cursor), dateStr(to));
    for (const r of rows) if (Number(r.tenYear) > 0) { await pool.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
    VALUES('CN',10,$1,$2,'chinabond',$1,$3) ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET yield_pct=EXCLUDED.yield_pct,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [r.workTime, r.tenYear, JSON.stringify(r)]);
      count++; }
    cursor = new Date(to.getTime() + 86400000);
  }
  return count;
}
async function syncCsiIndexPe(benchmark, indexCode) {
  const data = await request('https://www.csindex.com.cn/csindex-home/perf/indexCsiDsPe?indexCode=' + indexCode);
  const rows = data && data.success && Array.isArray(data.data) ? data.data : [];
  let count = 0;
  for (const r of rows) {
    // 中证该 PE 专用接口字段名为 peg，但端点与页面均为 indexCsiDsPe；按官方原始字段保留，映射入本系统统一 pe 口径。
    const pe = Number(r.peg); const date = String(r.tradeDate || '');
    if (!/^\d{8}$/.test(date) || !(pe > 0)) continue;
    const day = date.slice(0,4) + '-' + date.slice(4,6) + '-' + date.slice(6,8);
    await pool.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      VALUES('CN',$1,$2,$3,'csindex',$2,$4) ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [benchmark, day, pe, JSON.stringify(r)]);
    count++;
  }
  return count;
}
async function syncHsiPe() {
  const b = await request('https://www.hsi.com.hk/static/uploads/contents/en/dl_centre/monthly/pe/hsi.xls', true);
  const data = await parseHsiWorkbook(b); let count=0;
  for (const r of data.slice(3)) { const d = new Date(String(r[0])); const pe = Number(r[1]); if (Number.isNaN(d.getTime()) || !(pe > 0)) continue; const day = dateStr(d);
    await pool.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      VALUES('HK','HSI',$1,$2,'hsi_official',$1,$3) ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [day, pe, JSON.stringify(r)]);
    await pool.query(`INSERT INTO market.index_valuation_history(index_code,valuation_method,trade_date,pe_ttm,source_code,raw_payload)
      VALUES('HSI','market_cap_weighted',$1,$2,'hsi_official',$3)
      ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET
        pe_ttm=EXCLUDED.pe_ttm,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [day, pe, JSON.stringify(r)]);
    count++; }
  return count;
}
async function syncHkYield(full) {
  let count=0;
  for (let offset=0; offset<(full?2000:500); offset+=100) { const d = await request('https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/gov-bond/instit-bond-price-yield-daily?segment=Benchmark&offset=' + offset); const records=(((d || {}).result || {}).records || []);
  for (const r of records) { const key=Object.keys(r).find(k=>k.replace(/\*+$/,'')==='closing_ref_rate_10y'); const y = Number(key && r[key]); if (!r.end_of_day || !(y > 0)) continue;
    await pool.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
      VALUES('HK',10,$1,$2,'hkma',$1,$3) ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET yield_pct=EXCLUDED.yield_pct,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [r.end_of_day, y, JSON.stringify(r)]); count++; }
  if (!full || records.length < 100) break; } return count;
}
async function calculateGraham() {
  const { rows } = await pool.query(`SELECT v.market_code,v.benchmark_code,v.trade_date,v.pe,
    (SELECT y.yield_pct FROM market.sovereign_yield_daily y WHERE y.market_code=CASE WHEN v.market_code='HK' THEN 'US' ELSE v.market_code END AND y.tenor_years=10 AND (v.market_code<>'HK' OR y.source_code='manual_fed_funds') AND y.trade_date<=v.trade_date AND y.trade_date>=v.trade_date-CASE WHEN v.market_code='HK' THEN 10 ELSE 5 END ORDER BY y.trade_date DESC LIMIT 1) AS yield_pct,
    (SELECT y.trade_date FROM market.sovereign_yield_daily y WHERE y.market_code=CASE WHEN v.market_code='HK' THEN 'US' ELSE v.market_code END AND y.tenor_years=10 AND (v.market_code<>'HK' OR y.source_code='manual_fed_funds') AND y.trade_date<=v.trade_date AND y.trade_date>=v.trade_date-CASE WHEN v.market_code='HK' THEN 10 ELSE 5 END ORDER BY y.trade_date DESC LIMIT 1) AS yield_date
    FROM (SELECT DISTINCT ON (market_code,benchmark_code,trade_date) market_code,benchmark_code,trade_date,pe
      FROM market.market_valuation_daily WHERE pe>0
      ORDER BY market_code,benchmark_code,trade_date,CASE WHEN source_code='hsi_weighted_manual' THEN 0 WHEN source_code='hsi_official' THEN 1 ELSE 2 END) v`);
  for (const r of rows) { const earnings = 100 / Number(r.pe), y = Number(r.yield_pct); if (!(y > 0)) continue; const status = String(r.yield_date) === String(r.trade_date) ? 'normal' : 'carried_forward';
    await pool.query(`INSERT INTO analytics.graham_index_daily(market_code,benchmark_code,trade_date,pe,earnings_yield_pct,sovereign_yield_pct,sovereign_yield_date,graham_index_pct,data_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(market_code,benchmark_code,trade_date,formula_version) DO UPDATE SET pe=EXCLUDED.pe,earnings_yield_pct=EXCLUDED.earnings_yield_pct,sovereign_yield_pct=EXCLUDED.sovereign_yield_pct,sovereign_yield_date=EXCLUDED.sovereign_yield_date,graham_index_pct=EXCLUDED.graham_index_pct,data_status=EXCLUDED.data_status,calculated_at=now()`, [r.market_code,r.benchmark_code,r.trade_date,r.pe,earnings,y,r.yield_date,earnings-y,status]); }
}

function tsDate(value) { return String(value || '').replace(/-/g, ''); }
function monthDate(value) {
  const month = String(value || '');
  return /^\d{6}$/.test(month) ? month.slice(0, 4) + '-' + month.slice(4, 6) + '-01' : null;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function syncCsi300Valuation(full) {
  const end = tsDate(dateStr(new Date()));
  const ranges = full
    ? [['20040101', '20151231'], ['20160101', end]]
    : [[tsDate(dateStr(new Date(Date.now() - 45 * 86400000))), end]];
  let count = 0;
  for (const [startDate, endDate] of ranges) {
    const data = await tushareQuery('index_dailybasic', { ts_code: '000300.SH', start_date: startDate, end_date: endDate },
      'ts_code,trade_date,total_mv,pe_ttm,pb');
    if (!data) continue;
    for (const row of tsRows(data)) {
      const day = normDate(row.trade_date), pe = Number(row.pe_ttm), pb = Number(row.pb);
      if (!day || (!(pe > 0) && !(pb > 0))) continue;
      await pool.query(`INSERT INTO market.index_valuation_history
        (index_code,valuation_method,trade_date,market_cap,pe_ttm,pb,source_code,raw_payload)
        VALUES('CSI300','market_cap_weighted',$1,$2,$3,$4,'tushare_index_dailybasic',$5)
        ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET
          market_cap=EXCLUDED.market_cap,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,
          raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
      [day, Number(row.total_mv) || null, pe > 0 ? pe : null, pb > 0 ? pb : null, JSON.stringify(row)]);
      count++;
    }
  }
  return count;
}

async function syncMoneySupply() {
  const data = await tushareQuery('cn_m', {}, 'month,m2,m2_yoy');
  if (!data) return 0;
  let count = 0;
  for (const row of tsRows(data)) {
    const month = monthDate(row.month), m2 = Number(row.m2);
    if (!month || !(m2 > 0)) continue;
    await pool.query(`INSERT INTO market.money_supply_monthly
      (market_code,month,m2_100m_yuan,source_code,raw_payload)
      VALUES('CN',$1,$2,'nbs_via_tushare',$3)
      ON CONFLICT(market_code,month,source_code) DO UPDATE SET
        m2_100m_yuan=EXCLUDED.m2_100m_yuan,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [month, m2, JSON.stringify({
      ...row,
      source: 'https://data.stats.gov.cn/',
      fiscalReference: 'https://gks.mof.gov.cn/tongjishuju/',
      transport: 'tushare.cn_m',
      unit: '100m CNY',
      m1DefinitionVersion: String(row.month) >= '202501' ? '2025_revised' : 'pre_2025',
    })]);
    count++;
  }
  return count;
}

async function tradeMonthEnds(startYear, endYear) {
  const result = [], today = tsDate(dateStr(new Date()));
  for (let year = startYear; year <= endYear; year++) {
    const data = await tushareQuery('trade_cal',
      { exchange: 'SSE', start_date: year + '0101', end_date: year + '1231', is_open: '1' },
      'cal_date,is_open');
    if (!data) continue;
    const latest = new Map();
    for (const row of tsRows(data)) {
      if (String(row.is_open) !== '1' || !/^\d{8}$/.test(String(row.cal_date)) || String(row.cal_date) > today) continue;
      const day = String(row.cal_date), month = day.slice(0, 6), previous = latest.get(month);
      if (!previous || day > previous) latest.set(month, day);
    }
    result.push(...latest.values());
  }
  return result.sort();
}

// 全市场总市值完整性门禁：统一层（market.daily_valuations）证券数低于该值视为不完整，
// 拒绝使用并回退到对应交易日的 Tushare daily_basic 全量快照（A股两市约 5500 只）。
const MIN_UNIFIED_MARKET_COUNT = 4500;
// 统一层 total_market_cap 单位：元 → 存储列 total_market_cap_100m_yuan 单位：亿元
const YUAN_TO_100M = 100000000;

async function syncAShareMarketCap(full) {
  const currentYear = new Date().getUTCFullYear();
  const dates = await tradeMonthEnds(full ? 2010 : currentYear, currentYear);
  if (!dates.length) return 0;
  const existing = await pool.query(`SELECT to_char(trade_date,'YYYYMMDD') AS day
    FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic'`);
  const seen = new Set(existing.rows.map(row => row.day));
  const targets = full ? dates.filter(day => !seen.has(day)) : [dates.at(-1)].filter(day => day && !seen.has(day));
  let count = 0;
  for (const day of targets) {
    // 1) 优先用统一数据层按【目标交易日】完整分区聚合（daily_valuations.total_market_cap 单位：元）
    let totalYi = 0;   // 统一为亿元
    let securityCount = 0;
    let fromUnified = false;
    try {
      const { getTotalMarketCap } = require('../services/stockDataService');
      const cap = await getTotalMarketCap(normDate(day));
      if (cap && cap.total_cap > 0 && cap.stock_count >= MIN_UNIFIED_MARKET_COUNT) {
        totalYi = Number(cap.total_cap) / YUAN_TO_100M;
        securityCount = cap.stock_count;
        fromUnified = true;
      }
    } catch (_) { /* 统一层异常则走 Tushare 回退 */ }

    // 2) 统一层覆盖不足或异常：回退 Tushare daily_basic（total_mv 单位：万元 → 亿元 = /10000）
    //    回退数据同样验证交易日、数量、有效市值占比；异常时保留上一份有效数据（不写库）。
    if (!(totalYi > 0)) {
      const data = await tushareQuery('daily_basic', { trade_date: day }, 'ts_code,trade_date,total_mv');
      const rows = tsRows(data);
      if (rows.length < 1000) continue;
      const valid = rows.filter(row => Number.isFinite(Number(row.total_mv)) && Number(row.total_mv) > 0);
      if (valid.length / rows.length < 0.8) continue;
      securityCount = rows.length;
      totalYi = valid.reduce((sum, row) => sum + Number(row.total_mv), 0) / 10000;
    }
    if (!(totalYi > 0)) continue;
    await pool.query(`INSERT INTO market.a_share_market_cap_daily
      (trade_date,total_market_cap_100m_yuan,security_count,source_code,raw_payload)
      VALUES($1,$2,$3,'tushare_daily_basic',$4)
      ON CONFLICT(trade_date,source_code) DO UPDATE SET
        total_market_cap_100m_yuan=EXCLUDED.total_market_cap_100m_yuan,
        security_count=EXCLUDED.security_count,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [normDate(day), totalYi, securityCount, JSON.stringify({
      upstreamUnit: fromUnified ? 'CNY' : '10000 CNY',
      storedUnit: '100m CNY',
      securityCount,
      source: fromUnified ? 'unified_daily_valuations' : 'tushare_daily_basic',
    })]);
    count++;
    if (!fromUnified) await wait(350);  // 只有回退 Tushare 才需要限流
  }
  return count;
}

async function calculateM2MarketCap() {
  const result = await pool.query(`INSERT INTO analytics.m2_market_cap_daily
    (trade_date,m2_month,m2_100m_yuan,total_market_cap_100m_yuan,ratio_pct,data_status)
    SELECT c.trade_date,m.month,m.m2_100m_yuan,c.total_market_cap_100m_yuan,
      m.m2_100m_yuan/c.total_market_cap_100m_yuan*100,
      CASE WHEN c.trade_date <= (m.month + INTERVAL '2 months') THEN 'normal' ELSE 'carried_forward' END
    FROM market.a_share_market_cap_daily c
    JOIN LATERAL (
      SELECT month,m2_100m_yuan FROM market.money_supply_monthly
      WHERE market_code='CN' AND month <= date_trunc('month',c.trade_date)
      ORDER BY month DESC LIMIT 1
    ) m ON true
    WHERE c.source_code='tushare_daily_basic'
    ON CONFLICT(trade_date,formula_version) DO UPDATE SET
      m2_month=EXCLUDED.m2_month,m2_100m_yuan=EXCLUDED.m2_100m_yuan,
      total_market_cap_100m_yuan=EXCLUDED.total_market_cap_100m_yuan,
      ratio_pct=EXCLUDED.ratio_pct,data_status=EXCLUDED.data_status,calculated_at=now()`);
  return result.rowCount;
}

async function syncMarketCycleMetrics(full) {
  if (!process.env.TUSHARE_TOKEN) return { skipped: 'TUSHARE_TOKEN missing' };
  const result = {
    csi300Valuation: await syncCsi300Valuation(full),
    moneySupply: await syncMoneySupply(),
    aShareMarketCap: await syncAShareMarketCap(full),
  };
  result.m2MarketCap = await calculateM2MarketCap();
  return result;
}

async function runMarketVolatilitySync() { if (!(await tryClaimJob('market_volatility_sync'))) return; const id=await startJobRun('market_volatility_sync'); try { const end=dateStr(new Date()); const seen=await pool.query("SELECT count(*)::int AS n FROM market.sovereign_yield_daily WHERE market_code='CN' AND source_code='chinabond'"); const first=seen.rows[0].n===0; const cycleSeen=await pool.query("SELECT min(trade_date)::text AS valuation_min FROM market.index_valuation_history WHERE index_code='CSI300' AND source_code='tushare_index_dailybasic'"); const capSeen=await pool.query("SELECT min(trade_date)::text AS cap_min FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic'"); const cycleFirst=!cycleSeen.rows[0].valuation_min||cycleSeen.rows[0].valuation_min>'2005-01-01'||!capSeen.rows[0].cap_min||capSeen.rows[0].cap_min>'2010-01-31'; const start=first?'2006-03-01':dateStr(new Date(Date.now()-14*86400000)); const result={cnYield:await syncChinaYield(start,end),csi300Pe:await syncCsiIndexPe('CSI300','000300'),csiAllPe:await syncCsiIndexPe('CSIALL','000985'),hsiPe:await syncHsiPe(),hkYield:await syncHkYield(first),cycleMetrics:await syncMarketCycleMetrics(cycleFirst)}; await calculateGraham(); await finishJobRun(id,true,JSON.stringify(result)); } catch(e) { await finishJobRun(id,false,e.message||String(e)); } finally { await releaseJob('market_volatility_sync'); } }
function scheduleMarketVolatilitySync() { runMarketVolatilitySync().catch(e => console.error('股市波动首次同步失败:', e.message)); const now=new Date(), next=new Date(); next.setHours(18,45,0,0); if(next<=now) next.setDate(next.getDate()+1); const first=setTimeout(function(){ runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)); const timer=setInterval(()=>runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)),86400000); if(timer.unref) timer.unref(); }, next-now); if(first.unref) first.unref(); }
module.exports = { syncChinaYield, syncCsiIndexPe, syncHsiPe, syncHkYield, calculateGraham, parseHsiWorkbook,
  syncCsi300Valuation, syncMoneySupply, tradeMonthEnds, syncAShareMarketCap, calculateM2MarketCap,
  syncMarketCycleMetrics, runMarketVolatilitySync, scheduleMarketVolatilitySync };
