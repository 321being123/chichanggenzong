// 数据库连接与基础依赖（原 server/db.js 头部，物理拆分）
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { DEFAULT_FEE_SETTINGS } = require('../../public/shared/core-fees');

// DATA_DIR 指向项目根目录下的 data/（本文件位于 server/db，故需上溯两级）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// PostgreSQL TLS：PGSSL='true' 启用加密连接；若同时提供 PGSSL_CA（CA 证书路径），
// 则校验服务端证书（rejectUnauthorized=true），防止中间人；否则仅加密不校验（兼容自签名/内网）。
// 全部由环境变量控制，零新增依赖。
let ssl = false;
if (process.env.PGSSL === 'true') {
  ssl = process.env.PGSSL_CA
    ? { rejectUnauthorized: true, ca: fs.readFileSync(process.env.PGSSL_CA) }
    : { rejectUnauthorized: false };
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
    })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'portfolio',
      max: 10,
      ssl,
    });

module.exports = { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS };
