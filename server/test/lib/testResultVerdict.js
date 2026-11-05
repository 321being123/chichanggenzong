// 单个测试子进程的结果裁决（F11）。
//
// 修复前 run-all.js 先匹配 stdout 里的 `[SKIP]`，再看退出码：一个「退出码 1 + 输出里带 [SKIP]」
// 的文件会被记成跳过，本地最终只按 fail 数决定退出码，于是假绿放行。
// 正确顺序是「客观执行状态优先，文本标记最后」：
//   超时 → 启动失败(spawnError) → 被信号结束(无退出码) → 非零退出 → 正常退出后才识别跳过。
// 这个模块是纯函数，反例测试直接调用，不需要真起进程。

// 跳过标记必须出现在行首（允许前导空格），不做全文任意位置匹配。
// 修复前用 /\[SKIP\]/ 全文匹配：一条"断言输出含 [SKIP] 时判失败"的用例，
// 它的用例名里带 [SKIP]，于是整份文件被误判成跳过——正常的断言文字被当成了执行结果。
const SKIP_PATTERN = /^[ \t]*\[SKIP/m;

/**
 * @param {{status?:number|null, signal?:string|null, timedOut?:boolean, spawnError?:string|null}} result
 * @param {string} [output] 子进程 stdout+stderr 合并文本
 * @returns {{verdict:'timeout'|'spawn_error'|'signal'|'fail'|'partial_skip'|'pass', detail:string|null}}
 */
function classifyTestResult(result, output) {
  const r = result || {};
  if (r.timedOut) return { verdict: 'timeout', detail: null };
  if (r.spawnError) return { verdict: 'spawn_error', detail: String(r.spawnError) };
  if (typeof r.status !== 'number') {
    // 关闭事件只给了信号（如 SIGKILL/TIMEOUT 之外的外部终止）时没有退出码，
    // 不能因为没有退出码就当成"没失败"。
    return { verdict: 'signal', detail: r.signal ? String(r.signal) : null };
  }
  if (r.status !== 0) return { verdict: 'fail', detail: 'exit_' + r.status };
  // 到这里才轮到"正常退出"的文本判定。
  if (SKIP_PATTERN.test(String(output || ''))) return { verdict: 'partial_skip', detail: null };
  return { verdict: 'pass', detail: null };
}

/** 退出码是否表示"客观失败"（供汇总时快速判断，不含跳过语义）。 */
function isHardFailure(result) {
  const verdict = classifyTestResult(result, '').verdict;
  return verdict === 'timeout' || verdict === 'spawn_error' || verdict === 'signal' || verdict === 'fail';
}

module.exports = { classifyTestResult, isHardFailure, SKIP_PATTERN };
