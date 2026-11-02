// ========== 应用组装与启动（原 server.js 的入口职责集中于此） ==========
const express = require('express');
const { appVersion } = require('../package.json');
const buildIdentity = require('./services/buildIdentity');
const session = require('express-session');
const path = require('path');
const { SECRET, PORT, redis, initRedis } = require('./config');
const { initSchema, migrateFromJson, ensureAdmin, DATA_DIR, pool } = require('./db');
const { ensureAiModelsInit } = require('./services/aiModels');
const { redirectUnauthenticated, csrfMiddleware, securityHeaders } = require('./middleware/security');
const { requestId, accessLog, errorHandler } = require('./middleware/errorHandler');
const { guardSensitiveSession } = require('./middleware/sessionStoreGuard');
const { versionedStaticPages } = require('./middleware/versionedStaticPages');
const { getDependencyHealth } = require('./services/siteAnalytics');
const authRouter = require('./routes/auth');
const accountsRouter = require('./routes/accounts');
const marketRouter = require('./routes/market');
const importRouter = require('./routes/import');
const metaRouter = require('./routes/meta');
const profileRouter = require('./routes/profile');
const adminRouter = require('./routes/admin');
const ipoRouter = require('./routes/ipo');
const bondSafetyRouter = require('./routes/bondSafety');
const bondCycleRouter = require('./routes/bondCycle');
const bondValuationRouter = require('./routes/bondValuation');
const bondRedemptionRouter = require('./routes/bondRedemption');
const bondRevisionRouter = require('./routes/bondRevision');
const stockAnalysisRouter = require('./routes/stockAnalysis');
const stockSelectionRouter = require('./routes/stockSelection');
const bondAnalysisRouter = require('./routes/bondAnalysis');
const knowledgeRouter = require('./routes/knowledge');
const marketVolatilityRouter = require('./routes/marketVolatility');
const positionComparisonRouter = require('./routes/positionComparison');
const arbitrageRouter = require('./routes/arbitrage');
const feedbackRouter = require('./routes/feedback');
const notificationsRouter = require('./routes/notifications');
const shareRouter = require('./routes/share');
const telemetryRouter = require('./routes/telemetry');
// 单一后台任务注册清单（Web 兼容模式与独立 Worker 共用）：见 server/scheduler.js
const { startScheduler } = require('./scheduler');

const app = express();
app.disable('x-powered-by');
// 仅信任本机反向代理；官方 Nginx 部署使用 TRUST_PROXY=loopback。
// 不接受任意跳数，避免客户端伪造转发头绕过限流/IP 识别。
app.set('trust proxy', process.env.TRUST_PROXY === 'loopback' ? 'loopback' : false);

// 统计接口单独限制请求体，不能因为它是公开入口而继承 15MB 的业务上传上限。
app.use(function telemetryBodyLimit(req, res, next) {
  if (req.method === 'POST' && req.path === '/api/telemetry/events' && Number(req.headers['content-length'] || 0) > 32 * 1024) {
    return res.status(413).json({ error: '统计请求过大' });
  }
  next();
});
// 启动前的基础中间件（不依赖 Redis）：请求体解析 + 请求追踪/访问日志
// 审查 R-12：全局 JSON 上限收敛到 1MB（常规业务数据足够）；
// 仅上传/识别/整包恢复等明确吃大体积的路由放开到 15MB（10MB 图片经 Base64 后约 13.3MB）。
const largeJsonParser = express.json({ limit: '15mb' });
app.use('/api/vision-parse', largeJsonParser);
app.use('/api/vision-upload', largeJsonParser);
app.use('/api/excel-parse', largeJsonParser);
app.use('/api/excel-history-parse', largeJsonParser);
app.use('/api/knowledge/articles', largeJsonParser); // 文章可内嵌 base64 图片（单张≤5MB）
app.use(/^\/api\/accounts\/[^/]+\/import-snapshot$/, largeJsonParser); // 整包恢复
app.use(express.json({ limit: '1mb', verify: function (req, res, buffer) {
  if (req.method === 'POST' && req.path === '/api/telemetry/events' && buffer.length > 32 * 1024) {
    const error = new Error('统计请求过大'); error.status = 413; throw error;
  }
} }));
app.use(requestId);
app.use(accessLog);

