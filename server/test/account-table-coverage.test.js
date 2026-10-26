// 账户级表覆盖不变量（2026-10-26 线上告警根因防复发）
// 事故：账户改名只覆盖 7 张表，漏了 nav_position_snapshots / nav_import_batches，
// 导致导入持仓锚点按新名查不到，净值投影链从改名前断到当天，nav_snapshot 连续失败并告警。
// 本测试做五件事：
//   1) 动态发现结果必须与架构基线集合完全一致（新增表未登记、登记表缺失都会失败）；
//   2) 每张账户级表都必须具备不可变 account_id（迁移 176 的架构要求）；
//   3) 源码不得再出现手写表清单；
//   4) 真实执行一次改名，确认旧账户名零残留且新名下可见；
//   5) 改名不得改动 account_id（不可变主键语义）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { renameAccountData } = require('../db/accounts');
const { ACCOUNT_SCOPED_TABLES, ACCOUNT_METADATA_TABLE, listAccountScopedTables } = require('../db/accountScopedTables');
const { migration176AccountIdCompletion } = require('../db/migrations/era09AccountIdentity');

const U = 'account_table_coverage_test';
const A = '改名覆盖回归旧名';
const B = '改名覆盖回归新名';

function qualified(name) {
  return name.includes('.') ? name : 'public.' + name;
}

