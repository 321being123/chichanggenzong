// ========== 套利条款一次性回补脚本 ==========
// 用途：同步流水线只会对「新建事件」调用解析器，历史已存在的套利案件从未触发解析。
//       本脚本遍历所有（或指定 STRATEGY 的）套利案件：
//         1) 文档 url 为空/非 PDF（巨潮相对路径 bug）时，尝试从原始载荷的 adjunctUrl 恢复并写回；
//         2) 对该案件「所有关联 PDF 公告」逐一调用 Python 解析器并回写条款
//            （applyExtractedTerms 仅更新非空字段，多文档天然合并、互不覆盖，幂等安全）。
// 运行：在 /opt/portfolio 下
//   `sudo -u portfolio-app node server/scripts/reparseArbitrageTerms.js`
//   `STRATEGY=a_cash_offer,a_share_swap sudo -u portfolio-app node server/scripts/reparseArbitrageTerms.js`
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
  const STRATEGY = (process.env.STRATEGY || '').split(',').map(s => s.trim()).filter(Boolean);
  const START = parseInt(process.env.START_CASE_ID || '0', 10);   // 断点续跑：跳过错过的案件
  const ONLY = parseInt(process.env.ONLY_CASE_ID || '0', 10);     // 仅处理单个案件

  // 取出案件（可按 STRATEGY 过滤），同时带上目标证券代码供解析器做上下文选择
  let caseSql = `SELECT c.case_id, c.strategy_type, c.raw_payload AS case_payload, i.canonical_code AS target_code
                 FROM event.arbitrage_cases c
                 LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id`;
  const caseParams = [];
  if (STRATEGY.length) {
    caseSql += ' WHERE c.strategy_type = ANY($1)';
    caseParams.push(STRATEGY);
  }
  caseSql += ' ORDER BY c.case_id';
  const { rows: cases } = await pool.query(caseSql, caseParams);

  // 取出所有文档关联，按 case_id 分组
  const { rows: docs } = await pool.query(`
    SELECT acd.case_id, d.document_id, d.url, d.raw_payload AS doc_payload
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id = d.document_id
    ORDER BY acd.case_id
  `);
  const docsByCase = new Map();
  for (const d of docs) {
    if (!docsByCase.has(d.case_id)) docsByCase.set(d.case_id, []);
    docsByCase.get(d.case_id).push(d);
  }

  let extracted = 0, failed = 0, skipped = 0, recovered = 0;
  for (const c of cases) {
    if (Number(c.case_id) < START) continue;
    if (ONLY && String(c.case_id) !== String(ONLY)) continue;

    // 收集本案件所有可解析的 PDF（逐文档恢复相对路径 + 去重）
    const seen = new Set();
    const urls = [];
    for (const d of (docsByCase.get(c.case_id) || [])) {
      let url = (d.url || '').trim();
      if (!/\.pdf$/i.test(url)) {
        const rec = recoverUrl(d.doc_payload) || recoverUrl(c.case_payload);
        if (rec && /\.pdf$/i.test(rec)) {
          url = rec;
          if (d.document_id) {
            try {
              await pool.query('UPDATE event.documents SET url=$1 WHERE document_id=$2', [url, d.document_id]);
              recovered++;
            } catch (e) {
              console.error(`case ${c.case_id}: url update failed: ${e.message}`);
            }
          }
        }
      }
      if (/^https?:\/\//i.test(url) && /\.pdf$/i.test(url) && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }

    if (!urls.length) { skipped++; continue; }

    for (const url of urls) {
      try {
        const parsed = await parser.runPythonExtraction(url, c.target_code);
        const ok = await parser.applyExtractedTerms(c.case_id, parsed);
        extracted++;
        console.log(`case ${c.case_id} [${url.slice(-22)}]: conf=${parsed.confidence}${ok ? '' : ' (no new terms)'}`);
      } catch (e) {
        failed++;
        console.error(`case ${c.case_id} [${url.slice(-22)}]: ERR ${e.message}`);
      }
    }
  }

  console.log(`\nDONE cases=${cases.length} recovered=${recovered} extracted=${extracted} failed=${failed} skipped=${skipped}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
