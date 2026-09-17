#!/usr/bin/env node
// 从 JOB_DEFINITIONS 生成任务-接口-数据集矩阵，避免专项方案与代码任务清单漂移。
const fs = require('fs');
const path = require('path');
const { JOB_DEFINITIONS, externalCallLimitForMode } = require('../server/services/jobDefinitions');

const outputPath = path.join(__dirname, '..', 'docs', '任务接口数据集矩阵.generated.md');

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

function render() {
  const scheduled = JOB_DEFINITIONS.filter(job => !job.manualOnly).length;
  const manual = JOB_DEFINITIONS.filter(job => job.manualOnly).length;
  const lines = [
    '# 任务-接口-数据集矩阵（代码生成）',
    '',
    '> 此文件由 `scripts/generate-job-matrix.js` 从 `server/services/jobDefinitions.js` 生成，禁止手工修改。',
    `> 生成任务数：${JOB_DEFINITIONS.length}（定时 ${scheduled}，人工 ${manual}）。联网任务不设置内部调用数额度；真实限制只来自已核验官方策略。`,
    '',
    '| 任务 | 调度 | 外部接口 | 产出数据集 | 依赖数据集 | 任务调用数约束 |',
    '|---|---|---|---|---|---:|',
  ];
  for (const job of JOB_DEFINITIONS) {
    lines.push(`| ${job.jobCode} | ${scheduleOf(job)} | ${cell(job.externalApis)} | ${cell(job.producesDatasets)} | ${cell(job.consumesDatasets)} | ${budgetCell(job)} |`);
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
