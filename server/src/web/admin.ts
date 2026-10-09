/**
 * /view/admin —— 服务端网页总后台（客户端管理 Web）。HTML 模板存于 src/templates，
 * 运行时读取渲染（编译后从 dist/templates 读取）。
 *   - 登录（仅 SERVER_ADMIN 可进入，登录即判 ISADMIN；支持 ?token= 免登录）
 *   - 侧栏导航：房间 / 已登录电脑控制 / 用户管理 / 公司管理
 * 子页模板：room.html(.js)、sysmon.html(.js)、users.html(.js)、companies.html(.js)
 * 数据层：handlers/rtc.ts、handlers/sysmon.ts、handlers/admin-users.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'socket.io'
import type { ServerConfig } from '../config'

const PAGE = '/view/admin'
const LEGACY_ROOM = '/view/room'
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

function readTemplate(dir: string, name: string): string {
  const p = join(dir, name)
  if (!existsSync(p)) {
    throw new Error('模板缺失：' + p)
  }
  return readFileSync(p, 'utf8')
}

function pageHtml(serverPath: string, transports: string[]): string {
  const dir = templatesDir()
  let html = readTemplate(dir, 'admin.html')

  const replace = (html: string, name: string, content: string): string =>
    html.split('@@' + name + '@@').join(content)

  html = replace(html, 'ROOM_PAGE', readTemplate(dir, 'room.html'))
  html = replace(html, 'ROOM_JS', readTemplate(dir, 'room.js'))
  html = replace(html, 'SYSMON_PAGE', readTemplate(dir, 'sysmon.html'))
  html = replace(html, 'SYSMON_JS', readTemplate(dir, 'sysmon.js'))
  html = replace(html, 'USERS_PAGE', readTemplate(dir, 'users.html'))
  html = replace(html, 'USERS_JS', readTemplate(dir, 'users.js'))
  html = replace(html, 'COMPANIES_PAGE', readTemplate(dir, 'companies.html'))
  html = replace(html, 'COMPANIES_JS', readTemplate(dir, 'companies.js'))
  html = replace(html, 'SERVER_PATH', JSON.stringify(serverPath))
  html = replace(html, 'TRANSPORTS', JSON.stringify(transports))
  return html
}

/** 从服务端 node_modules 提供 socket.io 客户端脚本 */
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

/**
 * 注册 /view/admin 网页总后台路由。
 * GET /view/admin              → 单页 HTML（登录 + 房间 + 电脑控制 + 用户管理 + 公司管理）
 * GET /view/admin/socket.io.js → socket.io 客户端脚本（缓存 1 天）
 * GET /view/room               → 301 重定向到 /view/admin（旧会议页入口保留）
 */
export function registerAdminRoutes(http: HttpServer, _store: unknown, _io: Server, config: ServerConfig): void {
  const serverPath = config.path || '/socket.io'
  const transports = config.transports && config.transports.length ? config.transports : (['websocket', 'polling'] as string[])
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === IO_JS) {
      const js = ioClientJs()
      if (!js) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('socket.io client not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' })
      res.end(js)
      return
    }

    if (url.pathname === LEGACY_ROOM) {
      res.writeHead(301, { Location: PAGE + (url.search || '') })
      res.end()
      return
    }

    if (url.pathname !== PAGE) return
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('仅支持 GET')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    try {
      res.end(pageHtml(serverPath, transports))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('模板加载失败：' + (e instanceof Error ? e.message : String(e)))
    }
  })
}
