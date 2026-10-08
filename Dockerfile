# mochioa-server —— 运行时基础镜像（不含 dist、.env、data）
# dist 由宿主编译并挂载到 /app/dist（compose: ./dist:/app/dist）
# 环境变量由 compose environment 注入；数据目录挂载 ./data:/app/data
# 镜像仅含 node + 生产依赖 + ffmpeg，无任何业务源码/字节码/配置

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

EXPOSE 3000
CMD ["node", "/app/dist/index.js"]
