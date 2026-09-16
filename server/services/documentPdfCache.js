// 统一官方文档 PDF 持久化缓存：IPO 招股书、上市公告书及其他公告共用。
// 缓存只保存可重新获取的官方原文，不承载业务事实；业务事实仍写入 raw_records/event.documents。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function cacheDir() {
  return process.env.DOCUMENT_PDF_CACHE_DIR
    || process.env.ARBITRAGE_PDF_CACHE_DIR
    || path.join(__dirname, '..', '..', 'data', 'document_pdf_cache');
}

function cacheLimits() {
  const ttlValue = process.env.DOCUMENT_PDF_CACHE_TTL_DAYS ?? process.env.ARBITRAGE_PDF_CACHE_TTL_DAYS;
  const maxValue = process.env.DOCUMENT_PDF_CACHE_MAX_BYTES ?? process.env.ARBITRAGE_PDF_CACHE_MAX_BYTES;
  const ttl = Number(ttlValue);
  const max = Number(maxValue);
  return {
    ttlDays: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_DAYS,
    maxBytes: Number.isFinite(max) && max >= 1024 * 1024 ? Math.floor(max) : DEFAULT_MAX_BYTES,
  };
}

function cachePath(url, directory = cacheDir()) {
  const digest = crypto.createHash('sha256').update(String(url || '')).digest('hex');
  return path.join(directory, `${digest}.pdf`);
}

function cleanupDocumentPdfCache(now = Date.now(), directoryOverride = null) {
  const directory = directoryOverride || cacheDir();
  fs.mkdirSync(directory, { recursive: true });
  const { ttlDays, maxBytes } = cacheLimits();
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  const files = [];
  let deletedExpired = 0;
  let deletedOverflow = 0;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    const ext = path.extname(name).toLowerCase();
    if (!stat.isFile() || !['.pdf', '.part'].includes(ext)) continue;
    if (stat.mtimeMs < cutoff) {
      try { fs.unlinkSync(file); deletedExpired++; } catch (_) {}
      continue;
    }
    if (ext === '.pdf') files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  for (const item of files) {
    if (totalBytes <= maxBytes) break;
    try { fs.unlinkSync(item.file); totalBytes -= item.size; deletedOverflow++; } catch (_) {}
  }
  return {
    directory, ttlDays, maxBytes, totalBytes,
    fileCount: Math.max(files.length - deletedOverflow, 0), deletedExpired, deletedOverflow,
  };
}

function readCachedPdf(url, { now = Date.now(), directory = cacheDir() } = {}) {
  cleanupDocumentPdfCache(now, directory);
  const file = cachePath(url, directory);
  try {
    const stat = fs.statSync(file);
    const { ttlDays } = cacheLimits();
    if (!stat.isFile() || stat.size <= 0 || stat.mtimeMs < now - ttlDays * 24 * 60 * 60 * 1000) return null;
    const buffer = fs.readFileSync(file);
    return buffer.length ? buffer : null;
  } catch (_) {
    return null;
  }
}

function writeCachedPdf(url, buffer, { directory = cacheDir() } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('PDF 缓存内容为空');
  fs.mkdirSync(directory, { recursive: true });
  const target = cachePath(url, directory);
  const temp = `${target}.${process.pid}.${Date.now()}.part`;
  try {
    fs.writeFileSync(temp, buffer, { mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
  }
  cleanupDocumentPdfCache(Date.now(), directory);
  return target;
}

module.exports = {
  DEFAULT_TTL_DAYS,
  DEFAULT_MAX_BYTES,
  cacheDir,
  cacheLimits,
  cachePath,
  cleanupDocumentPdfCache,
  readCachedPdf,
  writeCachedPdf,
};
