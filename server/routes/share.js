// 证券分析与通用分享：公开页面壳、二维码与微信签名配置。
// 边界（见 docs/证券分析与通用分享开发方案_20261022.md）：
// - 公开页只读本地公开资料，不触发外部采集、不写分析快照、不初始化账户/持仓/自选。
// - 服务端生成标题与 Open Graph 元信息，避免分享平台只识别通用标题。
// - 二维码与签名目标一律由服务端按登记对象推出，不接受任意 URL。
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const asyncHandler = require('../middleware/async');
const { appVersion } = require('../../package.json');
const registry = require('../services/shareRegistry');
const wechatShare = require('../services/wechatShare');

const router = express.Router();

// 模板放在 server/views 而不是 public：放在 public 会被静态服务直出，用户能看到未替换的占位符。
const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'share.html');
const TEMPLATE_CACHE_MS = 5 * 1000;
let templateCache = { html: null, readAt: 0 };

function readTemplate() {
  const now = Date.now();
  if (templateCache.html && now - templateCache.readAt < TEMPLATE_CACHE_MS) return templateCache.html;
  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  templateCache = { html, readAt: now };
  return html;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function renderPage(security, meta) {
  const imageTag = meta.imageUrl
    ? `<meta property="og:image" content="${escapeAttr(meta.imageUrl)}">\n`
      + `<meta name="twitter:image" content="${escapeAttr(meta.imageUrl)}">`
    : '';
  return readTemplate()
    .replaceAll('__APP_VERSION__', encodeURIComponent(String(appVersion)))
    .replaceAll('__SHARE_TITLE__', escapeHtml(meta.title))
    .replaceAll('__SHARE_DESCRIPTION__', escapeHtml(meta.description))
    .replaceAll('__SHARE_CANONICAL__', escapeAttr(meta.canonical || ''))
    .replaceAll('__SHARE_OG_IMAGE__', imageTag)
    .replaceAll('__SHARE_KIND__', escapeAttr(security.kind))
    .replaceAll('__SHARE_CODE__', escapeAttr(security.code))
    .replaceAll('__SHARE_NAME__', escapeHtml(security.name))
    .replaceAll('__SHARE_PATH__', escapeAttr(meta.path));
}

// 公开分享页：/s/security/:kind/:code
router.get('/s/security/:kind/:code', asyncHandler(async (req, res) => {
  const resolved = await registry.resolveSecurity(req.params.kind, req.params.code);
  if (!resolved.ok) {
    // 开放参数空间：任何代码都能拼出地址，失败响应明确禁止收录。
    res.setHeader('X-Robots-Tag', 'noindex');
    const status = resolved.status || 404;
    if (status === 400) return res.status(400).type('text/plain; charset=utf-8').send('证券代码或类型不合法');
    if (status === 503) return res.status(503).type('text/plain; charset=utf-8').send(resolved.error);
    return res.status(404).type('text/plain; charset=utf-8').send('未找到该证券的公开分析页');
  }
  const meta = registry.buildSecurityMeta(resolved.security);
  if (!meta.canonical) {
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.status(503).type('text/plain; charset=utf-8').send('分享地址未配置');
  }
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  res.type('html').send(renderPage(resolved.security, meta));
}));

// 校验登记对象：三个接口共用，避免各自解释参数。
async function resolveRequestedContent(source) {
  if (!registry.isKnownContentType(source.contentType)) {
    return { ok: false, status: 400, error: '不支持的内容类型' };
  }
  return registry.resolveSecurity(source.resourceKind, source.resourceKey);
}

// 二维码：用已有 qrcode 依赖生成公开链接，不接受任意 URL。
router.get('/api/share/qrcode', asyncHandler(async (req, res) => {
  const resolved = await resolveRequestedContent(req.query || {});
  if (!resolved.ok) return res.status(resolved.status || 404).json({ error: resolved.error });

  const meta = registry.buildSecurityMeta(resolved.security);
  if (!meta.canonical) return res.status(503).json({ error: '分享地址未配置' });

  try {
    const qr = await QRCode.toDataURL(meta.canonical, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.json({ url: meta.canonical, title: meta.title, qr });
  } catch (error) {
    res.status(500).json({ error: '生成二维码失败' });
  }
}));

// 微信签名配置：签名目标是当前实际页面地址（含查询参数），由前端传入后按白名单校验。
// 卡片链接是 canonical，与签名 URL 无关；两者不得混用。
router.get('/api/share/wechat-config', asyncHandler(async (req, res) => {
  const resolved = await resolveRequestedContent(req.query || {});
  if (!resolved.ok) return res.status(resolved.status || 404).json({ error: resolved.error });

  const pageUrl = String((req.query && req.query.url) || '').trim();
  if (!pageUrl) return res.status(400).json({ error: '缺少签名页面地址' });
  if (!registry.isAllowedSignUrl(pageUrl)) return res.status(400).json({ error: '签名页面地址不在允许范围' });

  const meta = registry.buildSecurityMeta(resolved.security);
  if (!wechatShare.isConfigured()) {
    return res.json({ configured: false, share: meta, reason: '未配置微信分享凭据' });
  }
  try {
    const config = await wechatShare.buildConfig(pageUrl);
    res.setHeader('Cache-Control', 'no-store');
    res.json(Object.assign(config, { share: meta }));
  } catch (error) {
    // 上游失败只返回可读原因，不含票据或上游原始响应。
    res.status(502).json({ configured: false, share: meta, error: '微信签名暂时不可用' });
  }
}));

module.exports = router;
