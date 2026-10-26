// 智能导入整改回归（方案《智能导入识别质量与批量录入整改方案_20261026》）：
// 识别输出完整性、数值/单位/币种/身份清洗、零与负成本口径、多图上传边界、TTL 与一次性消费。
const assert = require('assert');
const router = require('../routes/import');
const cleanse = require('../services/importCleanse');
const vision = require('../services/vision');
const { validateTrade } = require('../services/tradeLedger');

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

function imgURI(payloadLen) {
  const b = Buffer.alloc(payloadLen, 1);
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), b]).toString('base64');
}

async function main() {
  console.log('智能导入整改（识别质量与批量录入）:');

  // ===== 识别输出完整性（4.1 第 5 条）=====
  await check('完整JSON数组 → ok', () => {
    const r = router.parseModelItems('[{"kind":"trade","code":"000001"}]', 'stop');
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.items.length, 1);
  });
  await check('明确空数组 → empty（不是错误）', () => {
    assert.strictEqual(router.parseModelItems('[]', 'stop').status, 'empty');
  });
  await check('输出截断（finish_reason=length）→ truncated', () => {
    assert.strictEqual(router.parseModelItems('[{"kind":"trade","code"', 'length').status, 'truncated');
  });
  await check('非数组JSON输出 → 不当零条成功', () => {
    const r = router.parseModelItems('{"a":1}', 'stop');
    assert.ok(r.status === 'bad_shape' || r.status === 'bad_json', '实际: ' + r.status);
    assert.ok(!r.items);
  });
  await check('无JSON内容 → bad_json/empty_output', () => {
    assert.strictEqual(router.parseModelItems('识别失败', 'stop').status, 'bad_json');
    assert.strictEqual(router.parseModelItems('', 'stop').status, 'empty_output');
  });

  // ===== 数字清洗（4.2 第 1 条）=====
  await check('数字清洗：HK$/千分位/单位/负数', () => {
    assert.strictEqual(cleanse.parseLooseNumber('HK$4.155').value, 4.155);
    assert.strictEqual(cleanse.parseLooseNumber('1,234.56').value, 1234.56);
    assert.strictEqual(cleanse.parseLooseNumber('300股').value, 300);
    assert.strictEqual(cleanse.parseLooseNumber(-5).value, -5);
    assert.strictEqual(cleanse.parseLooseNumber(0).value, 0);
    assert.strictEqual(cleanse.parseLooseNumber('10.5').value, 10.5);
  });
  await check('数字清洗：空白/单独“-”/多段/NaN/Infinity 不得变 0', () => {
    assert.strictEqual(cleanse.parseLooseNumber('').value, null);
    assert.strictEqual(cleanse.parseLooseNumber('-').value, null);
    assert.strictEqual(cleanse.parseLooseNumber('12.3 45.6').value, null);
    assert.strictEqual(cleanse.parseLooseNumber('12.3 45.6').reason, 'multi_segment');
    assert.strictEqual(cleanse.parseLooseNumber(NaN).value, null);
    assert.strictEqual(cleanse.parseLooseNumber(Infinity).value, null);
    assert.strictEqual(cleanse.parseLooseNumber('N/A').value, null);
  });

  // ===== 身份归一（4.2 第 3 条）=====
  await check('H+5位数字导入边界解析为港股候选', async () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'position', code: 'H02688', name: '新奥能源', cost: 41.2, quantity: 1000, quantity_unit: '股', currency: 'HKD', date: '2026-10-25' }
    ]);
    assert.strictEqual(items[0].code, '02688');
    assert.strictEqual(items[0].market_hint, 'HK');
    const out = cleanse.finalizeImportedItems(items);
    assert.strictEqual(out[0].price, 41.2);
    assert.strictEqual(out[0]._v.costSource, 'cost');
    assert.strictEqual(out[0]._v.status, 'ok', JSON.stringify(out[0]._v.issues));
    assert.strictEqual(out[0].quote_currency, 'HKD');
  });
  await check('1—5位数字港股沿用现有补零规则（02688）', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'position', code: '02688', name: '新奥能源', cost: 41.2, quantity: 100, date: '2026-10-25' }
    ]);
    const out = cleanse.finalizeImportedItems(items);
    assert.strictEqual(out[0].code, '02688');
    assert.strictEqual(out[0].quote_currency, 'HKD'); // 身份推导
  });

  // ===== 币种（4.2 第 4 条）=====
  await check('显式币种与身份冲突 → 阻止提交', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'position', code: '000001', name: '平安银行', cost: 10, quantity: 100, currency: 'HKD', date: '2026-10-25' }
    ]);
    const out = cleanse.finalizeImportedItems(items);
    assert.strictEqual(out[0]._v.status, 'blocked');
    assert.ok(out[0]._v.issues.some(i => i.field === 'currency'));
  });
  await check('单独“¥”不确认币种（禁止猜）', () => {
    assert.strictEqual(cleanse.normalizeCurrency('¥').value, null);
    assert.strictEqual(cleanse.normalizeCurrency('HK$').value, 'HKD');
    assert.strictEqual(cleanse.normalizeCurrency('人民币').value, 'CNY');
  });

  // ===== 成本与市价分开（4.1 第 4 条，用户 2026-10-26 裁决）=====
  await check('cost 优先于 avg_buy_price，两者均缺 → 空值阻止提交', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'position', code: '600519', name: '贵州茅台', cost: 0, avg_buy_price: 1800, quantity: 100, date: '2026-10-25' },
      { kind: 'position', code: '000001', name: '平安银行', cost: null, avg_buy_price: -3.5, quantity: 100, date: '2026-10-25' },
      { kind: 'position', code: '300750', name: '宁德时代', cost: null, avg_buy_price: null, market_price: 210, quantity: 100, date: '2026-10-25' }
    ]);
    const out = cleanse.finalizeImportedItems(items);
    assert.strictEqual(out[0].price, 0); // 零成本生效
    assert.strictEqual(out[0]._v.costSource, 'cost');
    assert.strictEqual(out[1].price, -3.5); // 负成本生效
    assert.strictEqual(out[1]._v.costSource, 'avg_buy_price');
    assert.strictEqual(out[2].price, null); // 均缺保持空值，不用市价估算
    assert.strictEqual(out[2]._v.status, 'blocked');
  });

  // ===== 数量单位（4.2 第 2 条）=====
  await check('明确“手”的上交所可转债换算一次为“张”', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'trade', code: '113050', name: '南银转债', price: 105, quantity: 3, quantity_unit: '手', direction: 'buy', date: '2026-10-25' }
    ]);
    assert.strictEqual(items[0].quantity, 30);
    assert.strictEqual(items[0].quantity_unit, '张');
  });
  await check('明确“张”不换算', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'trade', code: '113050', name: '南银转债', price: 105, quantity: 30, quantity_unit: '张', direction: 'buy', date: '2026-10-25' }
    ]);
    assert.strictEqual(items[0].quantity, 30);
    assert.strictEqual(items[0].quantity_unit, '张');
  });
  await check('负数量保留原值并标待核对（不取绝对值）', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'trade', code: '000001', name: '平安银行', price: 10, quantity: -300, direction: 'buy', date: '2026-10-25' }
    ]);
    assert.strictEqual(items[0].quantity, -300);
    assert.strictEqual(items[0]._v.status, 'blocked'); // 成交数量必须为正 → 阻止
    assert.ok(items[0]._v.issues.some(i => i.message.indexOf('负号') >= 0));
  });

  // ===== 税费缺失（4.2 第 5 条）=====
  await check('缺失费用保持 null，明确 0 仍为 0', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'trade', code: '000001', name: '平安银行', price: 12.34, quantity: 100, direction: 'buy', date: '2026-07-09', commission: 0, stamp_tax: null, transfer_fee: '1.5' }
    ]);
    assert.strictEqual(items[0].commission, 0);
    assert.strictEqual(items[0].stamp_tax, null);
    assert.strictEqual(items[0].transfer_fee, 1.5);
    assert.strictEqual(items[0].other_fee, null);
  });

  // ===== kind 与日期校验 =====
  await check('漏 kind 的行标 blocked（错误不当作零条成功）', () => {
    const { items } = cleanse.cleanseImportedItems([
      { code: '000001', name: '平安银行', price: 10, quantity: 100 }
    ]);
    assert.strictEqual(items[0]._v.status, 'blocked');
    assert.ok(items[0]._v.issues.some(i => i.field === 'kind'));
  });
  await check('交易缺日期阻止提交（不默认今天）', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'trade', code: '000001', name: '平安银行', price: 10, quantity: 100, direction: 'buy' }
    ]);
    assert.ok(items[0]._v.issues.some(i => i.field === 'date'));
    assert.strictEqual(items[0]._v.status, 'blocked');
  });
  await check('持仓缺日期阻止提交（显式选择快照日期）', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'position', code: '000001', name: '平安银行', cost: 10, quantity: 100 }
    ]);
    assert.ok(items[0]._v.issues.some(i => i.field === 'date' && i.level === 'error'));
    assert.strictEqual(items[0]._v.status, 'blocked');
    const withDate = cleanse.cleanseImportedItems([
      { kind: 'position', code: '000001', name: '平安银行', cost: 10, quantity: 100, date: '2026-10-25' }
    ]);
    assert.notStrictEqual(withDate.items[0]._v.status, 'blocked');
  });
  await check('负费用标错误阻止提交（不静默转 0）', () => {
    const { items } = cleanse.cleanseImportedItems([
      { kind: 'trade', code: '000001', name: '平安银行', price: 12.34, quantity: 100, direction: 'buy', date: '2026-07-09', commission: -5, stamp_tax: 0 }
    ]);
    assert.strictEqual(items[0]._v.status, 'blocked');
    assert.ok(items[0]._v.issues.some(i => i.field === 'commission' && i.message.indexOf('负') >= 0));
    assert.strictEqual(items[0].stamp_tax, 0); // 明确 0 仍为 0
  });

  // ===== 零/负成本入账（4.1 第 4 条）=====
  await check('open 允许零与负成本、数量仍为正', () => {
    const r = validateTrade({ direction: 'open', code: '000001', price: -5, quantity: 100 });
    assert.strictEqual(r.price, -5);
    assert.strictEqual(r.amount, -500);
    assert.strictEqual(validateTrade({ direction: 'open', code: '000001', price: 0, quantity: 100 }).price, 0);
    assert.throws(() => validateTrade({ direction: 'open', code: '000001', price: NaN, quantity: 100 }), /成本价/);
    assert.throws(() => validateTrade({ direction: 'open', code: '000001', price: 5, quantity: 0 }), /数量/);
  });
  await check('adjust 允许零/负成本，缺失成本不静默按 0 处理', () => {
    assert.strictEqual(validateTrade({ direction: 'adjust', code: '000001', price: -3, quantity: 100 }).price, -3);
    assert.strictEqual(validateTrade({ direction: 'adjust', code: '000001', price: 0, quantity: 0 }).price, 0);
    assert.throws(() => validateTrade({ direction: 'adjust', code: '000001', quantity: 100 }), /成本价/);
  });
  await check('buy/sell 负价与零价仍被拒', () => {
    assert.throws(() => validateTrade({ direction: 'buy', code: '000001', price: -5, quantity: 100 }), /正数/);
    assert.throws(() => validateTrade({ direction: 'sell', code: '000001', price: 0, quantity: 100 }), /正数/);
  });

  // ===== 上传边界（4.6）=====
  await check('旧 {image} 单图上传语义保留（单元素批次）', () => {
    const token = 't_legacy_' + Date.now();
    vision.setVisionToken(token, { images: [], createdAt: Date.now(), username: 'u1' });
    const r = vision.saveVisionBatch(token, [imgURI(100)]);
    assert.strictEqual(r.ok, true);
    const c = vision.consumeVisionToken(token, 'u1');
    assert.strictEqual(c.images.length, 1);
    assert.ok(c.image); // 旧 image 字段仅一张时提供
  });
  await check('每批最多 6 张，超出拒绝', () => {
    const token = 't_many_' + Date.now();
    vision.setVisionToken(token, { images: [], createdAt: Date.now(), username: 'u1' });
    const imgs = [];
    for (let i = 0; i < 7; i++) imgs.push(imgURI(10));
    const r = vision.saveVisionBatch(token, imgs);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'too_many');
  });
  await check('单张超过 6MiB 拒绝', () => {
    const token = 't_big_' + Date.now();
    vision.setVisionToken(token, { images: [], createdAt: Date.now(), username: 'u1' });
    const r = vision.saveVisionBatch(token, [imgURI(6 * 1024 * 1024 + 100)]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'image_too_large');
  });
  await check('过期即时检查（不靠重复上传续命）', () => {
    const token = 't_old_' + Date.now();
    vision.setVisionToken(token, { images: [], createdAt: Date.now() - 10 * 60 * 1000, username: 'u1' });
    const r = vision.saveVisionBatch(token, [imgURI(10)]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'expired');
  });
  await check('同 token 相同批次重传可复用，内容不同报冲突', () => {
    const token = 't_dup_' + Date.now();
    const img = imgURI(20);
    vision.setVisionToken(token, { images: [], createdAt: Date.now(), username: 'u1' });
    assert.strictEqual(vision.saveVisionBatch(token, [img]).ok, true);
    assert.strictEqual(vision.saveVisionBatch(token, [img]).reused, true);
    const conflict = vision.saveVisionBatch(token, [imgURI(21)]);
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.code, 'conflict');
  });
  await check('一次性消费 + 跨用户 forbidden', () => {
    const token = 't_once_' + Date.now();
    vision.setVisionToken(token, { images: [], createdAt: Date.now(), username: 'u1' });
    vision.saveVisionBatch(token, [imgURI(30)]);
    const other = vision.consumeVisionToken(token, 'u2');
    assert.strictEqual(other.forbidden, true);
    assert.strictEqual(other.images.length, 0);
    const mine = vision.consumeVisionToken(token, 'u1');
    assert.strictEqual(mine.images.length, 1);
    const again = vision.consumeVisionToken(token, 'u1');
    assert.strictEqual(again.expired, true); // 已销毁
  });

  console.log('\n通过 ' + passed + ' 项');
}

main()
  .then(() => { if (process.exitCode) { console.error('存在失败用例'); process.exit(1); } process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
