/**
 * 将 src/templates 下的网页模板（*.html / *.js）复制到 dist/templates，
 * 供编译产物在运行时读取渲染。templates 为非 TS 资源，tsc 不会拷贝，需手动复制。
 */
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const src = join(root, 'src', 'templates')
const dist = join(root, 'dist', 'templates')

if (!existsSync(src)) {
  console.warn('[copy-templates] src/templates 不存在，跳过：', src)
  process.exit(0)
}
mkdirSync(dist, { recursive: true })
cpSync(src, dist, { recursive: true })
console.log('[copy-templates] 已复制 templates →', dist)
for (const f of readdirSync(src)) {
  if (!existsSync(join(dist, f))) console.warn('[copy-templates] 未复制：', f)
}
