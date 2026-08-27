const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectVersionErrors, parseArgs, runCheck, splitGitOutput, workingTreeFiles } = require('../../scripts/check-knowledge');

function write(rootDir, relativePath, content = '') {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-governance-'));
  write(rootDir, 'docs/知识索引.md', '# 知识索引\n');
  write(rootDir, 'docs/技术架构.md', '# 技术架构\n');
  write(rootDir, 'docs/生产部署流程.md', '# 生产部署\n');
  write(rootDir, 'governance/knowledge-map.json', JSON.stringify({
    requiredFiles: ['docs/知识索引.md', 'docs/技术架构.md', 'docs/生产部署流程.md'],
    routes: [{
      id: 'architecture',
      paths: ['server/**'],
      update: ['docs/技术架构.md']
    }]
  }, null, 2));
  return rootDir;
}

function testArchitectureChangeNeedsDocumentation() {
  const rootDir = createFixture();
  const result = runCheck({ rootDir, changedFiles: ['server/app.js'] });
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join('\n'), /docs\/技术架构\.md/);
}

function testArchitectureChangePassesWithDocumentation() {
  const rootDir = createFixture();
  const result = runCheck({
    rootDir,
    changedFiles: ['server/app.js', 'docs/技术架构.md']
  });
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
}

function testMissingRequiredKnowledgeEntryFails() {
  const rootDir = createFixture();
  fs.rmSync(path.join(rootDir, 'docs/知识索引.md'));
  const result = runCheck({ rootDir, changedFiles: [] });
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join('\n'), /docs\/知识索引\.md/);
}

function testGitOutputPreservesChinesePaths() {
  assert.deepStrictEqual(
    splitGitOutput('package.json\u0000docs/技术架构.md\u0000'),
    ['package.json', 'docs/技术架构.md']
  );
}

function testStagedOptionIsRecognized() {
  assert.strictEqual(parseArgs(['--staged']).staged, true);
}

function testDefaultWorktreeCollectionIncludesUntrackedBusinessFiles() {
  const rootDir = createFixture();
  const git = require('child_process');
  const init = git.spawnSync('git', ['init', '-q'], { cwd: rootDir, encoding: 'utf8' });
  assert.strictEqual(init.status, 0, init.stderr);
  write(rootDir, 'public/panel.js', 'window.panel = true;\n');
  assert.ok(
    workingTreeFiles(rootDir).includes('public/panel.js'),
    '默认工作区收集必须包含未跟踪的业务文件'
  );
}

function testTrackedPreCommitHookChecksStagedKnowledgeChanges() {
  const hookPath = path.resolve(__dirname, '../../.githooks/pre-commit');
  assert.ok(fs.existsSync(hookPath), '缺少受版本控制的 pre-commit 知识门禁');
  assert.match(fs.readFileSync(hookPath, 'utf8'), /node scripts\/check-knowledge\.js --staged/);
}

function testVersionMismatchIsRejected() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-version-'));
  write(rootDir, 'package.json', JSON.stringify({ version: '1.0.0', appVersion: '1.0.0' }));
  write(rootDir, 'package-lock.json', JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.1' } } }));
  write(rootDir, 'CHANGELOG.md', '## 2026-08-27 · 1.0.0\n');
  write(rootDir, 'public/changelog.json', JSON.stringify([{ version: '1.0.0', items: ['修复：测试'] }]));
  assert.match(collectVersionErrors(rootDir).join('\n'), /package-lock\.json/);
}

testArchitectureChangeNeedsDocumentation();
testArchitectureChangePassesWithDocumentation();
testMissingRequiredKnowledgeEntryFails();
testGitOutputPreservesChinesePaths();
testStagedOptionIsRecognized();
testDefaultWorktreeCollectionIncludesUntrackedBusinessFiles();
testTrackedPreCommitHookChecksStagedKnowledgeChanges();
testVersionMismatchIsRejected();
console.log('knowledge-governance: 8 项检查，失败 0');
