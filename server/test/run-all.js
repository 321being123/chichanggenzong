// 统一测试入口（P2-1）：逐个在独立的 Node 子进程里跑 server/test/*.test.js，
// 每个文件进程隔离（互不污染状态），汇总通过/失败数量并给出非零退出码。
// 用法：node server/test/run-all.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = __dirname;
const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

let pass = 0, fail = 0;
const failed = [];

console.log('统一测试入口：共 ' + files.length + ' 个测试文件\n');

for (const f of files) {
  const file = path.join(testDir, f);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  // 取最后一行非空作为结论
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '(无输出)';
  if (r.status === 0) {
    pass++;
    console.log('  ✓ ' + f + '  ——  ' + last);
  } else {
    fail++;
    failed.push(f);
    console.log('  ✗ ' + f + '  (退出码 ' + r.status + ')  ——  ' + last);
  }
}

console.log('\n结果：通过 ' + pass + ' / ' + (pass + fail) + (fail ? '，失败 ' + fail + '：' + failed.join('、') : '，全部通过 ✅'));
process.exit(fail ? 1 : 0);
