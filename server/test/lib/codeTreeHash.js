// 代码树指纹（F15）：把"测试证据属于哪份代码"变成可比对的摘要。
//
// 为什么不用提交号直接绑定：项目规则允许"纯文档变更复用有效测试"，
// 提交号一变就得重跑全量，代价过高且没有额外信息量。
// 因此指纹只覆盖会影响测试结果的部分（源码、前端、部署脚本、CI 配置、依赖与迁移），
// 文档/CHANGELOG 的改动不会改变指纹，源码改动一定会改变指纹。
//
// Node 与 Python（部署前置校验）必须算出同一个值，所以规范固定为：
//   git ls-tree -r <commit> -- <paths>  的原始输出，取 sha256 十六进制摘要。
'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 顺序即指纹的一部分，禁止随意重排；新增会影响运行结果的一级目录时必须追加进来。
const CODE_TREE_PATHS = Object.freeze([
  'server',
  'public',
  'deploy',
  'scripts',
  '.github',
  'ipo-report',
  'package.json',
  'package-lock.json',
  'requirements.txt',
]);

function codeTreeHash(rev = 'HEAD', cwd = process.cwd()) {
  const result = spawnSync('git', ['ls-tree', '-r', rev, '--', ...CODE_TREE_PATHS], {
    cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error('读取代码树失败：' + result.error.message);
  if (result.status !== 0) {
    throw new Error('读取代码树失败：' + String(result.stderr || '').trim().slice(0, 300));
  }
  return crypto.createHash('sha256').update(result.stdout).digest('hex');
}

function headCommit(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

module.exports = { codeTreeHash, headCommit, CODE_TREE_PATHS };
