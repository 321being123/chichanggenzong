// 测试资源占用的人工查看/释放入口（N0-C：无法确认退出时给出人工处理入口，不做自动抢跑）。
// 用法：
//   node server/test/testctl.js status              查看当前占用
//   node server/test/testctl.js release --run-id=<id>  仅回收「持有进程已消失」的记录
'use strict';

const runControl = require('./lib/testRunControl');

const args = process.argv.slice(2);
const command = args[0] || 'status';
const runIdArg = (args.find(a => a.startsWith('--run-id=')) || '').split('=')[1];

if (command === 'status') {
  const items = runControl.statusAll();
  console.log('控制目录：' + runControl.CONTROL_ROOT);
  if (!items.length) {
    console.log('当前没有测试资源占用记录。');
    process.exit(0);
  }
  for (const item of items) {
    const verdict = runControl.canReclaim(item.record);
    console.log('- ' + item.resource + ' · ' + runControl.describeOwner(item.record) +
      ' · ' + (verdict.ok ? '可回收（持有进程与其子进程都已退出）'
        : '不可回收（' + runControl.describeBlockReason(verdict).replace(/^（|）$/g, '') + '）'));
  }
  process.exit(0);
}

if (command === 'release') {
  if (!runIdArg) {
    console.error('必须显式指定 --run-id=<id>；本命令只回收「持有进程与其登记子进程都已退出」的记录。');
    process.exit(2);
  }
  const outcome = runControl.releaseByRunId(runIdArg);
  if (outcome.released.length) console.log('已回收：' + outcome.released.join('、'));
  if (outcome.blocked.length) {
    for (const item of outcome.blocked) {
      console.log('未回收：' + item.resource + '（' + item.reason +
        (item.pids && item.pids.length ? '，子进程仍存活：' + item.pids.join(',') : '') +
        '）——请先确认该进程已停止，不要直接删锁抢跑。');
    }
  }
  if (!outcome.released.length && !outcome.blocked.length) {
    console.log('未回收任何记录（runId 不匹配）。');
  }
  process.exit(outcome.released.length ? 0 : 3);
}

console.error('未知命令：' + command + '（可用 status / release）');
process.exit(2);
