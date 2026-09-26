# mochioa-server —— 安装 Node 环境并编译服务端
# 产物：dist/（编译后的 JS）+ node_modules；运行阶段直接 node 启动

# ---- 构建阶段 ----
FROM node:22-slim AS build
WORKDIR /app

# 先装依赖（利用层缓存）
COPY server/package.json server/package-lock.json ./
RUN npm ci

# 编译 TypeScript
COPY server/ ./
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg：视频转码（rm/avi/mkv/3gp/rmvb 等非浏览器原生格式 → mp4 流播）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# 环境配置：compose 通过 environment 注入优先，此处 .env 供 dotenv 兜底（含 SERVER_ADMIN_USERS / MAIL_*）
COPY .env ./

# 本地文件存储目录（挂载宿主 ./data 持久化；按 {公司id|default}/{文件名/文件夹结构} 存储）
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "dist/index.js"]
