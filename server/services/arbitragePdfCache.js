// 套利公告 PDF 本地缓存：解析复用，避免同一官方文件反复下载。
const cache = require('./documentPdfCache');

// 兼容旧环境变量和调用方；新业务统一使用 documentPdfCache 的共享目录。
function cleanupArbitragePdfCache(now = Date.now()) {
  return cache.cleanupDocumentPdfCache(now);
}

module.exports = {
  cacheDir: cache.cacheDir,
  cacheLimits: cache.cacheLimits,
  cleanupArbitragePdfCache,
  DEFAULT_TTL_DAYS: cache.DEFAULT_TTL_DAYS,
  DEFAULT_MAX_BYTES: cache.DEFAULT_MAX_BYTES,
};
