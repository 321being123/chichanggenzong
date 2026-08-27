#!/usr/bin/env node
const childProcess = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const result = childProcess.spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: rootDir,
  encoding: 'utf8'
});

if (result.status !== 0) {
  console.error(`Git Hook 安装失败：${(result.stderr || '').trim() || '当前目录不是 Git 仓库'}`);
  process.exit(result.status || 1);
}

console.log('Git Hook 已安装：提交前将检查暂存的知识治理变更。');
