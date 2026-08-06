// 回填存量可转债快照的水位 terms_hash 为标准条款表口径。
//
// 背景：条款指纹来源从 profiles.raw_payload 切换到了 fundamental.convertible_bond_terms（标准条款表），
// 写入水位与读取判定现在都走这张表（读/写同源）。但切换前生成的存量快照，其 source_watermark.terms_hash
// 仍按旧来源（raw_payload）计算，与新代码算出的标准表口径 hash 不同，会导致部署后每日刷新时这些旧快照
// 一次性被判为 terms_changed、触发集中重算（抖动）。本脚本把存量快照回填成标准表口径，消除这一波抖动。
//
// 用法：
//   node server/scripts/backfillTermsHash.js            # 默认 --dry-run，仅打印预览，不改数据
//   node server/scripts/backfillTermsHash.js --apply    # 真正写库回填
//
// 幂等：重复运行结果一致；同一债券的快照指纹相同，按 instrument_id 批量覆盖。
// 仅改 source_watermark 的 terms_hash 字段，不影响快照其他水位与 payload。

const { pool } = require('../db');
const { buildStandardTermsHash } = require('../services/convertibleBondAnalysis');

async function main() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[terms-hash 回填] 模式=${mode}`);

  // 债券代码映射，便于阅读
  const mapRes = await pool.query(
    `SELECT instrument_id, canonical_code FROM core.instruments`
  );
  const codeMap = {};
  mapRes.rows.forEach(r => { codeMap[r.instrument_id] = r.canonical_code; });

  const instRes = await pool.query(
    `SELECT DISTINCT instrument_id FROM analytics.analysis_snapshots WHERE snapshot_type='convertible_bond_analysis'`
  );
  const ids = instRes.rows.map(r => r.instrument_id);
  console.log(`待核对可转债快照：${ids.length} 只`);

  let changedBonds = 0, sameBonds = 0, totalRows = 0, changedRows = 0;

  for (const id of ids) {
    const newHash = await buildStandardTermsHash(pool, id);
    const stat = await pool.query(
      `SELECT count(*) AS total_cnt,
              count(*) FILTER (WHERE source_watermark->>'terms_hash' IS DISTINCT FROM $2) AS need_cnt
       FROM analytics.analysis_snapshots
       WHERE instrument_id=$1 AND snapshot_type='convertible_bond_analysis'`,
      [id, newHash]
    );
    const total = Number(stat.rows[0].total_cnt);
    const need = Number(stat.rows[0].need_cnt);
    totalRows += total;

    if (need === 0) {
      sameBonds += 1;
      continue;
    }
    changedBonds += 1;
    changedRows += need;
    const code = codeMap[id] || id;
    if (!apply) {
      console.log(`[preview] ${code} (instrument ${id}): ${need}/${total} 行需回填 -> ${newHash}`);
    } else {
      await pool.query(
        `UPDATE analytics.analysis_snapshots
         SET source_watermark = jsonb_set(COALESCE(source_watermark, '{}'::jsonb), '{terms_hash}', to_jsonb($2::text))
         WHERE instrument_id=$1 AND snapshot_type='convertible_bond_analysis'`,
        [id, newHash]
      );
      console.log(`[applied] ${code} (instrument ${id}): ${need}/${total} 行已回填 -> ${newHash}`);
    }
  }

  console.log(
    `\n汇总（${mode}）：共 ${totalRows} 行快照；${changedBonds} 只债券需变更（${changedRows} 行），${sameBonds} 只已一致。`
  );
  await pool.end();
}

main().catch((err) => {
  console.error('回填失败：', err);
  process.exit(1);
});
