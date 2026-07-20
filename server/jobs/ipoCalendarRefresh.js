const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(PROJECT_ROOT, 'ipo-report', 'ipo_daily_report.py');
let running = false;

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function nextIpoRefreshDelay(now = new Date()) {
  const p = shanghaiParts(now);
  const current = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offset));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 0, 0);
    if (target > current) return target - current;
  }
  return 24 * 60 * 60 * 1000;
}

function pythonCandidates() {
  const configured = process.env.IPO_PYTHON_PATH;
  const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const projectVenv = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'ipo-report', 'venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, 'ipo-report', 'venv', 'bin', 'python');
  return [configured, fs.existsSync(projectVenv) ? projectVenv : null, fs.existsSync(bundled) ? bundled : null,
    process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean);
}

function runWith(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', SCRIPT] : [SCRIPT];
    const child = spawn(executable, args, { cwd: PROJECT_ROOT, env: process.env, windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error || output || `exit ${code}`)));
  });
}

async function runIpoCalendarRefresh(reason = 'scheduled') {
  if (running) return { skipped: true };
  running = true;
  const errors = [];
  try {
    for (const executable of pythonCandidates()) {
      try {
        const output = await runWith(executable);
        console.log(`[ipo-calendar] ${reason} 更新完成 (${executable})`);
        return { ok: true, executable, output };
      } catch (error) { errors.push(`${executable}: ${error.message}`); }
    }
    throw new Error(errors.length ? errors.join(' | ') : '未找到可用的 Python 解释器');
  } finally { running = false; }
}

function scheduleIpoCalendarRefresh() {
  function scheduleNext() {
    const delay = nextIpoRefreshDelay();
    const timer = setTimeout(async () => {
      try { await runIpoCalendarRefresh('weekday-18:00'); }
      catch (error) { console.error('[ipo-calendar] 更新失败:', error.message); }
      scheduleNext();
    }, delay);
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[ipo-calendar] 已调度：工作日 18:00（上海时间）');
}

module.exports = { SCRIPT, nextIpoRefreshDelay, runIpoCalendarRefresh, scheduleIpoCalendarRefresh, pythonCandidates };
