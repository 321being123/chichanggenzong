// P1-7 回归：上传图片校验（魔数）与 AI 模型白名单
// 目标：伪造 MIME 的非图片被拒；超大图被拒；客户端无法指定名单外的高成本模型。
const assert = require('assert');
const router = require('../routes/import');

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

// 构造一段合法图片 data URI：给定魔数字节 + 伪造扩展名
function imgURI(magic, fakeExt) {
  const b = Buffer.concat([Buffer.from(magic), Buffer.from('payload')]);
  return 'data:image/' + fakeExt + ';base64,' + b.toString('base64');
}

async function main() {
  console.log('上传与内存控制（P1-7）:');

  await check('合法 PNG 魔数通过', () => {
    assert.strictEqual(router.validateImage(imgURI([0x89, 0x50, 0x4e, 0x47], 'png')), null);
  });
  await check('合法 JPEG 魔数通过', () => {
    assert.strictEqual(router.validateImage(imgURI([0xff, 0xd8, 0xff], 'jpeg')), null);
  });
  await check('合法 GIF 魔数通过', () => {
    assert.strictEqual(router.validateImage(imgURI([0x47, 0x49, 0x46], 'gif')), null);
  });
  await check('伪造 MIME 的非图片（PHP 内容）被拒', () => {
    const php = Buffer.from('<?php echo "hack"; ?>');
    const uri = 'data:image/png;base64,' + php.toString('base64');
    assert.strictEqual(router.validateImage(uri), '不支持的图片格式');
  });
  await check('非图片 MIME 被拒', () => {
    const uri = 'data:text/html;base64,' + Buffer.from('<script>x</script>').toString('base64');
    assert.strictEqual(router.validateImage(uri), '仅支持图片文件');
  });
  await check('空图片被拒', () => {
    assert.strictEqual(router.validateImage(''), '缺少图片');
  });
  await check('超过 10MB 被拒', () => {
    const big = 'data:image/png;base64,' + Buffer.alloc(10 * 1024 * 1024 + 100).toString('base64');
    assert.ok(router.validateImage(big), '超大额图片应被拒绝');
  });

  await check('白名单内模型放行', () => {
    assert.strictEqual(router.pickVisionModel('agnes-2.0-flash'), 'agnes-2.0-flash');
  });
  await check('名单外高成本模型回落默认', () => {
    assert.strictEqual(router.pickVisionModel('gpt-4o-omni-ultra-expensive'), process.env.VISION_MODEL || 'agnes-2.0-flash');
  });
  await check('空模型回落默认', () => {
    assert.strictEqual(router.pickVisionModel(''), process.env.VISION_MODEL || 'agnes-2.0-flash');
  });

  await check('AI 503 自动重试后成功', async () => {
    let calls = 0;
    const response = await router.fetchAiWithRetry('https://example.com', {}, async () => {
      calls++;
      return { status: calls < 3 ? 503 : 200, ok: calls === 3 };
    }, [0, 0]);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(calls, 3);
  });

  await check('AI 非临时错误不重试', async () => {
    let calls = 0;
    const response = await router.fetchAiWithRetry('https://example.com', {}, async () => {
      calls++;
      return { status: 400, ok: false };
    }, [0, 0]);
    assert.strictEqual(response.status, 400);
    assert.strictEqual(calls, 1);
  });

  // ===== Excel 结构化直解析（表头清晰不走大模型）=====
  await check('持仓历史表直解析为 position', () => {
    const items = router.buildStructuredItems([
      ['交易日期', '证券代码', '证券名称', '股票余额', '成本价'],
      ['2026-01-05', '600519', '贵州茅台', '100', '1800.50']
    ]);
    assert.ok(items && items.length === 1);
    assert.strictEqual(items[0].kind, 'position');
    assert.strictEqual(items[0].code, '600519');
    assert.strictEqual(items[0].price, 1800.5);
    assert.strictEqual(items[0].quantity, 100);
  });
  await check('成交明细表（有买卖标志）直解析为 trade 且方向/日期/金额正确', () => {
    const items = router.buildStructuredItems([
      ['成交日期', '证券代码', '证券名称', '买卖标志', '成交价格', '成交数量', '发生金额'],
      ['2026-07-09', '000001', '平安银行', '买入', '12.34', '100', '1234.00'],
      ['2026-07-10', '600519', '贵州茅台', '卖出', '1850.00', '50', '92500.00']
    ]);
    assert.ok(items && items.length === 2);
    assert.strictEqual(items[0].kind, 'trade');
    assert.strictEqual(items[0].direction, 'buy');
    assert.strictEqual(items[0].date, '2026-07-09');
    assert.strictEqual(items[0].amount, 1234);
    assert.strictEqual(items[1].direction, 'sell');
  });
  await check('带括号注释表头也能命中（持仓数量(股)）', () => {
    const items = router.buildStructuredItems([
      ['证券代码', '证券名称', '持仓数量(股)', '买入均价(元)'],
      ['300750', '宁德时代', '200', '210.35']
    ]);
    assert.ok(items && items.length === 1 && items[0].kind === 'position');
  });
  await check('千分位数字正确转换', () => {
    const items = router.buildStructuredItems([
      ['代码', '名称', '价格', '数量'],
      ['601318', '中国平安', '45,600.50', '1,000']
    ]);
    assert.ok(items && items[0].price === 45600.5 && items[0].quantity === 1000);
  });
  await check('港股代码 5 位补零', () => {
    const items = router.buildStructuredItems([
      ['代码', '名称', '价格', '数量'],
      ['700', '腾讯控股', '380.20', '100'],
      ['9988', '阿里巴巴', '95.50', '200']
    ]);
    assert.ok(items && items[0].code === '00700' && items[1].code === '09988');
  });
  await check('复杂对账单（无核心列）返回 null 走大模型', () => {
    const items = router.buildStructuredItems([
      ['序号', '资金账号', '摘要', '发生额', '结余'],
      ['1', 'A12345', '买入手续费', '-5.00', '995.00']
    ]);
    assert.strictEqual(items, null);
  });
  await check('无数据行返回 null', () => {
    assert.strictEqual(router.buildStructuredItems([['代码', '名称']]), null);
  });

  console.log('\n通过 ' + passed + ' 项');
}

main()
  .then(() => { if (process.exitCode) { console.error('存在失败用例'); process.exit(1); } process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
