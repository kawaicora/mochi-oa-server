/**
 * 将网页资源复制到 dist，供编译产物运行时读取：
 *   - src/templates → dist/templates（*.html 页面模板）
 *   - src/static    → dist/static   （js/css/img 静态资源）
 * 均为非 TS 资源，tsc 不会拷贝，需手动复制。
 */
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const jobs = [
  { src: join(root, 'src', 'templates'), dist: join(root, 'dist', 'templates') },
  { src: join(root, 'src', 'static'), dist: join(root, 'dist', 'static') }
]
for (const j of jobs) {
  if (!existsSync(j.src)) { console.warn('[copy-templates] 源不存在，跳过：', j.src); continue }
  mkdirSync(j.dist, { recursive: true })
  cpSync(j.src, j.dist, { recursive: true })
  console.log('[copy-templates] 已复制 →', j.dist)
  for (const f of readdirSync(j.src)) {
    if (!existsSync(join(j.dist, f))) console.warn('[copy-templates] 未复制：', f)
  }
}
