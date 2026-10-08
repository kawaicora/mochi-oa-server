#!/usr/bin/env bash
# build-server.sh —— 服务端编译为二进制并导出 docker 压缩包（不含源代码）
# 流程：npm ci → tsc + esbuild + bytenode（dist 只留 index.js loader + app.jsc 字节码）→ docker build（Dockerfile 不编译）→ docker save 压缩
# 用法：./build-server.sh                （默认 tag: mochi-oa-server:<version>）
#      TAG=my-1.0 ./build-server.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/3 在 node:22-slim 内编译（与运行镜像同 V8，避免字节码 cachedDataRejected）"
# bytenode 字节码与 Node/V8 版本强绑定，必须用与运行镜像相同的 node:22-slim 编译
docker run --rm -v "$(pwd):/app" -w /app/server node:22-slim sh -c "npm ci && npm run build"

echo "==> 2/3 构建基础镜像（不含 dist/.env，运行时挂载 ./dist:/app/dist）"
ver=$(node -p "require('./server/package.json').version")
tag="${TAG:-mochi-oa-server:$ver}"
docker build -f Dockerfile -t "$tag" .

echo "==> 3/3 导出 docker 压缩包（基础镜像；部署时挂载 ./dist:/app/dist）"
out="mochi-oa-server-$ver.tar.gz"
docker save "$tag" | gzip > "$out"
echo "已导出: $out ($tag) —— 基础镜像，dist 由 ./dist 挂载"
