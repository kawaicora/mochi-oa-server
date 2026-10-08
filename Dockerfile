# mochioa-server —— 运行阶段（宿主机已编译为二进制，见 build-server.ps1 / build-server.sh）
# 镜像内容：node 运行时 + 生产依赖(node_modules) + 编译产物(dist: loader index.js + 字节码 app.jsc) + ffmpeg
# 不含任何业务源代码（server/src、编译工具均不进入镜像）

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg：视频转码（rm/avi/mkv/3gp/rmvb 等非浏览器原生格式 → mp4 流播）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 生产依赖（镜像内安装；不含 typescript/esbuild/bytenode 等编译工具）
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 编译产物（宿主机 build-server 脚本生成）：仅 index.js(loader) + app.jsc(字节码)，无源码
COPY server/dist ./dist
# 环境配置：compose 通过 environment 注入优先，此处 .env 供 dotenv 兜底（含 SERVER_ADMIN_USERS / MAIL_*）
COPY .env ./

# 本地文件存储目录（挂载宿主 ./data 持久化；按 {公司id|default}/{文件名/文件夹结构} 存储）
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "dist/index.js"]
