const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const snapshot = fs.readFileSync(path.join(root, 'server', 'jobs', 'navSnapshot.js'), 'utf8');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');

assert(/latestPositionAnchor/.test(snapshot), '净值快照必须识别历史持仓锚点');
assert(/manual_reconciliation/.test(snapshot) && /snapshotSource === 'imported'/.test(snapshot), '净值快照必须优先使用人工校准或券商导入快照');
assert(/tradeDay\(t\) <= anchor\.anchorDate/.test(snapshot), '净值快照只能重放锚点之后的交易');
assert(/holdingCode\(t\.code, t\.name\)/.test(snapshot), '净值快照必须兼容历史港股代码别名');
assert(/missingCodes/.test(snapshot) && /failedDatasets: \['nav_snapshot'\]/.test(snapshot), '缺行情代码必须返回可诊断的失败结果');
assert(/failedAccounts/.test(snapshot) && /result\.ok/.test(snapshot), '单账户失败不得再被整体任务伪装为成功');
assert(/hasPreviousTradingSnapshot = tradingGapDays === 0/.test(tables), '缺少上一交易日快照时页面不得显示今日涨跌');

console.log('nav snapshot regression tests passed');
