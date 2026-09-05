const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const app = read('server/app.js');
const migrations = read('server/db/migrations.js');
const connection = read('server/db/connection.js');
const runner = read('server/scripts/runMigrations.js');
const webUnit = read('deploy/portfolio-server.service');
const workerUnit = read('deploy/portfolio-worker.service');

assert.match(app, /DISABLE_RUNTIME_MIGRATIONS !== '1'/);
assert.match(migrations, /async function assertSchemaReady/);
assert.match(migrations, /数据库未完成最新迁移/);
assert.match(connection, /MIGRATION_ROLE/);
assert.match(connection, /options: `-c role=\$\{migrationRole\}`/);
assert.match(runner, /MIGRATION_DATABASE_URL/);
assert.match(runner, /MIGRATION_ENV_FILE/);
assert.match(webUnit, /Environment=DISABLE_RUNTIME_MIGRATIONS=1/);
assert.match(workerUnit, /Environment=DISABLE_RUNTIME_MIGRATIONS=1/);
console.log('migration-separation: 迁移账号入口、运行时版本检查和 systemd 开关通过');
