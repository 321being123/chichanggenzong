#!/usr/bin/env bash
# 持仓管理系统 · 腾讯云一键部署脚本
# 用法（在服务器网页终端粘贴）：
#   curl -fsSL https://raw.githubusercontent.com/321being123/chichanggenzong/master/deploy/server-init.sh | sudo bash
# 说明：自动安装 Node22 / PostgreSQL / Nginx / pm2，拉取 GitHub 代码，建库建账号，
#       生成 .env，配置 HTTP 反代，用 pm2 守护启动。幂等，可重复运行。

set -euo pipefail

REPO="https://github.com/321being123/chichanggenzong.git"
APP_DIR="/opt/portfolio"
DB_NAME="portfolio"
DB_USER="portfolio_user"

echo "===== 持仓管理系统 一键部署开始 ====="

# --- 1. 包管理器 ---
if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
else echo "不支持的操作系统，请使用 Ubuntu/CentOS"; exit 1
fi

# --- 2. Node 22 ---
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  echo "[1/9] 安装 Node 22 ..."
  if [ "$PKG" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    "$PKG" install -y nodejs
  fi
fi
echo "Node 版本: $(node -v)"

# --- 3. PostgreSQL / Nginx / git / curl / Python ---
echo "[2/9] 安装 PostgreSQL / Nginx / git / Python ..."
if [ "$PKG" = apt ]; then
  apt-get update
  apt-get install -y postgresql postgresql-contrib nginx git curl python3 python3-venv python3-pip
  PG_SVC="postgresql"
else
  "$PKG" install -y postgresql-server postgresql nginx git curl python3 python3-pip
  PG_SVC="postgresql"
fi
systemctl enable "$PG_SVC"
systemctl start "$PG_SVC"

# --- 4. pm2 ---
command -v pm2 >/dev/null 2>&1 || npm install -g pm2

# --- 5. 拉取代码 ---
echo "[3/9] 拉取代码 ..."
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

# --- 6. 建库 + 建账号（幂等） ---
echo "[4/9] 初始化数据库 ..."
if [ ! -f "$APP_DIR/.dbpass" ]; then
  openssl rand -hex 16 > "$APP_DIR/.dbpass"
fi
DB_PASS="$(cat "$APP_DIR/.dbpass")"

sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;" 2>/dev/null || true

# --- 7. 生成 .env（仅首次） ---
if [ ! -f "$APP_DIR/.env" ]; then
  echo "[5/9] 生成 .env ..."
  SECRET="$(openssl rand -hex 32)"
  REG_CODE="$(openssl rand -hex 4)"
  PUB_IP="$(curl -fsSL https://ifconfig.me 2>/dev/null || curl -fsSL ipinfo.io/ip 2>/dev/null || echo 127.0.0.1)"
  cat > "$APP_DIR/.env" <<ENV
PORT=3000
SECRET=$SECRET
ALLOWED_ORIGIN=$PUB_IP,localhost,127.0.0.1
REGISTER_CODE=$REG_CODE
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
PGSSL=false
ENV
  echo "$REG_CODE" > "$APP_DIR/REGISTER_CODE.txt"
  chmod 600 "$APP_DIR/.env" "$APP_DIR/.dbpass"
else
  echo "[5/9] .env 已存在，跳过"
  REG_CODE="$(grep '^REGISTER_CODE=' "$APP_DIR/.env" | cut -d= -f2 || echo '(见 .env)')"
fi

# --- 8. Nginx HTTP 反代 ---
echo "[6/9] 配置 Nginx ..."
cp "$APP_DIR/deploy/nginx-portfolio-http.conf" /etc/nginx/conf.d/portfolio.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

# --- 9. 安装依赖 + pm2 启动 ---
echo "[7/9] 安装依赖并启动 ..."
cd "$APP_DIR"
npm install
python3 -m venv ipo-report/venv
ipo-report/venv/bin/pip install -r requirements.txt
pm2 start deploy/ecosystem.config.js --update-env 2>/dev/null || pm2 restart portfolio-server 2>/dev/null || pm2 start server.js --name portfolio-server
pm2 save
pm2 startup >/dev/null 2>&1 || true

# 放行防火墙
ufw allow 80,443,22 2>/dev/null || true

PUB_IP="$(curl -fsSL https://ifconfig.me 2>/dev/null || curl -fsSL ipinfo.io/ip 2>/dev/null || echo 未知)"
echo "===== 部署完成 ====="
echo "访问地址 : http://$PUB_IP/"
echo "注册邀请码: $REG_CODE   (已保存到 $APP_DIR/REGISTER_CODE.txt)"
echo "查看日志 : pm2 logs portfolio-server"
echo "重启服务 : pm2 restart portfolio-server"
echo "提示     : 腾讯云安全组需放行 80 端口（和 22 方便你 SSH）。"
