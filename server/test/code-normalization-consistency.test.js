// DATA-02 数据集①：证券主档与代码映射 —— 双读核对
// 验收目标（报告 P1-2「禁止两套代码规则并存」）：
//   JS normalizeStockCode 与 SQL normalize_stock_code 对 A 股正股六位码的归一化结果必须完全一致；
//   与行情 Tushare 代码构造器 toTsCode 在 A 股正股空间也必须一致（确认不存在第二套冲突规则）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { pool } = require('../db');
const { normalizeStockCode } = require('../services/bondDataService');
const { toTsCode } = require('../services/market');

// A 股正股六位码样本：覆盖沪市(60/68)、深市(00/30) 全部分支
const STOCK_CODES = [
  '600000', '601398', '603259', '688981', // 沪市 .SH
  '000001', '000002', '002594', '300750'  // 深市 .SZ
];

(async () => {
  let skip = false;
  try { await pool.query('SELECT 1'); } catch (e) { skip = true; }

  if (skip) {
    console.log('SKIP code-normalization-consistency: 本地 PG 不可用');
    process.exit(0);
  }

  let failures = 0;
  const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL: ' + msg); } };

  // 双读：JS 实现 vs SQL 函数（同一输入空间，不允许两套规则）
  for (const code of STOCK_CODES) {
    const js = normalizeStockCode(code);
    let sql = null;
    try {
      const { rows } = await pool.query('SELECT normalize_stock_code($1) AS v', [code]);
      sql = rows[0].v;
    } catch (e) {
      console.error('SQL normalize_stock_code 执行失败（迁移 035 未生效？）: ' + e.message);
      failures++;
      continue;
    }
    check(js === sql, `代码归一化 JS(${js}) 与 SQL(${sql}) 不一致：code=${code}`);
    // 与行情代码构造器交叉核对（A 股正股空间二者必须等价）
    const ts = toTsCode(code);
    check(ts === js, `toTsCode(${ts}) 与 normalizeStockCode(${js}) 在 A 股正股空间不一致：code=${code}`);
  }

  // 边界：空值 / 已带后缀原样返回
  check(normalizeStockCode('') === null, '空字符串应返回 null');
  check(normalizeStockCode(null) === null, 'null 应返回 null');
  check(normalizeStockCode('600000.SH') === '600000.SH', '已带后缀应原样返回');
  check(normalizeStockCode('920002.SH') === '920002.BJ', '92开头代码即使误带.SH也必须纠正为.BJ');
  check(normalizeStockCode('600519.BJ') === '600519.SH', '沪市代码误带.BJ必须纠正为.SH');
  check(toTsCode('920002.SH') === '920002.BJ', '行情代码构造器必须校验92开头代码后缀');
  check(toTsCode('600519.BJ') === '600519.SH', '行情代码构造器必须校验沪市代码后缀');
  try {
    const { rows: r1 } = await pool.query("SELECT normalize_stock_code('') AS v");
    check(r1[0].v === null, 'SQL 空字符串应返回 null');
    const { rows: r2 } = await pool.query("SELECT normalize_stock_code('000001.SZ') AS v");
    check(r2[0].v === '000001.SZ', 'SQL 已带后缀应原样返回');
    const { rows: r3 } = await pool.query("SELECT normalize_stock_code('920002.SH') AS v");
    check(r3[0].v === '920002.BJ', 'SQL 92开头代码误带.SH必须纠正为.BJ');
    const { rows: r4 } = await pool.query("SELECT normalize_stock_code('600519.BJ') AS v");
    check(r4[0].v === '600519.SH', 'SQL 沪市代码误带.BJ必须纠正为.SH');
  } catch (e) {
    console.error('SQL 边界核对失败: ' + e.message);
    failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} 项代码归一化双读核对失败`);
    process.exit(1);
  }
  console.log(`OK code-normalization-consistency: ${STOCK_CODES.length} 个正股样本 JS/SQL/toTsCode 三方一致 + 边界用例通过`);
  await pool.end().catch(() => {});
  process.exit(0);
})();
