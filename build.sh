#!/usr/bin/env bash
# 服务端一键构建 + 部署重启（Linux 远程服务器）
# 用法：在 mochi-oa-server 仓库根目录执行  bash build.sh
# 流程：tsc 编译 → 静态资源(模板/JS/CSS)并入 dist → Docker 部署重启
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT/server"

if [ ! -f "$SERVER_DIR/package.json" ]; then
  echo "[ERR] 未找到 server/ 目录，请在 mochi-oa-server 仓库根目录运行"
  exit 1
fi

echo "===== [1/3] 编译 TypeScript -> dist ====="
cd "$SERVER_DIR"
node node_modules/typescript/bin/tsc -p tsconfig.json || { echo "[ERR] tsc 编译失败"; exit 1; }

echo "===== [2/3] 同步静态资源（templates/static -> dist） ====="
node tools/copy-templates.mjs || { echo "[ERR] 静态资源同步失败"; exit 1; }

echo "===== [3/3] Docker 部署重启 ====="
cd "$ROOT"
if ! docker compose up -d --build; then
  echo "[warn] compose up 失败，尝试直接重启容器…"
  docker restart mochi-oa-server-2f8e9c
fi
echo "===== 完成 ====="
