# 持仓管理系统

## 功能
- 手机号注册/登录（多人独立账号，数据隔离）
- 多账户管理（每个人可创建多个券商账户）
- 实时行情 + 涨跌颜色
- 收益趋势对比（基金净值法，对比沪深300/上证/中证全指/恒生）
- 截图识别导入持仓

## 部署

### 服务器部署（腾讯云/NAS）

```bash
# 1. 安装 Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# 2. 上传项目并安装
cd /opt
# scp -r portfolio-server root@IP:/opt/portfolio
cd portfolio
# 按 lockfile 精确安装（与 package-lock.json 一致；去掉 --omit=dev 可装开发依赖以跑测试）
npm ci --omit=dev

# 3. 用 PM2 保活运行
npm install -g pm2
pm2 start server.js --name portfolio-server
pm2 save
pm2 startup

# 4. 开放端口
# 腾讯云安全组只放行 80/443/22 端口（3000 仅内网 Nginx 反代使用，不对公网开放）
```

### 外网访问
配合 Nginx 反向代理 + 域名，可配置 HTTPS。

## 数据存储
- 数据统一存储在 **PostgreSQL** 数据库（用户、账户、持仓、交易、净值、现金流、收盘价等均为结构化表）。
- 通过环境变量 `DATABASE_URL` 或 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` 连接，详见 `.env` 示例。
- 会话密钥等敏感配置仅存于 `.env`，不进入仓库；数据库连接密码绝不明文写入代码。
- 重启服务（含 PM2）不会丢失数据，备份请用 `pg_dump`。
