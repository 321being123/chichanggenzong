// 备份保留规则（2026-10-30）
//
// 为什么要有这条测试：2026-10-30 手工清理时，把 `X.sql.gz.gpg.sha256` 当成独立组，
// 误删了保留组的校验文件。根因是 `scripts/backup_db.sh` 的 `group_base()` 只剥一层后缀，
// 同一组算出多个基名——既让"保留 14 组"实际只剩 3—4 组，也让清理脚本把同组文件拆散。
// 这里用假目录直接执行脚本里的真实函数，锁住三件事：
//   ① 同一组的所有产物算同一个基名；
//   ② 保留组数按 BACKUP_KEEP_GROUPS（默认 3）执行；
//   ③ 清理是"整组"的，绝不会只删组内某个校验文件。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backup_db.sh');
const SUFFIXES = ['sql.gz.gpg', 'sql.gz.gpg.sha256', 'attachments.tar.gz.gpg', 'attachments.tar.gz.gpg.sha256', 'manifest.sha256'];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    fail += 1;
    failures.push(name + ' :: ' + error.message);
    console.log('  ✗ ' + name + ' —— ' + error.message);
  }
}

function haveBash() {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return probe.status === 0 && (probe.stdout || '').includes('ok');
}

// 造 n 组假备份：每组 5 个文件（数据库密文+校验、附件密文+校验、组清单），日期递增。
function makeGroups(dir, count) {
  for (let day = 1; day <= count; day += 1) {
    const stamp = '2026100' + day + '_000000';
    for (const suffix of SUFFIXES) {
      const file = path.join(dir, `portfolio_${stamp}.${suffix}`);
      fs.writeFileSync(file, 'x');
      const when = new Date(Date.UTC(2026, 9, day, 3, 40));
      fs.utimesSync(file, when, when);
    }
  }
}

function prune(dir, keepGroups) {
  const script = [
    `eval "$(sed -n '/^group_base()/,/^}/p' '${SCRIPT.replace(/\\/g, '/')}')"`,
    `eval "$(sed -n '/^prune_backups()/,/^}/p' '${SCRIPT.replace(/\\/g, '/')}')"`,
    'prune_backups',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      BACKUP_DIR: dir.replace(/\\/g, '/'),
      PGDATABASE: 'portfolio',
      BACKUP_KEEP_GROUPS: String(keepGroups),
    }),
  });
  return result;
}

// 与脚本里的 group_base 保持一致：循环剥离后缀直到剥不动。
// 不要图省事写成「只剥一次」——那正是这次要修的 bug，测试自己重复这个错误会让断言永远绿。
function baseOf(name) {
  let previous = null;
  let current = name;
  while (previous !== current) {
    previous = current;
    current = current.replace(/\.(manifest\.sha256|attachments\.tar\.gz(\.gpg)?|sql\.gz(\.gpg)?|sha256|gpg)$/, '');
  }
  return current;
}

function groupsIn(dir) {
  const seen = new Set();
  for (const name of fs.readdirSync(dir)) seen.add(baseOf(name));
  return Array.from(seen).sort();
}

if (!haveBash()) {
  console.log('[SKIP] 没有可用的 bash，跳过备份保留规则测试');
  process.exit(0);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-'));
try {
  const dir = path.join(tmpRoot, 'backups');
  fs.mkdirSync(dir);
  makeGroups(dir, 5);

  check('同一组的 5 个产物算同一个基名（不会被拆成多组）', function () {
    const result = prune(dir, 5);
    assert.ok(result.status === 0, 'prune 执行失败：' + (result.stderr || ''));
    const groups = groupsIn(dir);
    assert.strictEqual(groups.length, 5, '5 组应被识别为 5 个基名，实际：' + groups.join(','));
    assert.deepStrictEqual(groups, [
      'portfolio_20261001_000000', 'portfolio_20261002_000000', 'portfolio_20261003_000000',
      'portfolio_20261004_000000', 'portfolio_20261005_000000',
    ]);
  });

  check('保留组数按 BACKUP_KEEP_GROUPS 执行（默认 3）', function () {
    const result = prune(dir, 3);
    assert.ok(result.status === 0, 'prune 执行失败：' + (result.stderr || ''));
    const groups = groupsIn(dir);
    assert.strictEqual(groups.length, 3, '应只剩 3 组，实际：' + groups.join(','));
    assert.deepStrictEqual(groups, [
      'portfolio_20261003_000000', 'portfolio_20261004_000000', 'portfolio_20261005_000000',
    ], '保留的应是最新的 3 组');
  });

  check('清理是整组删除：保留组内 5 个文件一个都不能少', function () {
    const files = fs.readdirSync(dir).sort();
    assert.strictEqual(files.length, 15, '3 组 × 5 个文件 = 15，实际：' + files.length + '（' + files.join(',') + '）');
    for (const stamp of ['20261003_000000', '20261004_000000', '20261005_000000']) {
      for (const suffix of SUFFIXES) {
        const file = path.join(dir, `portfolio_${stamp}.${suffix}`);
        assert.ok(fs.existsSync(file), '被误删：' + path.basename(file));
      }
    }
  });

  check('组数上限非法时回退到 3，不会被设成 0 而清空备份', function () {
    makeGroups(dir, 5);
    const result = prune(dir, 'abc');
    assert.ok(result.status === 0, 'prune 执行失败：' + (result.stderr || ''));
    assert.strictEqual(groupsIn(dir).length, 3, '非法值应回退默认 3');
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('\n备份保留规则：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) failures.forEach(function (item) { console.log(' - ' + item); });
process.exit(fail ? 1 : 0);
