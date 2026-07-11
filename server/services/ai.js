// ========== AI 接口 SSRF 防护 ==========
// 仅允许向服务端白名单内的 HTTPS 公网地址发起请求，拒绝私网/回环/非常规协议
const { AI_ALLOWED_HOSTS } = require('../config');

function assertSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('AI 服务地址非法'); }
  if (u.protocol !== 'https:') throw new Error('AI 服务仅允许 HTTPS');
  const host = u.hostname.toLowerCase();
  // 拒绝 IP 字面量（含私网/回环/链路本地）
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || host === '[::1]' || host === '::1') {
    const parts = host === '[::1]' || host === '::1' ? [] : host.split('.').map(Number);
    const priv = parts.length === 4 && (
      parts[0] === 10 ||
      (parts[0] === 127) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
    if (host === 'localhost' || host === '[::1]' || host === '::1' || priv) throw new Error('AI 服务地址被拒绝');
  }
  if (!AI_ALLOWED_HOSTS.includes(host)) throw new Error('AI 服务地址不在白名单');
  return true;
}

module.exports = { assertSafeUrl };
