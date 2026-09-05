// ========== AI 接口 SSRF 防护 ==========
// 仅允许向服务端白名单内的 HTTPS 公网地址发起请求，拒绝私网/回环/非常规协议。
const dns = require('dns').promises;
const net = require('net');
const { AI_ALLOWED_HOSTS } = require('../config');

function isPublicIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  return true;
}

function isPublicIPv6(ip) {
  const value = String(ip || '').toLowerCase();
  if (value === '::' || value === '::1' || value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return false;
  if (value.startsWith('::ffff:')) return isPublicIPv4(value.slice('::ffff:'.length));
  return true;
}

function isPublicIp(ip) {
  return net.isIPv4(ip) ? isPublicIPv4(ip) : net.isIPv6(ip) ? isPublicIPv6(ip) : false;
}

// extraHosts：后台大模型配置中管理员录入的额外放行域名（仅扩展白名单，HTTPS/公网校验不变）。
function assertSafeUrl(url, extraHosts) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('AI 服务地址非法'); }
  if (u.protocol !== 'https:') throw new Error('AI 服务仅允许 HTTPS');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || (net.isIP(host) && !isPublicIp(host))) throw new Error('AI 服务地址被拒绝');
  const extra = Array.isArray(extraHosts) ? extraHosts.map(function (h) { return String(h || '').toLowerCase(); }) : [];
  if (!AI_ALLOWED_HOSTS.includes(host) && !extra.includes(host)) throw new Error('AI 服务地址不在白名单');
  return true;
}

async function resolveSafeTarget(url, extraHosts) {
  let u;
  try { u = new URL(url); } catch (_) { throw new Error('AI 服务地址非法'); }
  assertSafeUrl(u.toString(), extraHosts);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return { url: u, hostname: host, address: host, family: net.isIPv4(host) ? 4 : 6 };
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch (_) { throw new Error('AI 服务域名解析失败'); }
  if (!addresses.length || addresses.some(a => !isPublicIp(a.address))) throw new Error('AI 服务解析到非公网地址');
  const first = addresses[0];
  return { url: u, hostname: host, address: first.address, family: first.family };
}

const pinnedAgents = new Map();
function createPinnedDispatcher(target) {
  const key = `${target.hostname}|${target.address}|${target.family}`;
  if (pinnedAgents.has(key)) return pinnedAgents.get(key);
  const { Agent } = require('undici');
  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (String(hostname).toLowerCase() !== target.hostname) return callback(new Error('目标主机在连接前发生变化'));
        if (options && options.all) return callback(null, [{ address: target.address, family: target.family }]);
        return callback(null, target.address, target.family);
      },
    },
  });
  pinnedAgents.set(key, agent);
  return agent;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// AI 请求手动跟随同源跳转，每一跳重新解析并固定公网 IP；跨源跳转一律拒绝，
// 因而 Authorization 不会被转发到新来源。fetchImpl 参数用于无外网单元测试。
async function fetchSafeAi(url, options = {}, extraHosts = [], fetchImpl = fetch) {
  let current = String(url);
  let requestOptions = { ...options };
  const usePinnedConnection = fetchImpl === fetch;
  if (!usePinnedConnection) assertSafeUrl(current, extraHosts);
  const original = usePinnedConnection
    ? await resolveSafeTarget(current, extraHosts)
    : { url: new URL(current) };
  const originalOrigin = original.url.origin;
  for (let hop = 0; hop <= 3; hop++) {
    const target = usePinnedConnection
      ? await resolveSafeTarget(current, extraHosts)
      : { url: new URL(current) };
    if (target.url.origin !== originalOrigin) throw new Error('AI 服务禁止跨域跳转');
    if (!usePinnedConnection) assertSafeUrl(current, extraHosts);
    const headers = { ...(requestOptions.headers || {}) };
    const response = await fetchImpl(current, {
      ...requestOptions,
      headers,
      redirect: 'manual',
      ...(usePinnedConnection ? { dispatcher: createPinnedDispatcher(target) } : {}),
    });
    if (!REDIRECT_STATUSES.has(Number(response && response.status))) return response;
    if (hop >= 3) throw new Error('AI 服务跳转次数过多');
    const location = response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location') : null;
    if (!location) throw new Error('AI 服务跳转缺少目标地址');
    const next = new URL(location, current);
    if (next.origin !== originalOrigin) throw new Error('AI 服务禁止跨域跳转');
    current = next.toString();
    const method = String(requestOptions.method || 'GET').toUpperCase();
    if ([301, 302, 303].includes(Number(response.status)) && !['GET', 'HEAD'].includes(method)) {
      requestOptions = { ...requestOptions, method: 'GET' };
      delete requestOptions.body;
      delete requestOptions.headers;
    }
  }
  throw new Error('AI 服务跳转失败');
}

module.exports = { assertSafeUrl, fetchSafeAi, resolveSafeTarget };
