# Changelog

## 2026-07-10

### 改版：持仓 tab 改为收益（投资实验记录）
- **变更**：
  - 顶部导航「持仓」改名为「收益」，原持仓列表页删除（总览里已能看持仓明细前 10，持仓管理功能整体下线：新增/编辑/删除持仓、现金编辑、筛选排序一并移除）。
  - 新增「收益」页，展示《投资实验记录》Excel：顶部 6 张指标卡片（总市值、净值、总收益率、年化收益、当前回撤、最大回撤），中间「资产与收益走势」折线图（总市值 vs 投入本金），下方完整明细表。
  - 收益页支持「导入 Excel」：服务端 `/api/import-fund-record` 解析《投资实验记录》表，按表头（时间/当前总市值/当前净值/总收益率/年化收益/回撤等）映射为结构化记录，存入账户数据 `fundRecord`，前端渲染。
- **文件**：`public/index.html`、`public/shared/core.js`、`server.js`（新增接口）、`server/db.js`（loadAccountData 回读 fundRecord）。

## 2026-07-09

### 修复：手机扫码上传无法选相册
- **根因**：`server.js` 内嵌的手机上传页 `mobileUploadHtml()` 中 `<input type="file" accept="image/*" capture="environment">` 带了 `capture="environment"`，强制调起摄像头，iOS/部分安卓无法选相册。
- **修复**：去掉 `capture="environment"` 属性。`accept="image/*"` 不带 capture 时，iOS 弹「拍照或选照片」、安卓 Chrome 提供拍照/相册选择，同时保留拍照能力。

### 优化：网站图标换成股市上涨主题
- **变更**：`public/favicon.svg` 改为深蓝底 + 红色上涨 K 线 + 黄色上升箭头（A 股红涨惯例）。
- **引用**：在 `public/index.html` 和 `public/login.html` 的 `<head>` 中加入 `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`，使浏览器正确加载新图标。

### 重构：合并 Excel/图片导入入口，统一识别交易与持仓
- **变更**：
  - 前端「录入交易」区由 4 个标签（手动/Excel/持仓/图片）简化为 2 个标签：**手动录入 / 智能导入**。
  - 「智能导入」内同时提供图片上传和 Excel 上传两个入口。
- **后端**：
  - `/api/vision-parse` 和 `/api/excel-parse` 返回统一格式 `{ items: [{ kind: 'trade'|'position', code, name, price, quantity, ... }] }`。
  - LLM 提示词要求同时识别交易记录和持仓记录，并由模型自行判断每行类型。
  - 删除独立的 `/api/excel-positions` 接口（功能已合并）。
- **前端**：
  - `public/shared/core.js` 新增 `doSmartParse(file, source)`、`renderSmartItems()`、`confirmSmartItem(index)`、`confirmAllSmartItems()`。
  - 结果表格混合展示交易行与持仓行，交易行显示日期/方向，持仓行显示为持仓类型。
  - 确认时根据 `kind` 自动调用交易录入或持仓导入逻辑。
  - 粘贴/拖拽/手机扫码上传均统一进入新的智能解析流程。

### 修复：涨跌排序时 0% 排第一
- **根因**：持仓表按「涨跌」排序时，`priceChangeMap[code] || -999` 把 0% 当成缺失数据，导致 0% 被排到最前面。
- **解决**：排序判断改为 `priceChangeMap[code] != null ? ... : -999`，0% 作为有效值参与正常升降序。

### 修复：导入交易名称显示为代码
- **根因**：Excel/图片/持仓导入时，如果解析结果没有名称，保存后交易历史名称列直接显示代码。
- **解决**：
  - `public/shared/core.js` 新增 `ensureName(code, currentName)`：优先取现有持仓中的名称，否则调用行情接口自动获取。
  - 三个导入确认函数（`confirmVisionItem`/`confirmExcelItem`/`confirmPositionItem`）改为 async，确认前自动补全名称。
  - 三个「全部导入」函数同步改为 async 顺序执行。
  - `renderTrades` 增加兜底：若交易名称为空或等于代码，从当前持仓中查找显示名称。

### 优化：AI 解析加载动画
- 图片识别、Excel 导入、持仓导入的解析等待阶段增加转圈 spinner（`.spinner` CSS）。
- 更新 `public/index.html` 三个 loading 容器，以及 `public/shared/core.js` 中动态设置 loading 文本的逻辑，使 spinner 和文字同时显示。

