// ========== AI 接口 SSRF 防护 ==========
// 仅允许向服务端白名单内的 HTTPS 公网地址发起请求，拒绝私网/回环/非常规协议。
const dns = require('dns').promises;
const net = require('net');
// Node 内置 fetch 使用自带的 undici 版本，不能接收 npm undici 生成的
// dispatcher；固定 IP 时必须同时使用同一 npm undici 实例的 fetch。
const { fetch: pinnedFetch } = require('undici');
const nativeFetch = globalThis.fetch;
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
  // 生产服务器可能没有 IPv6 出口；在已完成公网校验的地址中优先选 IPv4，
  // 没有 IPv4 时再使用 IPv6，避免把请求固定到不可达的首个 AAAA 记录。
  const first = addresses.find(function (address) { return address.family === 4; }) || addresses[0];
  return { url: u, hostname: host, address: first.address, family: first.family };
}

const pinnedAgents = new Map();
function createPinnedDispatcher(target) {
  const key = `${target.hostname}|${target.address}|${target.family}`;
  if (pinnedAgents.has(key)) return pinnedAgents.get(key);
  const { Agent, buildConnector } = require('undici');
  // undici 8.x 的 Agent.connect 需要一个 connector 函数，不能把 lookup
  // 回调放进 connect 配置对象（那会被误当成请求处理器并在发请求前报错）。
  // 复用官方 connector，只把已完成公网校验的地址替换进去，并保留原主机名作 TLS SNI。
  const baseConnector = buildConnector({});
  const pinnedConnector = function (options, callback) {
    const requestedHost = String((options && (options.hostname || options.host)) || '').toLowerCase();
    if (requestedHost !== target.hostname) return callback(new Error('目标主机在连接前发生变化'));
    return baseConnector({
      ...options,
      hostname: target.address,
      host: target.address,
      servername: target.hostname,
    }, callback);
  };
  const agent = new Agent({
    connect: pinnedConnector,
  });
  pinnedAgents.set(key, agent);
  return agent;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// AI 请求手动跟随同源跳转，每一跳重新解析并固定公网 IP；跨源跳转一律拒绝，
// 因而 Authorization 不会被转发到新来源。fetchImpl 参数用于无外网单元测试。
async function fetchSafeAi(url, options = {}, extraHosts = [], fetchImpl = globalThis.fetch) {
  let current = String(url);
  let requestOptions = { ...options };
  // 只有真正的 Node 内置 fetch 走固定 dispatcher；测试或调用方注入的 fetch
  // 必须继续使用注入实现，避免把可控桩误切到外部网络请求。
  const usePinnedConnection = fetchImpl === nativeFetch;
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
    const requestFetch = usePinnedConnection ? pinnedFetch : fetchImpl;
    const response = await requestFetch(current, {
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
