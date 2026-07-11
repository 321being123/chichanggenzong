// ========== 安全相关中间件（原 server.js 中的 CSRF / 安全响应头 / 未登录跳转） ==========
const { ALLOWED_HOSTS } = require('../config');

// 未登录跳转（仅拦截首页与 index.html）
function redirectUnauthenticated(req, res, next) {
  if ((req.path === '/' || req.path === '/index.html') && !req.session.user) return res.redirect('/login.html');
  next();
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  let u;
  try { u = new URL(origin); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return ALLOWED_HOSTS.some(a => a.host === u.hostname && (a.port === null || a.port === port));
}

// CSRF 防护：仅允许指定来源；同源 Referer 放行，否则写请求必须有白名单内的 Origin
function csrfMiddleware(req, res, next) {
  if (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE') {
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    // 同源（无 Origin 但 Referer 指向本机）放行；否则写请求必须有白名单内的 Origin
    if (!origin) {
      if (referer) {
        try {
          const u = new URL(referer);
          if (u.host === req.get('host')) return next();
        } catch (e) {}
      }
      return res.status(403).json({ error: '请求来源被拒绝' });
    }
    if (!isAllowedOrigin(origin)) return res.status(403).json({ error: '请求来源被拒绝' });
  }
  next();
}

// ========== 安全响应头（类 helmet 核心头，无额外依赖） ==========
// 注意：本应用大量使用内联脚本/样式与 onclick，故 CSP 暂仅约束到 self + unsafe-inline + data:（二维码图片用 data URL）。
// 待 P2-2 移除内联事件后可进一步收紧 CSP。
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // 仅 HTTPS 时下发 HSTS（与 Cookie secure:auto 配合）
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
}

module.exports = { redirectUnauthenticated, isAllowedOrigin, csrfMiddleware, securityHeaders };
