// ========== 自动记录每日收盘价（按市场收盘时刻精准触发） ==========
const { pool, loadAccountData, saveDailyPrices } = require('../db');
const { fetchQuoteByCode } = require('../services/market');

// 各市场收盘时间：{ hour, minute, 适用的代码前缀匹配规则 }
const MARKET_CLOSE_TIMES = [
  { h: 15, m: 10, label: 'A股',     match: code => /^(00|30|60|68|[48])/.test(code) },
  { h: 16, m: 10, label: '港股',    match: code => code.length === 5 },
  { h: 15, m: 10, label: '可转债',   match: code => /^(11|12)/.test(code) },
  { h: 15, m: 10, label: 'LOF/ETF', match: code => /^(15|16|50|51)/.test(code) && code.length === 6 },
];

// 获取东八区日期
function cnDateStr() {
  var d = new Date();
  d.setHours(d.getHours() + 8);
  return d.toISOString().split('T')[0];
}

// 是否为交易日（周一至周五）
function isTradingDay(d) {
  var day = (d || new Date()).getDay();
  return day >= 1 && day <= 5;
}

// 距离指定时间的毫秒数
function msUntil(h, m) {
  var now = new Date();
  var target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

// 为单个市场记录收盘价
async function recordMarketClose(label, matchFn) {
  var cnDate = cnDateStr();
  try {
    var { rows: users } = await pool.query('SELECT username, accounts FROM users');
    for (var user of users) {
      var accounts = typeof user.accounts === 'string' ? JSON.parse(user.accounts) : (user.accounts || []);
      for (var accountName of accounts) {
        // 今天已记录过就跳过
        var { rows: existing } = await pool.query(
          'SELECT 1 FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 LIMIT 1',
          [user.username, accountName, cnDate]
        );
        if (existing.length > 0) continue;

        var result = await loadAccountData(user.username, accountName);
        var positions = (result.positions || []).filter(p => matchFn(p.code));
        if (positions.length === 0) continue;

        var prices = [];
        for (var pos of positions) {
          if (!pos.code) continue;
          try {
            var quote = await fetchQuoteByCode(pos.code);
            if (quote && quote.price) {
              prices.push({ code: pos.code, name: pos.name || quote.name || '', price: quote.price });
            }
          } catch (e) {}
        }

        if (prices.length > 0) {
          await saveDailyPrices(user.username, accountName, cnDate, prices);
        }
      }
    }
  } catch (e) {
    // 静默失败
  }
}

// 为所有市场分别调度收盘任务
function scheduleAllMarketCloses() {
  for (var i = 0; i < MARKET_CLOSE_TIMES.length; i++) {
    (function (mkt) {
      function runAndReschedule() {
        if (isTradingDay()) {
          recordMarketClose(mkt.label, mkt.match).catch(() => {});
        }
        // 安排下一个交易日
        var delay = msUntil(mkt.h, mkt.m);
        // 跳过周末：如果下个工作日在周末之后，再加
        var nextDay = new Date(Date.now() + delay + 60000);
        while (!isTradingDay(nextDay)) {
          nextDay.setDate(nextDay.getDate() + 1);
        }
        // 重新计算延迟（从now到nextDay的收盘时间）
        var now = new Date();
        nextDay.setHours(mkt.h, mkt.m, 0, 0);
        var nextDelay = nextDay - now;
        if (nextDelay <= 0) nextDelay = 5000;
        setTimeout(runAndReschedule, nextDelay);
      }
      var initialDelay = msUntil(mkt.h, mkt.m);
      setTimeout(runAndReschedule, initialDelay);
    })(MARKET_CLOSE_TIMES[i]);
  }
}

module.exports = { scheduleAllMarketCloses };
