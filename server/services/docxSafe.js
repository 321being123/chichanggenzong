const { spawn } = require('child_process');
const path = require('path');
const { assertSafeZip } = require('./zipSafety');

const MAX_ACTIVE = 2;
const MAX_PENDING = 10;
let active = 0;
const queue = [];

function parseInWorker(buffer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', path.join(__dirname, 'docxParser.worker.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { NODE_OPTIONS: '' }),
    });
    let output = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      finish(reject, new Error('DOCX 解析超时，已终止'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 8 * 1024 * 1024) {
        try { child.kill('SIGKILL'); } catch (e) {}
        finish(reject, new Error('DOCX 解析结果过大'));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', e => finish(reject, e));
    child.on('close', () => {
      if (settled) return;
      try {
        const result = JSON.parse(output || '{}');
        if (result.error) return finish(reject, new Error(result.error));
        if (typeof result.content !== 'string') return finish(reject, new Error('DOCX 解析结果异常'));
        finish(resolve, result.content);
      } catch (e) {
        finish(reject, new Error('DOCX 解析结果异常'));
      }
    });
    child.stdin.end(JSON.stringify({ b64: buffer.toString('base64') }));
  });
}

function drain() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active++;
    parseInWorker(job.buffer, job.timeoutMs).then(job.resolve, job.reject).finally(() => {
      active--;
      drain();
    });
  }
}

function safeParseDocx(buffer, options) {
  options = options || {};
  if (!Buffer.isBuffer(buffer) || buffer.length > 15 * 1024 * 1024) {
    return Promise.reject(new Error('DOCX 文件过大或无效'));
  }
  try {
    assertSafeZip(buffer, { label: 'DOCX', maxUncompressed: 50 * 1024 * 1024, maxEntries: 5000, maxRatio: 200 });
  } catch (e) {
    return Promise.reject(e);
  }
  if (queue.length >= MAX_PENDING) return Promise.reject(new Error('DOCX 解析繁忙，请稍后重试'));
  return new Promise((resolve, reject) => {
    queue.push({ buffer, timeoutMs: options.timeoutMs || 15000, resolve, reject });
    drain();
  });
}

module.exports = { safeParseDocx };
