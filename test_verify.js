// 今日改动验证脚本
// 运行: node test_verify.js

const http = require('http');

const BASE = 'http://127.0.0.1:3000';
const PASS = '***REMOVED***';

let sessionCookie = '';
let passed = 0, failed = 0;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opt = { hostname: '127.0.0.1', port: 3000, path, method, headers: {} };
    if (sessionCookie) opt.headers['Cookie'] = sessionCookie;
    if (body) { opt.headers['Content-Type'] = 'application/json'; }
    const r = http.request(opt, res => {
      let data = '';
      const sc = res.headers['set-cookie'];
      if (sc) sessionCookie = sc[0].split(';')[0];
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function check(label, ok, detail) {
  if (ok) { passed++; console.log('  PASS: ' + label); }
  else { failed++; console.log('  FAIL: ' + label + (detail ? ' - ' + detail : '')); }
}

(async () => {
  console.log('=== 1. 登录测试 ===');
  let r = await req('POST', '/api/login', { username: 'being', password: PASS });
  check('being 登录', r && r.ok, JSON.stringify(r));
  
  r = await req('POST', '/api/login', { username: 'daicunzai', password: PASS });
  check('daicunzai 登录', r && r.ok, JSON.stringify(r));

  console.log('\n=== 2. 报价API测试（价格因子规则） ===');
  const quoteTests = [
    { code: '160723', name: '嘉实原油LOF', min: 1.5, max: 2.5, desc: 'LOF基金/1000因子' },
    { code: '000001', name: '平安银行',     min: 5,   max: 20,  desc: 'A股股票/100因子' },
    { code: '600519', name: '贵州茅台',     min: 800, max: 2000,desc: '沪市A股/100因子' },
    { code: '300750', name: '宁德时代',     min: 200, max: 600, desc: '创业板/100因子' },
    { code: '512880', name: '证券ETF',      min: 0.5, max: 5,   desc: '上海ETF/1000因子' },
    { code: '159915', name: '创业板ETF',    min: 2,   max: 8,   desc: '深圳ETF/1000因子' },
    { code: '180801', name: '首钢绿能REIT', min: 5,   max: 20,  desc: 'REITs/1000因子' },
  ];
  for (const t of quoteTests) {
    r = await req('GET', '/api/quote/' + t.code);
    const ok = r && r.price && r.price >= t.min && r.price <= t.max;
    check(t.name + '(' + t.code + ') ' + t.desc, ok, r ? 'price=' + r.price + ' change=' + r.change : 'null');
  }

  console.log('\n=== 3. 华泰账户数据验证 ===');
  r = await req('GET', '/api/data/' + encodeURIComponent('华泰账户'));
  if (r && r.positions) {
    check('华泰账户有 totalAsset', r.totalAsset > 0, 'totalAsset=' + r.totalAsset);
    check('华泰账户有 cash', r.cash > 0, 'cash=' + r.cash);
    
    const hkCodes = r.positions.filter(p => p.subtype === '港股').map(p => p.code);
    const all5Digit = hkCodes.every(c => c.length === 5);
    check('港股代码均为5位', all5Digit, '代码: ' + hkCodes.join(','));
    console.log('  港股数量: ' + hkCodes.length);
    
    const pos160723 = r.positions.find(p => p.code === '160723');
    if (pos160723) {
      check('嘉实原油价格正确', Math.abs(pos160723.price - 1.715) < 0.01, 'price=' + pos160723.price);
    }
  }

  console.log('\n=== 4. 招商证券账户数据验证 ===');
  r = await req('GET', '/api/data/' + encodeURIComponent('招商证券账户'));
  if (r && r.positions) {
    check('招商有 totalAsset', r.totalAsset > 0, 'totalAsset=' + r.totalAsset);
    check('招商有 cash', r.cash > 0, 'cash=' + r.cash);
    
    const hkCodes = r.positions.filter(p => p.subtype === '港股').map(p => p.code);
    const all5Digit = hkCodes.every(c => c.length === 5);
    check('港股代码均为5位', all5Digit, '代码: ' + hkCodes.join(','));
    console.log('  港股数量: ' + hkCodes.length);
    console.log('  总持仓: ' + r.positions.length + ' 只');
  }

  console.log('\n=== 结果 ===');
  console.log('通过: ' + passed + ', 失败: ' + failed + ', 总数: ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
