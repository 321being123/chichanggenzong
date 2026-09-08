// 运行：node server/test/ipo-instrument-identity.test.js
// 第 17 节首批身份链回归：迁移、A 股兼容读写和港交所内部限制口径。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'server', 'db', 'migrations.js'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'ipo-report', 'ipo_history_sync.py'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'server', 'services', 'securityIdentity.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server', 'routes', 'ipo.js'), 'utf8');
const hkex = require('../services/hkexAnnouncement');

assert.match(migration, /140_ipo_instrument_identity/);
assert.match(migration, /141_backfill_ipo_identity_gaps/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS instrument_id BIGINT/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS market_code TEXT NOT NULL DEFAULT 'CN'/);
assert.match(migration, /fk_ipo_history_instrument_id/);
assert.match(migration, /uq_ipo_history_market_instrument/);
assert.match(migration, /60次\/分钟、2000次\/日为本项目内部保护线/);
assert.match(sync, /ensure_instrument\(/);
assert.match(sync, /"instrument_id"\] = master\["instrument_id"\]/);
assert.match(sync, /market_code='CN'/);
assert.match(identity, /core\.instruments\.status='listed'/);
assert.match(route, /h\.market_code='CN'/);
assert.ok(hkex.ALLOWED_DOMAINS.has('www1.hkexnews.hk'));
assert.ok(hkex.ALLOWED_DOMAINS.has('www2.hkexnews.hk'));
assert.ok(!hkex.ALLOWED_DOMAINS.has('example.com'));

console.log('OK ipo-instrument-identity: IPO 事实已具备统一 instrument_id、CN 隔离和 HKEX 内部保护口径');
