// 栏目脚本懒加载：失败必须退避重试、且不得把失败结果永久缓存（0.8.4.25）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'shared', 'lazy-sections.js'), 'utf8');
const BASE = 'https://example.test/';
const SRC = BASE + 'js/feedback.js?v=0.8.4.20';

function boot(failUntil) {
  // failUntil：前 N 次注入失败，之后成功；用于模拟发版窗口内的短暂 404。
  const state = { attempts: 0, failUntil };
  const appended = [];
  const tag = { getAttribute: () => 'js/feedback.js?v=0.8.4.20' };
  const document = {
    head: {
      appendChild(el) {
        appended.push(el);
        state.attempts += 1;
        const fail = state.attempts <= state.failUntil;
        if (fail) { if (el.onerror) el.onerror(); } else if (el.onload) el.onload();
      }
    },
    createElement() { return { parentNode: null }; },
    querySelectorAll() { return [tag]; },
    querySelector() { return tag; },
    baseURI: BASE
  };
  const sandbox = { window: {}, document, Promise, Error, URL, console, setTimeout: (fn) => { fn(); return 0; } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { lazy: sandbox.window.LazySections, state, urls: () => appended.map((el) => el.src) };
}

(async () => {
  // 一次成功：不发多余请求，地址保持原样
  const ok = boot(0);
  await ok.lazy.ensureSection('feedback');
  assert.deepStrictEqual(ok.urls(), [SRC], '首次成功不应改写地址');

  // 连续两次失败后成功：共 3 次请求，重试地址带 retry 绕开旧 ?v 的强缓存
  const retried = boot(2);
  await retried.lazy.ensureSection('feedback');
  assert.strictEqual(retried.state.attempts, 3, '失败应按退避重试两次');
  assert.deepStrictEqual(retried.urls(), [SRC, SRC + '&retry=1', SRC + '&retry=2']);

  // 全部失败：如实拒绝，且失败结果不被缓存，再次进入栏目会重新尝试
  const failing = boot(99);
  await assert.rejects(failing.lazy.ensureSection('feedback'), /脚本加载失败/);
  const attemptsAfterFailure = failing.state.attempts;
  assert.strictEqual(attemptsAfterFailure, 3, '三次全失败后放弃');
  failing.state.failUntil = failing.state.attempts; // 让下一次注入成功
  await failing.lazy.ensureSection('feedback');
  assert.strictEqual(failing.state.attempts, attemptsAfterFailure + 1, '失败后不得复用失败的 Promise');

  // 同一栏目并发进入只加载一次
  const once = boot(0);
  await Promise.all([once.lazy.ensureSection('feedback'), once.lazy.ensureSection('feedback')]);
  assert.strictEqual(once.state.attempts, 1, '同一脚本只注入一次');

  // 页面本身必须回源校验，否则旧页面会长期停留在旧版本号
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(/ext === '' \|\| ext === '\.html'[\s\S]{0,160}no-cache, must-revalidate/.test(appSource),
    '页面响应必须带 no-cache 回源校验');

  console.log('LAZY-SECTIONS-RETRY: 失败重试、缓存清理、去重与页面回源校验通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
