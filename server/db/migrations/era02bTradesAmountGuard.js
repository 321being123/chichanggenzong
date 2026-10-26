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

module.exports = { migration174TradesAmountGuard };
