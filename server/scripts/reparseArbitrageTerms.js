// ========== 套利条款一次性回补脚本 ==========
// 用途：同步流水线只会对「新建事件」调用解析器，历史已存在的 249 条套利案件
//       从未触发解析 → 公开页条款全空。本脚本遍历所有 arbitrage_cases：
//         1) 主文档 url 为空（巨潮相对路径 bug）时，尝试从原始载荷的 adjunctUrl 恢复并写回；
//         2) 对每个有效 PDF url 重新调用 Python 解析器并回写条款（applyExtractedTerms 仅更新非空字段，幂等）。
// 运行：在 /opt/portfolio 下 `sudo -u portfolio-app node server/scripts/reparseArbitrageTerms.js`
const { pool } = require('../db');
const { normalizeAdjunctUrl } = require('../services/cninfoAnnouncement');
const parser = require('../services/arbitrageParser');

// 从原始载荷（cninfo 公告对象）里取附件相对路径并规范化为可下载 URL
function recoverUrl(rawJson) {
  if (!rawJson) return '';
  let obj;
  try { obj = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson; }
  catch { return ''; }
  if (!obj || typeof obj !== 'object') return '';
  const raw = obj.adjunctUrl || obj.attachmentUrl || obj.fileLink || '';
  return normalizeAdjunctUrl(raw);
}

async function main() {
  const { rows } = await pool.query(`
    SELECT c.case_id, c.raw_payload AS case_payload,
           d.document_id, d.url AS doc_url, d.raw_payload AS doc_payload
    FROM event.arbitrage_cases c
    LEFT JOIN event.documents d ON d.document_id = c.primary_document_id
    ORDER BY c.case_id
  `);

  let recovered = 0, extracted = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    let url = (r.doc_url || '').trim();

    // 主文档无有效 PDF 链接 → 尝试从原始载荷恢复（巨潮相对路径）
    if (!/\.pdf$/i.test(url)) {
      const recoveredUrl = recoverUrl(r.case_payload) || recoverUrl(r.doc_payload);
      if (recoveredUrl && /\.pdf$/i.test(recoveredUrl)) {
        url = recoveredUrl;
        if (r.document_id) {
          await pool.query(
            'UPDATE event.documents SET url=$1, updated_at=now() WHERE document_id=$2',
            [url, r.document_id]
          );
        }
        recovered++;
        console.log(`case ${r.case_id}: url recovered -> ${url}`);
      }
    }

    if (!/^https?:\/\//i.test(url) || !/\.pdf$/i.test(url)) {
      skipped++;
      continue;
    }

    try {
      const parsed = await parser.runPythonExtraction(url);
      const ok = await parser.applyExtractedTerms(r.case_id, parsed);
      extracted++;
      console.log(`case ${r.case_id}: extracted conf=${parsed.confidence}${ok ? '' : ' (no new terms)'}`);
    } catch (e) {
      failed++;
      console.error(`case ${r.case_id}: ERR ${e.message}`);
    }
  }

  console.log(`\nDONE total=${rows.length} recovered=${recovered} extracted=${extracted} failed=${failed} skipped=${skipped}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
