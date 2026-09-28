'use strict';

const assert = require('assert');
const path = require('path');
const { appVersion } = require('../../package.json');
const { versionedStaticPages } = require('../middleware/versionedStaticPages');

const publicDir = path.join(__dirname, '..', '..', 'public');
const middleware = versionedStaticPages(publicDir, appVersion);

function requestPage(route) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', path: route };
    const res = {
      type(value) { this.contentType = value; return this; },
      send(body) { resolve({ contentType: this.contentType, body }); },
    };
    middleware(req, res, reject);
  });
}

(async () => {
  for (const route of ['/', '/index.html', '/login.html', '/admin.html']) {
    const response = await requestPage(route);
    assert.strictEqual(response.contentType, 'html', `${route} 应返回 HTML`);
    assert(!response.body.includes('__APP_VERSION__'), `${route} 不得把版本占位符发给浏览器`);
    assert(response.body.includes(`?v=${appVersion}`), `${route} 资源必须自动跟随 appVersion`);
  }
  console.log('versioned static pages tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
