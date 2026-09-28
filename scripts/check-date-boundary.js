#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCAN_DIRS = ['server', 'public/js', 'public/shared', 'ipo-report', 'scripts', 'deploy'];
const SOURCE_EXTENSIONS = new Set(['.js', '.py']);
const EXCLUDED = /(^|\/)(vendor|node_modules|venv|\.venv|dist|build|__pycache__)(\/|$)/i;

function ruleRegex(ruleId) {
  if (ruleId === 'timezone-offset-480') return /getTimezoneOffset\s*\(\s*\)\s*\+\s*480/g;
  return null;
}

function functionNameAt(source, index) {
  const prefix = source.slice(0, index);
  const candidates = [];
  const declarations = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^({]*|\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  for (const regex of [declarations, assigned]) {
    let match;
    while ((match = regex.exec(prefix))) candidates.push({ index: match.index, name: match[1] });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates.length ? candidates[candidates.length - 1].name : '<module>';
}

function collectMatches(sources, baseline) {
  const matches = [];
  for (const item of sources) {
    for (const ruleId of new Set(baseline.rules.map(rule => rule.ruleId))) {
      const regex = ruleRegex(ruleId);
      if (!regex) continue;
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(item.source))) {
        const line = item.source.slice(0, match.index).split('\n').length;
        matches.push({
          ruleId,
          file: item.path.replace(/\\/g, '/'),
          function: functionNameAt(item.source, match.index),
          line,
        });
      }
    }
  }
  return matches;
}

function identity(rule) {
  return [rule.ruleId, rule.file.replace(/\\/g, '/'), rule.function, rule.expression].join('|');
}

function analyzeSources(sources, baseline) {
  const problems = [];
  const entries = new Map();
  for (const rule of baseline.rules || []) {
    if (!['open', 'fixed'].includes(rule.status) || !Number.isInteger(rule.expectedMatches) || rule.expectedMatches < 0) {
      problems.push({ type: 'INVALID_BASELINE_ENTRY', key: identity(rule) });
      continue;
    }
    const key = identity(rule);
    if (entries.has(key)) problems.push({ type: 'DUPLICATE_BASELINE_ENTRY', key });
    else entries.set(key, rule);
  }

  const observed = new Map();
  for (const match of collectMatches(sources, baseline)) {
    const rule = baseline.rules.find(item => item.ruleId === match.ruleId);
    const key = rule ? identity({ ...rule, file: match.file, function: match.function }) : '';
    const entry = entries.get(key);
    if (!entry) {
      problems.push({ type: 'UNREGISTERED_MATCH', ...match });
      continue;
    }
    observed.set(key, (observed.get(key) || 0) + 1);
    if (entry.status === 'fixed') problems.push({ type: 'FIXED_RULE_REAPPEARED', ...match });
  }

  for (const [key, rule] of entries) {
    const count = observed.get(key) || 0;
    if (count !== rule.expectedMatches) problems.push({ type: 'MATCH_COUNT_CHANGED', key, expected: rule.expectedMatches, actual: count });
    if (rule.status === 'open' && count === 0) problems.push({ type: 'OPEN_RULE_DISAPPEARED', key });
  }

  const openMatches = baseline.rules.reduce((sum, rule) => sum + (rule.status === 'open' ? (observed.get(identity(rule)) || 0) : 0), 0);
  const fixedRules = baseline.rules.filter(rule => rule.status === 'fixed').length;
  return { problems, openMatches, fixedRules, matches: collectMatches(sources, baseline) };
}

function collectSourceFiles(root) {
  const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...SCAN_DIRS], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
  return [...new Set(tracked.map(value => value.replace(/\\/g, '/')))]
    .filter(file => !EXCLUDED.test(file) && SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .filter(file => fs.existsSync(path.join(root, file)))
    .sort();
}

function checkRepository(root = path.resolve(__dirname, '..')) {
  const baselinePath = path.join(root, 'governance', 'date-boundary-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const files = collectSourceFiles(root);
  const sources = files.map(file => ({ path: file, source: fs.readFileSync(path.join(root, file), 'utf8') }));
  return { ...analyzeSources(sources, baseline), fileCount: files.length };
}

if (require.main === module) {
  try {
    const result = checkRepository(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
    console.log(`日期边界检查：扫描 ${result.fileCount} 个 JS/Python 源文件；已登记未修复 ${result.openMatches} 处；已修复规则 ${result.fixedRules} 条。`);
    if (result.problems.length) {
      for (const problem of result.problems) console.error(JSON.stringify(problem));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('日期边界检查失败：' + (error.message || String(error)));
    process.exitCode = 1;
  }
}

module.exports = { ruleRegex, functionNameAt, collectMatches, analyzeSources, collectSourceFiles, checkRepository };
