// 兼容层：物理拆分后，本文件仅重新导出 server/db/index.js 的聚合接口。
// 所有调用方（server/app.js、server/worker.js、API 路由等）无需改动。
module.exports = require('./db/index');
