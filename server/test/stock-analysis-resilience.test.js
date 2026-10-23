// ========== 股票分析页渲染健壮性与深链恢复 ==========
// 背景（2026-10-23 用户报障）：股票分析页出现"只剩区块标题、内容全空"。
// 复现确认两条独立缺陷：
//   ①单个区块渲染抛错会中断后续全部区块（顺序调用、异常冒泡到上层 catch，控制台无记录）；
//   ②带 code 的股票深链（?main=stock-analysis&code=xxx）只激活栏目、从不触发取数，整页空。
// 本测试锁定这两处不变量，纯静态检查，不连库。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('--- 股票分析渲染健壮性与深链恢复 ---');

const stockJs = fs.readFileSync(path.join(root, 'public', 'js', 'stock-analysis.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// 截取 stockAnalysisRender 函数体（从定义到下一个顶层 function）
const renderBody = (function () {
  const start = stockJs.indexOf('function stockAnalysisRender(d) {');
  assert.ok(start >= 0, '应存在 stockAnalysisRender 函数');
  const rest = stockJs.slice(start + 10);
  const nextTop = rest.search(/\nfunction [a-zA-Z]/);
  return nextTop >= 0 ? rest.slice(0, nextTop) : rest;
})();

test('六个分析区块各自包裹异常隔离，不再顺序裸调用', () => {
  const sections = [
    ['stockAnalysisRenderStability', '盈利与分红稳定性'],
    ['stockAnalysisRenderPercentiles', '股价及估值分位'],
    ['stockAnalysisRenderGrowth', '盈利增长'],
    ['stockAnalysisRenderSafety', '财务安全性'],
    ['stockAnalysisRenderCashflow', '经营现金流与自由现金流'],
    ['stockAnalysisRenderEvents', '公司公告'],
  ];
  for (const [fn, label] of sections) {
    const guarded = new RegExp('runSection\\(\\s*[\'"]' + label + '[\'"]');
    assert.ok(guarded.test(renderBody), `${label} 必须通过 runSection 包裹`);
    // 裸调用（不在 runSection 内）会让异常冒泡中断后续区块
    const bare = new RegExp('(?:^|[;}]\\s*)' + fn + '\\(');
    const callSites = (renderBody.match(new RegExp(fn + '\\(', 'g')) || []).length;
    assert.ok(callSites >= 1, `${fn} 应被调用`);
    assert.ok(!/(?:^|\n)\s{0,2}stockAnalysisRender(?:Stability|Percentiles|Growth|Safety|Cashflow|Events)\(d\./.test(renderBody),
      '不得存在未包裹的裸调用（会复现"前面出错、后面全空"）');
    void bare;
  }
});

test('隔离失败时向控制台记录并给出可见占位，不静默留白', () => {
  assert.ok(/console\.error/.test(renderBody), '渲染失败必须记录到控制台，便于定位');
  assert.ok(/该区块数据暂时无法展示/.test(renderBody), '失败区块应显示占位说明，不得空白');
  assert.ok(/runSection\s*=\s*function|function runSection/.test(renderBody), '应存在统一的 runSection 隔离器');
});

test('股票深链（?main=stock-analysis&code=）会触发分析', () => {
  const guard = indexHtml.match(/if \(initialMain === 'stock-analysis'\) \{[\s\S]{0,400}?\n    \}/);
  assert.ok(guard, 'switchMain 后置逻辑应处理 stock-analysis 深链');
  assert.ok(/startParams\.get\('code'\)/.test(guard[0]), '应读取 URL 的 code');
  assert.ok(/securityAnalysisSubmit\(stockReqCode, 'stock'\)/.test(guard[0]), '应按股票类型触发 securityAnalysisSubmit');
  assert.ok(/securityAnalysisKind\(stockReqCode\) !== 'bond'/.test(guard[0]), '转债代码不应在此分支重复处理（已映射到 bond-safety）');
});

test('可转债深链恢复逻辑未被破坏', () => {
  assert.ok(/requestedSub === 'analysis'/.test(indexHtml), '可转债个券分析子页恢复应保留');
  assert.ok(/securityAnalysisSubmit\(reqCode, 'bond'\)/.test(indexHtml), '可转债深链仍按 bond 类型提交');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
