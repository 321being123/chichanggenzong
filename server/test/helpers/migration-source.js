// R-6 迁移拆分后（2026-10-21）的源码读取口：迁移函数体已按域搬到 db/migrations/*.js，
// 注册表与引擎仍在 db/migrations.js。源码文本断言测试统一从这里取拼接文本，断言语义不变。
const fs = require('fs');
const path = require('path');

function readMigrationSource() {
  const dir = path.join(__dirname, '..', '..', 'db');
  let out = fs.readFileSync(path.join(dir, 'migrations.js'), 'utf8');
  const sub = path.join(dir, 'migrations');
  for (const f of fs.readdirSync(sub).sort()) {
    if (f.endsWith('.js')) out += '\n' + fs.readFileSync(path.join(sub, f), 'utf8');
  }
  return out;
}

module.exports = { readMigrationSource };
