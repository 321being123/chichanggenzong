// 官网/Tushare 数据同步：中债 10 年期、恒指历史 PE；港股基准利率使用美国十年期国债收益率替代。
// 不用第三方替代中证全指 PE；该数据源未拿到精确 000985 指数值时保持缺失。
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { tushareQuery, tsRows, normDate } = require('../services/market');
const { withExternalCallGuard, openExternalCircuit } = require('../services/externalCallGuard');

function request(url, binary, source = 'market-volatility', dataset = url) {
  return withExternalCallGuard(source, dataset, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'portfolio-server/1.0 (+official-data-sync)' }, timeout: 60000 }, r => {
    const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => {
      if (r.statusCode < 200 || r.statusCode >= 300) {
        const error = new Error('HTTP ' + r.statusCode);
        error.code = r.statusCode === 429 ? 'RATE_LIMIT' : r.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR';
        error.errorType = r.statusCode === 429 ? 'rate_limit' : r.statusCode >= 500 ? 'network' : 'upstream';
        error.source = source;
        return reject(error);
      }
      const b = Buffer.concat(chunks); resolve(binary ? b : JSON.parse(b.toString('utf8')));
    });
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  }));
}
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
    return withExternalCallGuard('chinabond', `yield:${from}:${to}`, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => { const req = https.request(u, { method: 'POST', headers: { 'User-Agent': 'portfolio-server/1.0', Referer: 'https://yield.chinabond.com.cn/cbweb-mn/pgxh/showHistory' } }, r => { let b=''; r.on('data', c => b += c); r.on('end', () => { try { if (r.statusCode === 429) { const e = new Error('中债接口 HTTP 429'); e.code='RATE_LIMIT'; e.errorType='rate_limit'; e.source='chinabond'; throw e; } if (r.statusCode >= 500) { const e = new Error('中债接口 HTTP ' + r.statusCode); e.code='UPSTREAM_5XX'; e.errorType='network'; e.source='chinabond'; throw e; } const data=JSON.parse(b); if (!Array.isArray(data)) throw new Error('中债返回格式错误'); resolve(data); } catch(e) { if (!e.code) { e = new Error('中债 ' + from + ' 至 ' + to + ' 查询失败：' + e.message); } reject(e); } }); }); req.on('error', reject); req.end(); }));
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
  // 水位：本地该基准最新日期往前 45 天重叠窗口（首次空表则全量）
  const wm = await pool.query(`SELECT max(trade_date)::text AS mx FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code=$1 AND source_code='csindex'`, [benchmark]);
  const maxDate = wm.rows[0].mx;
  const since = maxDate ? dateStr(new Date(new Date(maxDate).getTime() - 45 * 86400000)) : '2005-01-01';
  // 中证 PE 专用接口只能返回全部历史，下载后在内存过滤只保留重叠窗口
  const data = await request('https://www.csindex.com.cn/csindex-home/perf/indexCsiDsPe?indexCode=' + indexCode, false, 'csindex', `pe:${benchmark}:${indexCode}`);
  const rows = data && data.success && Array.isArray(data.data) ? data.data : [];
  const kept = [];
  for (const r of rows) {
    // 中证该 PE 专用接口字段名为 peg，但端点与页面均为 indexCsiDsPe；按官方原始字段保留，映射入本系统统一 pe 口径。
    const pe = Number(r.peg); const date = String(r.tradeDate || '');
    if (!/^\d{8}$/.test(date) || !(pe > 0)) continue;
    const day = date.slice(0,4) + '-' + date.slice(4,6) + '-' + date.slice(6,8);
    if (day < since) continue;
    kept.push({ day, pe, raw: r });
  }
  let written = 0;
  if (kept.length) {
    const values = [], params = []; let p = 1;
    for (const k of kept) {
      values.push(`($${p},$${p+1},$${p+2},$${p+3},'csindex',$${p+2},$${p+4})`);
      params.push('CN', benchmark, k.day, k.pe, JSON.stringify(k.raw));
      p += 5;
    }
    await pool.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      VALUES ${values.join(',')} ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
    written = kept.length;
  }
  console.log(`[市场周期] 中证PE(${benchmark}) 接口返回=${rows.length}条, 重叠窗口(${since}起)保留=${kept.length}条, 写入=${written}条`);
  return written;
}
async function syncHsiPe() {
  const b = await request('https://www.hsi.com.hk/static/uploads/contents/en/dl_centre/monthly/pe/hsi.xls', true, 'hsi-official', 'monthly-pe');
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
const US_TREASURY_YIELD_SOURCE = 'tushare_us_tycr';

async function syncUsTreasuryYield(end = dateStr(new Date())) {
  const wm = await pool.query(`SELECT max(trade_date)::text AS mx
    FROM market.sovereign_yield_daily
    WHERE market_code='US' AND tenor_years=10 AND source_code=$1`, [US_TREASURY_YIELD_SOURCE]);
  const maxDate = wm.rows[0] && wm.rows[0].mx;
  const start = maxDate
    ? dateStr(new Date(new Date(maxDate + 'T00:00:00Z').getTime() - 14 * 86400000))
    : '2012-01-01';
  if (!(process.env.TUSHARE_TOKEN || process.env.TUSHARE_BACKUP_TOKEN)) return 0;

  let cursor = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  let count = 0;
  while (cursor <= last) {
    const rangeEnd = new Date(Date.UTC(cursor.getUTCFullYear() + 5, cursor.getUTCMonth(), cursor.getUTCDate() - 1));
    const to = rangeEnd < last ? rangeEnd : last;
    const fromTs = tsDate(dateStr(cursor));
    const toTs = tsDate(dateStr(to));
    const data = await tushareQuery('us_tycr', { start_date: fromTs, end_date: toTs }, 'date,y10');
    if (!data) throw new Error(`Tushare us_tycr 查询失败（${fromTs}-${toTs}）`);
    const rows = tsRows(data).map(row => ({
      day: normDate(row.date),
      yieldPct: Number(row.y10),
      raw: row,
    })).filter(row => row.day && Number.isFinite(row.yieldPct));
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const values = [], params = [];
      let p = 1;
      for (const row of batch) {
        values.push(`('US',10,$${p},$${p + 1},'${US_TREASURY_YIELD_SOURCE}',$${p},$${p + 2})`);
        params.push(row.day, row.yieldPct, JSON.stringify(row.raw));
        p += 3;
      }
      if (!values.length) continue;
      await pool.query(`INSERT INTO market.sovereign_yield_daily
        (market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
        VALUES ${values.join(',')}
        ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET
          yield_pct=EXCLUDED.yield_pct,source_date=EXCLUDED.source_date,
          raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
      count += batch.length;
    }
    cursor = new Date(to.getTime() + 86400000);
  }
  console.log(`[市场周期] 美国十年期国债收益率(Tushare us_tycr) 写入=${count}条`);
  return count;
}
async function calculateGraham(pg = pool, recalcFrom = null) {
  // 水位：上次计算最大日期往前 45 天重叠窗口；仅重算本轮变化的日期
  const wm = await pg.query(`SELECT max(trade_date)::text AS mx FROM analytics.graham_index_daily`);
  const maxDate = wm.rows[0].mx;
  const since = recalcFrom || (maxDate ? dateStr(new Date(new Date(maxDate).getTime() - 45 * 86400000)) : '2005-01-01');
  const { rows } = await pg.query(`SELECT v.market_code,v.benchmark_code,v.trade_date,v.pe,
    (SELECT y.yield_pct FROM market.sovereign_yield_daily y WHERE y.market_code=CASE WHEN v.market_code='HK' THEN 'US' ELSE v.market_code END AND y.tenor_years=10 AND (v.market_code<>'HK' OR y.source_code='tushare_us_tycr') AND y.trade_date<=v.trade_date AND y.trade_date>=v.trade_date-CASE WHEN v.market_code='HK' THEN 10 ELSE 5 END ORDER BY y.trade_date DESC LIMIT 1) AS yield_pct,
    (SELECT y.trade_date FROM market.sovereign_yield_daily y WHERE y.market_code=CASE WHEN v.market_code='HK' THEN 'US' ELSE v.market_code END AND y.tenor_years=10 AND (v.market_code<>'HK' OR y.source_code='tushare_us_tycr') AND y.trade_date<=v.trade_date AND y.trade_date>=v.trade_date-CASE WHEN v.market_code='HK' THEN 10 ELSE 5 END ORDER BY y.trade_date DESC LIMIT 1) AS yield_date
    FROM (SELECT DISTINCT ON (market_code,benchmark_code,trade_date) market_code,benchmark_code,trade_date,pe
      FROM market.market_valuation_daily WHERE pe>0
      ORDER BY market_code,benchmark_code,trade_date,CASE WHEN source_code='hsi_weighted_manual' THEN 0 WHEN source_code='hsi_official' THEN 1 ELSE 2 END) v
    WHERE v.trade_date >= $1`, [since]);
  if (!rows.length) return 0;
  const rowsToInsert = [];
  for (const r of rows) {
    const earnings = 100 / Number(r.pe), y = Number(r.yield_pct);
    if (!(y > 0)) continue;
    const status = String(r.yield_date) === String(r.trade_date) ? 'normal' : 'carried_forward';
    rowsToInsert.push({
      market_code: r.market_code, benchmark_code: r.benchmark_code, trade_date: r.trade_date,
      pe: r.pe, earnings, y, yield_date: r.yield_date, graham: earnings - y, status,
    });
  }
  if (!rowsToInsert.length) return 0;
  // 分批写入：每批内部占位符从 $1 重新编号，避免首次全量超过 PostgreSQL 参数上限（每批 1000 行）
  const BATCH = 1000;
  for (let i = 0; i < rowsToInsert.length; i += BATCH) {
    const chunk = rowsToInsert.slice(i, i + BATCH);
    const values = [], params = []; let p = 1;
    for (const row of chunk) {
      values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8})`);
      params.push(row.market_code, row.benchmark_code, row.trade_date, row.pe, row.earnings, row.y, row.yield_date, row.graham, row.status);
      p += 9;
    }
    await pg.query(`INSERT INTO analytics.graham_index_daily(market_code,benchmark_code,trade_date,pe,earnings_yield_pct,sovereign_yield_pct,sovereign_yield_date,graham_index_pct,data_status)
      VALUES ${values.join(',')}
      ON CONFLICT(market_code,benchmark_code,trade_date,formula_version) DO UPDATE SET
        pe=EXCLUDED.pe,earnings_yield_pct=EXCLUDED.earnings_yield_pct,sovereign_yield_pct=EXCLUDED.sovereign_yield_pct,
        sovereign_yield_date=EXCLUDED.sovereign_yield_date,graham_index_pct=EXCLUDED.graham_index_pct,data_status=EXCLUDED.data_status,calculated_at=now()`, params);
  }
  console.log(`[市场周期] 格雷厄姆指数 重算窗口(${since}起)=${rows.length}条, 有效写入=${rowsToInsert.length}条`);
  return rowsToInsert.length;
}

