const crypto = require('crypto');

// 公共只读接口的短缓存与版本 ETag。版本由数据分区/最新记录生成，不缓存账户私有数据。
function buildEtag(version) {
  const token = crypto.createHash('sha1').update(String(version == null ? 'empty' : version)).digest('hex');
  return `"${token}"`;
}

function applyPublicCache(req, res, version, maxAge = 60) {
  const etag = buildEtag(version);
  res.set('Cache-Control', `public, max-age=${maxAge}, must-revalidate`);
  res.set('ETag', etag);
  const incoming = String(req.get('If-None-Match') || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (incoming.includes(etag) || incoming.includes('*')) {
    res.status(304).end();
    return true;
  }
  return false;
}

function applyPrivateCache(req, res, version) {
  const etag = buildEtag(version);
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', etag);
  const incoming = String(req.get('If-None-Match') || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (incoming.includes(etag) || incoming.includes('*')) {
    res.status(304).end();
    return true;
  }
  return false;
}

module.exports = { applyPublicCache, applyPrivateCache };
