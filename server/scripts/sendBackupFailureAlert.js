#!/usr/bin/env node
// systemd OnFailure 入口：复用统一的 ops.alert_notifications + SMTP 告警链路。

'use strict';

const { execFileSync } = require('child_process');
const { pool } = require('../db/connection');
const { mailer } = require('../config');
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

function recipients() {
  return String(process.env.ALERT_EMAIL_TO || '')
    .split(',').map(item => item.trim()).filter(Boolean);
}

async function fallbackSmtp(unit, summary, databaseError) {
  const to = recipients();
  if (!mailer || !to.length) return false;
  await mailer.sendMail({
    from: process.env.ALERT_EMAIL_FROM || `存在小站任务告警 <${process.env.SMTP_USER}>`,
    to,
    subject: `[${process.env.ALERT_ENVIRONMENT || process.env.NODE_ENV || 'production'}] 备份/恢复任务失败（数据库告警不可用）`,
    text: `${summary}\n\n告警记录库不可用，已直接通过 SMTP 投递。数据库错误：${String(databaseError.message || databaseError).slice(0, 500)}\n时间：${new Date().toISOString()}`,
  });
  console.log(JSON.stringify({ ok: true, fallback: 'smtp', unit }));
  return true;
}

async function resolveAlert(unit) {
  const { rows } = await pool.query(
    `UPDATE ops.alert_notifications
        SET status='resolved', resolved_at=now(), sending_started_at=NULL, next_send_at=NULL, updated_at=now()
      WHERE alert_key=$1 AND status NOT IN ('resolved','acknowledged')
      RETURNING alert_id`, [`infra:backup:${unit}`]
  );
  console.log(JSON.stringify({ ok: true, resolved: rows.length, unit }));
}

async function main() {
  if (process.argv[2] === '--resolve') {
    await resolveAlert(safeUnit(process.argv[3]));
    return;
  }
  const unit = safeUnit(process.argv[2]);
  const summary = `systemd 单元 ${unit} 执行失败，请检查备份、对象存储或恢复演练状态。\n\n最近日志：\n${recentJournal(unit)}`;
  try {
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
  } catch (error) {
    if (!await fallbackSmtp(unit, summary, error)) throw error;
  }
}

main()
  .catch(error => {
    console.error(`备份失败告警发送异常：${String(error.message || error).slice(0, 500)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
