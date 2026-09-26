import type { Socket } from 'socket.io'
import type { ServerConfig } from '../config'
import type { MailConfig } from '../types'
import { fail, ok } from '../util'
import type { AuthUser, Ctx } from './auth'
import type { Mailer } from '../mailer'

type Ack = (res: Record<string, unknown>) => void

interface MailCtx extends Ctx {
  mailer: Mailer
}

function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

/**
 * SERVER_ADMIN 判定：服务器所有者权限，基于用户名（大小写不敏感），与公司/群角色无关。
 * 名单来自 .env/Docker 的 SERVER_ADMIN_USERS（回退 ADMIN_USER）。
 */
function isServerAdmin(auth: AuthUser, config: ServerConfig): boolean {
  return config.serverAdmins.some((u) => u.toLowerCase() === auth.username.toLowerCase())
}

/** 对外展示的配置视图（隐藏 SMTP 密码明文） */
function viewMailConfig(c: MailConfig): Record<string, unknown> {
  return {
    email: c.email,
    displayName: c.displayName,
    host: c.host,
    port: c.port,
    secure: c.secure,
    user: c.user,
    enabled: c.enabled,
    isDefault: c.isDefault,
    password: '••••••••'
  }
}

export function registerMailHandlers(ctx: MailCtx): void {
  const { io, store, config, mailer } = ctx

  io.on('connection', (socket) => {
    // ---- 读取主邮件配置（含当前用户是否 SERVER_ADMIN） ----
    socket.on('mail:getMainConfig', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const isAdmin = isServerAdmin(auth, config)
      const main = await mailer.getMainMail()
      ack(
        ok({
          serverAdmin: isAdmin,
          source: main.source, // 'env' | 'db'
          // 仅环境未配置（source=db）时才允许客户端设置
          canEdit: isAdmin && main.source === 'db',
          config: main.config ? viewMailConfig(main.config) : null
        })
      )
    })

    // ---- 设置主邮件配置（需 SERVER_ADMIN；仅当环境未配置主邮件时生效） ----
    socket.on('mail:setMainConfig', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      if (!isServerAdmin(auth, config)) return ack(fail('需要 SERVER_ADMIN 权限'))

      // 环境已配置主邮件：客户端设置不生效（第一优先级是环境配置）
      if (config.mail?.enabled) return ack(fail('主邮件已由服务器环境配置，请在 .env / Docker 中修改'))

      const d = (data ?? {}) as {
        email?: unknown; displayName?: unknown; host?: unknown; port?: unknown
        secure?: unknown; user?: unknown; password?: unknown
      }
      const email = typeof d.email === 'string' ? d.email.trim() : ''
      const host = typeof d.host === 'string' ? d.host.trim() : ''
      if (!email || !host) return ack(fail('发信邮箱与 SMTP 主机必填'))
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ack(fail('发信邮箱不合法'))
      const port = Number(d.port ?? 465)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return ack(fail('SMTP 端口不合法'))
      const user = typeof d.user === 'string' ? d.user.trim() : email
      const password = typeof d.password === 'string' ? d.password : ''
      const secure = d.secure === undefined ? true : Boolean(d.secure)
      const displayName = typeof d.displayName === 'string' ? d.displayName.trim().slice(0, 128) : ''

      // 幂等：更新同邮箱主配置，或新增
      const existing = (await store.listMailConfigs({ companyId: null })).find((c) => c.email === email)
      // 更新已有配置且密码留空 → 保留原 SMTP 密码
      const finalPassword = password || existing?.password || ''
      if (!finalPassword) return ack(fail('SMTP 密码必填（首次配置需填写）'))
      await store.saveMailConfig({
        id: existing?.id,
        companyId: null,
        email,
        displayName,
        host,
        port,
        secure,
        user,
        password: finalPassword,
        isDefault: true,
        enabled: true,
        priority: 10
      })
      ack(ok())
    })
  })
}

export { isServerAdmin }
