FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
# 数据库走外部 PostgreSQL：运行时通过环境变量传入 DATABASE_URL 或 PG* 连接参数
# 例如：docker run -e DATABASE_URL=postgres://user:pass@pg-host:5432/portfolio -p 3000:3000 portfolio-server
CMD ["node", "server.js"]
