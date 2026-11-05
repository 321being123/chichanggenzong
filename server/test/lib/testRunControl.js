// 同机测试运行控制（N0）：跨工作树资源互斥、独立监督超时与可核验释放。
//
// 设计边界（与方案 10.7 对应）：
//  - 锁放在仓库「公共 Git 目录」下，所有 worktree 读取同一处；不能各放本任务工作树（10.7 B）。
//  - 只按实际共享对象声明资源（PG 实例+库名、固定端口、共享目录），一次声明、按序领取、全有全无，
//    避免 A 占库等端口、B 占端口等库的死锁（10.7 B）。
//  - 释放要求 runId + ownerPid 双匹配；回收只在「能证明原持有进程已消失」时进行，PID 存活一律保守阻塞，
//    不按心跳超时、锁文件时间或上一聊天结束就抢跑（10.7 C）。
//  - 无法确认退出时阻塞并打印人工入口，不宣称自动恢复成功。
//  - 状态记录不含密码、Token 或完整敏感连接串。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

function gitCommonDir() {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
    });
    if (r.status === 0) {
      const raw = String(r.stdout || '').trim();
      if (raw) return path.resolve(REPO_ROOT, raw);
    }
  } catch (_) { /* 无 git 时退回临时目录 */ }
  return null;
}

// 受保护的本机控制目录：优先仓库公共 Git 目录（worktree 共享），否则按仓库路径哈希落到临时目录。
function resolveControlRoot() {
  if (process.env.TEST_CONTROL_ROOT) return path.resolve(process.env.TEST_CONTROL_ROOT);
  const common = gitCommonDir();
  if (common) return path.join(common, 'test-control');
  return path.join(os.tmpdir(), 'portfolio-test-control-' + sha1(REPO_ROOT).slice(0, 12));
}

const CONTROL_ROOT = resolveControlRoot();
const LOCK_DIR = path.join(CONTROL_ROOT, 'locks');
const RUN_DIR = path.join(CONTROL_ROOT, 'runs');

