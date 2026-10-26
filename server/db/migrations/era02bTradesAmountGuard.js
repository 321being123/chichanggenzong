// ========== 174：trades 金额一致性改由触发器承担，解除对非金额列更新的拦截 ==========
// 背景：chk_trades_amount_rel 是 NOT VALID CHECK，PostgreSQL 在 UPDATE 时仍会校验新行，
// 只改 account_name 的账户重命名会被历史期初导入交易（amount=成本金额≠price×qty，招商 32 条）拦住。
// 旧实现在运行期 DROP/ADD CONSTRAINT 绕过，但生产运行账号 portfolio_user 不是表 owner，
// 报 "must be owner of table trades"（2026-10-26 线上实测）。
// 现在：删除该 CHECK，改由触发器只在「新增」与「金额相关列变化」时校验；
// 只改 account_name 等无关列不再触发校验，新写入保护强度不变（错误码仍为 23514）。
async function migration174TradesAmountGuard(pool) {
  await pool.query('ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount_rel');
  await pool.query(`
    CREATE OR REPLACE FUNCTION trades_amount_rel_guard() RETURNS trigger
    LANGUAGE plpgsql AS $guard$
    BEGIN
      IF NOT (NEW.direction IN ('open','adjust') OR NEW.amount IS NULL
              OR ABS(NEW.amount - ROUND(NEW.price * NEW.quantity, 2)) < 0.02) THEN
        RAISE EXCEPTION 'trades 金额与价格×数量不一致（amount=%, price=%, quantity=%）',
          NEW.amount, NEW.price, NEW.quantity
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $guard$`);
  await pool.query('DROP TRIGGER IF EXISTS trg_trades_amount_rel_ins ON trades');
  await pool.query(`CREATE TRIGGER trg_trades_amount_rel_ins BEFORE INSERT ON trades
    FOR EACH ROW EXECUTE FUNCTION trades_amount_rel_guard()`);
  await pool.query('DROP TRIGGER IF EXISTS trg_trades_amount_rel_upd ON trades');
  await pool.query(`CREATE TRIGGER trg_trades_amount_rel_upd
    BEFORE UPDATE OF amount, price, quantity, direction ON trades
    FOR EACH ROW EXECUTE FUNCTION trades_amount_rel_guard()`);
}

// ========== 175：零/负成本期初与调整事件的符号约束豁免 ==========
// 方案《智能导入识别质量与批量录入整改方案_20261026》4.1 第 4 条（用户 2026-10-26 裁决）：
// 持仓成本价允许零与负（做T摊薄为负属正常），零/负成本 open 与负成本 adjust 需要能入账。
// 仅对 open/adjust 豁免价格/金额符号约束（chk_trades_price、chk_trades_amount、chk_trades_amount_cny
// 同族一起排查）；buy/sell 约束不动（成交价仍必须为正、金额仍非负）；chk_trades_qty 不动（数量仍为正）。
// 金额一致性由 174 触发器承担，本已豁免 open/adjust。
async function migration175TradesOpenCostSign(pool) {
  await pool.query('ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_price');
  await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_price
    CHECK (direction IN ('open','adjust') OR price >= 0)`);
  await pool.query('ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount');
  await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_amount
    CHECK (direction IN ('open','adjust') OR amount IS NULL OR amount >= 0)`);
  // 同族：迁移 073 的人民币金额非负约束（负成本 open 的 amount_cny 为负属期初快照语义）
  await pool.query('ALTER TABLE trades DROP CONSTRAINT IF EXISTS chk_trades_amount_cny');
  await pool.query(`ALTER TABLE trades ADD CONSTRAINT chk_trades_amount_cny
    CHECK (direction IN ('open','adjust') OR amount_cny IS NULL OR amount_cny >= 0)`);
}

module.exports = { migration174TradesAmountGuard, migration175TradesOpenCostSign };
