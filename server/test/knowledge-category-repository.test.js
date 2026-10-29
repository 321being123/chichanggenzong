// 分类目录读取与分类移动依赖不同的仓储合同，避免同名函数互相覆盖。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const repository = require('../repositories/knowledgeRepository');
const acorn = require('acorn');

// 同类巡检：仓储顶层函数重名会被后一个声明静默覆盖。
for (const name of fs.readdirSync(path.join(__dirname, '../repositories')).filter(name => name.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(__dirname, '../repositories', name), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const names = new Set();
  for (const node of ast.body) {
    if (node.type !== 'FunctionDeclaration' || !node.id) continue;
    assert(!names.has(node.id.name), name + ' 存在同名函数 ' + node.id.name);
    names.add(node.id.name);
  }
}

(async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ id: 1, name: '示例', parent_id: null, can_manage: true }] };
  } };
  const categories = await repository.listCategories({ username: 'synthetic' }, client);
  assert(Array.isArray(categories), '公开目录返回行数组');
  assert.strictEqual(categories[0].can_manage, true);
  assert.deepStrictEqual(calls[0].params, ['synthetic']);
  assert.match(calls[0].sql, /ORDER BY sort_order, id/);
  const anonymous = await repository.listCategories({ username: null }, client);
  assert(Array.isArray(anonymous));
  assert.deepStrictEqual(calls[1].params, [null]);
  const tree = await repository.listCategoryTree(client);
  assert(Array.isArray(tree.rows), '移动事务需要查询结果的 rows');
  assert.match(calls[2].sql, /SELECT id, parent_id FROM article_categories/);
  const route = fs.readFileSync(path.join(__dirname, '../routes/knowledge.js'), 'utf8');
  assert.match(route, /knowledgeRepository\.listCategories\(\{ username \}\)/);
  assert.match(route, /knowledgeRepository\.listCategoryTree\(client\)/);
  console.log('投资笔记分类读取与移动仓储合同通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
