// 安全的 Excel 解析入口（主进程侧）：把同步、易挂、有已知漏洞的 xlsx 解析
// 放到独立子进程执行，并设置超时强杀 + 内存上限，避免恶意/畸形文件拖垮 Web 主进程。
const { spawn } = require('child_process');
const path = require('path');

function safeParseExcel(b64, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const worker = path.join(__dirname, 'excelParser.worker.js');
    const child = spawn(process.execPath, [worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 关闭继承的危险 NODE_OPTIONS，给子进程独立内存上限（Linux cgroup 生效，其它系统忽略无伤）
      env: Object.assign({}, process.env, { NODE_OPTIONS: '' }),
    });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    const timeoutMs = opts.timeoutMs || 15000;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      reject(new Error('Excel 解析超时，已终止'));
    }, timeoutMs);

    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!out) { reject(new Error(err ? err.toString().slice(0, 200) : 'Excel 解析无输出')); return; }
      try {
        const r = JSON.parse(out);
        if (r.error) return reject(new Error(r.error));
        resolve(r);
      } catch (e) {
        reject(new Error('Excel 解析结果异常'));
      }
    });

    child.stdin.write(JSON.stringify({ b64: b64, mode: opts.mode, contains: opts.contains }));
    child.stdin.end();
  });
}

module.exports = { safeParseExcel };
