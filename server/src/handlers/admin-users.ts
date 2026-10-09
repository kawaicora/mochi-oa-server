/**
 * 用户管理 handler —— /view/admin → 用户管理 页的数据层。
 * 仅 SERVER_ADMIN 可调用（服务端兜底）。
 * 事件：
 *   admin:listUsers   → 全部用户（含所属公司）
 *   admin:updateUser  → 修改用户资料（昵称/头像/手机/邮箱），邮箱查重
 */
import type { Server, Socket } from 'socket.io'
import type { ServerConfig } from '../config'
import type { Store } from '../db/store'
import { fail, ok } from '../util'
import { isServerAdmin } from './mail'
import type { AuthUser } from './auth'

type Ack = (res: Record<string, unknown>) => void

export function registerAdminUsersHandlers(ctx: { io: Server; store: Store; config: ServerConfig }): void {
  const { io, store, config } = ctx

  io.on('connection', (socket: Socket) => {
    const authedUser = (): AuthUser | null => (socket.data.auth as AuthUser | null) ?? null

    socket.on('admin:listUsers', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      try {
        const users = await store.listUsers()
        // 为每个用户附带所属公司（名称 + 角色）
        const enriched = await Promise.all(
          users.map(async (usr) => {
            let companies: Array<{ id: number; name: string; role: string }> = []
            try {
              const mems = await store.getUserCompanies(usr.id)
              companies = mems.map((m) => ({ id: m.company.id, name: m.company.name, role: m.role }))
            } catch { companies = [] }
            return {
              id: usr.id,
              username: usr.username,
              nick: usr.nick,
              avatar: usr.avatar,
              phone: usr.phone,
              email: usr.email,
              extra: usr.extra,
              createdAt: usr.createdAt,
              companies
            }
          })
        )
        ack(ok({ users: enriched }))
      } catch (e) {
        ack(fail('查询用户失败：' + (e instanceof Error ? e.message : String(e))))
      }
    })

    socket.on('admin:updateUser', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { userId?: unknown; patch?: unknown }
      const userId = Number(d.userId)
      if (!Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const p = (d.patch && typeof d.patch === 'object' ? d.patch : {}) as { nick?: unknown; avatar?: unknown; phone?: unknown; email?: unknown }
      const patch: { nick?: string; avatar?: string; phone?: string; email?: string } = {}
      if (p.nick !== undefined) patch.nick = String(p.nick ?? '').trim().slice(0, 32)
      if (p.avatar !== undefined) patch.avatar = String(p.avatar ?? '').trim().slice(0, 500)
      if (p.phone !== undefined) patch.phone = String(p.phone ?? '').trim().slice(0, 32)
      if (p.email !== undefined) patch.email = String(p.email ?? '').trim().slice(0, 120)
      if (Object.keys(patch).length === 0) return ack(fail('没有可更新的字段'))
      try {
        // 邮箱查重：改邮箱时若被他人占用则拒绝
        if (patch.email && patch.email !== '') {
          const target = await store.getUserById(userId)
          if (patch.email && (!target || target.email !== patch.email)) {
            const byEmail = await store.getUserByEmail(patch.email).catch(() => null)
            if (byEmail && byEmail.id !== userId) return ack(fail('该邮箱已被其他账号绑定'))
          }
        }
        await store.updateUserProfile(userId, patch)
        ack(ok())
      } catch (e) {
        ack(fail('更新失败：' + (e instanceof Error ? e.message : String(e))))
      }
    })
  })
}
