// ========== 应用组装与启动（原 server.js 的入口职责集中于此） ==========
const express = require('express');
const session = require('express-session');
const path = require('path');
const { SECRET, PORT, redis } = require('./config');
const { initSchema, migrateFromJson, DATA_DIR } = require('./db');
const { redirectUnauthenticated, csrfMiddleware, securityHeaders } = require('./middleware/security');
const authRouter = require('./routes/auth');
const accountsRouter = require('./routes/accounts');
const marketRouter = require('./routes/market');
const importRouter = require('./routes/import');
const metaRouter = require('./routes/meta');
const { scheduleAllMarketCloses } = require('./jobs/marketClose');
const { ensureIndexBaseline } = require('./jobs/indexBaseline');

const app = express();
// 部署在 Nginx 反代后，信任一层代理（用于正确的客户端IP与 X-Forwarded-Proto）
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: SECRET,
  store: redis.store,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

// 未登录跳转
app.use(redirectUnauthenticated);
app.use(express.static(path.join(__dirname, '..', 'public')));

// CSRF 防护：仅允许指定来源
app.use(csrfMiddleware);
// 安全响应头
app.use(securityHeaders);

// 路由挂载
app.use('/api', authRouter);
app.use('/api', accountsRouter);
app.use('/api', marketRouter);
app.use('/', importRouter);   // 同时承接 /api/* 与 /m/*
app.use('/api', metaRouter);

// ========== 启动：先初始化数据库（建表+首启文件迁移），再监听端口 ==========
async function start() {
  try {
    await initSchema();
    await migrateFromJson();
    console.log('数据库初始化完成');
  } catch (e) {
    console.error('数据库初始化失败:', e.message);
    process.exit(1);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`持仓管理系统已启动: http://0.0.0.0:${PORT}`);
    console.log(`数据目录: ${DATA_DIR}`);
    // 按各市场收盘时刻精准调度收盘价记录
    scheduleAllMarketCloses();
    // 启动后自动补齐指数基线（A股走Tushare，恒生走腾讯），缺失才联网，幂等自愈
    ensureIndexBaseline().catch(function (e) { console.error('指数基线补齐失败:', e.message); });
  });
}

module.exports = { app, start };
