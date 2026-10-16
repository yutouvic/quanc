# ---------- 构建阶段：安装依赖并打包前端 ----------
FROM node:22-alpine AS builder

WORKDIR /app

# 先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码与静态资源，执行前端打包（生成 public/client.js）
COPY src ./src
COPY public ./public
RUN npm run build

# ---------- 运行阶段：仅保留生产依赖与构建产物 ----------
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

# 仅安装生产依赖（boardgame.io、koa-static 等）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制服务器源码与已构建的前端资源
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public

# 以非 root 用户运行
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 8000

CMD ["node", "src/server.js"]
