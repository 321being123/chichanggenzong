# 持仓管理系统

## 维护文档

- [技术架构](docs/技术架构.md)：系统入口、前后端分层、数据库、后台任务、数据源与维护边界。
- [生产部署流程](docs/生产部署流程.md)：版本、测试、发布、部署和验收铁律。

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

# 2. 从 Git 同步项目并按 lockfile 安装
cd /opt/portfolio
sudo git fetch origin
sudo git reset --hard origin/master
sudo npm ci --omit=dev

# 3. 用 PM2 保活运行
sudo npm install -g pm2
sudo pm2 start deploy/ecosystem.config.js
sudo pm2 save
sudo pm2 startup

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
