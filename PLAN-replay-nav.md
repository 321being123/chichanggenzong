# 方案：晚录入交易 → 历史净值精确回填（全量重构）

> 目标：周二交易、周四才录入时，周二/周三（交易日→录入日前一天）的净值快照被自动纠正，与"如果周二就录入"算出来的净值一致。

## 一、现状（已查代码确认）

- `nav_history`：独立"每日净值快照"表 `{date, nav, total_asset, invested}`，只有首条 nav=1.0。
- 净值算法 `recordNav()`（core-returns.js:112）：
  - 链式剔除入金：`nav_t = nav_{t-1} * total_t / (totalAsset_{t-1} + periodCashFlow)`，
    `periodCashFlow` = 上次净值日(不含)→今日(含)的累计净现金流。
  - `total_t = calcSummary().total` = **当前**持仓市值(用当前价) + 现金。即正常刷新时用的是"当下"数据。
  - `invested_t = investedAt(today)`（cashBase + 现金流，见 core-earnings.js:116）。
- `daily_prices` 表已存在（db.js:91），收盘任务每天把**当时持仓**的收盘价写进去（marketClose.js:79 → saveDailyPrices）。→ 部署日之后、且当天有持仓的代码，历史收盘价齐全。
- 录入交易 `addTradeInternal`（core-trade.js:515）只做 `recalcCash + saveData + renderAll`，**不碰 nav_history**，也**不触发任何回填**。

## 二、核心难点（必须解决）

晚录入的这只股票，在其"交易日至录入日前一天"那几天**不在持仓里** → 那几天的 `daily_prices` 缺这只股票的价格 → 直接 replay 会算不出它的市值。

**填补方式（待用户拍板，默认推荐"两者结合"）：**
- A. Tushare 历史回补：对缺口日期，用 Tushare 拉该代码历史收盘，upsert 进 `daily_prices` 再 replay（精确，依赖网络/限频）。
- B. 成交价近似：缺口日市值用"成交价 P × 数量"（你周二以 P 买入，周二/周三市值≈qty×P，直到周四有真实收盘价）。离线、合理。
- **默认=A+B 结合**：先试 Tushare，失败回退成交价。

## 三、实现（服务端为主，因为数据在库里）

### 1. 新增后端 replay 引擎 `server/jobs/replayNav.js`
- `recomputeNav(username, accountName, fromDate)`：
  1. 载入 trades(排序)、cashFlows、cashBase、navHistory(排序)、daily_prices(全)。
  2. 确定起点：取 `fromDate` 之前最近的一条 nav_history 记录作为链式锚点 `prev`（含 nav、totalAsset）；若 fromDate 早于首条则从头(首条 nav=1.0)。
  3. 对区间 `[max(fromDate, 首个有 daily_prices 的日期), 今日]` 的每个交易日 d（跳过休市/周末）：
     - **持仓-as-of-d**：重放 `date ≤ d` 的 trades（买加/卖减）得各代码数量。
     - **价格(code,d)**：优先 `daily_prices[code,d]`；若该 code 在区间内有交易且缺价 → 按二节方式补（Tushare 或成交价）；其余持仓缺价则向前取最近一日价（carry-forward 近似）。
     - **现金-as-of-d** = cashBase + ΣcashFlows≤d + Σtrade现金流≤d（买:-(额+费)，卖:+(额-费)）。
     - **totalAsset(d)** = cashAsOf(d) + Σ 持仓qty×price。
     - **invested(d)** = 服务端复刻 `investedAt(d)`。
     - **nav(d)** = `prev.nav * totalAsset(d) / (prev.totalAsset + periodCashFlow)`，与 `recordNav` 逐字一致；periodCashFlow = `prev.date < cf.date ≤ d` 的现金流和。
     - upsert `nav_history(d)`（ON CONFLICT 覆盖）。
     - `prev ← (d, nav(d), totalAsset(d))`。
  4. 返回影响的日期数（供前端提示）。

### 2. 新增接口 `POST /api/accounts/:acc/recompute-nav`
- body `{ fromDate }`；鉴权同其它账户接口；调用 `recomputeNav`；返回 `{ ok, days }`。

### 3. 前端触发
- `addTradeInternal`（core-trade.js:515）末尾：若 `date < todayCN()`，交易保存后调用 `recomputeNav(date)`，成功后 `loadAccountData` 刷新 navHistory + `renderAll()`。
- `enter_trade.js`（CLI）同理：写入 trade 后若 date<今日，调用接口回填。
- 仅对"过去日期"的交易触发；当日交易走原有 `recordNav` 即可（不动）。

### 4. 兼容性 / 边界
- 部署日**之前**的历史（无 daily_prices）→ 无法精确 replay，跳过那些日期（保持原快照），仅纠正"部署日之后、且有价可算"的区间。
- 重放严格复刻 `recordNav` 公式，保证与现有近期净值连续、不跳变。
- 幂等：upsert，重复触发无害。

## 四、验证
- 单元：用一组 mock（trades + daily_prices + cashFlows）验证 replay 出的 nav 与"若周二就录入"手算一致（含入金剔除、卖出减仓、缺口日补价）。
- 联调：构造"周二买、周四录"场景，确认周二/周三 nav 被纠正、周四及之后不变、顶部"今年收益"等派生指标同步正确。
- 语法 `node --check` 全过。

## 五、范围之外（本次不做）
- 不改 `recordNav` 现有当日逻辑；不改净值展示 UI。
- 不回溯补"部署前"的历史净值（缺价，无法精确）。
