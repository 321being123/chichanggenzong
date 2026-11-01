'use strict';
// 可转债列表「转债名称旁生命周期标记」回归：
// 强赎状态优先、到期分档（最后 30 天红色 / 不到半年橘红 / 不到一年黄色）、五个转债列表共用同一份实现。
// 时间口径固定为上海时区，断言显式传入「现在」，不用真实时钟，避免跨天或跨时区飘移。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0;
function check(name, fn) {
  fn();
  pass += 1;
  console.log('ok - ' + name);
}

const context = { self: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'shared', 'core-date.js'), 'utf8'), context);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'shared', 'bond-marks.js'), 'utf8'), context);
const marks = context.self.BondMarks;

// 上海时间 2026-11-01 10:00（用 ISO 字符串传入，避免跨 realm 的 Date 判定）
const NOW = '2026-11-01T02:00:00Z';
function markOf(row, now) { return marks.lifecycle(row, now || NOW); }

check('强赎类状态优先于到期提醒且用红色叹号', () => {
  const html = markOf({ call_status: 'announced', maturity_date: '2026-12-01' });
  assert(html.includes('bond-lifecycle-mark-call'), '已公告强赎必须用强赎红色标识');
  assert(html.includes('title="已公告强赎"'), '已公告强赎必须有悬停说明');
  assert(!html.includes('expiry'), '强赎状态已表达时不得再叠加到期标识');
  ['maturity_redeem', 'redemption_unconfirmed', 'completed', 'maturity_near'].forEach((status) => {
    assert(markOf({ call_status: status }).includes('bond-lifecycle-mark'), status + ' 必须显示名称标识');
  });
});

check('最后 30 天到期用红色临近到期并给出天数说明', () => {
  const html = markOf({ call_status: 'tracking', maturity_date: '2026-11-20' });
  assert(html.includes('bond-lifecycle-mark-maturity'), '30 天内到期必须用红色标识');
  assert(html.includes('临近到期：到期日 2026-11-20，还有 19 天'), '红色标识必须写明到期日与剩余天数');
});

check('不到半年到期用橘红叹号', () => {
  const html = markOf({ maturity_date: '2027-04-10' });
  assert(html.includes('bond-lifecycle-mark-expiry-6m'), '半年内到期必须用橘红标识');
  assert(html.includes('距到期不到半年：到期日 2027-04-10'), '橘红标识必须写明原因');
  assert(html.includes('还有 160 天'), '橘红标识必须写明剩余天数');
});

check('不到一年到期用黄色叹号', () => {
  const html = markOf({ maturity_date: '2027-09-01' });
  assert(html.includes('bond-lifecycle-mark-expiry-1y'), '一年内到期必须用黄色标识');
  assert(html.includes('距到期不到一年：到期日 2027-09-01'), '黄色标识必须写明原因');
  assert(!html.includes('expiry-6m'), '超过半年的不得同时显示橘红');
});

check('超过一年、已到期、无到期日都不加标记', () => {
  assert.strictEqual(markOf({ maturity_date: '2028-06-01' }), '', '一年以上不应有标记');
  assert.strictEqual(markOf({ maturity_date: '2026-10-20' }), '', '已到期不应有标记');
  assert.strictEqual(markOf({ maturity_date: null }), '', '无到期日不应有标记');
  assert.strictEqual(markOf(null), '', '空行不应崩溃');
  assert.strictEqual(markOf({ maturity_date: '2027/09/01' }), '', '非业务日期格式不应猜测');
});

check('半年与一年按自然月计算，边界日当天仍算在内', () => {
  assert(markOf({ maturity_date: '2027-05-01' }).includes('expiry-6m'), '正好 6 个月应算橙档');
  assert(markOf({ maturity_date: '2027-05-02' }).includes('expiry-1y'), '超过 6 个月应落到黄档');
  assert(markOf({ maturity_date: '2027-11-01' }).includes('expiry-1y'), '正好 12 个月应算黄档');
  // 月末安全：8 月 31 日 + 6 个月＝次年 2 月末，不得溢出到 3 月
  const monthEnd = markOf({ maturity_date: '2027-02-28' }, '2026-08-31T02:00:00Z');
  assert(monthEnd.includes('expiry-6m'), '月末加月不得溢出到下个月');
  assert(!markOf({ maturity_date: '2027-03-01' }, '2026-08-31T02:00:00Z').includes('expiry-6m'), '溢出会把 3 月 1 日误判为半年内');
});

check('日期按上海时区判定，不随浏览器时区漂移', () => {
  // UTC 10-31 17:00 ＝ 上海 11-01 01:00，两者的剩余天数必须一致
  const beforeMidnightUtc = markOf({ maturity_date: '2026-11-20' }, '2026-10-31T17:00:00Z');
  assert(beforeMidnightUtc.includes('还有 19 天'), '上海时区跨零点必须按 11-01 起算');
});

check('五个可转债列表都用同一份共享标记', () => {
  const lists = ['bond-list.js', 'bond-safety.js', 'bond-valuation.js', 'bond-redemption.js', 'bond-revision.js'];
  for (const file of lists) {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8');
    assert(source.includes('bondLifecycleMark('), file + ' 未复用共享生命周期标记');
    assert(!/function\s+\w*LifecycleMarker\s*\(/.test(source), file + ' 不得再保留各自的近似实现');
  }
  // 强赎监控的业务状态就是强赎状态，必须按 call_status 传入；下修状态不是强赎状态，不得冒充。
  const redemption = fs.readFileSync(path.join(ROOT, 'public', 'js', 'bond-redemption.js'), 'utf8');
  assert(redemption.includes('call_status: row.business_status'), '强赎监控名称旁必须复用强赎业务状态');
  const revision = fs.readFileSync(path.join(ROOT, 'public', 'js', 'bond-revision.js'), 'utf8');
  assert(!revision.includes('call_status'), '下修监控的下修状态不得当作强赎状态');
});

check('样式与加载顺序符合统一样式要求', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'bond-safety.css'), 'utf8');
  assert(css.includes('.bond-lifecycle-mark-expiry-6m') && css.includes('.bond-lifecycle-mark-expiry-1y'), '到期两档标缺少颜色样式');
  assert(/\.bond-lifecycle-mark\s*\{[^}]*cursor:help/.test(css), '标记必须保留悬停提示光标');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const marksAt = html.indexOf('shared/bond-marks.js');
  assert(marksAt >= 0, '主站必须加载共享标记脚本');
  assert(marksAt < html.indexOf('js/bond-list.js'), '共享标记脚本必须先于列表脚本加载');
  assert(marksAt < html.indexOf('js/bond-safety.js'), '共享标记脚本必须先于安全性列表脚本加载');
});

console.log('bond-lifecycle-marks: ' + pass + ' 项通过');
