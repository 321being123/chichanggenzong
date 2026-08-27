const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, runCheck, splitGitOutput } = require('../../scripts/check-knowledge');

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

testArchitectureChangeNeedsDocumentation();
testArchitectureChangePassesWithDocumentation();
testMissingRequiredKnowledgeEntryFails();
testGitOutputPreservesChinesePaths();
testStagedOptionIsRecognized();
console.log('knowledge-governance: 5 项检查，失败 0');
