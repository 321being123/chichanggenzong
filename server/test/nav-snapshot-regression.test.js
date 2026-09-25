const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const snapshot = fs.readFileSync(path.join(root, 'server', 'jobs', 'navSnapshot.js'), 'utf8');
const tables = fs.readFileSync(path.join(root, 'public', 'shared', 'core-tables.js'), 'utf8');
const { getJobDefinition } = require('../services/jobDefinitions');

assert(/latestPositionAnchor/.test(snapshot), '净值快照必须识别历史持仓锚点');
assert(/manual_reconciliation/.test(snapshot) && /snapshotSource === 'imported'/.test(snapshot), '净值快照必须优先使用人工校准或券商导入快照');
assert(/codeCutoffs/.test(snapshot) && /人工快照可能只校准部分证券/.test(snapshot), '部分人工校准不得覆盖券商全量持仓底座');
assert(/tradeDay\(t\) <= cutoff/.test(snapshot), '净值快照只能重放对应证券锚点之后的交易');
assert(/holdingCode\(t\.code, t\.name\)/.test(snapshot), '净值快照必须兼容历史港股代码别名');
assert(/missingCodes/.test(snapshot) && /failedDatasets: \['nav_snapshot'\]/.test(snapshot), '缺行情代码必须返回可诊断的失败结果');
assert(/failedAccounts/.test(snapshot) && /result\.ok/.test(snapshot), '单账户失败不得再被整体任务伪装为成功');
assert.strictEqual(getJobDefinition('nav_snapshot').freshnessGate, false, '单账户已有今日快照不得短路其他账户的净值任务');
assert(/liveAttribution\.complete === true/.test(tables) && /liveAttribution\.currentDate === todayCN\(\)/.test(tables),
  '页面今日涨跌必须依赖服务端按各持仓市场日历验证完整的归因');
assert(!/hasPreviousTradingSnapshot/.test(tables), '页面不得用 A 股交易日间隔替代跨市场净值归因');

console.log('nav snapshot regression tests passed');
