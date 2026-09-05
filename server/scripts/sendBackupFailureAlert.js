#!/usr/bin/env node
// systemd OnFailure 入口：复用统一的 ops.alert_notifications + SMTP 告警链路。

'use strict';

const { execFileSync } = require('child_process');
const { pool } = require('../db/connection');
const { notifyJobFailure } = require('../services/jobAlertMailer');

function safeUnit(value) {
  const unit = String(value || '').trim();
  return /^[A-Za-z0-9_.@:-]+$/.test(unit) ? unit : 'unknown-backup-unit';
}

function recentJournal(unit) {
  try {
    return execFileSync('/usr/bin/journalctl', ['-u', unit, '-n', '40', '--no-pager', '-o', 'cat'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 200 * 1024,
    }).trim().slice(-5000);
  } catch (error) {
    return `无法读取失败日志：${String(error.message || error).slice(0, 500)}`;
  }
}

async function main() {
  const unit = safeUnit(process.argv[2]);
  const summary = `systemd 单元 ${unit} 执行失败，请检查备份、对象存储或恢复演练状态。\n\n最近日志：\n${recentJournal(unit)}`;
  const result = await notifyJobFailure({
    alertKey: `infra:backup:${unit}`,
    jobCode: `infra-backup:${unit}`,
    alertType: 'failure',
    severity: 'critical',
    subject: `备份/恢复任务失败：${unit}`,
    summary,
  });
  console.log(JSON.stringify({ ok: Boolean(result && result.ok), alertId: result && result.alertId, suppressed: result && result.suppressed }));
  if (!result || !result.ok) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(`备份失败告警发送异常：${String(error.message || error).slice(0, 500)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