### 修复：导入证券代码前导 0 被删除
- **根因**：券商 Excel 把代码存为数字，`xlsx` 读取后 000001 变成 1，LLM 返回短代码，前端保存时丢失前导零。
- **解决**：
  - `public/js/code-classify.js` 新增 `classifyCode.normalizeCode(code)`：A股/基金/可转债/信用债等数字代码统一补 6 位，港股补 5 位，美股不变。
  - 后端 `/api/excel-parse`、`/api/excel-positions` 解析 LLM 结果后统一调用 `normalizeCode` 恢复代码。
  - 前端所有录入入口（手动交易、快速添加、持仓编辑、Excel/图片/持仓导入确认）统一在保存前调用 `classifyCode.normalizeCode`。
  - LLM 提示词中明确强调证券代码作为字符串返回并保留前导零。

### 新增：Excel 导入持仓表（大模型解析）
- **前端**：交易录入区新增「持仓导入」标签页，支持上传券商导出的 `.xlsx`/`.xls`/`.csv` 持仓表。
- **后端**：新增 `POST /api/excel-positions`，用 `xlsx` 读取首工作表后调用 LLM 解析，返回 `positions` 数组（`code/name/quantity/price`）。
- **交互**：解析结果展示可编辑表格，支持单条「确认导入」和「✅ 全部导入」；已存在的证券代码会更新持仓（价格/数量），不存在则追加；导入持仓不影响交易记录和现金。

### 新增：Excel 导入交易明细（大模型解析）
- **前端**：交易录入区新增「Excel导入」标签页，支持上传 `.xlsx`/`.xls`/`.csv`。
- **后端**：新增 `POST /api/excel-parse`，用 `xlsx` 读取首工作表后调用 LLM 解析，返回与图片识别一致的 `trades` 数组（含可选 `date` 交易日期）。
- **交互**：Excel 解析结果展示可编辑表格，支持单条「确认录入」和「✅ 全部录入」；Excel 行带日期输入框，可覆盖默认当天。

### 优化：图片识别增加「全部录入」
- 图片识别结果区增加「✅ 全部录入」按钮，避免逐条点击。

## 📌 本地验证进度索引（2026-07-08）

> 配套详情（环境限制、三套本地起 PG 方案、连库验证命令）：`deploy/本地验证交接文档.md`。

| 验证级别 | 状态 | 关键结论 | 阻塞点 |
|---------|------|---------|-------|
| **加载级**（依赖安装 + 模块加载） | ✅ 已通过 | `npm install` 装 `pg@8.22.0`；`better-sqlite3` 彻底移除（0 残留原生模块）；`server/db.js` 加载正常、11 项导出齐全 | 无 |
| **连库级**（建表 + 读写联调） | ✅ 已通过（2026-07-08 本机 agent 环境实跑） | `initSchema()` 六表在 `portfolio` 库创建成功；`enter_trade.js` 第40行 `await` 修复生效；现金自动重算正确（买入 100×100 → 现金 -10000）；`positions`/`trades` 真写入 PG 已抽查确认 | 无 |

**下一步**：连库验证已全部通过，代码可进入部署。本机 agent 环境已实跑（方案 A 起 PG，踩坑见下方注），无需再等外部 PG 实例。

> **连库验证实跑注记（2026-07-08）**：本 agent 环境成功按方案 A 起 PG（EDB 二进制 zip 16.4）。关键坑：
> 1. 原生 `curl`/`*.exe` **只认 Windows 原生路径**（`C:/...`），不认 POSIX（`/c/...`），否则"找不到路径/写不出文件"。
> 2. `pg_ctl` 的 `-l` 日志参数也必须用 Windows 路径，否则报"系统找不到指定的路径"导致启动失败。
> 3. **前台/后台命令结束时 server 会被回收**，且 Windows 共享内存段不随进程死亡释放，导致下次启动报"已存在的共享内存块仍在使用中"。解法：验证必须在**同一条命令内** `start → 建库 → initSchema → enter_trade → 查询 → stop` 自包含跑完；命令开头 `taskkill /F /IM postgres.exe` 清残留共享内存。
> 4. `db.js` 默认库为 `portfolio`（`PGDATABASE || 'portfolio'`），**不要**把 `PGDATABASE` 设成 `postgres`，否则表建错库。

