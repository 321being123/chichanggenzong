const fs = require('fs');
const path = require('path');

const PAGE_FILES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/login.html': 'login.html',
  '/admin.html': 'admin.html',
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
