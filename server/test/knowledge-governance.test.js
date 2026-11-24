const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectVersionErrors, isReleaseMetadataOnly, parseArgs, runCheck, splitGitOutput, workingTreeFiles } = require('../../scripts/check-knowledge');

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

function testReleaseMetadataDoesNotRequireArchitectureDocs() {
  const rootDir = createFixture();
  write(rootDir, 'public/changelog.json', '[]');
  const result = runCheck({ rootDir, changedFiles: ['public/changelog.json'] });
  assert.strictEqual(isReleaseMetadataOnly(rootDir, ['public/changelog.json']), true);
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
}

function testReviewRoutesDoNotForceUnrelatedDocumentEdits() {
  const rootDir = createFixture();
  const map = require('../../governance/knowledge-map.json');
  write(rootDir, 'governance/knowledge-map.json', JSON.stringify({
    requiredFiles: [],
    routes: map.routes.map(({ readSections, ...route }) => route)
  }));
  const samples = [
    ['public/css/stock-analysis.css', 'frontend'],
    ['server/test/feedback-ui-classroom.test.js', 'feedback'],
    ['server/test/notification-service.test.js', 'notification-center'],
    ['deploy/部署说明.md', 'deployment'],
    ['docs/生产部署历史记录_截至20261124.md', 'knowledge-maintenance'],
    ['server/test/lib/testRunControl.js', 'test-validation-policy'],
    ['governance/knowledge-map.json', 'solution-design']
  ];
  for (const [file, routeId] of samples) {
    const result = runCheck({ rootDir, changedFiles: [file] });
    assert.ok(result.matchedRoutes.some(({ id }) => id === routeId), file);
    assert.strictEqual(result.ok, true, result.errors.join('\n'));
  }
  const taskChange = runCheck({ rootDir, changedFiles: ['server/services/jobDefinitions.js'] });
  assert.match(taskChange.errors.join('\n'), /task-quality-governance.*ADR-0003/);
}

function testEntryDocumentsRejectReleaseLogsInIntroduction() {
  const rootDir = createFixture();
  write(rootDir, 'docs/知识索引.md', '> 2026-11-24 已发布\n\n# 知识索引\n');
  write(rootDir, 'docs/技术架构.md', '# 技术架构\n\n> 最后核对日期：2026-11-24（**0.9.5.5 已发布**）\n');
  write(rootDir, 'docs/生产部署流程.md', '# 生产部署\n\n> **发布回执（0.9.5.5）**\n');
  const result = runCheck({ rootDir, changedFiles: [] });
  assert.deepStrictEqual(result.errors, [
    'docs/知识索引.md 必须以一级标题开始，历史记录请归档。',
    'docs/技术架构.md 的文首含版本流水，请写入发布历史或原任务记录。',
    'docs/生产部署流程.md 的文首含版本流水，请写入发布历史或原任务记录。'
  ]);
}

function testEntryDocumentsAllowDateAndEvidenceLinks() {
  const rootDir = createFixture();
  write(rootDir, 'docs/技术架构.md', '# 技术架构\n\n> 最后核对日期：2026-11-24。历史记录见原文。\n');
  write(rootDir, 'docs/知识索引.md', '# 知识索引\n\n> 参阅发布历史。\n\n## 当前摘要\n\n0.9.5.5 已发布，详情见回执。\n');
  const result = runCheck({ rootDir, changedFiles: [] });
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
}

testArchitectureChangeNeedsDocumentation();
testArchitectureChangePassesWithDocumentation();
testMissingRequiredKnowledgeEntryFails();
testGitOutputPreservesChinesePaths();
testStagedOptionIsRecognized();
testDefaultWorktreeCollectionIncludesUntrackedBusinessFiles();
testTrackedPreCommitHookChecksStagedKnowledgeChanges();
testVersionMismatchIsRejected();
testReleaseMetadataDoesNotRequireArchitectureDocs();
testReviewRoutesDoNotForceUnrelatedDocumentEdits();
testEntryDocumentsRejectReleaseLogsInIntroduction();
testEntryDocumentsAllowDateAndEvidenceLinks();
console.log('knowledge-governance: 12 项检查，失败 0');
