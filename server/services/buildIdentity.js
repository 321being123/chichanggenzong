// 启动构建身份（S-001）：用于回答"这个正在跑的进程加载的是哪个提交"。
//
// 背景：systemd unit active、磁盘 Git HEAD 和 /health 的版本号各只能证明一件事，
// 版本号相同也不代表内存里是新代码（旧 Worker 可能还在跑旧代码）。
// 这里在进程启动时固定一份身份，由 /health 自述；部署脚本再与 MainPID、
// 进程启动时刻、服务器 HEAD 交叉核对，形成"同一提交"的证据链。
//
// 顺序：APP_COMMIT 环境变量（部署链路可注入）→ 仓库 .git/HEAD → 空。
// 只输出提交号、启动时刻与进程号，不读取也不输出任何环境变量或凭据。
const fs = require('fs');
const path = require('path');
const { appVersion } = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');

function readCommitFromGit(rootDir = ROOT) {
  // 优先用 git 自己算：worktree、子模块、packed-refs 的边界都由它处理，
  // 手写 .git 目录解析在这些场景会读不到（本任务开发用的就是 worktree）。
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['-C', rootDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(out)) return out;
  } catch (_) { /* 没有 git 或不是仓库，继续按文件解析 */ }
  try {
    const gitDir = path.join(rootDir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 40) || null;
    const ref = head.slice(5).trim();
    const refPath = path.join(gitDir, ref);
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim().slice(0, 40) || null;
    // 打包过的仓库：ref 记录在 packed-refs 里。
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find(row => row.trim().endsWith(' ' + ref));
    return line ? line.trim().split(' ')[0].slice(0, 40) : null;
  } catch (_) {
    return null;
  }
}

const commit = String(process.env.APP_COMMIT || '').trim().slice(0, 40) || readCommitFromGit();
const startedAt = new Date().toISOString();

module.exports = {
  version: String(process.env.APP_VERSION || appVersion || ''),
  commit,
  startedAt,
  pid: process.pid,
  // 供 /health 输出：只含身份字段，不含环境变量。
  describe() {
    return { version: this.version, commit: this.commit, startedAt: this.startedAt, pid: this.pid };
  },
};