// 停机期不再接受新的业务请求（S-005）：只在进入停机后生效，
// /health 与 /ready 仍可探测，用来对外报告"正在停机"而不是冒充可用。
app.use(function rejectWhileShuttingDown(req, res, next) {
  if (!shuttingDown) return next();
  if (req.path === '/health' || req.path === '/ready') return next();
  res.set('Connection', 'close');
  return res.status(503).json({ error: '服务正在重启，请稍后重试' });
});

// ========== 启动：先初始化数据库与 Redis，再注册会话/路由并监听端口 ==========
// 说明：会话 Store 依赖异步初始化的 Redis（initRedis 确认连接后才创建 Store）。
// 因此会话中间件及之后的所有中间件/路由注册都必须放在 initRedis 成功后，
// 不能在模块顶层同步注册，否则会用到尚未就绪的 store 造成静默降级。
let server = null;
let server6 = null;

async function start() {
  try {
    await initSchema();
    await ensureAdmin();
    if (process.env.DISABLE_RUNTIME_MIGRATIONS !== '1') await migrateFromJson();
    await ensureAiModelsInit();
    console.log('数据库初始化完成');
  } catch (e) {
    console.error('数据库初始化失败:', e.message);
    process.exit(1);
  }

  // Redis 异步初始化：等待连接确认后再创建会话 Store；生产环境 REDIS_REQUIRED=1
  // 时连接失败会直接 throw（已在 config.initRedis 内处理），此处捕获后中止启动。
  try {
    await initRedis();
  } catch (e) {
    console.error('Redis 初始化失败导致启动中止:', e.message);
    process.exit(1);
  }

  // 敏感入口的存储守卫必须在 session 之前（复验 RV-02）：必需 Redis 断连时，
  // express-session 会先去 Store 取会话并抛 ClientOfflineError，导致带旧 Cookie 的请求拿到 500。
  // 提前拦截后，登录/注册/发码/重置一律按约定 503，既不读会话也不排队等重连。
  app.use(guardSensitiveSession);

  // 会话中间件依赖异步初始化的 redis.store（无 Redis 时为 undefined → 内存存储，与现状一致）
  app.use(session({
    secret: SECRET,
    store: redis.store,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' }
  }));

  // 未登录跳转
  app.use(redirectUnauthenticated);
  // 安全响应头（必须在静态资源之前注册，确保 HTML/JS/CSS 均携带 CSP / X-Frame-Options 等头）
  app.use(securityHeaders);
  // 页面必须每次回源校验（走 ETag），否则旧页面里的 ?v= 会长期停在旧版本，
  // 一旦静态文件在发版窗口内短暂缺失，旧页面就只能靠手工刷新恢复。
  // 开发期静态资源仍全量不缓存；生产 JS/CSS 由 Nginx 按版本参数管理缓存。
  app.use(function noCacheStatic(req, res, next) {
    if (req.path.startsWith('/api')) return next();
    const ext = path.extname(req.path).toLowerCase();
    if (ext === '' || ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      return next();
    }
    if (process.env.NODE_ENV === 'production') return next();
    if (['.js', '.css'].includes(ext)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });
  app.use(versionedStaticPages(path.join(__dirname, '..', 'public'), appVersion));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // CSRF 防护：仅允许指定来源
  app.use(csrfMiddleware);

  // 路由挂载
  app.use('/api/telemetry', telemetryRouter);
  app.use('/api', authRouter);
  app.use('/api', accountsRouter);
  app.use('/api', marketRouter);
  app.use('/', importRouter);   // 同时承接 /api/* 与 /m/*
  app.use('/api', metaRouter);
  app.use('/api', profileRouter);   // 个人中心：资料读取/更新/改密
  // 股票筛选（投资策略选股中心）：登录只读 + 管理员补数/计算/回测入队。
  // 管理员入口必须先于通用 /api/admin 挂载，否则会被后台路由的兜底吃掉。
  app.use('/api/admin/stock-selection', stockSelectionRouter.adminRouter);
  app.use('/api/stock-selection', stockSelectionRouter);
  app.use('/api/admin', adminRouter);   // 管理后台：统一 /api/admin 前缀，路由内已 requireAdmin
  app.use('/api/stock-analysis', stockAnalysisRouter); // 股票分析：持仓/自选、三表快照和单股刷新
  app.use('/api/bond-analysis', bondAnalysisRouter); // 可转债分析：数据库快照读取和单债刷新
  app.use('/api/ipo', ipoRouter);       // 打新日历：报告/历史列表/已上市表现
  app.use('/api/bond-safety', bondSafetyRouter); // 可转债安全性：数据库快照读取/管理员刷新
  app.use('/api/bond-cycle', bondCycleRouter);    // 可转债周期：只读聚合查询
  app.use('/api/bond-valuation', bondValuationRouter); // 可转债估值：列表/详情/历史/预警/刷新
  app.use('/api/bond-redemption', bondRedemptionRouter); // 可转债强赎监控：统一状态只读查询
  app.use('/api/bond-revision', bondRevisionRouter); // 可转债下修监控：统一状态只读查询
  app.use('/api/knowledge', knowledgeRouter);    // 知识分享：文章/分类/评论/公开分享
  app.use('/api/market-volatility', marketVolatilityRouter); // 股市波动：格雷厄姆指数与仓位纪律
  app.use('/api', positionComparisonRouter);     // 仓位对比：公开状态/标杆列表/对比/复制测算
  app.use('/api/arbitrage', arbitrageRouter);     // 套利机会：A 股套利/港股私有化/港股供股权
  app.use('/api/feedback', feedbackRouter);      // 意见反馈：公开列表/我的反馈/排名/版本关联/回复/截图
  app.use('/api/notifications', notificationsRouter); // 站内通知：本人收件箱/未读数/已读
  app.use('/', shareRouter);      // 通用分享：公开证券分析页 /s/security/:kind/:code、二维码与微信签名配置

  // 健康检查（无需登录）：liveness 与 readiness 供反向代理/编排探测
  // 健康检查同时自述启动构建身份（S-001）：版本、提交、启动时刻与进程号，
  // 让"这个进程加载的是哪个提交"可以由进程自己回答，而不是只看磁盘 Git HEAD。
  app.get('/health', (req, res) => res.json(Object.assign({ status: 'ok', ts: Date.now() }, buildIdentity.describe())));
  app.get('/ready', async (req, res) => {
    // 停机中一律 not_ready：负载均衡与编排据此停止转发，再等在途请求自然结束。
    if (shuttingDown) return res.status(503).json({ status: 'shutting_down', checks: {}, ts: Date.now() });
    const dependency = await getDependencyHealth();
    const checks = { db: dependency.database.ready, dbStatus: dependency.database.status, redis: dependency.redis.ready, redisStatus: dependency.redis.status };
    const redisRequired = dependency.redis.required;
    const ready = checks.db && (!redisRequired || checks.redis);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks, ts: Date.now() });
  });

  // 统一错误处理（兜底所有未捕获异常，输出结构化日志并返回 JSON）
  app.use(errorHandler);

  server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`存在小站已启动: http://127.0.0.1:${PORT}`);
    console.log(`数据目录: ${DATA_DIR}`);
    // 仅生产兼容模式允许在 Web 进程内运行调度。拆分独立 worker 时给 Web 进程设
    // DISABLE_SCHEDULER=1（见 server/worker.js），避免重复执行；非生产环境始终关闭。
    if (process.env.NODE_ENV === 'production' && process.env.DISABLE_SCHEDULER !== '1') {
      startScheduler().catch(function (e) { console.error('[scheduler] 启动失败:', e && e.message); });
    } else if (process.env.NODE_ENV !== 'production') {
      console.log('[scheduler] 非生产环境不启动后台任务调度');
    } else {
      console.log('[scheduler] DISABLE_SCHEDULER=1：Web 进程不运行后台任务（由独立 worker 承担）');
    }
  });
  // 同时监听 IPv6 回环地址 ::1：现代浏览器打开 localhost 常先解析到 ::1，
  // 若仅监听 IPv4 会导致"本地打不开"(连接被拒)。双栈监听，::1 失败不影响 IPv4。
  try {
    server6 = app.listen(PORT, '::1', () => {
      console.log(`存在小站已启动(IPv6): http://[::1]:${PORT}`);
    });
  } catch (e) {
    console.log('[listen] IPv6(::1) 监听跳过:', e.message);
  }
}

