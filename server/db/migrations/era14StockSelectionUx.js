// 迁移 193：股票筛选个人派生的请求绑定（页面交互优化方案 3.2）。
// request_id 仅能记录一个 run，无法在“不同请求 ID、同一规范化输入”时保留每个请求的幂等绑定，
// 因此单独保存请求 ID→输入哈希→结果的轻量映射，不复制候选或组合事实。
'use strict';

async function migration193StockSelectionUx(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS analytics.stock_selection_request_bindings (
      binding_id BIGSERIAL PRIMARY KEY,
      owner_username TEXT NOT NULL REFERENCES users(username),
      owner_subject_id UUID,
      client_request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      run_id BIGINT NOT NULL REFERENCES analytics.stock_selection_runs(run_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT stock_selection_request_binding_id_length CHECK (char_length(client_request_id) BETWEEN 1 AND 100)
    )`);
  await pg.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_selection_request_binding_identity
      ON analytics.stock_selection_request_bindings
        (COALESCE(owner_subject_id::text, 'legacy:' || owner_username), client_request_id)`);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS ix_stock_selection_request_binding_run
      ON analytics.stock_selection_request_bindings(run_id)`);
}

module.exports = { migration193StockSelectionUx };
