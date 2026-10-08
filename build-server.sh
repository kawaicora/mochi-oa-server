#!/usr/bin/env bash
# build-server.sh —— 服务端编译为二进制并导出 docker 压缩包（不含源代码）
# 流程：npm ci → tsc + esbuild + bytenode（dist 只留 index.js loader + app.jsc 字节码）→ docker build（Dockerfile 不编译）→ docker save 压缩
# 用法：./build-server.sh                （默认 tag: mochi-oa-server:<version>）
#      TAG=my-1.0 ./build-server.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/3 编译服务端（tsc + esbuild + bytenode -> 字节码）"
(
  cd server
  npm ci
  npm run build
)

echo "==> 2/3 构建镜像（Dockerfile 只 COPY 二进制 + 生产依赖，不含源码）"
ver=$(node -p "require('./server/package.json').version")
tag="${TAG:-mochi-oa-server:$ver}"
docker build -f Dockerfile -t "$tag" .

echo "==> 3/3 导出 docker 压缩包（仅二进制，不含源代码）"
out="mochi-oa-server-$ver.tar.gz"
docker save "$tag" | gzip > "$out"
echo "已导出: $out ($tag) —— 仅含二进制字节码，不含源代码"