function tsDate(value) { return String(value || '').replace(/-/g, ''); }
function monthDate(value) {
  const month = String(value || '');
  return /^\d{6}$/.test(month) ? month.slice(0, 4) + '-' + month.slice(4, 6) + '-01' : null;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function syncCsi300Valuation(full) {
  // 水位：本地 CSI300 估值最新日期；空表才全量，否则只拉最近 45 天重叠窗口
  const wm = await pool.query(`SELECT max(trade_date)::text AS mx FROM market.index_valuation_history WHERE index_code='CSI300' AND source_code='tushare_index_dailybasic'`);
  const maxDate = wm.rows[0].mx;
  // 沪深300估值是否全量，只看它自己表是否为空；不再受“A股总市值表为空”牵连，避免总市值丢失时误触发估值全量重拉
  const needFull = !maxDate;
  const end = tsDate(dateStr(new Date()));
  const ranges = needFull
    ? [['20040101', '20151231'], ['20160101', end]]
    : [[tsDate(dateStr(new Date(Date.now() - 45 * 86400000))), end]];
  let count = 0;
  for (const [startDate, endDate] of ranges) {
    const data = await tushareQuery('index_dailybasic', { ts_code: '000300.SH', start_date: startDate, end_date: endDate },
      'ts_code,trade_date,total_mv,pe_ttm,pb');
    if (!data) continue;
    const kept = tsRows(data).filter(row => {
      const day = normDate(row.trade_date), pe = Number(row.pe_ttm), pb = Number(row.pb);
      return day && ((pe > 0) || (pb > 0));
    });
    if (!kept.length) continue;
    const values = [], params = []; let p = 1;
    for (const row of kept) {
      const day = normDate(row.trade_date), pe = Number(row.pe_ttm), pb = Number(row.pb);
      values.push(`('CSI300','market_cap_weighted',$${p},$${p+1},$${p+2},$${p+3},'tushare_index_dailybasic',$${p+4})`);
      params.push(day, Number(row.total_mv) || null, pe > 0 ? pe : null, pb > 0 ? pb : null, JSON.stringify(row));
      p += 5;
    }
    await pool.query(`INSERT INTO market.index_valuation_history
      (index_code,valuation_method,trade_date,market_cap,pe_ttm,pb,source_code,raw_payload)
      VALUES ${values.join(',')}
      ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET
        market_cap=EXCLUDED.market_cap,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,
        raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
    count += kept.length;
  }
  console.log(`[市场周期] 沪深300估值 ${needFull ? '全量' : '增量(45天)'} 写入=${count}条`);
  return count;
}

async function syncMoneySupply() {
  const data = await tushareQuery('cn_m', {}, 'month,m2,m2_yoy');
  if (!data) return 0;
  // 水位：本地最新月份；只保留最近 24 个月重叠窗口（首次空表则全量）
  const wm = await pool.query(`SELECT max(month)::text AS mx FROM market.money_supply_monthly WHERE market_code='CN'`);
  const maxMonth = wm.rows[0].mx;
  const since = maxMonth ? (new Date(maxMonth).getUTCFullYear() - 2) + '-' + String(new Date(maxMonth).getUTCMonth() + 1).padStart(2, '0') + '-01' : '1990-01-01';
  const kept = [];
  for (const row of tsRows(data)) {
    const month = monthDate(row.month), m2 = Number(row.m2);
    if (!month || !(m2 > 0)) continue;
    if (maxMonth && month < since) continue;
    kept.push({ month, m2, row });
  }
  let written = 0;
  if (kept.length) {
    const values = [], params = []; let p = 1;
    for (const k of kept) {
      values.push(`('CN',$${p},$${p+1},'nbs_via_tushare',$${p+2})`);
      params.push(k.month, k.m2, JSON.stringify({
        ...k.row,
        source: 'https://data.stats.gov.cn/',
        fiscalReference: 'https://gks.mof.gov.cn/tongjishuju/',
        transport: 'tushare.cn_m',
        unit: '100m CNY',
        m1DefinitionVersion: String(k.row.month) >= '202501' ? '2025_revised' : 'pre_2025',
      }));
      p += 3;
    }
    await pool.query(`INSERT INTO market.money_supply_monthly
      (market_code,month,m2_100m_yuan,source_code,raw_payload)
      VALUES ${values.join(',')}
      ON CONFLICT(market_code,month,source_code) DO UPDATE SET
        m2_100m_yuan=EXCLUDED.m2_100m_yuan,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
    written = kept.length;
  }
  console.log(`[市场周期] 货币供应量 接口返回=${tsRows(data).length}条, 重叠窗口(近24月)保留=${kept.length}条, 写入=${written}条`);
  return written;
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
  if (!(process.env.TUSHARE_TOKEN || process.env.TUSHARE_BACKUP_TOKEN)) return { skipped: 'TUSHARE_TOKEN/TUSHARE_BACKUP_TOKEN missing' };
  const result = {
    csi300Valuation: await syncCsi300Valuation(full),
    moneySupply: await syncMoneySupply(),
    aShareMarketCap: await syncAShareMarketCap(full),
  };
  result.m2MarketCap = await calculateM2MarketCap();
  return result;
}

async function runMarketVolatilitySync(context = {}) {
  if (!(await tryClaimJob('market_volatility_sync'))) return { skipped: true, reason: 'locked' };
  const id = await startJobRun('market_volatility_sync');
  const requested = new Set((context.failedDatasets || []).map(item => typeof item === 'string' ? item : item && item.code).filter(Boolean));
  const failedDatasets = [];
  const failures = [];
  const result = {};
  const shouldRun = code => !requested.size || requested.has(code);
  const runDataset = async (code, task) => {
    if (!shouldRun(code)) { result[code] = { status: 'succeeded', skipped: true }; return; }
    try { result[code] = await task(); }
    catch (error) {
      failedDatasets.push(code);
      failures.push({ code: error.code || 'JOB_FAILED', errorType: error.errorType || error.type || 'unknown', source: error.source || null, error: error.message });
      result[code] = { status: 'failed', error: error.message, errorCode: error.code, errorType: error.errorType, source: error.source };
    }
  };
  try {
    const end = dateStr(new Date());
    const seen = await pool.query("SELECT count(*)::int AS n FROM market.sovereign_yield_daily WHERE market_code='CN' AND source_code='chinabond'");
    const first = seen.rows[0].n === 0;
    const capSeen = await pool.query("SELECT count(*)::int AS n FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic'");
    const cycleFirst = capSeen.rows[0].n === 0;
    const start = first ? '2006-03-01' : dateStr(new Date(Date.now() - 14 * 86400000));
    await runDataset('cn_yield', () => syncChinaYield(start, end));
    await runDataset('csi300_pe', () => syncCsiIndexPe('CSI300', '000300'));
    await runDataset('csi_all_pe', () => syncCsiIndexPe('CSIALL', '000985'));
    await runDataset('hsi_pe', () => syncHsiPe());
    await runDataset('us_treasury_yield', () => syncUsTreasuryYield(end));
    await runDataset('cycle_metrics', () => syncMarketCycleMetrics(cycleFirst));
    if (!failedDatasets.length) await calculateGraham();
    const ok = failedDatasets.length === 0;
    await finishJobRun(id, ok, JSON.stringify({ result, failedDatasets }));
    console.log('[市场周期] 本次同步汇总:', JSON.stringify({ result, failedDatasets }));
    const firstFailure = failures[0] || null;
    return {
      ok,
      status: ok ? 'succeeded' : 'partial',
      failedDatasets,
      datasets: Object.keys(result).map(code => ({ code, status: failedDatasets.includes(code) ? 'failed' : 'succeeded' })),
      ...(failedDatasets.length && firstFailure ? { error: firstFailure.error, errorCode: firstFailure.code, errorType: firstFailure.errorType, source: firstFailure.source } : {}),
    };
  } catch (error) {
    await finishJobRun(id, false, error.message || String(error));
    return { ok: false, error: error.message || String(error), failedDatasets: ['cycle_metrics'] };
  } finally { await releaseJob('market_volatility_sync'); }
}
function scheduleMarketVolatilitySync() { runMarketVolatilitySync().catch(e => console.error('股市波动首次同步失败:', e.message)); const now=new Date(), next=new Date(); next.setHours(18,45,0,0); if(next<=now) next.setDate(next.getDate()+1); const first=setTimeout(function(){ runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)); const timer=setInterval(()=>runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)),86400000); if(timer.unref) timer.unref(); }, next-now); if(first.unref) first.unref(); }
module.exports = { syncChinaYield, syncCsiIndexPe, syncHsiPe, syncUsTreasuryYield, calculateGraham, parseHsiWorkbook,
  syncCsi300Valuation, syncMoneySupply, tradeMonthEnds, syncAShareMarketCap, calculateM2MarketCap,
  syncMarketCycleMetrics, runMarketVolatilitySync, scheduleMarketVolatilitySync };