function ensureDirs() {
  for (const dir of [CONTROL_ROOT, LOCK_DIR, RUN_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function newRunId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return prefix + '-' + stamp + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
}

// ---- 资源标识（都不允许带密码） ----

function pgResource(database) {
  const db = String(database || '').replace(/[^a-zA-Z0-9_]/g, '_');
  const host = process.env.PGHOST || 'localhost';
  const port = String(process.env.PGPORT || 5432);
  return 'pg:' + host + ':' + port + '/' + db;
}

function dirResource(absPath) {
  return 'dir:' + path.resolve(absPath);
}

function portResource(port) {
  return 'port:' + String(port);
}

function lockPath(resource) {
  return path.join(LOCK_DIR, sha1(resource).slice(0, 24) + '.lock');
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readLock(resource) {
  try {
    const raw = fs.readFileSync(lockPath(resource), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

// ---- 本轮子进程登记（R2：父进程消失不等于测试已停） ----
// 父入口崩溃后，它 spawn 的 Node/Python 子进程仍可能连着测试库继续跑。
// 只凭「父 PID 不存在」就回收资源，会和这些遗留测试重叠。所以本轮创建的子进程
// 必须登记下来，回收前逐个确认已退出；确认不了就阻塞，不猜。

function runRecordPath(runId) {
  return path.join(RUN_DIR, sha1(runId).slice(0, 24) + '.json');
}

function readRunRecord(runId) {
  try {
    const data = JSON.parse(fs.readFileSync(runRecordPath(runId), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, payload) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function writeRunRecord(runId, patch) {
  ensureDirs();
  const current = readRunRecord(runId) || { runId, children: [] };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(runRecordPath(runId), next);
  return next;
}

/** 登记一个本轮创建的子进程（pid + 启动时刻 + 说明），同时把快照冗余进持有的锁。 */
function registerChild(runId, pid, label = '') {
  const n = Number(pid);
  if (!runId || !Number.isInteger(n) || n <= 0) return null;
  const record = readRunRecord(runId) || { runId, children: [] };
  const children = Array.isArray(record.children) ? record.children.slice() : [];
  if (!children.some(c => Number(c.pid) === n)) {
    children.push({ pid: n, label: String(label || ''), startedAt: new Date().toISOString() });
  }
  const next = writeRunRecord(runId, { children });
  // 锁里冗余一份：即使 run 记录丢失，回收判定也不会因为「读不到子进程」而误判安全。
  for (const resource of next.resources || []) {
    const lock = readLock(resource);
    if (lock && lock.runId === runId) {
      try { writeJsonAtomic(lockPath(resource), { ...lock, children }); } catch (_) { /* 诊断信息写失败不影响持有 */ }
    }
  }
  return next;
}

function unregisterChild(runId, pid) {
  const n = Number(pid);
  if (!runId || !Number.isInteger(n)) return null;
  const record = readRunRecord(runId);
  if (!record) return null;
  const children = (Array.isArray(record.children) ? record.children : []).filter(c => Number(c.pid) !== n);
  const next = writeRunRecord(runId, { children });
  for (const resource of next.resources || []) {
    const lock = readLock(resource);
    if (lock && lock.runId === runId) {
      try { writeJsonAtomic(lockPath(resource), { ...lock, children }); } catch (_) { /* 同上 */ }
    }
  }
  return next;
}

function pidSet(list) {
  return new Set((list || []).map(c => Number(c && c.pid)).filter(n => Number.isInteger(n) && n > 0));
}

function unionChildren(list) {
  const seen = new Set();
  const out = [];
  for (const item of (list || [])) {
    const pid = Number(item && item.pid);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    out.push({ pid, label: (item && item.label) || '' });
  }
  return out;
}

/**
 * 统一解析「本轮登记了哪些子进程」——释放、回收、人工入口共用这一个入口。
 *
 * 2026-11-03 第三轮验收发现的缺陷：release() 只读主登记，主登记文件丢失或 JSON 损坏时
 * readRunRecord 返回 null，于是 children 退化成 []，「不知道」被当成「确认没有子进程」，
 * 锁被误删——可锁文件里其实还记着存活的子进程。
 *
 * 四种情况必须分开，任何「不知道」都要阻塞：
 *   ① 主登记可读 → 用它；与锁内冗余不一致时取并集（宁可多拦，不可漏放）
 *   ② 主登记缺失/损坏、锁内冗余可读 → 用锁内并集
 *   ③ 两处都未知 → known:false（调用方必须阻塞）
 *   ④ 两处矛盾 → known:true + merged_conflict，仍按并集判定
 */
function resolveChildRegistry(runId, lockRecords) {
  const runRecord = readRunRecord(runId);
  const runChildren = (runRecord && Array.isArray(runRecord.children)) ? runRecord.children : null;

  const snapshotChildren = [];
  let lockPresent = 0;
  let lockUnknown = false;
  for (const record of (lockRecords || [])) {
    if (!record) continue;
    lockPresent += 1;
    if (Array.isArray(record.children)) snapshotChildren.push(...record.children);
    else lockUnknown = true; // 这段登记缺失的锁不能用来证明安全
  }

  if (runChildren) {
    const runPids = pidSet(runChildren);
    const snapPids = pidSet(snapshotChildren);
    const conflict = snapshotChildren.length > 0 &&
      (runPids.size !== snapPids.size || [...runPids].some(pid => !snapPids.has(pid)));
    return {
      known: true,
      children: unionChildren([...runChildren, ...snapshotChildren]),
      source: conflict ? 'merged_conflict' : 'run_record',
    };
  }
  if (snapshotChildren.length) {
    return { known: true, children: unionChildren(snapshotChildren), source: 'lock_snapshot' };
  }
  if (lockUnknown) return { known: false, reason: 'lock_registry_unreadable' };
  if (lockPresent > 0) return { known: true, children: [], source: 'lock_empty' };
  return { known: false, reason: 'run_record_unreadable' };
}

function aliveFromRegistry(registry) {
  return registry.children.filter(c => isProcessAlive(c.pid)).map(c => Number(c.pid));
}

/** 该 run 登记过、且当前仍存活的子进程；null 表示无法确认（调用方必须阻塞）。 */
function aliveChildrenOf(runId, lockRecord) {
  const registry = resolveChildRegistry(runId, lockRecord ? [lockRecord] : []);
  if (!registry.known) return null;
  return aliveFromRegistry(registry);
}

/**
 * 回收前的安全判定（R2 核心）：父进程消失只是必要条件，不是充分条件。
 * 返回 { ok:false, reason } 时一律阻塞。
 */
function canReclaim(record) {
  if (!record) return { ok: false, reason: 'lock_unreadable' };
  if (isProcessAlive(record.ownerPid)) return { ok: false, reason: 'owner_alive' };
  const alive = aliveChildrenOf(record.runId, record);
  if (alive === null) return { ok: false, reason: 'ownership_unknown' };
  if (alive.length) return { ok: false, reason: 'children_alive', pids: alive };
  return { ok: true };
}

function readRawLock(resource) {
  try { return fs.readFileSync(lockPath(resource), 'utf8'); } catch (_) { return null; }
}

function describeOwner(record) {
  if (!record) return '(锁记录无法解析)';
  const waited = record.startedAt ? Math.round((Date.now() - Date.parse(record.startedAt)) / 1000) : '?';
  return 'runId=' + record.runId + ' pid=' + record.ownerPid + ' 说明=' + (record.label || '-') +
    ' 已持锁=' + waited + 's';
}

// 为什么没回收：让等待日志能直接看出「父进程已死但子进程还活着」这类真正的原因，
// 而不是只显示「被 xxx 占用」让人误以为是活着的持有者。
function describeBlockReason(verdict) {
  const reason = verdict && verdict.reason;
  if (reason === 'children_alive') return '（原持有进程已退出，但它登记的子进程仍存活：' + (verdict.pids || []).join(',') + '，未回收）';
  if (reason === 'ownership_unknown') return '（原持有进程已退出，但读不到它登记的子进程，无法确认安全，未回收）';
  if (reason === 'lock_unreadable') return '（锁记录无法解析，未回收）';
  if (reason === 'reclaim_race') return '（回收时被其他运行抢先，重新排队）';
  if (reason === 'verify_failed') return '（领取后复核发现锁不属于本次运行，已回退重试）';
  if (reason === 'race') return '（与其他运行同时创建锁，重新排队）';
  return '';
}

// 回收只允许在「原持有 PID 已不存在」时进行；先把锁改名再核对内容，
// 防止另一个等待者刚好抢到新锁时被误删。
function tryReclaim(resource, observedRunId) {
  const lp = lockPath(resource);
  const stale = lp + '.stale.' + process.pid + '.' + Date.now();
  try {
    fs.renameSync(lp, stale);
  } catch (_) {
    return false;
  }
  let moved = null;
  try { moved = JSON.parse(fs.readFileSync(stale, 'utf8')); } catch (_) { moved = null; }
  if (moved && observedRunId && moved.runId !== observedRunId) {
    try { fs.renameSync(stale, lp); } catch (_) { /* 还原失败按残留处理 */ }
    return false;
  }
  try { fs.unlinkSync(stale); } catch (_) { /* 已删除 */ }
  // 原持有者已确认退出，它的登记记录一并清掉，避免下一轮把旧子进程当成活的。
  if (moved && moved.runId) {
    try { fs.unlinkSync(runRecordPath(moved.runId)); } catch (_) { /* 无记录 */ }
  }
  return true;
}

/**
 * 领取一组资源（全有或全无）。
 * @returns {Promise<{runId,waitMs,release}>}
 */
async function acquireLock(options) {
  ensureDirs();
  const runId = options.runId || newRunId(options.prefix || 'run');
  const label = options.label || 'test';
  const waitTimeoutMs = Number.isFinite(options.waitTimeoutMs) ? options.waitTimeoutMs : 30 * 60 * 1000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 500;
  const statusEveryMs = Number.isFinite(options.statusEveryMs) ? options.statusEveryMs : 15000;
  const log = options.log || console.log;
  const resources = Array.from(new Set(options.resources || [])).sort();
  if (!resources.length) throw new Error('acquireLock 需要至少一个资源');

  const record = {
    runId,
    ownerPid: process.pid,
    // 所有权令牌：区分「同一 PID 被系统复用」与「真的是本轮持有者」。
    ownerToken: crypto.randomBytes(6).toString('hex'),
    label,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    host: os.hostname(),
    repoRoot: REPO_ROOT,
    children: [],
  };

  const acquired = [];
  let retained = null;
  /**
   * 唯一的安全释放判据（2026-11-02 第二轮验收）：exit 钩子、finally、watchdog、人工释放都要走这里。
   * 只要本轮登记的子进程还有存活，就**不删锁**——修前 exit 钩子无条件 release，
   * 入口明明打印了「保留资源占用」，锁却已经被删掉，下一轮会直接进来和遗留测试重叠。
   * @returns {null|{reason:string,pids:number[]}} null=已释放；非 null=被保留的原因
   */
  const release = (options = {}) => {
    if (!options.force) {
      const items = acquired.map(resource => ({ resource, record: readLock(resource) }));
      // 统一判据：主登记读不到时回退锁内冗余；两处都读不到算「不知道」，照样阻塞。
      const registry = resolveChildRegistry(runId, items.map(i => i.record).filter(Boolean));
      const markRetained = info => {
        for (const item of items) {
          if (item.record && item.record.runId === runId) {
            try { writeJsonAtomic(lockPath(item.resource), { ...item.record, retainedReason: info }); } catch (_) { /* 留痕失败不影响持有 */ }
          }
        }
      };
      if (!registry.known) {
        retained = { reason: 'ownership_unknown', detail: registry.reason, pids: [] };
        markRetained(retained);
        return retained;
      }
      const alive = aliveFromRegistry(registry);
      if (alive.length) {
        retained = { reason: 'children_alive', pids: alive, source: registry.source };
        markRetained(retained);
        return retained;
      }
    }
    retained = null;
    for (const resource of acquired.splice(0)) {
      const current = readLock(resource);
      if (current && current.runId === runId && Number(current.ownerPid) === process.pid) {
        try { fs.unlinkSync(lockPath(resource)); } catch (_) { /* 已被清理 */ }
      }
    }
    // 正常释放：没有遗留子进程就删掉本轮登记，避免记录无限累积。
    // 登记文件本身损坏时也一并清掉——它已无证据价值，留着只会让下一轮误判「所有权未知」。
    const runRecord = readRunRecord(runId);
    if (runRecord && Array.isArray(runRecord.children) && runRecord.children.length === 0) {
      try { fs.unlinkSync(runRecordPath(runId)); } catch (_) { /* 无记录 */ }
    }
    return null;
  };
  const releaseOnExit = () => release();

  const startedAt = Date.now();
  let lastStatusAt = 0;
  let announcedWait = false;

  try {
    for (;;) {
      let blockedBy = null;
      for (const resource of resources) {
        // 单资源内部重试：回收失主残留之后必须重新读锁、重新走一次原子创建（R1）。
        // 修前这里回收完直接 continue 到下一个资源，最后一个资源回收后循环结束、
        // 磁盘上没有新锁，却返回「领取成功」——两个运行会同时进入。
        for (;;) {
          const current = readLock(resource);
          if (current) {
            const verdict = canReclaim(current);
            if (verdict.ok) {
              const reclaimed = tryReclaim(resource, current.runId);
              if (reclaimed) {
                log('[测试资源] 回收失主残留：' + resource + '（' + describeOwner(current) + '）');
                continue; // 重新读 → 重新创建，不自认为已持有
              }
              blockedBy = { resource, current: readLock(resource) || current, verdict: { reason: 'reclaim_race' } };
              break;
            }
            blockedBy = { resource, current, verdict };
            break;
          }
          let fd;
          try {
            fd = fs.openSync(lockPath(resource), 'wx');
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // 竞争：别人刚建
            blockedBy = { resource, current: readLock(resource), verdict: { reason: 'race' } };
            break;
          }
          try {
            fs.writeSync(fd, JSON.stringify({ ...record, resource, children: [], heartbeatAt: new Date().toISOString() }, null, 2));
          } finally {
            fs.closeSync(fd);
          }
          acquired.push(resource);
          break;
        }
        if (blockedBy) break;
      }

      if (!blockedBy) {
        // 领取完成必须复核：每个资源都真的归本次 run 所有（R1 验收：单资源、多资源都要核）。
        const missing = resources.filter(resource => {
          const lock = readLock(resource);
          return !lock || lock.runId !== runId || Number(lock.ownerPid) !== process.pid
            || String(lock.ownerToken || '') !== record.ownerToken;
        });
        if (!missing.length) break;
        release();
        blockedBy = { resource: missing[0], current: readLock(missing[0]), verdict: { reason: 'verify_failed' } };
      }

      // 部分领取必须全部回退，避免死锁
      release();

      const waited = Date.now() - startedAt;
      if (waited > waitTimeoutMs) {
        const error = new Error('等待测试资源超时（' + Math.round(waitTimeoutMs / 1000) + 's）：' +
          blockedBy.resource + ' 被 ' + describeOwner(blockedBy.current) + ' 占用；本次未执行任何测试');
        error.code = 'TEST_RESOURCE_WAIT_TIMEOUT';
        error.resource = blockedBy.resource;
        throw error;
      }
      if (!announcedWait) {
        log('[测试资源] 等待：' + blockedBy.resource + ' 被 ' + describeOwner(blockedBy.current) + ' 占用' +
          describeBlockReason(blockedBy.verdict) + '；' +
          '已排队，上限 ' + Math.round(waitTimeoutMs / 1000) + 's。人工入口：node server/test/testctl.js status');
        announcedWait = true;
        lastStatusAt = Date.now();
      } else if (Date.now() - lastStatusAt >= statusEveryMs) {
        log('[测试资源] 仍在等待 ' + Math.round(waited / 1000) + 's：' + blockedBy.resource +
          describeBlockReason(blockedBy.verdict));
        lastStatusAt = Date.now();
      }
      await sleep(pollMs);
    }
  } catch (error) {
    release();
    throw error;
  }

  // 持有期间心跳仅用于诊断，不作为释放依据
  const heartbeat = setInterval(() => {
    for (const resource of acquired) {
      const current = readLock(resource);
      if (!current || current.runId !== runId) continue;
      try {
        fs.writeFileSync(lockPath(resource), JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() }, null, 2));
      } catch (_) { /* 诊断信息写失败不影响持有 */ }
    }
  }, 2000);
  if (heartbeat.unref) heartbeat.unref();

  // 落本轮登记（含资源清单与所有权令牌）：registerChild 要靠它把子进程写进锁，
  // 回收判定也要靠它区分「父死了但测试还在跑」与「父死了且测试已停」。
  writeRunRecord(runId, {
    label,
    ownerPid: process.pid,
    ownerToken: record.ownerToken,
    resources,
    children: [],
    repoRoot: REPO_ROOT,
  });

  process.once('exit', releaseOnExit);

  let finished = false;
  // 只有「真的释放成功」才算结束；被保留时保持可重试，等子进程退出后再调用就能清掉。
  const releaseOnce = () => {
    if (finished) return null;
    const outcome = release();
    if (outcome) return outcome;
    finished = true;
    clearInterval(heartbeat);
    process.removeListener('exit', releaseOnExit);
    return null;
  };

  return { runId, waitMs: Date.now() - startedAt, resources, release: releaseOnce, forceRelease: () => release({ force: true }) };
}

/**
 * 子进程复用父入口已持有的授权：必须同时满足 env 声明的 runId/PID 与锁文件内容一致，
 * 且该 PID 仍存活；不接受仅凭一个「已加锁」标志。
 */
function inheritRunContext(options = {}) {
  const runId = process.env.TEST_RUN_ID;
  const ownerPid = Number(process.env.TEST_RUN_LOCK_OWNER_PID || 0);
  if (!runId || !ownerPid) return null;
  if (!isProcessAlive(ownerPid)) return null;
  const resources = options.resources || [];
  for (const resource of resources) {
    const current = readLock(resource);
    if (!current || current.runId !== runId || Number(current.ownerPid) !== ownerPid) return null;
  }
  return { runId, ownerPid, resources };
}

function statusAll() {
  ensureDirs();
  const files = fs.readdirSync(LOCK_DIR).filter(f => f.endsWith('.lock'));
  return files.map(file => {
    const resource = null;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, file), 'utf8')); } catch (_) { data = null; }
    return {
      file,
      resource: (data && data.resource) || resource || file.replace(/\.lock$/, ''),
      record: data,
      ownerAlive: data ? isProcessAlive(data.ownerPid) : false,
    };
  });
}

function releaseByRunId(runId) {
  ensureDirs();
  const items = statusAll().filter(item => item.record && item.record.runId === runId);
  if (!items.length) return { released: [], blocked: [] };

  // 人工释放与自动释放共用同一判据：先看持有进程，再统一解析登记（含锁内冗余），
  // 任何「不知道」都阻塞——不能因为主登记文件坏了就当成没子进程。
  if (items.some(item => isProcessAlive(item.record.ownerPid))) {
    return { released: [], blocked: items.map(i => ({ resource: i.resource, reason: 'owner_alive' })) };
  }
  const registry = resolveChildRegistry(runId, items.map(i => i.record));
  if (!registry.known) {
    return {
      released: [],
      blocked: items.map(i => ({ resource: i.resource, reason: 'ownership_unknown', detail: registry.reason })),
    };
  }
  const alive = aliveFromRegistry(registry);
  if (alive.length) {
    return { released: [], blocked: items.map(i => ({ resource: i.resource, reason: 'children_alive', pids: alive })) };
  }
  const released = [];
  for (const item of items) {
    try {
      fs.unlinkSync(path.join(LOCK_DIR, item.file));
      released.push(item.resource);
    } catch (_) { /* ignore */ }
  }
  if (released.length === items.length) {
    try { fs.unlinkSync(runRecordPath(runId)); } catch (_) { /* 无记录 */ }
  }
  return { released, blocked: [] };
}

/** 终止整棵进程树（含 Node/Python 启动的孙进程），不按进程名全局结束。 */
function killProcessTree(pid, options = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { killed: false, method: 'none' };
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    return {
      killed: !isProcessAlive(n),
      method: 'taskkill /T /F',
      output: ((r.stdout || '') + (r.stderr || '')).trim(),
    };
  }
  return killProcessTreeSyncPosix(n, options);
}

/**
 * POSIX 同步版：仅供同步上下文（进程退出钩子、测试清理）兜底使用。
 * 正常监督路径必须走 killProcessTreeAsync —— 同步忙等会让本进程无法处理子进程退出事件，
 * 也无法确认「本轮进程组是否真的清空」。
 */
function killProcessTreeSyncPosix(n, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 3000;
  signalTarget(n, options, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targetAlive(n, options)) sleepSync(200);
  if (targetAlive(n, options)) {
    signalTarget(n, options, 'SIGKILL');
    sleepSync(200);
  }
  return { killed: !targetAlive(n, options), method: options.group ? 'group SIGTERM/SIGKILL' : 'SIGTERM/SIGKILL' };
}

/**
 * POSIX 异步版（F14）：先发 SIGTERM 给**本轮进程组**，用有界轮询等组内全部退出，
 * 再升级 SIGKILL；整个过程不阻塞事件循环，所以子进程的 exit/close 事件照常被处理。
 */
async function killProcessTreeAsync(pid, options = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { killed: false, method: 'none' };
  if (process.platform === 'win32') return killProcessTree(n, options);
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 3000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 100;
  signalTarget(n, options, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && targetAlive(n, options)) await sleep(pollMs);
  let method = options.group ? 'group SIGTERM' : 'SIGTERM';
  if (targetAlive(n, options)) {
    signalTarget(n, options, 'SIGKILL');
    method = options.group ? 'group SIGKILL' : 'SIGKILL';
    const killDeadline = Date.now() + Math.max(pollMs * 5, 1000);
    while (Date.now() < killDeadline && targetAlive(n, options)) await sleep(pollMs);
  }
  return { killed: !targetAlive(n, options), method };
}

/** 目标存活判定：优先按进程组（-pid），没有进程组时退回单 PID。 */
function targetAlive(n, options = {}) {
  if (options.group && process.platform !== 'win32') {
    try { process.kill(-n, 0); return true; } catch (error) {
      if (error.code === 'EPERM') return true;
      // ESRCH：进程组已不存在，再兜底看单 PID，避免"组不在但进程还在"被误判已清空。
      return isProcessAlive(n);
    }
  }
  return isProcessAlive(n);
}

function signalTarget(n, options = {}, signalName) {
  if (options.group && process.platform !== 'win32') {
    try { process.kill(-n, signalName); return; } catch (_) { /* 无该进程组 → 退回单 PID */ }
  }
  try { process.kill(n, signalName); } catch (_) { /* 已退出 */ }
}

/**
 * 独立监督一个子进程：外部计时（不受子进程事件循环卡死影响），超时后停整棵进程树。
 */
function spawnWithTimeout(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5 * 60 * 1000;
  // F14：POSIX 上让子进程自成一个进程组（detached 只影响进程组，不影响 stdio 管道），
  // 这样超时终止可以精准结束"本轮这一组"，既能带走孙进程，又不会波及别人的进程。
  const useGroup = process.platform !== 'win32';
  return new Promise(resolve => {
    const startedAt = Date.now();
    let out = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: useGroup,
    });
    const append = chunk => {
      out += chunk.toString('utf8');
      if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // 交给调用方登记子进程（R2）：父入口若崩溃，回收判定要靠这份登记确认子进程已退出。
    if (typeof options.onSpawn === 'function') {
      try { options.onSpawn(child.pid); } catch (_) { /* 登记失败不能拖垮本次执行 */ }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // 先标记超时再异步终止：终止期间 close 事件可能先到，finish 的 settled 保护会把结果收敛为一次。
      killProcessTreeAsync(child.pid, { group: useGroup })
        .then(kill => finish({ status: null, signal: 'TIMEOUT', timedOut: true, treeKill: kill }))
        .catch(error => finish({ status: null, signal: 'TIMEOUT', timedOut: true, treeKill: { killed: false, method: 'error', output: error.message } }));
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, out, durationMs: Date.now() - startedAt, pid: child.pid });
    }

    child.on('error', error => finish({ status: null, signal: null, spawnError: error.message, timedOut }));
    child.on('close', (code, signal) => finish({ status: code, signal, timedOut }));
  });
}

module.exports = {
  REPO_ROOT,
  CONTROL_ROOT,
  LOCK_DIR,
  RUN_DIR,
  newRunId,
  ensureDirs,
  pgResource,
  dirResource,
  portResource,
  lockPath,
  isProcessAlive,
  acquireLock,
  inheritRunContext,
  statusAll,
  releaseByRunId,
  killProcessTree,
  killProcessTreeAsync,
  spawnWithTimeout,
  describeOwner,
  describeBlockReason,
  // R2：子进程登记与回收安全判定
  registerChild,
  unregisterChild,
  canReclaim,
  aliveChildrenOf,
  readRunRecord,
  runRecordPath,
};
