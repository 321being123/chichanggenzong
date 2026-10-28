// 微信 JS-SDK 服务端签名与票据缓存。
// 边界（见 docs/证券分析与通用分享开发方案_20261022.md 第7节）：
// - 未配置 WECHAT_APP_ID / WECHAT_APP_SECRET 时一律返回未配置，前端降级为复制与菜单提示，不伪造成功。
// - access_token / jsapi_ticket 只在服务端使用，不落日志、不进 HTML、不进仓库。
// - 票据到期才更新；同一凭据并发刷新合并；失败后进入短期冷却，不连续重试。
// - 不新增后台定时任务，不写金融事实表。
const crypto = require('crypto');
const { redis } = require('../config');
const { fetchJson } = require('./wechatShareSource');

const TOKEN_CACHE_KEY = 'share:wechat:access_token';
const TICKET_CACHE_KEY = 'share:wechat:jsapi_ticket';
const FAIL_CACHE_KEY = 'share:wechat:fail_until';

const FAIL_COOLDOWN_MS = 5 * 60 * 1000;
const EXPIRY_SAFETY_MS = 5 * 60 * 1000; // 提前 5 分钟视为过期，避免临界失败

// 无 Redis 时的进程内兜底缓存。单进程运行边界与现有会话行为一致。
const memoryCache = new Map();
let inflight = null;

function appId() { return String(process.env.WECHAT_APP_ID || '').trim(); }
function appSecret() { return String(process.env.WECHAT_APP_SECRET || '').trim(); }

function isConfigured() {
  return Boolean(appId() && appSecret());
}

async function cacheGet(key) {
  if (redis.ready && redis.client) {
    try {
      const value = await redis.client.get(key);
      if (value != null) return value;
    } catch (_) { /* Redis 读失败退回进程内 */ }
  }
  const local = memoryCache.get(key);
  return local == null ? null : local;
}

async function cacheSet(key, value, ttlSeconds) {
  memoryCache.set(key, value);
  if (redis.ready && redis.client) {
    try { await redis.client.setEx(key, Math.max(1, Math.floor(ttlSeconds)), value); } catch (_) { /* 仅进程内缓存 */ }
  }
}


async function getAccessToken() {
  const cached = await cacheGet(TOKEN_CACHE_KEY);
  if (cached) return cached;
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
    + `&appid=${encodeURIComponent(appId())}&secret=${encodeURIComponent(appSecret())}`;
  const payload = await fetchJson(url, 'access_token');
  const token = String(payload.access_token || '');
  if (!token) throw new Error('access_token 为空');
  const expiresIn = Number(payload.expires_in) || 7200;
  await cacheSet(TOKEN_CACHE_KEY, token, expiresIn - EXPIRY_SAFETY_MS / 1000);
  return token;
}

async function fetchJsapiTicket() {
  const cached = await cacheGet(TICKET_CACHE_KEY);
  if (cached) return cached;
  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${encodeURIComponent(token)}&type=jsapi`;
  const payload = await fetchJson(url, 'jsapi_ticket');
  const ticket = String(payload.ticket || '');
  if (!ticket) throw new Error('jsapi_ticket 为空');
  const expiresIn = Number(payload.expires_in) || 7200;
  await cacheSet(TICKET_CACHE_KEY, ticket, expiresIn - EXPIRY_SAFETY_MS / 1000);
  return ticket;
}

// 同一时刻只允许一次票据刷新；失败进入冷却，冷却期内直接失败，不反复撞击上游。
async function getJsapiTicket() {
  const cached = await cacheGet(TICKET_CACHE_KEY);
  if (cached) return cached;

  const failUntil = Number(await cacheGet(FAIL_CACHE_KEY) || 0);
  if (failUntil && Date.now() < failUntil) {
    throw new Error('微信票据获取处于冷却期');
  }

  if (!inflight) {
    inflight = fetchJsapiTicket()
      .catch(async (error) => {
        await cacheSet(FAIL_CACHE_KEY, String(Date.now() + FAIL_COOLDOWN_MS), Math.ceil(FAIL_COOLDOWN_MS / 1000));
        throw error;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// 官方算法：字段名 ASCII 字典序拼接后 sha1；url 必须与当前页面 location（去 fragment）完全一致。
function signTicket(ticket, nonceStr, timestamp, url) {
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

async function buildConfig(pageUrl) {
  if (!isConfigured()) return { configured: false, reason: '未配置微信分享凭据' };
  const ticket = await getJsapiTicket();
  const nonceStr = crypto.randomBytes(8).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    configured: true,
    appId: appId(),
    timestamp,
    nonceStr,
    signature: signTicket(ticket, nonceStr, timestamp, pageUrl),
  };
}

function resetCacheForTest() {
  memoryCache.clear();
  inflight = null;
}

module.exports = {
  isConfigured,
  getAccessToken,
  getJsapiTicket,
  signTicket,
  buildConfig,
  resetCacheForTest,
};
