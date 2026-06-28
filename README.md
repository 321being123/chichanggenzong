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
# 1. 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# 2. 上传项目并安装
cd /opt
# scp -r portfolio-server root@IP:/opt/portfolio
cd portfolio
npm install --production

# 3. 用 PM2 保活运行
npm install -g pm2
pm2 start server.js --name portfolio
pm2 save
pm2 startup

# 4. 开放端口
# 腾讯云安全组放行 3000 端口
```

### Docker 部署（绿联云）

```bash
docker compose up -d
```

### 外网访问
配合 Nginx 反向代理 + 域名，可配置 HTTPS。

## 数据存储
- 用户账号存在 `data/__users__.json`
- 每个用户的持仓数据存在 `data/{用户名}__{账户名}.json`
- 重启容器不会丢失数据
