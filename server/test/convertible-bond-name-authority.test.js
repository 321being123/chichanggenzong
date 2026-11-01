const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pickAuthoritativeName } = require('../domain/convertibleBondNameRules');

// 官方简称存在时一律以官方为准：公告正文残留「中科转债二」不得覆盖「中科转债」（2026-11-01 事故）。
assert.strictEqual(pickAuthoritativeName('中科转债', '中科转债二'), '中科转债');
assert.strictEqual(pickAuthoritativeName(' 中科转债 ', '中科转债二'), '中科转债');
// 真二期简称与官方简称一致时保持原样。
assert.strictEqual(pickAuthoritativeName('常青转债二', '常青转债二'), '常青转债二');
assert.strictEqual(pickAuthoritativeName('润禾转02', '润禾转债'), '润禾转02');
// 官方简称缺失时退回公告名 / 网上发行简称。
assert.strictEqual(pickAuthoritativeName('', '中科转债'), '中科转债');
assert.strictEqual(pickAuthoritativeName(null, '中科发债'), '中科发债');
assert.strictEqual(pickAuthoritativeName('', ''), '');

// 生命周期同步必须走这条裁决，不能退回「公告解析名优先」。
const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondLifecycleSync.js'), 'utf8');
assert.ok(service.includes('pickAuthoritativeName'), '生命周期同步必须用官方简称裁决名称');
assert.ok(/const name = await authoritativeBondName\(/.test(service), '主档名称必须经 authoritativeBondName 裁决');

console.log('convertible bond name authority tests passed');
