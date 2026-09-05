#!/usr/bin/env node
// 发布维护阶段使用迁移账号执行数据库升级；Web/Worker 只做版本检查。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
if (!process.env.MIGRATION_DATABASE_URL) {
  console.error('缺少 MIGRATION_DATABASE_URL');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
process.env.MIGRATION_ROLE = process.env.MIGRATION_ROLE || 'portfolio_owner';
const { runMigrations, pool } = require('../db');

runMigrations()
  .then(() => { console.log('数据库迁移完成'); })
  .catch(error => { console.error('数据库迁移失败:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
