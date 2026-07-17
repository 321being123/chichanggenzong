# PostgreSQL 存储改造 — 交接文档

> ⚠️ **Docker 已废弃**：本项目当前使用腾讯云裸机 + pm2 + Nginx 部署，**不支持 Docker 部署**。Dockerfile / docker-compose.yml / .dockerignore 已删除，文末涉及 Docker 的条目仅供历史参考。

> 生成时间：2026-07-08
> 负责人：戴存在（daicunzai）
> 关联：原方案为 SQLite（better-sqlite3，单文件 `data/portfolio.db`）

---

## 一、改造背景与决策

- **决策时间**：2026-07-08
- **决策内容**：将数据存储从 SQLite 改为 **PostgreSQL**。
- **决策原因**：计划把系统开放给几十人使用，用户希望采用更"企业级"的关系型数据库。
- **已与用户沟通确认的前提（接手人务必了解）**：
  1. SQLite 对"几十人、单服务器、低频手动写入"其实足够稳，PostgreSQL 是用户**主动选择**，不是技术必需。
  2. 2核4G 内存无论 SQLite 还是 PG 都绰绰有余（PG 空闲约 400~500MB，整套约 1.5~2G）。
  3. `pg` 是**纯 JS 驱动**，换掉 `better-sqlite3` 后，部署时不再需要在 Linux 上编译原生模块，**上线反而更简单**。

---

## 二、已完成工作（2026-07-08）

### ✅ 1. `server/db.js` — 完全重写为 PostgreSQL 异步数据层
- `better-sqlite3` → `pg` 的 `Pool`。
- 全部表结构转为 PG 语法（`TEXT` / `double precision`），新增 `initSchema()` 在启动时自动建表。
- 所有导出函数改为 `async`（返回 Promise）。
- 迁移逻辑 `migrateFromJson` / `migrateToStructured` 已转 PG 语法（`ON CONFLICT` upsert）。
- **现金自动重算逻辑完全保留**（现金 = 期初本金 `cashBase` + 现金流净额 + 交易净额），与前端一致。
- 导出接口：`module.exports = { pool, initSchema, migrateFromJson, migrateToStructured, loadUsers, saveUsers, hashPwd, verifyPwd, loadAccountData, saveAccountData, uid, DATA_DIR }`

### ✅ 2. `server.js` — 路由全部适配异步
- 注册/登录/账户/数据/导出等路由加 `async` + `await`。
- 新增 `asyncHandler` 包装，避免未捕获 Promise 异常导致进程挂起。
- 启动流程改为：`await initSchema()` + 迁移 → 再 `app.listen()`。
- **其余业务逻辑（行情代理、分类、现金重算、安全校验等）一律未动。**

### ⚠️ 3. `enter_trade.js` — 部分改造（**不完整，见第三节第 1 条**）
- `main()` 已改为 `async function main()` ✓
- `saveAccountData(...)` 已加 `await` ✓
- 导入语句正确：`const { loadAccountData, saveAccountData, uid } = require('./server/db');` ✓
- **缺失**：第 40 行 `loadAccountData` 调用未加 `await`（上次 429 中断未保存）。

---

## 三、待完成工作（接手人按序执行）

### 🔴 第 1 项（必修 bug）：补 `enter_trade.js` 第 40 行的 `await`
当前（错误）：
```js
const data = loadAccountData(USER, account);
```
改为（正确）：
```js
const data = await loadAccountData(USER, account);
```
> 不修则 `data` 是 Promise，`data.trades.push(...)` 必崩。这是上次 429 打断遗留的唯一缺口。

### 🟠 第 2 项：`package.json` 换依赖
- 删除：`"better-sqlite3": "^12.11.1"`
- 新增：`"pg": "^8.13.0"`
- 保留：`express` / `express-session` / `xlsx`
- 注：`npm install` 会自动装 `pg`。

### 🟠 第 3 项：`import_positions.py` 改 PG
- 用 `psycopg2` 替换 `sqlite3`。
- 连接走环境变量（`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` 或 `DATABASE_URL`）。
- 写入 `account_data` 表，用 `ON CONFLICT (username, account_name) DO UPDATE` upsert。
- **解析逻辑（A股/港股/可转债分类、`code.zfill(5)` 港股前导0）一律不变**，只换数据库读写层。

### 🟡 第 4 项：`.env.example` 增加 PG 连接变量
在现有变量后追加（db.js 已支持以下读取方式）：
```env
# PostgreSQL 连接（二选一）
# 方式A：完整连接串（优先）
DATABASE_URL=postgres://postgres:密码@localhost:5432/portfolio
# 方式B：分项变量
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=
PGDATABASE=portfolio
# 如数据库启用 SSL（云数据库常见），设 true
PGSSL=false
```

