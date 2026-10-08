// tools/compile-bytenode.mjs （服务端加固）
// 流程：tsc 已把 src 编译到 dist/ → esbuild 把业务打成单文件 dist/app.js（依赖库 external）→
// bytenode 把 app.js 编译成 V8 字节码 app.jsc，dist/index.js 替换为 loader。
// 运行时解包拿到的是字节码，无法直接还原成明文 JS；依赖库在 node_modules（公开）保持明文。
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('.')
const cli = path.resolve('node_modules/bytenode/lib/cli.js')
const entry = path.join(root, 'dist', 'index.js')
const bundle = path.join(root, 'dist', 'app.js')

async function main() {
  // 1) esbuild：业务单文件 bundle（第三方依赖 external，运行时从 node_modules require）
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    logLevel: 'warning',
    external: [
      'sequelize',
      'mysql2',
      'socket.io',
      'socket.io-client',
      'multer',
      'nodemailer',
      'jsonwebtoken',
      'dotenv',
      'bytenode'
    ]
  })
  console.log('[obf] esbuild bundle -> dist/app.js')

  // 2) bytenode：app.js 编译成 V8 字节码
  execSync(`node "${cli}" -c "${bundle}"`, { stdio: 'inherit' })

  // 3) 入口 index.js 替换为 loader
  const loader = `require('bytenode');\nrequire('./app.jsc')`
  fs.writeFileSync(entry, loader, 'utf8')

  // 4) 清理明文：删除 esbuild bundle（app.js）与 tsc 其他明文产物，
  //    只保留 loader(index.js) + 字节码(app.jsc) —— 镜像/分发里不含任何业务源码
  const distDir = path.join(root, 'dist')
  const keep = new Set(['index.js', 'app.jsc'])
  for (const f of fs.readdirSync(distDir)) {
    if (!keep.has(f)) fs.rmSync(path.join(distDir, f), { recursive: true, force: true })
  }
  console.log('[obf] 清理明文产物（仅保留 index.js + app.jsc）')
  console.log('[obf] done')
}

main().catch((e) => {
  console.error('[obf] FAILED:', e)
  process.exit(1)
})
