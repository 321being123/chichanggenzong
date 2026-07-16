FROM node:22-alpine

# 时区固定为东八区，避免容器内 UTC 导致调度错时
ENV TZ=Asia/Shanghai

WORKDIR /app

# 先只复制依赖清单，利用层缓存
COPY package.json package-lock.json ./

# 仅安装生产依赖（已锁定 lockfile）
RUN npm ci --omit=dev

# 再复制源码（.dockerignore 已排除 .env/.git/日志/数据库/测试数据）
COPY . .

# 运行时数据目录，交给非 root 用户
RUN mkdir -p /app/data && chown -R node:node /app

# 以非 root 用户运行
USER node

EXPOSE 3000

# 密钥（数据库/AI/SMTP 等）请在运行时通过环境变量或 Secret Manager 注入，不要写进镜像
# 例如：docker run -e DATABASE_URL=postgres://user:pass@pg-host:5432/portfolio -p 3000:3000 portfolio-server
CMD ["node", "server.js"]
