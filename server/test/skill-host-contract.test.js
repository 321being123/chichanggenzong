// 三个专项 Skill 的宿主契约（2026-10-30）
//
// 这里能自动断言的是「文件与内容契约」：Skill 存在、frontmatter 合法、描述里既有触发场景也有
// 不应触发的排除语、正文关键步骤没被改回去、用户级薄入口只指路不复制流程。
// 它证明不了「宿主会不会自动加载」——那只能实测。显式调用实测记录见
// docs/Skill宿主发现与行为验收_20261030.md，未做的部分在文档里如实标注，不在这里冒充通过。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SKILLS = ['site-doc-handoff', 'site-release-closeout', 'site-monthly-review'];
// WorkBuddy 只认工作区级目录；其他机器/CI 上没有这个目录，按「不存在则跳过」处理。
const HOST_ENTRY_DIRS = [
  path.join(ROOT, '..', '.codebuddy', 'skills'),
  'D:/Users/存在小站/.codebuddy/skills',
];

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

function readSkill(name) {
  return fs.readFileSync(path.join(ROOT, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
}

function frontmatter(text) {
  // 仓库里既有 LF 也有 CRLF 文件，正则要同时吃得下，否则会把「文件是 CRLF」误判成「缺少 frontmatter」。
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const data = {};
  match[1].split(/\r?\n/).forEach(function (line) {
    const pair = line.match(/^(\w+):\s*(.*)$/);
    if (pair) data[pair[1]] = pair[2].replace(/^"|"$/g, '').trim();
  });
  return data;
}

console.log('--- 仓库侧 Skill 契约 ---');

check('三个 Skill 都存在且 frontmatter 合法', function () {
  for (const name of SKILLS) {
    const text = readSkill(name);
    const meta = frontmatter(text);
    assert.ok(meta, name + ' 缺少 frontmatter');
    assert.strictEqual(meta.name, name, name + ' 的 name 必须与目录同名');
    assert.ok((meta.description || '').length >= 12, name + ' 的 description 太短，宿主无法判断何时使用');
  }
});

check('描述里既有触发场景也有「不该用」的排除语（决定负例不误触发）', function () {
  const expectations = {
    'site-doc-handoff': [/文档/, /交接|收尾/],
    'site-release-closeout': [/发布|上线/, /续办|补回写/],
    'site-monthly-review': [/复盘|月度/, /健康检查|审查/],
  };
  for (const [name, patterns] of Object.entries(expectations)) {
    const meta = frontmatter(readSkill(name));
    for (const pattern of patterns) {
      assert.ok(pattern.test(meta.description), `${name} 的描述缺少 ${pattern}`);
    }
    assert.ok(
      /不要用|不适用|不该|无需/.test(meta.description),
      name + ' 的描述没有排除语，邻近任务容易被误触发'
    );
  }
});

check('发布 Skill 保留「新发布 / 只补回写」两个分支', function () {
  const text = readSkill('site-release-closeout');
  assert.ok(/只补回写/.test(text), '缺少「只补回写」分支');
  assert.ok(/A 新发布|新发布/.test(text), '缺少「新发布」分支');
  assert.ok(/不许改版本|不改版本/.test(text), '没有写明「只补回写」不许改版本');
  assert.ok(/不.*重新部署|不重部署/.test(text), '没有写明「只补回写」不许重新部署');
});

check('发布 Skill 把反馈批次核对放在部署之前', function () {
  const text = readSkill('site-release-closeout');
  const prepare = text.indexOf('反馈核对准备');
  const deploy = text.search(/\*\*部署\*\*|部署命令/);
  assert.ok(prepare > 0, '缺少「反馈核对准备」步骤');
  assert.ok(deploy > 0, '缺少部署步骤');
  assert.ok(prepare < deploy, '批次核对必须在部署步骤之前（脚本缺核对依据会直接拦发布）');
  assert.ok(/--feedback-none-evidence/.test(text), '缺少「确认无相关反馈」的证据入口说明');
});

check('发布 Skill 写明哪些 feedback_status 才算完成态', function () {
  const text = readSkill('site-release-closeout');
  ['applied_verified', 'applied_verified_no_implementation', 'crosschecked_no_related_feedback'].forEach(function (value) {
    assert.ok(text.includes(value), '缺少完成态说明：' + value);
  });
  assert.ok(/未闭环/.test(text), '必须写明其余状态都算未闭环');
});

check('文档 Skill 要求同步摘要、索引与旧结论替代', function () {
  const text = readSkill('site-doc-handoff');
  assert.ok(/知识索引|摘要/.test(text), '缺少摘要/索引同步要求');
  assert.ok(/旧结论|替代/.test(text), '缺少「旧结论要被替代」的要求');
});

check('月度 Skill 要求复查上月行动效果', function () {
  const text = readSkill('site-monthly-review');
  assert.ok(/上月/.test(text), '缺少上月基线/行动复查要求');
  assert.ok(/有效|无效|未实施/.test(text), '缺少对上次措施是否有效的判定要求');
});

console.log('--- 用户级薄入口（WorkBuddy 只认这一层） ---');

const entryDir = HOST_ENTRY_DIRS.find(function (dir) { return fs.existsSync(dir); });
if (!entryDir) {
  console.log('[SKIP] 未找到工作区级 Skill 目录，跳过薄入口校验（其他机器/CI 正常情况）');
} else {
  check('薄入口存在且只指路、不复制流程', function () {
    for (const name of SKILLS) {
      const file = path.join(entryDir, name, 'SKILL.md');
      assert.ok(fs.existsSync(file), '缺少薄入口：' + name);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(
        text.includes('.agents/skills/' + name + '/SKILL.md'),
        name + ' 的薄入口没有指向仓库权威文件，可能已经变成第二份事实'
      );
      assert.ok(text.length < 1200, name + ' 的薄入口过长（' + text.length + ' 字符），疑似把流程复制过来了');
      const target = path.join(ROOT, '.agents', 'skills', name, 'SKILL.md');
      assert.ok(fs.existsSync(target), name + ' 的薄入口指向的仓库文件不存在');
    }
  });
}

console.log('\nSkill 宿主契约：' + pass + ' 项通过，' + fail + ' 项失败');
if (fail) failures.forEach(function (item) { console.log(' - ' + item); });
process.exit(fail ? 1 : 0);
