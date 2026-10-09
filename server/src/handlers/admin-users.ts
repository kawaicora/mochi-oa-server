/**
 * 用户/公司/设备管理 handler —— /view/admin 的数据层。
 * 仅 SERVER_ADMIN 可调用（服务端兜底）。
 * 事件：
 *   admin:listUsers      → 全部用户（含所属公司 + serverAdmin 标记）
 *   admin:updateUser     → 修改用户资料（昵称/头像/手机/邮箱），邮箱查重
 *   admin:setServerAdmin → 动态设置/取消某用户的 SERVER_ADMIN（运行时覆盖，重启回退 config）
 *   admin:listCompanies  → 全部公司（含成员与角色）
 *   admin:listDevices    → 已登录设备列表（电脑控制九宫格；远程客户端设备待客户端对接）
 */
import { Server, Socket } from 'socket.io'
import type { ServerConfig } from '../config'
import type { Store } from '../db/store'
import { fail, ok } from '../util'
import { isServerAdmin, serverAdminOverrides } from './mail'
import type { AuthUser } from './auth'
import * as os from 'node:os'

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
              serverAdmin: isServerAdmin({ id: usr.id, username: usr.username, nick: usr.nick || usr.username, sessionId: 0 } as AuthUser, config),
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

    socket.on('admin:setServerAdmin', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { username?: unknown; admin?: unknown }
      const username = String(d.username ?? '').trim()
      if (!username) return ack(fail('缺少用户名'))
      const admin = !!d.admin
      try {
        const target = await store.getUserByUsername(username).catch(() => null)
        if (!target) return ack(fail('用户不存在：' + username))
        if (admin) {
          if (!isServerAdmin({ id: target.id, username: target.username, nick: target.nick || '', sessionId: 0 } as AuthUser, config)) {
            serverAdminOverrides.add(target.username.toLowerCase())
          }
        } else {
          // 取消管理员：仅移除运行时覆盖（config 里的保留）
          serverAdminOverrides.delete(target.username.toLowerCase())
        }
        ack(ok({ admin }))
      } catch (e) {
        ack(fail('操作失败：' + (e instanceof Error ? e.message : String(e))))
      }
    })

    socket.on('admin:listCompanies', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      try {
        const users = await store.listUsers()
        const byCompany = new Map<number, { id: number; name: string; members: Array<{ userId: number; username: string; nick: string; avatar: string; role: string }> }>()
        for (const usr of users) {
          try {
            const mems = await store.getUserCompanies(usr.id)
            for (const m of mems) {
              const key = m.company.id
              let co = byCompany.get(key)
              if (!co) { co = { id: key, name: m.company.name, members: [] }; byCompany.set(key, co) }
              co.members.push({ userId: usr.id, username: usr.username, nick: usr.nick || '', avatar: usr.avatar || '', role: m.role })
            }
          } catch { /* 跳过单个用户 */ }
        }
        ack(ok({ companies: Array.from(byCompany.values()) }))
      } catch (e) {
        ack(fail('查询公司失败：' + (e instanceof Error ? e.message : String(e))))
      }
    })

    socket.on('admin:listDevices', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      // 电脑控制：九宫格数据。目前仅返回服务器本机；远程客户端电脑需客户端对接后上报填充。
      const nets = os.networkInterfaces()
      const ips: string[] = []
      for (const name of Object.keys(nets)) {
        for (const n of nets[name] || []) {
          if (n && n.family === 'IPv4' && !n.internal) { ips.push(n.address); break }
        }
      }
      const devices = [
        { id: 'local', name: '本机（服务器）', username: 'SERVER_ADMIN', os: os.type() + ' ' + os.release(), ip: ips.join('，') || '127.0.0.1', online: true, remote: false }
      ]
      ack(ok({ devices }))
    })
  })
}
