// 迁移 186：理杏仁官方财报三表宽表（A股 CAS / 港股 HKFRS 各一套）。
//
// 背景：此前只向来源要了 17 个指标（利润 7 / 资产 6 / 现金流 2 / 指标 4），
// 落库也只有 20 个标准科目，而官方同一接口能给三表上百个科目。
//
// 设计要点：
//   1) A股与港股会计准则不同，科目集合不同 → 物理分表，不共用一个列集合；
//   2) 列名 = 指标代码转下划线（bs.ta → bs_ta），由字典文件驱动生成，不手写列；
//   3) 一张宽表一行 = 一份报告（report_id 唯一），与 fundamental.financial_reports 一一对应；
//   4) 现有 fundamental.financial_facts（20 个标准科目）不动，下游读取口径不受影响。
//
// 幂等：表存在则跳过；新增科目只需更新字典文件并加一次 ALTER 迁移。

const dict = require('../../dataAccess/lixingerReportMetrics');

async function ensureStatementTable(pg, market, statement) {
  const table = dict.tableNameOf(market, statement);
  const metrics = dict.metricsByStatement(market, statement);
  if (!metrics.length) return { table, columns: 0, created: false };
  const columns = metrics.map(item => `      ${dict.columnOf(item.code)} NUMERIC`).join(',\n');
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      statement_id BIGSERIAL PRIMARY KEY,
      report_id BIGINT NOT NULL REFERENCES fundamental.financial_reports(report_id) ON DELETE CASCADE,
      company_id BIGINT NOT NULL,
      period_end DATE NOT NULL,
      period_type TEXT,
      announced_at DATE,
      currency_code CHAR(3),
      accounting_standard TEXT NOT NULL DEFAULT '${dict.standardOf(market)}',
      source_id SMALLINT,
      source_version TEXT,
      raw_record_id BIGINT,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
${columns},
      CONSTRAINT ${table.split('.').pop()}_report_uk UNIQUE (report_id),
      CONSTRAINT ${table.split('.').pop()}_standard_check CHECK (accounting_standard = '${dict.standardOf(market)}')
    )`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_${table.split('.').pop()}_company_period
    ON ${table}(company_id, period_end DESC)`);
  await pg.query(`COMMENT ON TABLE ${table} IS '${dict.STATEMENT_LABEL[statement]}（${dict.standardOf(market)}）：理杏仁官方 ${metrics.length} 个科目，一行一份报告'`);
  return { table, columns: metrics.length, created: true };
}

async function migration186FinancialStatementWide(pg) {
  const created = [];
  for (const market of Object.keys(dict.MARKET_STANDARD)) {
    for (const statement of dict.STATEMENTS) {
      created.push(await ensureStatementTable(pg, market, statement));
    }
  }
  return created;
}

// 194 使用固定日期版本的公司财报类型目录；已建的 186 宽表不会因字典变化自动扩列。
// 只添加可空列，既有值和报告身份不变；空库若在 186 已创建这些列则幂等跳过。
async function migration194FinancialStatementTypeColumns(pg) {
  const snapshot = require('fs').readFileSync(require('path').join(__dirname, '../../dataAccess/catalog/lixingerCompanyStatementTypes_20261113.txt'), 'utf8');
  const columnsByTable = new Map();
  for (const raw of snapshot.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#')) continue;
    const [market, , statement, code] = raw.split('|');
    if (!dict.MARKET_STANDARD[market] || !dict.STATEMENTS.includes(statement)
        || !code.startsWith({ balance: 'bs.', income: 'ps.', cashflow: 'cfs.' }[statement])) {
      throw new Error(`迁移 194 的财报字段无效：${raw}`);
    }
    const key = `${market}|${statement}`;
    if (!columnsByTable.has(key)) columnsByTable.set(key, new Set());
    columnsByTable.get(key).add(dict.columnOf(code));
  }
  for (const market of Object.keys(dict.MARKET_STANDARD)) {
    for (const statement of dict.STATEMENTS) {
      const table = dict.tableNameOf(market, statement);
      const fields = columnsByTable.get(`${market}|${statement}`);
      if (!fields || !fields.size) throw new Error(`迁移 194 缺少字段：${market}/${statement}`);
      const columns = [...fields].map(column => `ADD COLUMN IF NOT EXISTS ${column} NUMERIC`);
      await pg.query(`ALTER TABLE ${table} ${columns.join(', ')}`);
    }
  }
}

module.exports = { migration186FinancialStatementWide, migration194FinancialStatementTypeColumns, ensureStatementTable };
