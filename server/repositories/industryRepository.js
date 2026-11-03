// 行业分类标准层的写入仓储。
// 只做 core.industry_nodes / core.company_industry_memberships 的 SQL 与体系归一，
// 不访问网络、不判断"该不该分类"；取数与体系选择分别在 dataAccess 与 domain 完成。
'use strict';

const { pool } = require('../db/connection');

function executorOf(tx) {
  if (!tx) return (sql, params) => pool.query(sql, params);
  return (sql, params) => tx.query(sql, params);
}

/** 分类体系缺行时补建（测试库与老环境可能还没有该体系）。 */
async function ensureTaxonomy({ code, name, version }, tx) {
  const exec = executorOf(tx);
  const existing = await exec('SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code = $1', [code]);
  if (existing.rows.length) return existing.rows[0].taxonomy_id;
  const inserted = await exec(
    `INSERT INTO core.industry_taxonomies(taxonomy_code, taxonomy_name, version)
     VALUES($1,$2,$3) ON CONFLICT(taxonomy_code) DO NOTHING RETURNING taxonomy_id`,
    [code, name || code, version || '']);
  if (inserted.rows.length) return inserted.rows[0].taxonomy_id;
  const again = await exec('SELECT taxonomy_id FROM core.industry_taxonomies WHERE taxonomy_code = $1', [code]);
  return again.rows[0] ? again.rows[0].taxonomy_id : null;
}

async function sourceIdOf(sourceCode, tx) {
  if (!sourceCode) return null;
  const exec = executorOf(tx);
  const { rows } = await exec('SELECT source_id FROM ops.data_sources WHERE source_code = $1', [sourceCode]);
  return rows[0] ? rows[0].source_id : null;
}

/**
 * 写入一条完整行业路径：全层级节点（含父子关系）+ 公司归属指向最深节点。
 * 只影响同一分类体系内的旧归属，A 股申万与港股恒生不会互相顶掉。
 */
async function upsertIndustryPath(input, tx) {
  const exec = executorOf(tx);
  const list = (Array.isArray(input.nodes) ? input.nodes : [])
    .filter(node => node && node.code && node.name)
    .map(node => ({ code: String(node.code), name: String(node.name), level: Number(node.level) || null }))
    .sort((a, b) => (a.level || 99) - (b.level || 99));
  if (!list.length || !input.companyId) return null;
  const taxonomyId = await ensureTaxonomy({
    code: input.taxonomyCode, name: input.taxonomyName, version: input.taxonomyVersion,
  }, tx);
  if (!taxonomyId) return null;

  let parentId = null;
  const nodeIds = [];
  for (const node of list) {
    const { rows } = await exec(
      `INSERT INTO core.industry_nodes(taxonomy_id, industry_code, industry_name, level, parent_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(taxonomy_id, industry_code) DO UPDATE SET
         industry_name = EXCLUDED.industry_name,
         level = COALESCE(EXCLUDED.level, core.industry_nodes.level),
         parent_id = COALESCE(EXCLUDED.parent_id, core.industry_nodes.parent_id)
       RETURNING industry_node_id`,
      [taxonomyId, node.code, node.name, node.level, parentId]);
    parentId = rows[0].industry_node_id;
    nodeIds.push(parentId);
  }
  const leafId = parentId;

  // 同体系旧归属转历史；valid_to 已有值时不覆盖，保留最早失效日。
  await exec(
    `UPDATE core.company_industry_memberships m
        SET is_current = false, valid_to = COALESCE(m.valid_to, CURRENT_DATE)
       FROM core.industry_nodes n
      WHERE m.industry_node_id = n.industry_node_id
        AND n.taxonomy_id = $1 AND m.company_id = $2
        AND m.is_current = true AND m.industry_node_id <> $3`,
    [taxonomyId, input.companyId, leafId]);

  const sourceId = await sourceIdOf(input.sourceCode, tx);
  const validFrom = input.validFrom || null;
  const existing = await exec(
    `SELECT membership_id FROM core.company_industry_memberships
      WHERE company_id = $1 AND industry_node_id = $2 AND valid_from IS NOT DISTINCT FROM $3::date
      LIMIT 1`, [input.companyId, leafId, validFrom]);
  if (existing.rows.length) {
    await exec(
      `UPDATE core.company_industry_memberships
          SET is_current = true, valid_to = NULL, source_id = $2, announced_at = $3
        WHERE membership_id = $1`,
      [existing.rows[0].membership_id, sourceId, input.announcedAt || null]);
  } else {
    await exec(
      `INSERT INTO core.company_industry_memberships(company_id, industry_node_id, source_id, valid_from, announced_at, is_current)
       VALUES($1,$2,$3,$4,$5,true)`,
      [input.companyId, leafId, sourceId, validFrom, input.announcedAt || null]);
  }
  return { taxonomyId, nodeIds, rootNodeId: nodeIds[0], leafNodeId: leafId };
}

module.exports = { ensureTaxonomy, upsertIndustryPath, sourceIdOf };
