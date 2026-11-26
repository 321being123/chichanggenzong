// 213：补 core.company_instruments 的 instrument_id 索引。
//
// 2026-11-26 事故的第二个成因：全市场选股 loadUniverse 用 LATERAL 按 instrument_id 反查
// 发行人公司，而这张表只有 (company_id, instrument_id, relation_type) 主键，没有以
// instrument_id 为前导的索引，于是每只股票都全表扫一遍 8748 行；5582 只股票累计
// 扫了四千多万行，实测 100 只股票就要 7.8 秒、全市场 8 分钟以上。
// 财务表重复副本清理后行数减半仍无法单独解决该问题，必须补上这条索引。
async function migration213CompanyInstrumentsInstrumentIndex(pool) {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_core_company_instruments_instrument
      ON core.company_instruments (instrument_id, relation_type, valid_from DESC NULLS LAST);
  `);
}

module.exports = { migration213CompanyInstrumentsInstrumentIndex };