---

## 📌 部署配置状态（2026-07-08，已就绪）

> 全套部署物料已生成并修正，可直接用于腾讯云 CVM（Nginx + pm2 + PostgreSQL / 或 Docker）。详见 `deploy/部署说明.md`。

| 配置项 | 文件 | 状态 | 说明 |
|--------|------|------|------|
| 环境变量模板 | `deploy/.env.example` | ✅ | 含 `DATABASE_URL`/`PG*` + `SECRET`/`ALLOWED_ORIGIN`/`REGISTER_CODE` |
| Nginx 反代 + HTTPS | `deploy/nginx-portfolio.conf` | ✅ | 80→443 跳转 + 反代 3000 + 免费SSL + HSTS |
| pm2 守护 | `deploy/ecosystem.config.js` | ✅ | fork 单实例（PG 单进程策略） |
| 部署文档 | `deploy/部署说明.md` | ✅ | 买 CVM→装 Node22/PG/Nginx/pm2→上传→配 .env→反代→pm2→安全组→备份 |
| Docker（可选） | `Dockerfile` + `docker-compose.yml` | ✅ | node22-alpine + postgres:16-alpine 一键起 |
| Python 导入依赖 | `requirements.txt` | ✅ | `psycopg2-binary`（import_positions.py 用） |

**本次关键修正（部署阻断点）**：
1. **接入 dotenv**（`server/db.js` 顶部 `require('dotenv').config()` + `package.json` 加 `dotenv`）：修复"部署后 `.env` 不生效、PG 连不上"的致命缺口——原 `部署说明.md` 误称"pm2 自动读 .env"，但 Node 默认不读 `.env`。
2. `部署说明.md` 删除已失效的"SQLite 数据迁移"小节（迁移脚本与 `portfolio.db` 已于「全清」时删）；`better-sqlite3` 过时措辞改为通用"原生模块"；补 dotenv 说明。
3. `ecosystem.config.js` 注释修正为"应用通过 dotenv 读取项目根 .env"。

> **安全提醒**：`.env` 含密码/连接串，已被 `.gitignore` 忽略，绝不入库。云 PG 请用专用账号（`portfolio_user`）+ 强密码 + `PGSSL=true`。

---

## 2026-07-08

### PostgreSQL 存储改造（已完成，2026-07-08 补齐收尾）
- **决策**：用户 2026-07-08 决定将存储从 SQLite(better-sqlite3) 改为 PostgreSQL（计划开放给几十人使用，用户主动选择）。
- **已完成（核心）**：`server/db.js` 完全重写为 PG 异步数据层（`pg` Pool，新增 `initSchema()` 自动建表）；`server.js` 路由全加 async/await + asyncHandler 包装，启动前 await 建表；`enter_trade.js` 的 `main()`/`saveAccountData` 已改异步。
- **已完成（收尾，2026-07-08 补齐）**：`enter_trade.js` 第40行补 `await`；`package.json` 换依赖（删 better-sqlite3、加 `pg`）；`import_positions.py` 改用 `psycopg2` 走环境变量连接、upsert 写 `account_data`（解析逻辑不变）；`deploy/.env.example` 增加 `DATABASE_URL`/`PG*` 连接变量；`deploy/部署说明.md` 增加 PG 安装/建库/建用户与 `pg_dump` 备份步骤；`Dockerfile` 升级 node22 并去除原生编译；新增 `requirements.txt`(`psycopg2-binary`)、`migrate_sqlite_to_pg.py`(旧 SQLite→PG 迁移)、`docker-compose.yml`(可选一键起 PG)。
- **状态**：代码已可部署。部署前需 `npm install`（装 pg）+ 配置 PG 连接（`DATABASE_URL` 或 `PG*`）。详见 `deploy/PostgreSQL改造交接文档.md` 与 `deploy/部署说明.md`。

