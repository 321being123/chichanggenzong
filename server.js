// 入口文件：组装并启动服务（具体实现见 server/ 下的模块化代码）
// 保持 `node server.js` 可直接启动，部署 / pm2 无需任何改动。
const { start } = require('./server/app');
start();