### 🟡 第 5 项：部署说明与配套文件
1. `deploy/部署说明.md` 增加「安装 PostgreSQL / 建库 / 建用户」步骤（Ubuntu：`apt install postgresql`，`sudo -u postgres createdb portfolio`，建专用账号并授权）。
2. `Dockerfile` 去掉 `better-sqlite3` 原生编译相关步骤（如有）。
3. 新增 `requirements.txt`（Python 导入用）：`psycopg2-binary`。
4. 新增迁移脚本 `migrate_sqlite_to_pg.py`：读旧 `data/portfolio.db` → 写 PG（仅当线上已有旧 SQLite 数据需要迁移时执行）。

### 🟢 第 6 项：本地开发环境说明
- 开发者**本地需装 PostgreSQL** 才能 `node server.js`（或用 `DATABASE_URL` 指向远程/容器 PG）。
- 建议在仓库加 `docker-compose.yml` 一键起 PG（可选，非必须）。

---

## 四、关键技术细节

### 连接配置（已写在 `server/db.js`）
- **优先** `DATABASE_URL`（如 `postgres://user:pass@host:5432/db`）。
- 否则用 `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`，默认值指向本地 `localhost:5432` / 库名 `portfolio`。
- `PGSSL=true` 时启用 SSL（`rejectUnauthorized: false`，适配云数据库）。
- 连接池 `max: 10`。

### 表结构（PostgreSQL，已由 `initSchema()` 自动创建）
| 表 | 字段 |
|---|---|
| `users` | `username` PK, `password` NOT NULL, `accounts` TEXT DEFAULT '[]' |
| `account_data` | `username`, `account_name` (PK 复合), `data` TEXT DEFAULT '{}', `updated_at` TEXT |
| `positions` | `id`,`username`,`account_name` (PK 复合), `code`,`name`,`price` double precision, `quantity` double precision, `cost` double precision, `type`,`subtype`,`note` |
| `trades` | `id`,`username`,`account_name` (PK 复合), `date`,`created_at`,`code`,`name`,`direction`,`price` double precision, `quantity` double precision, `amount` double precision, `type`,`subtype`,`note` |
| `nav_history` | `username`,`account_name`,`date` (PK 复合), `nav` double precision, `total_asset` double precision |
| `cash_flows` | `id`,`username`,`account_name` (PK 复合), `date`,`created_at`,`amount` double precision, `note` |

### 与原 SQLite 实现的差异（接手人注意）
- 无 `PRAGMA journal_mode=WAL` —— PG ACID 天然保证，不需要。
- `double precision` 等价于 SQLite `REAL`。
- `updated_at` 用 `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')` 生成。
- 计数查询用 `COUNT(*)::int`（PG 返回 bigint，转 int 后端才好用）。
- 写入采用「先 `DELETE` 该账户全部，再批量 `INSERT`」策略（与 SQLite 版一致），单进程（`ecosystem.config.js` `instances: 1`）下无并发问题。

---

## 五、数据备份方式变更
- **原（SQLite）**：直接拷贝单文件 `data/portfolio.db` + 云硬盘快照。
- **新（PG）**：`pg_dump portfolio > backup_$(date +%F).sql`，配合 cron 每日执行。
- 示例 cron（每日 03:00）：
  ```cron
  0 3 * * * /usr/bin/pg_dump -U postgres portfolio | gzip > /var/backups/portfolio_$(date +\%F).sql.gz
  ```

---

## 六、验证步骤（全部完成后）
```bash
# 1. 安装依赖
npm install

# 2. 本地/服务器装 PG 并建库
sudo -u postgres createdb portfolio

# 3. 验证建表
node -e "require('./server/db').initSchema().then(()=>console.log('schema ok')).catch(e=>{console.error(e);process.exit(1)})"

# 4. 验证读取（如有数据）
node -e "require('./server/db').loadAccountData('daicunzai','华泰账户').then(d=>console.log(JSON.stringify(d).slice(0,200))).catch(e=>{console.error(e);process.exit(1)})"

# 5. 启动
node server.js
# 或 pm2
pm2 start deploy/ecosystem.config.js
```

---

## 七、当前状态与风险提示
> **状态更新（2026-07-08）**：第三节全部 6 项已补齐完成，代码已可部署。
- ✅ 第1项 `enter_trade.js` 第40行已补 `await`。
- ✅ 第2项 `package.json` 已换依赖（删 better-sqlite3、加 `pg`）。
- ✅ 第3项 `import_positions.py` 已改 `psycopg2`（解析逻辑不变，upsert 写 `account_data`）。
- ✅ 第4项 `deploy/.env.example` 已加 `DATABASE_URL`/`PG*` 连接变量。
- ✅ 第5项 `部署说明.md` 已加 PG 安装/建库/建用户 + `pg_dump` 备份；`Dockerfile` 升 node22、去原生编译；新增 `requirements.txt`、`migrate_sqlite_to_pg.py`。
- ✅ 第6项 新增可选 `docker-compose.yml` 一键起 PG。
- 📌 部署前：`npm install`（装 pg）+ 配置 PG 连接（`DATABASE_URL` 或 `PG*`）。
- 📌 改代码前请先读根目录 `CHANGELOG.md`（已记录本次改造决策与进度）。