// 优雅停机（S-005，2026-11-01 整改）：
// 顺序必须是「停止接收新请求 → 等待 HTTP 监听真正关闭（在途请求、事务与 Session 写回完成）
// → 关闭 DB/Redis 并等待结果 → 退出」。原实现发完 close() 就去 pool.end/redis.quit，
// 依赖先完成时立即 exit(0)，在途请求会拿不到连接或丢掉 Session 写回。
const DRAIN_TIMEOUT_MS = Math.max(Number(process.env.WEB_DRAIN_TIMEOUT_MS) || 3000, 0);
let shuttingDown = false;
let shutdownPromise = null;

// 单个监听的关闭 Promise：未启动/已关闭都安全返回。
// keep-alive 空闲连接不会自己断开，会让 close 回调永远等下去，所以关闭后立刻只断开空闲连接；
// 在途请求仍由 close 回调等它们自然结束。
function closeListener(srv) {
  if (!srv || typeof srv.close !== 'function') return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      srv.close(done);
      if (typeof srv.closeIdleConnections === 'function') setTimeout(() => srv.closeIdleConnections(), 0);
    } catch (_) { done(); }
  });
}

// 排空编排（可注入依赖，供回归测试用受控屏障验证顺序与退出码）。
// 返回 'drained'（正常排空）、'degraded'（排空完成但依赖关闭失败）、'timeout'（硬截止到点）。
async function drainHttpAndDeps({ servers = [], closeDeps = async () => [], timeoutMs = DRAIN_TIMEOUT_MS } = {}) {
  let timer = null;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.max(Number(timeoutMs) || 0, 0));
    if (timer.unref) timer.unref();
  });
  const work = (async () => {
    await Promise.allSettled(servers.map(closeListener));
    let results = [];
    try {
      const gotten = await closeDeps();
      results = Array.isArray(gotten) ? gotten : [gotten];
    } catch (error) {
      results = [{ status: 'rejected', reason: error }];
    }
    const failed = results.filter(item => item && item.status === 'rejected');
    failed.forEach(item => console.warn('[shutdown] 依赖关闭失败:', String(item.reason && item.reason.message).slice(0, 160)));
    return failed.length ? 'degraded' : 'drained';
  })();
  const outcome = await Promise.race([work, deadline]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function shutdown(signal) {
  // 重复信号（systemd stop 与手工 SIGTERM、连续 Ctrl+C）不重复关闭依赖，也不重置截止时间。
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，停止接收新请求并等待在途请求完成...`);
  shutdownPromise = (async () => {
    const outcome = await drainHttpAndDeps({
      servers: [server, server6],
      closeDeps: () => Promise.allSettled([
        pool.end(),
        redis.client ? redis.client.quit() : Promise.resolve(),
      ]),
    });
    if (outcome === 'drained') process.exit(0); // 正常排空才以 0 退出
    if (outcome === 'degraded') {
      console.error('[shutdown] 请求已排空，但 DB/Redis 释放不完整，以非零退出标记');
      process.exit(1);
    }
    console.error(`[shutdown] 排空超时（${DRAIN_TIMEOUT_MS}ms 未完成），强制断开残存连接并非优雅退出`);
    try { if (server && server.closeAllConnections) server.closeAllConnections(); } catch (_) { /* 忽略 */ }
    try { if (server6 && server6.closeAllConnections) server6.closeAllConnections(); } catch (_) { /* 忽略 */ }
    process.exit(1);
  })();
  return shutdownPromise;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, start, shutdown, drainHttpAndDeps, closeListener, isShuttingDown: () => shuttingDown };
