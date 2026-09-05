// ========== 安全相关中间件（原 server.js 中的 CSRF / 安全响应头 / 未登录跳转） ==========
const { ALLOWED_HOSTS } = require('../config');

// 公开首页允许未登录访问；只有管理后台仍强制跳转登录。
function redirectUnauthenticated(req, res, next) {
  // 后台需回跳参数，避免登录后落回前台
  if (req.path === '/admin.html' && !req.session.user) return res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl || '/admin.html'));
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
  // 所有可能改变状态的 HTTP 方法都必须经过来源检查；PATCH 不能遗漏。
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
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
// 静态 HTML 的内联脚本/样式使用构建时哈希；动态事件属性暂时单独保留在
// script-src-attr/style-src-attr，避免把整个 script/style 元素重新放开。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function inlineHashes(tag) {
  const dir = path.join(__dirname, '..', '..', 'public');
  const hashes = new Set();
  for (const file of ['index.html', 'login.html', 'admin.html', 'ipo-report.html', 'share-knowledge.html']) {
    let html;
    try { html = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { continue; }
    const re = new RegExp(`<${tag}\\b(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let match;
    while ((match = re.exec(html))) {
      hashes.add(`'sha256-${crypto.createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes];
}

const CSP_INLINE_SCRIPT_HASHES = inlineHashes('script');
const CSP_INLINE_STYLE_HASHES = inlineHashes('style');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // 仅 HTTPS 时下发 HSTS（与 Cookie secure:auto 配合）
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const scriptSources = ["'self'", ...CSP_INLINE_SCRIPT_HASHES].join(' ');
  const styleSources = ["'self'", ...CSP_INLINE_STYLE_HASHES].join(' ');
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    `script-src ${scriptSources}`,
    "script-src-attr 'unsafe-inline'",
    `style-src ${styleSources}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  next();
}

module.exports = { redirectUnauthenticated, isAllowedOrigin, csrfMiddleware, securityHeaders, CSP_INLINE_SCRIPT_HASHES, CSP_INLINE_STYLE_HASHES };
