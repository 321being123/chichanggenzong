// 交易录入脚本 — 走系统标准 saveAccountData 流程，自动处理所有表
// 用法: node enter_trade.js <账户名> <代码> <名称> <方向buy/sell> <价格> <数量> [日期]
// 例:   node enter_trade.js 华泰账户 601766 中国中车 buy 5.14 4500
const { loadAccountData, saveAccountData, uid } = require('./server/db');
// 代码→品种 单一分类函数（与前端共用，见 public/js/code-classify.js）
const classifyCode = require('./public/js/code-classify.js');

const USER = 'daicunzai';

function nowSec() {
  const now = new Date();
  const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${cn.getUTCFullYear()}-${p(cn.getUTCMonth() + 1)}-${p(cn.getUTCDate())} ${p(cn.getUTCHours())}:${p(cn.getUTCMinutes())}:${p(cn.getUTCSeconds())}`;
}

// 根据代码前缀推断细类（委托单一分类函数，未知返回空）
function inferSubtype(code) {
  const c = classifyCode(code);
  return c ? c.subtype : '';
}

async function main() {
  const [account, code, name, direction, priceStr, qtyStr, date] = process.argv.slice(2);
  if (!account || !code || !direction || !priceStr || !qtyStr) {
    console.log('用法: node enter_trade.js <账户名> <代码> <名称> <方向buy/sell> <价格> <数量> [日期]');
    process.exit(1);
  }
  const price = parseFloat(priceStr);
  const qty = parseInt(qtyStr, 10);
  if (isNaN(price) || isNaN(qty) || qty <= 0) {
    console.error('✗ 价格/数量无效');
    process.exit(1);
  }
  if (direction !== 'buy' && direction !== 'sell') {
    console.error('✗ 方向必须是 buy 或 sell');
    process.exit(1);
  }

  const data = await loadAccountData(USER, account);
  const tradeName = name || code;
  const amount = price * qty;
  const tradeDate = date || (function () {
    const now = new Date();
    const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
    const p = n => String(n).padStart(2, '0');
    return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
  })();

  // 1. 加交易记录
  const inferredSubtype = inferSubtype(code);
  data.trades.push({
    id: uid(), date: tradeDate, created_at: nowSec(), code, name: tradeName, direction,
    price, quantity: qty, amount, type: '股权', subtype: inferredSubtype, note: ''
  });

  // 2. 更新持仓（加权成本价）
  const existing = data.positions.find(p => p.code === code);
  const delta = direction === 'buy' ? qty : -qty;
  if (existing) {
    const oldMv = (existing.price || 0) * (existing.quantity || 0);
    const newMv = direction === 'buy' ? amount : -amount;
    const totalQty = (existing.quantity || 0) + delta;
    if (totalQty > 0) {
      existing.quantity = totalQty;
      existing.price = (oldMv + newMv) / totalQty;
      existing.type = '股权';
      // 保留已有细类，仅在原为空时用推断值补充（不覆盖已有 A股 等）
      existing.subtype = existing.subtype || inferredSubtype;
      if (!existing.name) existing.name = tradeName;
    } else {
      data.positions = data.positions.filter(p => p.code !== code);
    }
  } else if (direction === 'buy') {
    data.positions.push({
      id: uid(), code, name: tradeName, price, quantity: qty,
      cost: amount, type: '股权', subtype: inferredSubtype, note: ''
    });
  }

  // 3. 现金由系统自动重算（现金 = 期初本金 + 现金流 + 交易净额），与后端 loadAccountData 一致
  const cfNet = (data.cashFlows || []).reduce((s, c) => s + (c.amount || 0), 0);
  const tradeNet = (data.trades || []).reduce((s, t) => s + (t.direction === 'buy' ? -(t.amount || 0) : (t.amount || 0)), 0);
  const base = (typeof data.cashBase === 'number') ? data.cashBase : 0;
  data.cash = base + cfNet + tradeNet;

  // 4. 走标准流程写入（自动处理 positions/trades/cash_flows/account_data 所有表）
  await saveAccountData(USER, account, data);

  console.log('✅ 已录入: ' + tradeName + ' ' + (direction === 'buy' ? '买入' : '卖出') + ' ' + qty + ' 股 @ ' + price);
  console.log('   现金余额: ' + data.cash.toFixed(2));
}

main().catch(e => { console.error(e); process.exit(1); });
