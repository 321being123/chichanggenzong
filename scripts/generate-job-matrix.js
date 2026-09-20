#!/usr/bin/env node
// 从 JOB_DEFINITIONS 生成任务-接口-数据集矩阵，避免专项方案与代码任务清单漂移。
const fs = require('fs');
const path = require('path');
const { JOB_DEFINITIONS, externalCallLimitForMode } = require('../server/services/jobDefinitions');
const { DATASET_PARTITION_REGISTRY } = require('../server/services/datasetPartitionRegistry');

const outputPath = path.join(__dirname, '..', 'docs', '任务接口数据集矩阵.generated.md');
const traceabilityPath = path.join(__dirname, '..', 'governance', 'rule-traceability.json');

function scheduleOf(job) {
  if (job.manualOnly) return '人工';
  if (job.monthly) return `每月 ${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')}`;
  return [
    `${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')}`,
    ...(job.additionalSchedules || []).map(item =>
      `${String(item.hour).padStart(2, '0')}:${String(item.minute).padStart(2, '0')}（${item.mode || '补充'}）`
    ),
  ].join('<br>');
}

function cell(values) {
  return (Array.isArray(values) ? values : []).join('<br>') || '—';
}

function budgetCell(job) {
  const label = value => value === null ? '不设内部调用数上限' : String(value);
  const values = !(job.additionalSchedules || []).length ? [label(externalCallLimitForMode(job))] : [
    `core: ${label(externalCallLimitForMode(job, 'core'))}`,
    ...(job.additionalSchedules || []).map(item =>
      `${item.mode || '补充'}: ${label(externalCallLimitForMode(job, item.mode || 'core'))}`
    ),
  ];
  return values.join('<br>');
}

function loadTraceability() {
  const traceability = JSON.parse(fs.readFileSync(traceabilityPath, 'utf8'));
  if (!traceability || traceability.schemaVersion !== 1 || !Array.isArray(traceability.rules)) {
    throw new Error('规则追踪矩阵必须包含 schemaVersion=1 和 rules 数组');
  }
  const ids = new Set();
  for (const rule of traceability.rules) {
    if (!rule || !rule.id || !rule.title || !rule.owner || !rule.status) throw new Error('规则追踪条目缺少 id/title/owner/status');
    if (ids.has(rule.id)) throw new Error(`规则追踪 ID 重复：${rule.id}`);
    ids.add(rule.id);
    const implementation = rule.implementation || {};
    const implementationPath = path.join(__dirname, '..', implementation.file || '');
    if (!implementation.file || !implementation.symbol || !fs.existsSync(implementationPath)) {
      throw new Error(`${rule.id} 的实现文件或符号声明无效`);
    }
    const implementationText = fs.readFileSync(implementationPath, 'utf8');
    if (!implementationText.includes(implementation.symbol)) {
      throw new Error(`${rule.id} 的实现符号不存在：${implementation.file}#${implementation.symbol}`);
    }
    if (!Array.isArray(rule.tests) || !rule.tests.length) throw new Error(`${rule.id} 缺少回归测试映射`);
    for (const test of rule.tests) {
      const testPath = path.join(__dirname, '..', test.file || '');
      if (!test.file || !fs.existsSync(testPath)) throw new Error(`${rule.id} 的测试文件不存在：${test.file}`);
      if (test.pattern && !fs.readFileSync(testPath, 'utf8').includes(test.pattern)) {
        throw new Error(`${rule.id} 的测试标记不存在：${test.file}#${test.pattern}`);
      }
    }
  }
  return traceability;
}

function render() {
  const traceability = loadTraceability();
  const scheduled = JOB_DEFINITIONS.filter(job => !job.manualOnly).length;
  const manual = JOB_DEFINITIONS.filter(job => job.manualOnly).length;
  const lines = [
    '# 任务-接口-数据集矩阵（代码生成）',
    '',
    '> 此文件由 `scripts/generate-job-matrix.js` 从 `server/services/jobDefinitions.js` 生成，禁止手工修改。',
    `> 生成任务数：${JOB_DEFINITIONS.length}（定时 ${scheduled}，人工 ${manual}）。联网任务不设置内部调用数额度；真实限制只来自已核验官方策略。`,
    `> 数据集分区注册表已纳入任务契约审计，当前登记 ${Object.keys(DATASET_PARTITION_REGISTRY).length} 个数据集。`,
    '',
    '| 任务 | 调度 | 外部接口 | 产出数据集 | 依赖数据集 | 任务调用数约束 |',
    '|---|---|---|---|---|---:|',
  ];
  for (const job of JOB_DEFINITIONS) {
    lines.push(`| ${job.jobCode} | ${scheduleOf(job)} | ${cell(job.externalApis)} | ${cell(job.producesDatasets)} | ${cell(job.consumesDatasets)} | ${budgetCell(job)} |`);
  }
  lines.push('', '## 规则—实现—测试追踪矩阵', '',
    '> 规则来源：`governance/rule-traceability.json`。生成器会校验实现文件、实现符号和测试文件标记，防止规则只停留在文档。', '',
    '| 规则 ID | 规则 | 实现符号 | 测试 | 责任人 | 状态 |',
    '|---|---|---|---|---|---|');
  for (const rule of traceability.rules) {
    const implementation = `${rule.implementation.file}#${rule.implementation.symbol}`;
    const tests = rule.tests.map(test => `${test.file}${test.pattern ? `#${test.pattern}` : ''}`).join('<br>');
    lines.push(`| ${rule.id} | ${rule.title} | ${implementation} | ${tests} | ${rule.owner} | ${rule.status} |`);
  }
  lines.push('', '<!-- JOB_MATRIX_GENERATED_END -->', '');
  return lines.join('\n');
}

function main() {
  const expected = render();
  const check = process.argv.includes('--check');
  const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (check) {
    if (actual !== expected) {
      console.error(`任务矩阵与 JOB_DEFINITIONS 不一致，请运行：node scripts/generate-job-matrix.js\n期望文件：${path.relative(process.cwd(), outputPath)}`);
      process.exit(1);
    }
    console.log(`任务矩阵校验通过：${JOB_DEFINITIONS.length} 个任务。`);
    return;
  }
  fs.writeFileSync(outputPath, expected, 'utf8');
  console.log(`已生成 ${path.relative(process.cwd(), outputPath)}`);
}

main();
