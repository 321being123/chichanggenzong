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
    assert.strictEqual(router.pickVisionModel('agnes-1.5-pro'), 'agnes-1.5-pro');
  });
  await check('名单外高成本模型回落默认', () => {
    assert.strictEqual(router.pickVisionModel('gpt-4o-omni-ultra-expensive'), process.env.VISION_MODEL || 'agnes-1.5-flash');
  });
  await check('空模型回落默认', () => {
    assert.strictEqual(router.pickVisionModel(''), process.env.VISION_MODEL || 'agnes-1.5-flash');
  });

  console.log('\n通过 ' + passed + ' 项');
}

main()
  .then(() => { if (process.exitCode) { console.error('存在失败用例'); process.exit(1); } process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
