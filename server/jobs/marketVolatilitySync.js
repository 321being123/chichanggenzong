// 官网数据同步：中债 10 年期、恒指历史 PE、香港金管局 10 年期。
// 不用第三方替代中证全指 PE；该数据源未拿到精确 000985 指数值时保持缺失。
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');

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
      VALUES('HK','HSI',$1,$2,'hsi_official',$1,$3) ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [day, pe, JSON.stringify(r)]); count++; }
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
async function runMarketVolatilitySync() { if (!(await tryClaimJob('market_volatility_sync'))) return; const id=await startJobRun('market_volatility_sync'); try { const end=dateStr(new Date()); const seen=await pool.query("SELECT count(*)::int AS n FROM market.sovereign_yield_daily WHERE market_code='CN' AND source_code='chinabond'"); const first=seen.rows[0].n===0; const start=first?'2006-03-01':dateStr(new Date(Date.now()-14*86400000)); const result={cnYield:await syncChinaYield(start,end),csi300Pe:await syncCsiIndexPe('CSI300','000300'),csiAllPe:await syncCsiIndexPe('CSIALL','000985'),hsiPe:await syncHsiPe(),hkYield:await syncHkYield(first)}; await calculateGraham(); await finishJobRun(id,true,JSON.stringify(result)); } catch(e) { await finishJobRun(id,false,e.message||String(e)); } finally { await releaseJob('market_volatility_sync'); } }
function scheduleMarketVolatilitySync() { runMarketVolatilitySync().catch(e => console.error('股市波动首次同步失败:', e.message)); const now=new Date(), next=new Date(); next.setHours(18,45,0,0); if(next<=now) next.setDate(next.getDate()+1); const first=setTimeout(function(){ runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)); const timer=setInterval(()=>runMarketVolatilitySync().catch(e=>console.error('股市波动同步失败:',e.message)),86400000); if(timer.unref) timer.unref(); }, next-now); if(first.unref) first.unref(); }
module.exports = { syncChinaYield, syncCsiIndexPe, syncHsiPe, syncHkYield, calculateGraham, parseHsiWorkbook, runMarketVolatilitySync, scheduleMarketVolatilitySync };
