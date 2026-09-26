/**
 * 忘记密码 → 重置密码页面（服务端渲染）。
 *
 * 流程：
 *   1) 客户端 auth:sendResetCode  向绑定邮箱发验证码（purpose=reset）
 *   2) 客户端 auth:sendResetMail  验证码通过 → issue 一次性重置令牌 → 发重置邮件（含 /view/reset-pwd?token= 链接）
 *   3) GET  /view/reset-pwd?token=   peek 令牌 → 渲染新密码表单（令牌无效/过期 → 错误页）
 *   4) POST /view/reset-pwd          consume 令牌 → 校验新密码 → 更新散列 → 使该用户所有会话失效 → 成功页
 *
 * 令牌一次性、30 分钟有效（见 reset-tokens.ts），存进程内存。
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'socket.io'
import type { Store } from './db/store'
import { resetTokens } from './reset-tokens'
import { hashPassword } from './password'
import { sessionRoom } from './util'

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 解析表单（application/x-www-form-urlencoded） */
function parseForm(buf: Buffer): Record<string, string> {
  const params = new URLSearchParams(buf.toString('utf8'))
  const out: Record<string, string> = {}
  for (const [k, v] of params) out[k] = v
  return out
}

/** 统一页面外壳（内联 CSS，深色简洁，中文字体） */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#0f1117;color:#e8eaed;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#1a1e28;border:1px solid #2a2f3d;border-radius:14px;padding:36px 32px;width:360px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.4)}
h1{font-size:20px;font-weight:600;margin-bottom:6px}
.sub{color:#9aa0ae;font-size:13px;margin-bottom:24px}
label{display:block;font-size:13px;color:#c3c8d2;margin:14px 0 6px}
input{width:100%;height:42px;border:1px solid #333a49;border-radius:8px;background:#141822;color:#e8eaed;padding:0 12px;font-size:14px;outline:none}
input:focus{border-color:#4a6cf7}
button{width:100%;height:44px;border:none;border-radius:8px;background:#4a6cf7;color:#fff;font-size:15px;font-weight:600;margin-top:24px;cursor:pointer}
button:hover{background:#5b79ff}
.err{background:#3a1f24;border:1px solid #7c2836;color:#ffb3bc;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:8px}
.ok{background:#16331f;border:1px solid #2c6b3c;color:#a9e0b8;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:8px}
.tip{color:#9aa0ae;font-size:12px;text-align:center;margin-top:18px}
a{color:#7b96ff}
</style></head><body><div class="card">${body}</div></body></html>`
}

const formPage = (token: string, email: string): string =>
  page(
    '重置密码',
    `<h1>重置密码</h1><div class="sub">账号邮箱：${email}</div>
     <form method="post" action="/view/reset-pwd">
       <input type="hidden" name="token" value="${token}">
       <label>新密码（6-128 位）</label>
       <input type="password" name="newPassword" minlength="6" maxlength="128" required autocomplete="new-password">
       <label>确认新密码</label>
       <input type="password" name="confirm" minlength="6" maxlength="128" required autocomplete="new-password">
       <button type="submit">重置密码</button>
     </form><div class="tip">重置后所有设备将退出登录，请用新密码重新登录。</div>`
  )

const errPage = (msg: string): string =>
  page('重置密码', `<div class="err">${msg}</div><div class="sub">链接无效或已过期，请回到客户端重新获取重置邮件。</div>`)

const okPage = (): string =>
  page(
    '密码已重置',
    `<div class="ok">密码已重置成功。</div><div class="sub">所有设备已退出登录，请用新密码重新登录客户端。</div>`
  )

function sendHtml(res: ServerResponse, code: number, html: string): void {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

/**
 * 注册 /view/reset-pwd 路由。
 * io 可选：传入时，改密成功后把该用户所有在线 socket 断开（会话已删除，重连即回登录页）。
 */
export function registerResetPwdRoutes(http: HttpServer, store: Store, io?: Server): void {
  http.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/view/reset-pwd') return // 其它路径交由其它路由处理

    // ---- 渲染表单 ----
    if (req.method === 'GET') {
      const token = url.searchParams.get('token') ?? ''
      if (!token) return sendHtml(res, 400, errPage('缺少重置令牌'))
      const entry = resetTokens.peek(token)
      if (!entry) return sendHtml(res, 400, errPage('重置链接无效或已过期'))
      sendHtml(res, 200, formPage(token, entry.email))
      return
    }

    // ---- 提交新密码 ----
    if (req.method === 'POST') {
      const form = parseForm(await readBody(req))
      const token = form.token ?? ''
      const pwd = form.newPassword ?? ''
      const confirm = form.confirm ?? ''

      const entry = resetTokens.consume(token)
      if (!entry) return sendHtml(res, 400, errPage('重置链接无效或已过期'))
      if (pwd.length < 6 || pwd.length > 128) return sendHtml(res, 400, errPage('新密码长度需 6-128 位'))
      if (pwd !== confirm) return sendHtml(res, 400, errPage('两次输入的新密码不一致'))

      try {
        await store.updateUserPassword(entry.userId, hashPassword(pwd))
      } catch (e) {
        return sendHtml(res, 500, errPage(e instanceof Error ? `重置失败：${e.message}` : '重置失败'))
      }

      // 使该用户所有会话失效（改密后强制重新登录）
      const sessions = await store.listSessionsByUser(entry.userId).catch(() => [] as never[])
      for (const s of sessions as { id: number }[]) {
        await store.deleteSession(s.id).catch(() => {})
        if (io) io.in(sessionRoom(s.id)).disconnectSockets(true)
      }
      sendHtml(res, 200, okPage())
      return
    }

    res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(errPage('不支持的请求方式'))
  })
}
