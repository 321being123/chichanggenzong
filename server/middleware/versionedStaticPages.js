const fs = require('fs');
const path = require('path');

const PAGE_FILES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/login.html': 'login.html',
  '/admin.html': 'admin.html',
  // 全部页面统一走 __APP_VERSION__ 替换，静态 ?v= 才不会与发版脱节（2026-10-21 审查 U-2/U-12）
  '/share-knowledge.html': 'share-knowledge.html',
  '/ipo-report.html': 'ipo-report.html',
  '/bond-revision-motive.html': 'bond-revision-motive.html',
});

function renderAppVersion(html, appVersion) {
  return html.replaceAll('__APP_VERSION__', encodeURIComponent(String(appVersion)));
}

function versionedStaticPages(publicDir, appVersion) {
  return function serveVersionedPage(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = PAGE_FILES[req.path];
    if (!file) return next();

    fs.readFile(path.join(publicDir, file), 'utf8', function (error, html) {
      if (error) return next(error.code === 'ENOENT' ? undefined : error);
      res.type('html').send(renderAppVersion(html, appVersion));
    });
  };
}

module.exports = { renderAppVersion, versionedStaticPages };
