// pm2 启动配置：进程守护 + 崩溃自启 + 开机自启
// 用法：在服务器项目目录下执行 `pm2 start deploy/ecosystem.config.js`
//       然后 `pm2 save` 将当前进程固化，`pm2 startup` 设置开机自启
module.exports = {
  apps: [
    {
      name: 'portfolio-server',
      script: 'server.js',
      cwd: __dirname + '/..',          // 指向项目根目录
      instances: 1,                    // PostgreSQL 写入为「先删后插」单进程策略，不要多实例
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        DURABLE_SCHEDULER: '1',
        // 注意：PORT / ALLOWED_ORIGIN / REGISTER_CODE / SECRET / PG 连接变量 放在项目根目录的 .env 文件里
        // （应用启动时会通过 dotenv 自动读取项目根的 .env，pm2 只负责拉起进程）
        // Web/Worker 固定拆分：Web 进程不跑后台任务，全部调度交由下方 portfolio-worker 执行（避免重复执行/丢失）。
        DISABLE_SCHEDULER: '1'
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    },
    {
      // 独立后台任务进程：只跑调度，不监听端口（见 server/worker.js + server/scheduler.js）
      name: 'portfolio-worker',
      script: 'server/worker.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        DURABLE_SCHEDULER: '1',
        JOB_PROCESS_ROLE: 'worker',
        WORKER_DRAIN_TIMEOUT_MS: '60000'
        // 不暴露端口；PG 任务锁保证与 Web（若仍运行调度）不会重复执行同一有锁任务
      },
      kill_timeout: 3000000,
      error_file: 'logs/pm2-worker-error.log',
      out_file: 'logs/pm2-worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
