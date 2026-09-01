// 可转债动机回测门禁：锁定公告前取数、样本外窗口和失败留痕。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const script = fs.readFileSync(path.join(root, 'server', 'scripts', 'backtestConvertibleBondMotive.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'server', 'db', 'migrations.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.ok(script.includes('c.trigger_date >= $1::date'), '回测必须以触发日作为信号日');
assert.ok(script.includes('c.proposal_date > c.trigger_date'), '提议日不得早于或等于信号日，防止未来数据泄漏');
assert.ok(script.includes('loadMotiveInput') && script.includes('modelCalibrated: true'), '回测必须读取评分日可见事实并临时计算研究分档');
assert.ok(script.includes('ROUND_TRIP_COST = 0.003') && script.includes('netReturnAfterCost'), '回测必须扣除0.30%往返成本');
assert.ok(script.includes('const highReturns = highRows.map') && !script.includes('const returns = rows.map'), '收益门槛必须只统计高分组，不能误用全部样本平均收益');
assert.ok(script.includes('DATA_COMPLETENESS_BELOW_95PCT') && script.includes('HIGH_SCORE_PROPOSAL_RATE_BELOW_35PCT'), '未达上线门槛时必须记录明确阻断原因');
assert.ok(script.includes('convertible_bond_revision_motive_backtests'), '回测结果必须落库留痕');
assert.ok(migration.includes('115_convertible_bond_revision_motive_backtest') && migration.includes('convertible_bond_revision_motive_backtests'), '缺少动机回测结果迁移');
assert.ok(packageJson.scripts && packageJson.scripts['backtest:motive'], '缺少动机回测命令入口');

console.log('convertible-bond-motive-backtest.test.js 通过');
