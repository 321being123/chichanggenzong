const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveCanonicalCode } = require('../services/securityIdentity');
const migrationsSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations.js'), 'utf8');

(async () => {
  assert.strictEqual(await resolveCanonicalCode('601919', 'stock'), '601919.SH');
  assert.strictEqual(await resolveCanonicalCode('601198', 'stock'), '601198.SH');
  assert.strictEqual(await resolveCanonicalCode('000672', 'stock'), '000672.SZ');
  assert.strictEqual(await resolveCanonicalCode('920002', 'stock'), '920002.BJ');
  assert.strictEqual(await resolveCanonicalCode('900901', 'stock'), '900901.SH');
  assert.strictEqual(await resolveCanonicalCode('123175', 'convertible_bond'), '123175.SZ');
  assert.strictEqual(await resolveCanonicalCode('113575.SH', 'convertible_bond'), '113575.SH');

  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'securityIdentity.js'), 'utf8');
  assert.ok(source.includes('证券已经有关联公司时必须复用'), '主档写入必须复用已有公司关系');
  assert.ok(source.includes("c.raw_data->>'ts_code'=$3"), '公司关系应优先使用官方 ts_code');
  assert.ok(!source.includes('matches.rows.length > 1'), '标准代码解析不得因历史重复主档抛歧义');
  assert.ok(migrationsSource.includes("pg_advisory_lock(904000)") && migrationsSource.includes("pg_advisory_unlock(904000)"), 'Web/Worker 并发启动时必须串行执行数据库迁移');
  assert.ok(migrationsSource.includes('tmp_instrument_expected') && migrationsSource.includes('tmp_instrument_survivors'), '主档迁移必须先按标准代码选唯一保留行，再处理错误后缀');
  assert.ok(migrationsSource.includes("regexp_replace(i.canonical_code,'[^0-9]','','g')"), '主档迁移必须使用明确的数字提取规则');
  console.log('security identity consolidation tests passed');
})().catch(error => { console.error(error); process.exit(1); });