(async () => {
  try {
    const db = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    assert(/test/.test(db), '账户表覆盖回归只能使用隔离测试库');

    // 迁移 176 幂等执行：保证 account_id 列存在（测试库不依赖外部预跑顺序）
    await migration176AccountIdCompletion(pool);

    // 1) 清单里每张表都必须真实存在，防止拼错表名后被静默跳过
    const existsRows = (await pool.query(
      `SELECT table_schema||'.'||table_name AS t FROM information_schema.tables WHERE table_type='BASE TABLE'`
    )).rows.map(r => r.t);
    for (const table of ACCOUNT_SCOPED_TABLES) {
      assert(existsRows.includes(qualified(table)), `账户级表清单里的 ${table} 在数据库中不存在`);
    }

    // 2) 动态发现必须与基线集合完全一致：多出来=新表未登记，少掉=登记了不存在的表
    const discovered = (await listAccountScopedTables(pool)).map(row => row.table).sort();
    const expected = ACCOUNT_SCOPED_TABLES.map(qualified).sort();
    const uncovered = discovered.filter(t => !expected.includes(t));
    const missing = expected.filter(t => !discovered.includes(t));
    assert.deepStrictEqual(uncovered, [], `以下带 account_name 的表未登记为账户级表：${uncovered.join(', ')}`);
    assert.deepStrictEqual(missing, [], `清单中登记但数据库里没有 account_name 的表：${missing.join(', ')}`);

    // 3) 架构要求：账户级表必须持有不可变 account_id（改名不再依赖账户名字符串）
    const noId = (await pool.query(
      `SELECT t.table_schema||'.'||t.table_name AS name FROM information_schema.tables t
        WHERE t.table_type='BASE TABLE' AND t.table_schema IN ('public','analytics')
          AND (t.table_schema||'.'||t.table_name) = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name
                             AND c.column_name='account_id')`,
      [expected]
    )).rows.map(r => r.name);
    assert.deepStrictEqual(noId, [], `以下账户级表缺少不可变 account_id：${noId.join(', ')}`);

    // 4) 源码不得再出现第二份硬编码表清单（历史事故就是三处各写一份、各自漏表）
    //    只认旧清单的固定片段，避免误伤数据集名数组等无关字面量。
    const LEGACY_TABLE_LIST = /'daily_prices'\s*,\s*'index_history'/;
    const dbDir = path.join(__dirname, '..', 'db');
    for (const file of ['accounts.js', 'brokers.js']) {
      const source = fs.readFileSync(path.join(dbDir, file), 'utf8');
      assert(!LEGACY_TABLE_LIST.test(source),
        `${file} 仍硬编码账户表清单，必须改用 accountScopedTables 的动态发现`);
    }

    // 5) 真实改名回归：写入旧名数据 → 改名 → 旧名零残留、新名可见、account_id 不变
    for (const table of ACCOUNT_SCOPED_TABLES.concat([ACCOUNT_METADATA_TABLE])) {
      await pool.query(`DELETE FROM ${table} WHERE username=$1`, [U]);
    }
    await pool.query('DELETE FROM users WHERE username=$1', [U]);
    await pool.query(
      `INSERT INTO users(username,password,accounts,role,status) VALUES($1,'x',$2,'user','active')`,
      [U, JSON.stringify([A])]
    );
    const id = require('crypto').createHash('sha256').update(U + '\n' + A).digest('hex');
    await pool.query(
      `INSERT INTO accounts(id,username,account_name,cash_base,hk_rate,version,updated_at)
       VALUES($1,$2,$3,100,1,0,'2026-10-26 15:00:00')`, [id, U, A]
    );
    await pool.query(`INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)`, [U, A]);
    await pool.query(
      `INSERT INTO nav_position_snapshots(snapshot_id,username,account_name,account_id,snapshot_date,instrument_code,quantity,price,
         quote_currency,fx_rate_to_cny,market_value_cny,source)
       VALUES('cov-snap-1',$1,$2,$3,'2026-10-16','600000',100,10,'CNY',1,1000,'manual_reconciliation')`, [U, A, id]
    );
    await pool.query(
      `INSERT INTO nav_import_batches(id,username,account_name,account_id,range_start,range_end,row_count,input_hash,status)
       VALUES('cov-batch-1',$1,$2,$3,'2026-10-01','2026-10-16',3,'cov-hash','done')`, [U, A, id]
    );
    await pool.query(
      `INSERT INTO index_baseline_settled(username,account_name,account_id,index_name,baseline_date)
       VALUES($1,$2,$3,'000300.SH','2026-10-16')`, [U, A, id]
    );

    const renamed = await renameAccountData(U, A, B);
    assert.strictEqual(renamed.ok, true, `改名应成功，实际：${renamed.conflict || ''}`);

    const leftover = [];
    for (const table of ACCOUNT_SCOPED_TABLES) {
      const row = (await pool.query(`SELECT count(*)::int AS c FROM ${table} WHERE username=$1 AND account_name=$2`, [U, A])).rows[0];
      if (row.c > 0) leftover.push(`${table}:${row.c}`);
    }
    assert.deepStrictEqual(leftover, [], `改名后旧账户名仍残留数据：${leftover.join(', ')}`);

    for (const table of ['nav_position_snapshots', 'nav_import_batches', 'index_baseline_settled', 'account_data']) {
      const row = (await pool.query(`SELECT count(*)::int AS c FROM ${table} WHERE username=$1 AND account_name=$2`, [U, B])).rows[0];
      assert.strictEqual(row.c, 1, `${table} 的数据没有跟随改名迁移到新账户名`);
    }

    const stillSame = (await pool.query(
      `SELECT count(*)::int AS c FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 AND account_id=$3`,
      [U, B, id]
    )).rows[0];
    assert.strictEqual(stillSame.c, 1, '改名不应改动 account_id');

    console.log('✅ 账户级表覆盖不变量通过（动态发现一致、account_id 齐备、无孤儿、改名全表迁移）');
  } finally {
    for (const table of ACCOUNT_SCOPED_TABLES.concat([ACCOUNT_METADATA_TABLE])) {
      await pool.query(`DELETE FROM ${table} WHERE username=$1`, [U]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE username=$1', [U]).catch(() => {});
    await pool.end();
  }
})().catch(error => {
  console.error('❌ 账户级表覆盖不变量失败：', error.message);
  process.exit(1);
});
