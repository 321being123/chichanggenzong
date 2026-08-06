// 回填存量可转债快照的水位 terms_hash 为标准条款表口径，且按「各快照自身 as_of_date 当时生效的条款」计算。
//
// 背景：条款指纹来源从 profiles.raw_payload 切换到了 fundamental.convertible_bond_terms（标准条款表），
// 写入水位与读取判定现在都走这张表，并按有效期（effective_from/effective_to）选取截至快照日期生效的条款
// （读/写同源、且历史快照锁定当时生效条款）。切换前生成的存量快照，其 source_watermark.terms_hash 仍按旧来源
// （raw_payload）计算，与新代码算出的标准表口径 hash 不同，会导致部署后每日刷新时这些旧快照一次性被判为
// terms_changed、触发集中重算（抖动）。
//
// 本脚本把存量快照回填成标准表口径，消除这一波抖动。关键点：每条历史快照按其「自身 as_of_date 当时生效的条款」
// 计算哈希，而不是用当前条款统一覆盖全部历史行——条款若在存续期内修订，早期快照必须锁定当时的条款。
//
// 用法：
//   node server/scripts/backfillTermsHash.js            # 默认 --dry-run，仅打印预览，不改数据
//   node server/scripts/backfillTermsHash.js --apply    # 真正写库回填
//
// 幂等：重复运行结果一致；同一 (instrument_id, as_of_date) 的哈希相同，按快照逐行覆盖。

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

  // 读出全部可转债快照行：按各自 as_of_date 当时生效的条款计算哈希，而非用当前条款统一覆盖
  const rowsRes = await pool.query(
    `SELECT snapshot_id, instrument_id, to_char(as_of_date,'YYYY-MM-DD') AS as_of,
            source_watermark->>'terms_hash' AS old_hash
     FROM analytics.analysis_snapshots WHERE snapshot_type='convertible_bond_analysis'`
  );
  console.log(`待核对可转债快照行：${rowsRes.rowCount} 行`);

  // 同一 (instrument_id, as_of) 的哈希相同，去重计算，减少查库
  const hashCache = new Map();
  async function hashFor(instId, asOf) {
    const key = `${instId}|${asOf}`;
    if (hashCache.has(key)) return hashCache.get(key);
    const h = await buildStandardTermsHash(pool, instId, asOf);
    hashCache.set(key, h);
    return h;
  }

  const toUpdate = [];
  for (const row of rowsRes.rows) {
    const newHash = await hashFor(row.instrument_id, row.as_of);
    if (newHash !== row.old_hash) {
      toUpdate.push({ snapshot_id: row.snapshot_id, instrument_id: row.instrument_id, newHash });
    }
  }

  let changedRows = toUpdate.length;
  const changedBonds = new Set(toUpdate.map(u => u.instrument_id));

  for (const u of toUpdate) {
    const code = codeMap[u.instrument_id] || u.instrument_id;
    if (!apply) {
      console.log(`[preview] ${code}: snapshot ${u.snapshot_id} -> ${u.newHash}`);
    } else {
      await pool.query(
        `UPDATE analytics.analysis_snapshots
         SET source_watermark = jsonb_set(COALESCE(source_watermark,'{}'::jsonb), '{terms_hash}', to_jsonb($2::text))
         WHERE snapshot_id=$1`,
        [u.snapshot_id, u.newHash]
      );
      console.log(`[applied] ${code}: snapshot ${u.snapshot_id} -> ${u.newHash}`);
    }
  }

  console.log(
    `\n汇总（${mode}）：共 ${rowsRes.rowCount} 行快照；${changedBonds.size} 只债券、${changedRows} 行需变更。`
  );
  await pool.end();
}

main().catch((err) => {
  console.error('回填失败：', err);
  process.exit(1);
});
