const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectSkillEntryErrors, runCheck } = require('../../scripts/check-knowledge');

function write(rootDir, relativePath, content = '') {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-entry-'));
  write(rootDir, 'docs/知识索引.md', '# 知识索引\n');
  write(rootDir, 'docs/技术架构.md', '# 技术架构\n');
  write(rootDir, 'docs/生产部署流程.md', '# 生产部署\n');
  write(rootDir, 'governance/knowledge-map.json', JSON.stringify({
    requiredFiles: ['docs/知识索引.md', 'docs/技术架构.md', 'docs/生产部署流程.md'],
    routes: []
  }, null, 2));
  return rootDir;
}

function writeSkill(rootDir, dirName, body) {
  write(rootDir, `.agents/skills/${dirName}/SKILL.md`, body);
}

const VALID_SKILL = [
  '---',
  'name: site-demo',
  'description: "示例技能：演示合法的 Skill 入口结构。"',
  '---',
  '',
  '# 示例',
  '',
  '读 `docs/技术架构.md`。'
].join('\n');

function testValidSkillPasses() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', VALID_SKILL);
  const errors = collectSkillEntryErrors(rootDir);
  assert.deepStrictEqual(errors, [], errors.join('\n'));
  const result = runCheck({ rootDir, changedFiles: [] });
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
}

function testMissingAgentsDirectoryIsTolerated() {
  const rootDir = createFixture();
  assert.deepStrictEqual(collectSkillEntryErrors(rootDir), []);
}

function testMissingSkillFileFails() {
  const rootDir = createFixture();
  fs.mkdirSync(path.join(rootDir, '.agents/skills/site-demo'), { recursive: true });
  const errors = collectSkillEntryErrors(rootDir).join('\n');
  assert.match(errors, /缺少 SKILL\.md/);
}

function testNameMustMatchDirectory() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', VALID_SKILL.replace('name: site-demo', 'name: site-other'));
  assert.match(collectSkillEntryErrors(rootDir).join('\n'), /name 必须与目录同名/);
}

function testMissingDescriptionFails() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', ['---', 'name: site-demo', '---', '', '# 示例'].join('\n'));
  assert.match(collectSkillEntryErrors(rootDir).join('\n'), /description/);
}

function testMissingFrontmatterFails() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', '# 没有 frontmatter\n');
  assert.match(collectSkillEntryErrors(rootDir).join('\n'), /缺少 frontmatter/);
}

function testReferenceToMissingDocFails() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', VALID_SKILL.replace('docs/技术架构.md', 'docs/不存在的文档.md'));
  assert.match(collectSkillEntryErrors(rootDir).join('\n'), /引用了不存在的仓库文档/);
}

function testPlaceholderReferenceIsSkipped() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', VALID_SKILL + '\n读 `docs/项目月度复盘_YYYYMM.md`。');
  assert.deepStrictEqual(collectSkillEntryErrors(rootDir), []);
}

function testRunCheckRejectsBrokenSkill() {
  const rootDir = createFixture();
  writeSkill(rootDir, 'site-demo', VALID_SKILL.replace('name: site-demo', 'name: site-other'));
  const result = runCheck({ rootDir, changedFiles: [] });
  assert.strictEqual(result.ok, false, '结构不合法的 Skill 必须让 runCheck 整体失败');
  assert.match(result.errors.join('\n'), /name 必须与目录同名/);
}

function main() {
  const cases = [
    ['合法 Skill 通过且不影响整体门禁', testValidSkillPasses],
    ['缺少 .agents/skills 目录不报错', testMissingAgentsDirectoryIsTolerated],
    ['目录缺少 SKILL.md 失败', testMissingSkillFileFails],
    ['name 与目录不同名失败', testNameMustMatchDirectory],
    ['缺少 description 失败', testMissingDescriptionFails],
    ['缺少 frontmatter 失败', testMissingFrontmatterFails],
    ['引用不存在的仓库文档失败', testReferenceToMissingDocFails],
    ['占位路径不误报', testPlaceholderReferenceIsSkipped],
    ['runCheck 整体拒绝不合法的 Skill', testRunCheckRejectsBrokenSkill]
  ];
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      run();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${name} —— ${error.message}`);
    }
  }
  console.log(`skill-entry: ${cases.length} 项检查，失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main();
