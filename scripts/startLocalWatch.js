// 本地 Web 开发入口：代码变更时由 Node 自动重载；不启动后台调度或运行时迁移。
process.env.DISABLE_SCHEDULER = '1';
process.env.DISABLE_RUNTIME_MIGRATIONS = '1';

require('../server.js');
