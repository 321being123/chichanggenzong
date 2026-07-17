// 安全的 Excel 解析入口（主进程侧）：把同步、易挂、有已知漏洞的 xlsx 解析
// 放到独立子进程执行，并设置超时强杀 + 内存上限，避免恶意/畸形文件拖垮 Web 主进程。
const { spawn } = require('child_process');
const path = require('path');

function safeParseExcel(b64, opts) {
  opts = opts || {};
  // 输入上限：base64 字符串超过约 64MB（≈48MB 二进制）直接拒绝，避免把超大负载塞进子进程
  if (typeof b64 === 'string' && b64.length > 64 * 1024 * 1024) {
    return Promise.reject(new Error('Excel 文件过大，已拒绝'));
  }
  return new Promise((resolve, reject) => {
    const worker = path.join(__dirname, 'excelParser.worker.js');
    const child = spawn(process.execPath, ['--max-old-space-size=256', worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 关闭继承的危险 NODE_OPTIONS，给子进程独立内存上限（--max-old-space-size 真正生效）
      env: Object.assign({}, process.env, { NODE_OPTIONS: '' }),
    });

    const MAX_OUT = 16 * 1024 * 1024; // 子进程输出上限 16MB，超出直接强杀，防止输出撑爆主进程
    let out = '';
    let err = '';
    let outCapped = false;
    child.stdout.on('data', d => {
      if (outCapped) return;
      out += d;
      if (out.length > MAX_OUT) { outCapped = true; try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
    });
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
