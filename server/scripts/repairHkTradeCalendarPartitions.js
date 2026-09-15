#!/usr/bin/env node
// 港股交易日历业务分区定向修复：默认只读预览；--apply 才写入且保留原记录。
// 该脚本只复制已有分区元数据，不联网、不重跑任务；生产执行必须另行授权。
require('dotenv').config();

const { pool } = require('../db/connection');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRM = process.env.CONFIRM_HK_CALENDAR_REPAIR === '1';
const DEFAULT_DATES = ['2026-09-10', '2026-09-11', '2026-09-14'];

function valueOf(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function targetDates() {
  const values = String(valueOf('--dates', DEFAULT_DATES.join(','))).split(',').map(item => item.trim());
  const dates = [...new Set(values.filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item)))];
  if (!dates.length) throw new Error('--dates 必须包含 YYYY-MM-DD');
  return dates;
}

async function main() {
  if (APPLY && process.env.NODE_ENV === 'production' && !CONFIRM) {
    throw new Error('生产分区修复必须设置 CONFIRM_HK_CALENDAR_REPAIR=1');
  }
  const dates = targetDates();
  const { rows: existing } = await pool.query(
    `SELECT partition_id,dataset_code,scope_key,partition_key::text,data_as_of::text,status,published_at,is_stale,stale_reason,row_count,source_id,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code='hk_trade_calendar' AND scope_key='HK' AND partition_key=ANY($1::date[])
      ORDER BY partition_key`, [dates]
  );
  const byDate = new Map(existing.map(row => [row.partition_key, row]));
  const repairs = [];
  for (const date of dates) {
    const current = byDate.get(date);
    if (current && current.status === 'published' && !current.is_stale) {
      repairs.push({ targetDate: date, action: 'skip', reason: 'already_published', current });
      continue;
    }
    // 错误版本把未来覆盖截止日写入 partition_key；取不早于目标业务日的最近已发布快照，
    // 保留其真实 data_as_of，只把业务分区键纠正为目标日。
    const { rows: candidates } = await pool.query(
      `SELECT partition_id,dataset_code,scope_key,partition_key::text,data_as_of::text,status,published_at,is_stale,stale_reason,row_count,source_id,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code='hk_trade_calendar' AND scope_key='HK'
          AND status='published' AND is_stale=false
          AND partition_key > $1::date AND COALESCE(data_as_of,partition_key) >= $1::date
        ORDER BY partition_key ASC LIMIT 1`, [date]
    );
    const source = candidates[0] || null;
    repairs.push({ targetDate: date, action: source ? 'copy' : 'unresolved', source, current: current || null });
  }

  const applied = [];
  if (APPLY) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of repairs.filter(row => row.action === 'copy' && row.source)) {
        const source = item.source;
        const { rows } = await client.query(
          `INSERT INTO ops.dataset_partitions
             (dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,source_id,diagnostics)
           VALUES('hk_trade_calendar','HK',$1::date,'published',$2::date,COALESCE($3::timestamptz,now()),false,'',$4,$5,
                  COALESCE($6::jsonb,'{}'::jsonb) || jsonb_build_object('repair', 'business_partition_backfill',
                    'source_partition_id', $7, 'previous_target', COALESCE($8::jsonb,'null'::jsonb)))
           ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET
             status='published',data_as_of=EXCLUDED.data_as_of,published_at=EXCLUDED.published_at,
             is_stale=false,stale_reason='',row_count=EXCLUDED.row_count,source_id=EXCLUDED.source_id,
             diagnostics=EXCLUDED.diagnostics,updated_at=now()
           RETURNING partition_id,partition_key::text,data_as_of::text,status`,
          [item.targetDate, source.data_as_of || item.targetDate, source.published_at, source.row_count || 0,
            source.source_id, JSON.stringify(source.diagnostics || {}), source.partition_id, JSON.stringify(item.current || null)]
        );
        applied.push(rows[0]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', dates, repairs, applied }, null, 2));
}

main().catch(error => {
  console.error(`港股交易日历分区修复失败：${error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