### 本地验证（加载级已通过，连库验证待起 PG 实例）
- **加载级（已通过）**：`npm install` 装 `pg@8.22.0`、`better-sqlite3` 彻底移除（0 残留原生模块）；`server/db.js` 加载正常，关键导出齐全（initSchema / saveAccountData / loadAccountData / pool 等）。
- **连库级（待执行）**：本 agent 环境为**标准用户** + PowerShell 工具 stdout 不回传 + Bash 调 `powershell.exe` 被安全拦截，无法自动安装启动 PG；已探明**本机 VC++ 运行库齐全**、EDB 二进制 zip 免装方案可行，给出三套本地起 PG 方案与连库验证命令。详见 `deploy/本地验证交接文档.md`。

### 部署可选优化（时区 + 子目录）
- **时区统一东八区**：新增 `utils.todayCN()`，前端所有业务日期（净值/交易/现金流/导出文件名）及 `enter_trade.js` 交易日期、服务端 K 线起止日，均改用北京时间，避免服务器非东八区时净值日期差一天。
- **支持子目录部署**：新增 `BASE_URL`（`index.html`/`login.html` 的 `<meta name="base-url">` 配置）+ `api()` 封装；所有 `fetch('/api/...')` 与登录后跳转均加前缀；静态资源改为相对路径。根目录部署 `content=""` 即可；子目录部署如 `/portfolio` 需配合 Nginx `location /portfolio/ { proxy_pass http://127.0.0.1:3000/; }`。

### 手机扫码上传图片（AI视觉识别）
- 图片识别区改为左右布局：左边上传框（拖拽/点击上传），右边直接显示二维码
- 切换到"图片识别"模式自动生成二维码，切换到"手动录入"自动停止轮询
- 服务端用 `qrcode` 包生成二维码 base64（避免外部 API 不稳定）
- 手机扫码后打开上传页（免登录），拍照/选图 → 电脑端自动接收 → AI 识别
- 手机上传页使用 `capture="environment"` 直接调起相机
- Token 5 分钟过期，in-memory 存储，定期清理

### 部署配置
- 安装 `qrcode` npm 依赖（服务端二维码生成）
- CSS 缓存戳 `?v=N` 机制，避免浏览器缓旧样式

### 故障修复
- **CSS 解析失败修复**：`.trade-mode-btn.active` 和 `.trade-mode-btn:hover:not(.active)` 各缺 `}` 闭合大括号，导致后续所有 vision-row 等样式全部失效（旧代码遗留问题）
- **招商证券数据修复**：迁移到 PostgreSQL 时两账户 `account_data.data` 被写入相同内容，手动清空招商证券账户数据，华泰账户保留

## 2026-07-06

### 按核查报告.md 修复（代码核查 + 分类逻辑收敛）
- **P0 静默丢数据**: `core.js confirmDelete` 删除"删持仓连带过滤删交易"那行 → 删持仓保留交易流水（交易用于净值计算）。
- **P1 收益图指数开关失效**: 4个对比指数按钮改为中文键 `toggleIndex('沪深300'…)` + `class-index-toggle` + `data-idx`，与 `indexVisibility`/数据集 label 对齐，点击可正常隐藏/显示。
- **P1 区间高亮失效**: 5个区间按钮补 `data-days`；`switchPeriod` 只清 `.period-btn[data-days]` 的 active（不再误清指数按钮高亮）。
- **P2 亏损负号**: `renderReturnsStats` 亏损金额显示 `-` 号。
- **清理死代码**: 删 `index.html exportExcel()`（与 core.js `exportToExcel` 重复且未调用）；删 `index.html` 重复的 `initAutoRefresh()` 调用。
- **归档失效脚本**: `calc_cash.py`/`fix_currency.py`/`fix_hk_prices.py`/`fix_qty.py`/`fix_rate.py` + `data/json_backup_*` 移到 `_deprecated/`（仍写迁移前旧JSON，已失效）；保留 `import_positions.py`；活代码 HK 汇率统一 0.868。
- **分类逻辑收敛为单一函数（前后端共用）**: 新建 `public/js/code-classify.js`（UMD，浏览器全局+Node require）。`recognizeCode`/`fetchQuoteByCode`/`inferSubtype` 全部委托它；删除死代码 `getSecId`。消除 4 处前缀规则漂移。

## 2026-06-27

