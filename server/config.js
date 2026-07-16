// ========= 应用级配置（原 server.js 中的常量与可选服务初始化集中于此） =========
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { DATA_DIR } = require('./db');

const PORT = process.env.PORT || 3000;

// 会话密钥：优先环境变量，否则首次启动时在 DATA_DIR 生成并持久化
const SECRET = process.env.SECRET || (function () {
  const sf = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(sf, 'utf-8').trim(); } catch (e) {
    const s = 'pts-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(sf, s, 'utf-8');
    return s;
  }
})();

// CSRF 防护：允许的来源（部署到公网时通过 ALLOWED_ORIGIN 配置，多个用逗号分隔）
const ALLOWED_HOSTS = (process.env.ALLOWED_ORIGIN || 'localhost,127.0.0.1')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(h => { const [host, port] = h.split(':'); return { host, port: port || null }; });

// AI 服务白名单（仅允许向白名单内的 HTTPS 公网地址发起请求）
const AI_ALLOWED_HOSTS = (process.env.AI_ALLOWED_HOSTS || 'apihub.agnes-ai.com')
  .split(',').map(s => s.trim()).filter(Boolean);

// AI 视觉模型白名单（P1-7）：禁止客户端任意指定高成本模型，仅放行服务端许可的模型
const ALLOWED_VISION_MODELS = (process.env.VISION_ALLOWED_MODELS || 'agnes-1.5-flash,agnes-1.5-pro')
  .split(',').map(s => s.trim()).filter(Boolean);

const REGISTER_CODE = process.env.REGISTER_CODE;

// ========= 可选 Redis：配置 REDIS_URL 后启用会话共享+限流；未配置则退回内存（与现状一致）==========
// 用可变对象持有状态，供限流中间件实时读取（避免 let 导出被快照为初始值）
const redis = { client: null, store: undefined, ready: false };

// 异步初始化 Redis（P1-5）：必须先「等待连接确认」再创建 Session Store，
// 避免连接尚未成功就把不可用的 Store 挂到会话、造成静默降级。
// 生产环境若设 REDIS_REQUIRED=1，连接失败直接启动失败，拒绝带病上线。
async function initRedis() {
  if (!process.env.REDIS_URL) return;
  try {
    const { createClient } = require('redis');
    const connectRedis = require('connect-redis');
    const RedisStore = connectRedis.default || connectRedis;
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (e) => console.warn('[Redis] 连接错误:', e.message));
    await client.connect(); // 阻塞直到连接确认
    redis.client = client;
    redis.store = new RedisStore({ client, prefix: 'sess:' });
    redis.ready = true;
    console.log('[Redis] 会话存储已启用');
  } catch (e) {
    redis.client = null; redis.store = undefined; redis.ready = false;
    if (process.env.NODE_ENV === 'production' && process.env.REDIS_REQUIRED === '1') {
      throw new Error('[Redis] 生产环境要求 Redis 但连接失败：' + e.message);
    }
    console.warn('[Redis] 连接失败，退回内存存储:', e.message);
  }
}

// 生产环境但未配置 Redis：会话/限流退回内存，多实例与重启会丢状态，并发可能相互覆盖。
// 不静默默认，明确告警，提醒运维配置 REDIS_URL。
if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {
  console.warn('[Redis][告警] 生产环境未配置 REDIS_URL：会话与限流将使用内存存储，多实例部署/重启会丢失登录态与限流计数，多用户并发保存可能相互覆盖。请配置 Redis 以启用共享会话与限流。');
}

// 邮箱验证码（nodemailer）
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

module.exports = { PORT, SECRET, ALLOWED_HOSTS, AI_ALLOWED_HOSTS, ALLOWED_VISION_MODELS, REGISTER_CODE, redis, mailer, initRedis };
