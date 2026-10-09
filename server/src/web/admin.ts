/**
 * /view/admin —— 服务端网页总后台（Flask 式：模板渲染 + 静态资源）。
 *   - src/templates/*.html  页面模板（读文件渲染）
 *   - src/static/{js,css,img}  静态资源（/view/admin/static/*，编译后从 dist/static 读取）
 *   - /view/admin/config.js  动态下发 socket 路径与 transports（Flask url_for 等价）
 * 登录：仅 SERVER_ADMIN 可进入；支持 ?token= 免登录。子页：房间 / 已登录电脑控制 / 用户管理 / 公司管理。
 * 数据层：handlers/rtc.ts、handlers/sysmon.ts、handlers/admin-users.ts
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, normalize, extname } from 'node:path'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'socket.io'
import type { ServerConfig } from '../config'

const PAGE = '/view/admin'
const LEGACY_ROOM = '/view/room'
const CONFIG_JS = '/view/admin/config.js'
const STATIC_PREFIX = '/view/admin/static/'
const IO_JS = '/view/admin/socket.io.js'

/** 模板目录：优先 dist/templates（编译产物），回退 src/templates（本机直接跑 node dist） */
function templatesDir(): string {
  const cands = [
    join(__dirname, '..', 'templates'),
    join(process.cwd(), 'src', 'templates'),
    join(__dirname, '..', '..', 'src', 'templates'),
    resolve(__dirname, '..', '..', '..', '..', 'server', 'src', 'templates')
  ]
  for (const p of cands) {
    if (existsSync(join(p, 'admin.html'))) return p
  }
  return cands[0]
}

/** 静态资源目录：优先 dist/static，回退 src/static */
function staticDir(): string {
  const cands = [
    join(__dirname, '..', 'static'),
    join(process.cwd(), 'src', 'static'),
    join(__dirname, '..', '..', 'src', 'static'),
    resolve(__dirname, '..', '..', '..', '..', 'server', 'src', 'static')
  ]
  for (const p of cands) {
    if (existsSync(join(p, 'js'))) return p
  }
  return cands[0]
}

function readTemplate(dir: string, name: string): string {
  const p = join(dir, name)
  if (!existsSync(p)) throw new Error('模板缺失：' + p)
  return readFileSync(p, 'utf8')
}

function pageHtml(): string {
  const dir = templatesDir()
  let html = readTemplate(dir, 'admin.html')
  const replace = (html: string, name: string, content: string): string => html.split('@@' + name + '@@').join(content)
  html = replace(html, 'ROOM_PAGE', readTemplate(dir, 'room.html'))
  html = replace(html, 'SYSMON_PAGE', readTemplate(dir, 'sysmon.html'))
  html = replace(html, 'USERS_PAGE', readTemplate(dir, 'users.html'))
  html = replace(html, 'COMPANIES_PAGE', readTemplate(dir, 'companies.html'))
  return html
}

const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

/** 从 node_modules 提供 socket.io 客户端脚本 */
function ioClientJs(): Buffer | null {
  const candidates = [
    join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'),
    join(process.cwd(), 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js')
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p) } catch { /* 继续 */ }
    }
  }
  return null
}

/** 安全地解析 /view/admin/static/<rel>，防路径穿越 */
function resolveStatic(rel: string): string | null {
  const base = normalize(staticDir())
  const abs = normalize(join(base, rel))
  const sep = process.platform === 'win32' ? '\\' : '/'
  if (abs !== base && !abs.startsWith(base + sep)) return null
  if (!existsSync(abs) || !statSync(abs).isFile()) return null
  return abs
}

export function registerAdminRoutes(http: HttpServer, _store: unknown, _io: Server, config: ServerConfig): void {
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    // ── socket.io 客户端脚本 ──
    if (pathname === IO_JS) {
      const js = ioClientJs()
      if (!js) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('socket.io client not found'); return }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' })
      res.end(js)
      return
    }

    // ── 动态配置（Flask url_for 等价）：下发 socket 路径与 transports ──
    if (pathname === CONFIG_JS) {
      const serverPath = config.path || '/socket.io'
      const transports = config.transports && config.transports.length ? config.transports : (['websocket', 'polling'] as string[])
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('window.__ADMIN_CONFIG__ = ' + JSON.stringify({ path: serverPath, transports }) + ';\n')
      return
    }

    // ── 静态资源（Flask send_static_file）──
    if (pathname.startsWith(STATIC_PREFIX)) {
      const rel = pathname.slice(STATIC_PREFIX.length)
      const abs = resolveStatic(rel)
      if (!abs) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return }
      const mime = MIME[extname(abs).toLowerCase()] || 'application/octet-stream'
      try {
        const buf = readFileSync(abs)
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' })
        res.end(buf)
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('read fail: ' + (e instanceof Error ? e.message : String(e)))
      }
      return
    }

    // ── 旧会议页入口 → 总后台 ──
    if (pathname === LEGACY_ROOM) {
      res.writeHead(301, { Location: PAGE + (url.search || '') })
      res.end()
      return
    }

    if (pathname !== PAGE) return
    if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('仅支持 GET'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    try {
      res.end(pageHtml())
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('模板加载失败：' + (e instanceof Error ? e.message : String(e)))
    }
  })
}
