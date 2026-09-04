// ========== 应用组装与启动（原 server.js 的入口职责集中于此） ==========
const express = require('express');
const { appVersion } = require('../package.json');
const session = require('express-session');
const path = require('path');
const { SECRET, PORT, redis, initRedis } = require('./config');
const { initSchema, migrateFromJson, ensureAdmin, DATA_DIR, pool } = require('./db');
const { ensureAiModelsInit } = require('./services/aiModels');
const { redirectUnauthenticated, csrfMiddleware, securityHeaders } = require('./middleware/security');
const { requestId, accessLog, errorHandler } = require('./middleware/errorHandler');
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
const bondAnalysisRouter = require('./routes/bondAnalysis');
const knowledgeRouter = require('./routes/knowledge');
const marketVolatilityRouter = require('./routes/marketVolatility');
const positionComparisonRouter = require('./routes/positionComparison');
const arbitrageRouter = require('./routes/arbitrage');
// 单一后台任务注册清单（Web 兼容模式与独立 Worker 共用）：见 server/scheduler.js
const { startScheduler } = require('./scheduler');

const app = express();
app.disable('x-powered-by');
// 仅信任本机反向代理；官方 Nginx 部署使用 TRUST_PROXY=loopback。
// 不接受任意跳数，避免客户端伪造转发头绕过限流/IP 识别。
app.set('trust proxy', process.env.TRUST_PROXY === 'loopback' ? 'loopback' : false);

// 启动前的基础中间件（不依赖 Redis）：请求体解析 + 请求追踪/访问日志
// 上限 15mb：10MB 图片经 Base64 后约 13.3MB，超过原 10mb 会被 body-parser 直接拒绝（P1-7）
app.use(express.json({ limit: '15mb' }));
app.use(requestId);
app.use(accessLog);

// ========== 启动：先初始化数据库与 Redis，再注册会话/路由并监听端口 ==========
// 说明：会话 Store 依赖异步初始化的 Redis（initRedis 确认连接后才创建 Store）。
// 因此会话中间件及之后的所有中间件/路由注册都必须放在 initRedis 成功后，
// 不能在模块顶层同步注册，否则会用到尚未就绪的 store 造成静默降级。
let server = null;

async function start() {
  try {
    await initSchema();
    await ensureAdmin();
    await migrateFromJson();
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
  // 开发期静态资源不缓存；生产由 Nginx 按版本参数管理 7 天缓存，避免 Node 与 Nginx 返回冲突的 Cache-Control。
  app.use(function noCacheStatic(req, res, next) {
    if (process.env.NODE_ENV === 'production') return next();
    if (req.path.startsWith('/api')) return next();
    const ext = path.extname(req.path).toLowerCase();
    if (ext === '' || ['.html', '.js', '.css'].includes(ext)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // CSRF 防护：仅允许指定来源
  app.use(csrfMiddleware);

  // 路由挂载
  app.use('/api', authRouter);
  app.use('/api', accountsRouter);
  app.use('/api', marketRouter);
  app.use('/', importRouter);   // 同时承接 /api/* 与 /m/*
  app.use('/api', metaRouter);
  app.use('/api', profileRouter);   // 个人中心：资料读取/更新/改密
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

  // 健康检查（无需登录）：liveness 与 readiness 供反向代理/编排探测
  app.get('/health', (req, res) => res.json({ status: 'ok', version: appVersion, ts: Date.now() }));
  app.get('/ready', async (req, res) => {
    const checks = { db: false, redis: redis.ready };
    try { await pool.query('SELECT 1'); checks.db = true; } catch (e) {}
    res.status(checks.db ? 200 : 503).json({ status: checks.db ? 'ready' : 'not_ready', checks, ts: Date.now() });
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
    app.listen(PORT, '::1', () => {
      console.log(`存在小站已启动(IPv6): http://[::1]:${PORT}`);
    });
  } catch (e) {
    console.log('[listen] IPv6(::1) 监听跳过:', e.message);
  }
}

// 优雅停机：停止接收新请求并关闭 DB/Redis 连接池（P2-2）
function shutdown(signal) {
  console.log(`[shutdown] 收到 ${signal}，停止接收新请求并释放连接...`);
  if (server) server.close();
  const finish = () => process.exit(0); // 优雅停机一律以 0 退出，便于编排器识别
  // 兜底：3 秒后强制退出，避免连接池久久不释放导致进程悬挂
  const hardStop = setTimeout(finish, 3000);
  hardStop.unref();
  Promise.allSettled([
    pool.end().catch(() => {}),
    redis.client ? redis.client.quit().catch(() => {}) : Promise.resolve()
  ]).then(finish);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, start, shutdown };
