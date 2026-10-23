// 证券分析与通用分享：内容登记、公开身份校验与元信息生成。
// 约束（见 docs/证券分析与通用分享开发方案_20261022.md）：
// - 只登记已核验的公开内容类型，不接受任意内部路径、任意网页 URL 或任意接口作为分享目标。
// - 入口层用统一身份服务确认对象存在，不按数字前缀自行猜市场。
// - 不新增数据表、不触发外部采集、不写分析快照。
const { canonicalizeSecurityCode, resolveInstrument } = require('./securityIdentity');

const SITE_NAME = '存在小站';
const CONTENT_LABEL = '证券分析';

// 首期只开放证券分析，且只有 bond / stock 两种资源类型。
const CONTENT_TYPES = Object.freeze({
  'security-analysis': Object.freeze({ kinds: Object.freeze(['bond', 'stock']) }),
});

const KIND_ASSET_CLASS = Object.freeze({ bond: 'convertible_bond', stock: 'stock' });
const KIND_DESCRIPTION = Object.freeze({
  bond: '可转债公开分析：条款触发、转股与纯债价值、期权价值、安全性与评级历史。',
  stock: '股票公开分析：估值分位、盈利增长、财务安全性、现金流与公司公告。',
});

// 公开站点地址的唯一来源。未配置时返回 null，由调用方给出明确说明，绝不回退到 Host 头或页面参数。
function publicOrigin() {
  const raw = String(process.env.SHARE_PUBLIC_ORIGIN || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

// 签名目标白名单：只允许本站主站与已登记分享页路径，且不能带 fragment。
// 主站内点分享时签名 URL 是 /?main=... 这类地址，与卡片链接 canonical 不同，两者都要在这里放行。
function isAllowedSignUrl(rawUrl) {
  const origin = publicOrigin();
  if (!origin || !rawUrl) return false;
  let target;
  try { target = new URL(String(rawUrl)); } catch (_) { return false; }
  if (target.origin !== new URL(origin).origin) return false;
  if (target.hash) return false;
  const pathname = target.pathname;
  if (pathname === '/' || pathname === '/index.html') return true;
  return /^\/s\/security\/(bond|stock)\/[0-9]{6}\.(SH|SZ|BJ)$/.test(pathname);
}

function isKnownContentType(contentType) {
  const key = String(contentType || '').trim();
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, key) && key === 'security-analysis';
}

function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_ASSET_CLASS, String(kind || '').trim());
}

// 公开分享页地址：/s/security/:kind/:code
function securitySharePath(kind, canonicalCode) {
  return `/s/security/${encodeURIComponent(kind)}/${encodeURIComponent(canonicalCode)}`;
}

function securityShareUrl(kind, canonicalCode) {
  const origin = publicOrigin();
  return origin ? origin + securitySharePath(kind, canonicalCode) : null;
}

// 解析并校验公开证券。成功返回 { ok:true, security }，失败返回带 HTTP 状态码的原因。
async function resolveSecurity(kindValue, rawCodeValue) {
  const kind = String(kindValue || '').trim().toLowerCase();
  if (!isKnownKind(kind)) return { ok: false, status: 400, error: '仅支持 bond 或 stock 两种证券类型' };

  const rawCode = String(rawCodeValue || '').trim();
  if (!rawCode || rawCode.length > 20) return { ok: false, status: 400, error: '证券代码不合法' };

  const canonicalCode = canonicalizeSecurityCode(rawCode, KIND_ASSET_CLASS[kind]);
  if (!canonicalCode || !/^\d{6}\.(SH|SZ|BJ)$/.test(canonicalCode)) {
    return { ok: false, status: 400, error: '证券代码不合法' };
  }

  let instrument = null;
  try {
    instrument = await resolveInstrument({ canonicalCode });
  } catch (error) {
    return { ok: false, status: 503, error: '证券身份暂时无法校验' };
  }
  if (!instrument) return { ok: false, status: 404, error: '证券不存在' };

  // 类型必须与解析结果一致，避免用 stock 路径打开转债或其他品种。
  if (String(instrument.asset_class || '') !== KIND_ASSET_CLASS[kind]) {
    return { ok: false, status: 404, error: '证券类型不匹配' };
  }

  const name = String(instrument.name || '').trim() || canonicalCode;
  return {
    ok: true,
    security: {
      kind,
      code: canonicalCode,
      digits: canonicalCode.slice(0, 6),
      name,
    },
  };
}

// 公开元信息：只含名称、代码、固定说明与公开地址，不含行情、运维字段或内部诊断。
function buildSecurityMeta(security) {
  const origin = publicOrigin();
  const canonical = securityShareUrl(security.kind, security.code);
  return {
    contentType: 'security-analysis',
    resourceKind: security.kind,
    resourceKey: security.code,
    title: `${security.name}（${security.digits}）｜${CONTENT_LABEL}｜${SITE_NAME}`,
    description: KIND_DESCRIPTION[security.kind],
    canonical,
    path: securitySharePath(security.kind, security.code),
    // 封面必须是可公网访问的绝对 HTTPS 地址且不小于 300×300，相对路径分享平台抓不到。
    imageUrl: origin ? origin + '/share-cover.png' : null,
  };
}

module.exports = {
  SITE_NAME,
  CONTENT_LABEL,
  CONTENT_TYPES,
  KIND_ASSET_CLASS,
  publicOrigin,
  isKnownContentType,
  isKnownKind,
  securitySharePath,
  securityShareUrl,
  isAllowedSignUrl,
  resolveSecurity,
  buildSecurityMeta,
};
