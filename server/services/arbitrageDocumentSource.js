// 套利公告 PDF 正文的 Python 解析桥接（外部取数与解析执行，不含业务判定）。
// 从 server/services/arbitrageParser.js 抽出，供解析服务与分红事实采集共用。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'extractArbitrageDocument.py');

// 复用项目已有的 Python 定位逻辑（与 marketVolatilitySync / convertibleBondAnalysis 一致）：
// 优先 PYTHON 环境变量，其次项目内 venv（root/venv 或 ipo-report/venv，Windows/类 Unix），最后退回 PATH。
function resolvePython() {
  const root = path.resolve(__dirname, '..', '..');
  const candidates = [
    process.env.PYTHON,
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'bin', 'python'),
    path.join(root, 'ipo-report', 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'ipo-report', 'venv', 'bin', 'python'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'python.exe' : 'python3'; // 退回 PATH
}

// 调用 Python 解析器提取单条公告 URL 的条款
// targetCode: 目标证券代码（如 A 股换股吸收合并中的被吸收合并方），帮助解析器选择正确的换股价格
function runPythonExtraction(url, targetCode, { rawText = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(url)) return reject(new Error('only http(s) urls are supported'));
    const py = resolvePython();
    const args = [SCRIPT, url];
    if (targetCode) args.push('--target-code', String(targetCode));
    if (rawText) args.push('--raw-text');
    const child = spawn(py, args, {
      cwd: path.resolve(__dirname, '..', '..'),
      env: childProcessEnv({ PYTHONUTF8: '1' }),
      windowsHide: true,
      timeout: 120000,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      mergeExternalCallStatsFromStderr(err);
      if (!out.trim()) return reject(new Error('parser empty output (code ' + code + '): ' + err.slice(0, 300)));
      try {
        const json = JSON.parse(out);
        if (json.error) {
          const message = String(json.error);
          const typed = message.match(/\[(BUDGET_WAIT|RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|POLICY_NOT_CONFIGURED|POLICY_DISABLED|PERMISSION_DENIED)\]\[([^\]]+)\](?:\[([^\]]+)\])?/i);
          const error = new Error(message);
          if (typed) {
            error.code = typed[1].toUpperCase();
            error.errorType = ['BUDGET_WAIT', 'RATE_LIMIT', 'QUOTA_EXHAUSTED'].includes(error.code) ? 'rate_limit' : 'circuit_open';
            error.source = typed[2];
            error.apiName = typed[3] || '*';
          }
          if (json.error_code) error.code = String(json.error_code).toUpperCase();
          if (json.error_type) error.errorType = String(json.error_type);
          if (json.source) error.source = String(json.source);
          if (json.api_name) error.apiName = String(json.api_name);
          if (json.recover_at) error.recoverAt = json.recover_at;
          return reject(error);
        }
        resolve(json);
      } catch (e) {
        reject(new Error('parser output not JSON: ' + out.slice(0, 300)));
      }
    });
  });
}

module.exports = { resolvePython, runPythonExtraction };
