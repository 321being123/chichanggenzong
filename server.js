// 入口文件：组装并启动服务（具体实现见 server/ 下的模块化代码）
// 保持 `node server.js` 可直接启动，部署由 systemd 管理，无需额外入口。
// 进程级兜底（审查 R-1/R-3）：记录失控异常后有序退出，由 systemd 拉起新进程；
// 不允许吞掉异常后带着未知状态继续跑。
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] 未处理的 Promise 异常，记录后退出:', (reason && reason.stack) || reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('[fatal] 未捕获异常，记录后退出:', (error && error.stack) || error);
  process.exit(1);
});
const { start } = require('./server/app');
start();
