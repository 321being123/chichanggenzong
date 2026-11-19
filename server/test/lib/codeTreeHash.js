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

// 工作区指纹：全量测试必须绑定“实际被执行的源码”，不能在未提交改动时只写 HEAD 的树。
// 取 HEAD 文件集合与当前工作区（含未跟踪代码文件）的并集，按路径+内容排序哈希；
// 发布后工作区干净时，该值仍稳定绑定提交后的文件内容，发布脚本使用同一算法复核。
function worktreeCodeTreeHash(cwd = process.cwd()) {
  const list = args => {
    const result = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw new Error('读取工作区代码树失败：' + result.error.message);
    if (result.status !== 0) throw new Error('读取工作区代码树失败：' + String(result.stderr || '').trim().slice(0, 300));
    return String(result.stdout || '').split('\0').filter(Boolean);
  };
  const headEntries = list(['ls-tree', '-r', '-z', 'HEAD', '--', ...CODE_TREE_PATHS]);
  const headPaths = headEntries.map(entry => entry.slice(entry.indexOf('\t') + 1)).filter(Boolean);
  const currentPaths = list(['ls-files', '-co', '--exclude-standard', '-z', '--', ...CODE_TREE_PATHS]);
  const paths = [...new Set([...headPaths, ...currentPaths])].sort();
  const hash = crypto.createHash('sha256');
  for (const relativePath of paths) {
    hash.update(Buffer.from(relativePath, 'utf8'));
    hash.update(Buffer.from([0]));
    const absolutePath = require('path').join(cwd, relativePath);
    let content;
    try {
      content = require('fs').readFileSync(absolutePath);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
      content = Buffer.from('__DELETED__', 'utf8');
    }
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function headCommit(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

module.exports = { codeTreeHash, worktreeCodeTreeHash, headCommit, CODE_TREE_PATHS };