### 嘉实原油LOF(160723)价格系数修复
- **根因**: "16"开头LOF基金（160723）的价格因子缺失。东方财富API返回 f43=1715（千分位计价），但 `fetchQuoteByCode` 中 factor 判断未覆盖，用了 factor=100 得到错误价格 17.15。
- **修复1**（16:33）: 补加 `p2 === '16'` 条件。
- **修复2**（16:50）: **全面重构 factor 逻辑**，改为"默认1000，仅A股股票用100"的排除法。
- **数据库**: 160723 价格已从 17.15 更新为 1.715。
- **正确价格**: 1.715 / 涨跌幅 +1.48% / 市值 24,010.00。

### 🚨 价格系数规则（全面版，务必遵守）
**东方财富API价格系数原则**：
- **A股股票**（00/30/60/68开头，以及4/8开头的新三板/北交所）→ **factor=100**（分，2位小数）
- **其他所有品种**（LOF基金、ETF、REITs、可转债、QDII基金等）→ **factor=1000**（厘，3位小数）

代码实现：`server.js fetchQuoteByCode()` 中反转逻辑，默认 factor=1000，
仅对A股股票前缀（00/30/60/68/4/8开头）降为 factor=100。
以后新增任何非股票品种（无论什么代码前缀）都不会遗漏。

### 格式约定（重要，后续改代码注意）
- **数量**: 按 1 万加逗号（4位分组），不是标准千分位。例如 14000 → `1,4000`。
- **价格**: `toFixed(3)` 保留3位小数。例如 1.715 → `¥1.715`。
- **市值/金额**: `fmt()` 函数，带¥前缀，4位万位分组，2位小数。

### 🚨 港股价格与汇率（务必遵守）
- **数据库港股 price 字段存的是港币**，不是人民币。
- 计算港股持仓市值人民币值时，必须乘 `hkRate`（当前 0.868）。
- 前端 `getMarketValue()` 已处理此逻辑，后端/脚本计算时要注意。
- **现金已更新**: 现金 = 1,216,588.96，总资产 = 2,464,604.74。

### 🚨 港股代码规则（系统级别）
- **港股代码固定5位**，必须保留前导0。例如 570 → `00570`，152 → `00152`。
- **禁止**去除或缩减前导0（以前的做法是去掉前导0，已作废）。
- `import_positions.py` 中 `parse_hk_shares()` 已增加 `code.zfill(5)`。
- 两个账户的港股代码均已修正：华泰19只、招商16只。

---

### 交易时间感知
- 新增 `isMarketOpen()` 到 `public/js/utils.js`。
- A股: 9:30-11:30 / 13:00-15:00。
- 港股: 9:30-12:00 / 13:00-16:00。
- 混合持仓时，任一市场开盘即视为开盘。

### 架构全面改造
- **数据层重构**: 从 JSON 文件迁移到 SQLite（better-sqlite3），数据库文件 `data/portfolio.db`。
  - 新建表：users、account_data。
  - 新增独立表：positions、trades、nav_history、cash_flows。
  - 启动时自动从旧 JSON 文件迁移数据，旧文件备份到 `data/json_backup_*/`。
- **后端分层**: 数据库代码抽出为 `server/db.js`，server.js 精简为纯路由+中间件（约180行）。
- **前端模块化**: 提取110行工具函数到 `public/js/utils.js`（fmtQty、fmt、recognizeCode、getSecId等）。
- **行情去重**: 移除前端 `fetchTencent()`/`fetchEastMoney()`，行情统一走服务端代理。
- **安全加固**: CSRF 防护，PUT/POST/DELETE 校验 Referer/Origin。
- **新增API**: `/api/hkrate`（港币汇率代理）、`/api/kline`（指数K线代理）。

### 上交所可转债行情Bug修复（此前）
- **根因**: 上交所可转债(11xxxx)的 secid 构造缺少 `1.` 前缀，查不到行情。
- **修复**: secid 构造增加 `code.startsWith('11')` 判断。
- **数据迁移**: 从API重拉全部43只正确价格。
- **附**: 搜特退债404002默认涨跌幅0%。

## 2026-06-26

### 项目初始化
- 从券商导出 CSV 文件导入持仓数据（A股 + 港股通）。
- 支持 `import_positions.py` 导入脚本。
- 初始持仓：43只（17 A股 + 7 可转债 + 19 港股），47笔交易。
- 用户：daicunzai，账户：华泰账户。
