// 套利公告 PDF 本地缓存：解析复用，避免同一官方文件反复下载。
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function cacheDir() {
  return process.env.ARBITRAGE_PDF_CACHE_DIR
    || path.join(__dirname, '..', '..', 'data', 'arbitrage_pdf_cache');
}

function cacheLimits() {
  const ttl = Number(process.env.ARBITRAGE_PDF_CACHE_TTL_DAYS);
  const max = Number(process.env.ARBITRAGE_PDF_CACHE_MAX_BYTES);
  return {
    ttlDays: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_DAYS,
    maxBytes: Number.isFinite(max) && max >= 1024 * 1024 ? Math.floor(max) : DEFAULT_MAX_BYTES,
  };
}

function cleanupArbitragePdfCache(now = Date.now()) {
  const directory = cacheDir();
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
    if (!stat.isFile() || !['.pdf', '.part'].includes(path.extname(name).toLowerCase())) continue;
    if (stat.mtimeMs < cutoff) {
      try { fs.unlinkSync(file); deletedExpired++; } catch (_) {}
      continue;
    }
    if (path.extname(name).toLowerCase() === '.pdf') files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  for (const item of files) {
    if (totalBytes <= maxBytes) break;
    try {
      fs.unlinkSync(item.file);
      totalBytes -= item.size;
      deletedOverflow++;
    } catch (_) {}
  }

  return { directory, ttlDays, maxBytes, totalBytes, fileCount: Math.max(files.length - deletedOverflow, 0), deletedExpired, deletedOverflow };
}

module.exports = { cacheDir, cacheLimits, cleanupArbitragePdfCache, DEFAULT_TTL_DAYS, DEFAULT_MAX_BYTES };
