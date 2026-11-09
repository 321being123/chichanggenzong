// 2026-11-10 线上反馈静态/行为回归：
//   #27 股票筛选里 01114.HK 只显示英文名 BRILLIANCE CHI，应显示中文名
//   #28 持仓对比「我的」与「标杆」两组列没有颜色区分
//   #29 打新详情上下游产业链把同一串产品名重复输出十几次
//   #30 安全性列表到期感叹号颜色与风险评级不对应、区分度低
//   #31 文章编辑工具栏不吸顶；中文紧贴 ** 时星号不识别成粗体
// 只做源码断言与纯函数行为验证，不启动浏览器、不连数据库（低性能模式）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

// ---------- #27 港股中文名 ----------
check('#27 选股候选与组合都复用既有腾讯行情中文名', () => {
  const repo = read('server/repositories/stockSelectionRepository.js');
  assert.ok(/const HK_NAME_FALLBACK = `[\s\S]*?market_quote_cache q/.test(repo), '候选/组合查询要有统一的中文名回退片段');
  assert.ok(/q\.source = 'tencent'/.test(repo), '只读取已落库的腾讯行情缓存，不在页面请求里回源');
  assert.ok((repo.match(/CASE WHEN c\.name ~ '\[一-龥\]' THEN c\.name/g) || []).length === 2,
    '候选列表与正式组合两个出口都要按「已有中文名优先」回退');
  assert.ok(/COALESCE\(NULLIF\(q\.name, ''\), c\.name\)/.test(repo), '缓存没有中文名时必须保留原名称');
  assert.ok(/c\.code LIKE '%\.HK'/.test(repo), '回退只作用于港股，不改 A 股名称');
});

// ---------- #28 持仓对比两组列配色 ----------
check('#28 三张对比表的表头与数据行都标记了列归属', () => {
  const js = read('public/js/position-comparison.js');
  assert.ok((js.match(/<th class="pc-col-mine">/g) || []).length >= 3, '三张表的「我的」表头都要带分组类');
  assert.ok((js.match(/<th class="pc-col-bench">/g) || []).length >= 3, '三张表的「标杆」表头都要带分组类');
  assert.ok((js.match(/<td class="pc-col-mine">/g) || []).length >= 3, '证券表「我的」数据列要带分组类');
  assert.ok((js.match(/<td class="pc-col-bench">/g) || []).length >= 3, '证券表「标杆」数据列要带分组类');
  assert.ok(/class="pc-col-bench">标杆数量/.test(js), '半公开隐藏两列时类名仍与表头一致');
});

check('#28 分色规则沉淀在共享样式并覆盖手机吸顶表头', () => {
  const css = read('public/shared/style.css');
  assert.ok(/\.pc-table th\.pc-col-mine/.test(css) && /\.pc-table td\.pc-col-mine/.test(css), '「我的」表头与单元格都要着色');
  assert.ok(/\.pc-table th\.pc-col-bench/.test(css) && /\.pc-table td\.pc-col-bench/.test(css), '「标杆」表头与单元格都要着色');
  assert.ok(/\.biz-table-floating-head \.biz-table th\.pc-col-mine/.test(css)
    && /\.biz-table-floating-head \.biz-table th\.pc-col-bench/.test(css),
    '浮动表头克隆时丢掉 pc-table 类，必须单独覆盖，否则手机横滑时配色丢失');
  assert.ok(!read('public/js/position-comparison.js').includes('#dcebff'), '颜色只能在共享样式里定义，JS 不写死色值');
});

// ---------- #29 产业链去重 ----------
function chainRenderer() {
  const src = read('server/routes/ipo.js');
  const body = src.slice(src.indexOf('function cnStockIndustryChain'), src.indexOf('async function buildCnStockLiveReport'));
  assert.ok(body.includes('function cnStockIndustryChain'), '缺少产业链渲染函数');
  return new Function(body + '; return cnStockIndustryChain;')();
}

check('#29 下游不再逐条重复贴全量产品名', () => {
  const src = read('server/routes/ipo.js');
  assert.ok(!/Array\.isArray\(item\.products\) && item\.products\.length/.test(src),
    '旧写法把每条 downstream 的全量产品名拼进「产品→应用」');
  const render = chainRenderer();
  const products = ['钻铣加工中心', '立式加工中心', '精雕加工中心'];
  const exposure = { industry_chain: {
    products,
    upstream: [
      { industry: '传动部件', product: '公司产品', products },
      { industry: '结构部件', product: '公司产品', products },
      { industry: '传动部件', product: '公司产品', products },
    ],
    downstream: ['精密铣床', '五轴联动机床', '三维五轴激光', '精密铣床']
      .map((x, i) => ({ industry: x, products, related_tracks: i === 0 ? ['消费电子'] : [] })),
    evidence: { url: 'https://example.com/a.pdf' },
  } };
  const result = render(exposure);
  assert.ok(result, '有上下游数据时仍要返回产业链摘要');
  assert.strictEqual((result.summary.match(/钻铣加工中心/g) || []).length, 1, '产品名在整行摘要里只应完整出现一次');
  assert.ok(result.summary.includes('精密铣床；五轴联动机床；三维五轴激光'), '下游应用按名称去重后逐项列出');
  assert.ok(!result.summary.includes('精密铣床；五轴联动机床；三维五轴激光；精密铣床'), '重复的下游应用不能再次出现');
  assert.ok(result.summary.includes('传动部件、结构部件→公司产品'), '上游行业跨条目去重');
  assert.deepStrictEqual(result.relatedTracks, ['消费电子'], '关联赛道仍单独输出且去重');
  assert.ok(/上下游产业链（招股书披露）/.test(src), '详情页字段名保持不变');
});

// ---------- #30 感叹号配色 ----------
check('#30 到期感叹号复用风险评级配色，强赎红不变', () => {
  const css = read('public/css/bond-safety.css');
  const high = css.match(/\.bond-rating-high \{[^}]*\}/);
  const medium = css.match(/\.bond-rating-medium \{[^}]*\}/);
  const six = css.match(/\.bond-lifecycle-mark-expiry-6m \{[^}]*\}/);
  const year = css.match(/\.bond-lifecycle-mark-expiry-1y \{[^}]*\}/);
  assert.ok(high && medium && six && year, '四个类都必须存在');
  assert.strictEqual(six[0].match(/color:\s*(#[0-9a-fA-F]{6})/)[1], high[0].match(/background:\s*(#[0-9a-fA-F]{6})/)[1],
    '半年提醒必须与「高风险」同色');
  assert.strictEqual(year[0].match(/color:\s*(#[0-9a-fA-F]{6})/)[1], medium[0].match(/background:\s*(#[0-9a-fA-F]{6})/)[1],
    '一年提醒必须与「中风险」同色');
  assert.ok(/\.bond-lifecycle-mark-call,\.bond-lifecycle-mark-maturity \{ color:#d93025; \}/.test(css), '强赎与临近退市保持红色');
});

// ---------- #31 编辑器工具栏与粗体 ----------
check('#31 编辑工具栏吸顶且避开一级导航', () => {
  const css = read('public/css/knowledge.css');
  const rule = css.match(/\.ks-editor-card \.vditor-toolbar \{[^}]*\}/);
  assert.ok(rule, '缺少工具栏规则');
  assert.ok(/position:\s*sticky/.test(rule[0]), '工具栏必须吸顶，不能是 relative');
  assert.ok(/top:\s*var\(--site-nav-height\)/.test(rule[0]), 'top 必须用变量，桌面 52px、手机含安全区');
  assert.ok(!/position:\s*relative/.test(rule[0]), 'relative 会让工具栏随页面滚走');
});

check('#31 中文紧贴星号能渲染成粗体，正常写法与幂等性不变', () => {
  global.window = global;
  require(path.join(ROOT, 'public', 'shared', 'md-safe.js'));
  const normalize = global.normalizeInlineEmphasis;
  const marked = require(path.join(ROOT, 'public', 'vendor', 'marked.min.js'));
  assert.strictEqual(typeof normalize, 'function', 'md-safe 要导出共用的强调归一化函数');

  const tight = '**没有对手方，就没有提价博弈。**ST新潮文里';
  const normalized = normalize(tight);
  assert.ok(/<strong>没有对手方，就没有提价博弈。<\/strong>/.test(String(marked.parse(normalized))),
    '闭合星号后紧跟字母/中文时必须渲染成粗体');
  assert.strictEqual(normalize(normalized), normalized, '归一化必须幂等，不能每次渲染多加空格');

  for (const plain of ['就是**均价和收盘价的差**，不是溢价。', '**1、不动产投资信托**', '普通文本']) {
    assert.strictEqual(normalize(plain), plain, '正常写法不能被改动：' + plain);
  }
  const js = read('public/js/knowledge.js');
  const setValueCalls = js.match(/editor\.setValue\([^\n]*\);/g) || [];
  assert.ok(setValueCalls.length >= 2 && setValueCalls.every(call => call.includes('normalizeInlineEmphasis')),
    '打开已有文章与导入文章两条 setValue 链路都要归一化，编辑器里才不会出现字面星号');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;
