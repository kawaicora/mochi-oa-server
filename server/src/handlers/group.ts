import type { Socket } from 'socket.io'
import { AlreadyExistsError } from '../db/store'
import { isOnline } from '../presence'
import { fail, groupRoom, makeJoinCode, ok, userRoom } from '../util'
import type { AuthUser, Ctx } from './auth'

type Ack = (res: Record<string, unknown>) => void

const isName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 64
const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{3,32}$/.test(v)

function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

const idOf = (v: unknown): number => Number(v)

export function registerGroupHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ---- 创建群：公司成员即可；创建人为群主 ----
    socket.on('group:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; departmentId?: unknown; name?: unknown }
      const companyId = idOf(d.companyId)
      if (!Number.isInteger(companyId) || companyId < 0) return ack(fail('参数不合法'))
      if (!isName(d.name)) return ack(fail('群名不合法'))
      if (await store.getGroupByName(companyId, d.name.trim())) return ack(fail('已存在同名群'))
      // 钉钉模式：无公司(companyId=0)也能建群（上级 company 为 0）；有公司则须为公司成员
      if (companyId > 0 && (await store.getMemberRole(companyId, auth.id)) === null) return ack(fail('不在公司中'))

      let departmentId: number | null = null
      if (d.departmentId !== undefined && d.departmentId !== null && d.departmentId !== 0) {
        departmentId = idOf(d.departmentId)
        if (!Number.isInteger(departmentId) || departmentId <= 0) return ack(fail('部门不合法'))
        const dept = await store.getDepartmentById(departmentId)
        if (!dept || dept.companyId !== companyId) return ack(fail('部门不属于该公司'))
      }

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeJoinCode()
        try {
          const group = await store.createGroup({ companyId, departmentId, name: d.name.trim(), code, ownerId: auth.id })
          await store.getOrCreateGroupConversation(group.id, auth.id) // 为群建对话，加入对话列表
          void socket.join(groupRoom(group.id))
          return ack(ok({ group }))
        } catch (err) {
          if (err instanceof AlreadyExistsError) continue // 生成的码冲突，换一个
          return ack(fail('创建失败'))
        }
      }
      ack(fail('群码生成冲突，请重试'))
    })

    // ---- 我的群 ----
    socket.on('group:list', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const groups = await store.getUserGroups(auth.id)
      ack(ok({ groups }))
    })

    // ---- 某公司下的群（用于加入/搜索） ----
    socket.on('group:search', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; keyword?: unknown }
      const companyId = d.companyId === undefined ? undefined : idOf(d.companyId)
      if (companyId !== undefined && (!Number.isInteger(companyId) || companyId <= 0)) return ack(fail('参数不合法'))
      if (companyId !== undefined && (await store.getMemberRole(companyId, auth.id)) === null) {
        return ack(fail('不在公司中'))
      }
      const groups = await store.listGroups(companyId, typeof d.keyword === 'string' ? d.keyword : undefined)
      ack(ok({ groups }))
    })

    // ---- 凭群码加入群：须为公司成员 ----
    socket.on('group:join', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const code = (data as { code?: unknown } | null)?.code
      if (!isCode(code)) return ack(fail('群码不合法'))
      const group = await store.getGroupByCode(code)
      if (!group) return ack(fail('群不存在或群码错误'))
      // 无公司群(companyId=0)任何用户可凭码加入；有公司群须为公司成员
      if (group.companyId > 0 && (await store.getMemberRole(group.companyId, auth.id)) === null) {
        return ack(fail('不在该公司，无法加入该群'))
      }
      try {
        await store.addGroupMember(group.id, auth.id, 'member')
        const conv = await store.getOrCreateGroupConversation(group.id)
        await store.addConversationMember(conv.id, auth.id)
        void socket.join(groupRoom(group.id))
        io.to(groupRoom(group.id)).emit('group:members-updated', { groupId: group.id })
        ack(ok({ group }))
      } catch (err) {
        ack(fail(err instanceof AlreadyExistsError ? '已在群中' : '加入失败'))
      }
    })

    // ---- 退出群 ----
    socket.on('group:leave', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const groupId = idOf((data as { groupId?: unknown } | null)?.groupId)
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      const role = await store.getGroupMemberRole(groupId, auth.id)
      if (role === null) return ack(fail('不在群中'))
      if (role === 'owner') return ack(fail('群主不能退出群'))
      await store.removeGroupMember(groupId, auth.id)
      const conv = await store.getOrCreateGroupConversation(groupId)
      await store.removeConversationMember(conv.id, auth.id).catch(() => {})
      void socket.leave(groupRoom(groupId))
      io.to(groupRoom(groupId)).emit('group:members-updated', { groupId })
      io.to(userRoom(auth.id)).emit('group:removed', { groupId })
      ack(ok())
    })

    // ---- 群成员 ----
    socket.on('group:members', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const groupId = idOf((data as { groupId?: unknown } | null)?.groupId)
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      if ((await store.getGroupMemberRole(groupId, auth.id)) === null) return ack(fail('不在群中'))
      const members = await store.getGroupMembers(groupId)
      const avatars = await Promise.all(members.map(async (m) => (await store.getUserById(m.userId))?.avatar ?? ''))
      members.forEach((m, i) => { m.avatar = avatars[i] })
      ack(ok({ members: members.map((m) => ({ ...m, online: isOnline(m.userId) })) }))
    })

    // 群主/管理员可管理；普通成员可邀请
    const canManage = (role: string | null): boolean => role === 'owner' || role === 'admin'
    const broadcastMembers = (groupId: number): void => {
      io.to(groupRoom(groupId)).emit('group:members-updated', { groupId })
    }
    // 成员变更后各端自动刷新（避免只对自己生效）
    const joinGroupSockets = (userId: number, groupId: number): void => {
      for (const s of io.sockets.sockets.values()) {
        if (s.data.auth?.id === userId) void s.join(groupRoom(groupId))
      }
    }

    // ---- 群主/管理员移除成员 ----
    socket.on('group:kick', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown }
      const groupId = idOf(d.groupId)
      const userId = idOf(d.userId)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) {
        return ack(fail('参数不合法'))
      }
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (!canManage(myRole)) return ack(fail('仅群主/管理员可移除成员'))
      const target = await store.getGroupMember(groupId, userId)
      if (!target) return ack(fail('目标不在群中'))
      if (target.role === 'owner') return ack(fail('不能移除群主'))
      if (myRole === 'admin' && target.role === 'admin') return ack(fail('管理员不能移除其他管理员'))

      await store.removeGroupMember(groupId, userId)
      const conv = await store.getOrCreateGroupConversation(groupId)
      await store.removeConversationMember(conv.id, userId).catch(() => {})
      for (const s of io.sockets.sockets.values()) {
        if (s.data.auth?.id === userId) void s.leave(groupRoom(groupId))
      }
      broadcastMembers(groupId)
      io.to(userRoom(userId)).emit('group:removed', { groupId })
      ack(ok())
    })

    // ---- 群主设为管理员 ----
    socket.on('group:setAdmin', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown }
      const groupId = idOf(d.groupId); const userId = idOf(d.userId)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (myRole !== 'owner') return ack(fail('仅群主可设置管理员'))
      const target = await store.getGroupMember(groupId, userId)
      if (!target) return ack(fail('目标不在群中'))
      if (target.role !== 'member') return ack(fail('已是群主/管理员'))
      await store.setGroupMemberRole(groupId, userId, 'admin')
      broadcastMembers(groupId)
      ack(ok())
    })

    // ---- 群主取消管理员 ----
    socket.on('group:unsetAdmin', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown }
      const groupId = idOf(d.groupId); const userId = idOf(d.userId)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (myRole !== 'owner') return ack(fail('仅群主可取消管理员'))
      const target = await store.getGroupMember(groupId, userId)
      if (!target) return ack(fail('目标不在群中'))
      if (target.role !== 'admin') return ack(fail('目标不是管理员'))
      await store.setGroupMemberRole(groupId, userId, 'member')
      broadcastMembers(groupId)
      ack(ok())
    })

    // ---- 群主/管理员禁言（seconds>0 禁言；0/缺省 解禁） ----
    socket.on('group:mute', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown; seconds?: unknown }
      const groupId = idOf(d.groupId); const userId = idOf(d.userId)
      const seconds = d.seconds === undefined ? 0 : Number(d.seconds)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (!canManage(myRole)) return ack(fail('仅群主/管理员可禁言'))
      const target = await store.getGroupMember(groupId, userId)
      if (!target) return ack(fail('目标不在群中'))
      if (target.role === 'owner') return ack(fail('不能禁言群主'))
      if (myRole === 'admin' && target.role === 'admin') return ack(fail('管理员不能禁言其他管理员'))
      const mutedUntil = seconds > 0 ? new Date(Date.now() + seconds * 1000) : null
      await store.setGroupMemberMuted(groupId, userId, mutedUntil)
      broadcastMembers(groupId)
      ack(ok({ mutedUntil: mutedUntil ? mutedUntil.toISOString() : null }))
    })

    // ---- 群主/管理员直接加人（公司成员） ----
    socket.on('group:add', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown }
      const groupId = idOf(d.groupId); const userId = idOf(d.userId)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const group = await store.getGroupById(groupId)
      if (!group) return ack(fail('群不存在'))
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (!canManage(myRole)) return ack(fail('仅群主/管理员可添加成员'))
      if (group.companyId > 0 && (await store.getMemberRole(group.companyId, userId)) === null) return ack(fail('目标不在该公司'))
      if ((await store.getGroupMemberRole(groupId, userId)) !== null) return ack(fail('已在群中'))
      try {
        await store.addGroupMember(groupId, userId, 'member')
        const conv = await store.getOrCreateGroupConversation(groupId)
        await store.addConversationMember(conv.id, userId)
        joinGroupSockets(userId, groupId)
        broadcastMembers(groupId)
        io.to(userRoom(userId)).emit('group:added', { groupId })
        ack(ok())
      } catch (err) {
        ack(fail(err instanceof AlreadyExistsError ? '已在群中' : '添加失败'))
      }
    })

    // ---- 群友邀请（普通成员/管理员/群主均可）：发给目标用户，目标确认后入群 ----
    const invites = new Map<string, { groupId: number; groupName: string; fromUserId: number; fromNick: string }>()
    socket.on('group:invite', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown }
      const groupId = idOf(d.groupId); const userId = idOf(d.userId)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const group = await store.getGroupById(groupId)
      if (!group) return ack(fail('群不存在'))
      if ((await store.getGroupMemberRole(groupId, auth.id)) === null) return ack(fail('不在群中'))
      if (group.companyId > 0 && (await store.getMemberRole(group.companyId, userId)) === null) return ack(fail('目标不在该公司'))
      if ((await store.getGroupMemberRole(groupId, userId)) !== null) return ack(fail('对方已在群中'))
      if ((await store.getUserById(userId)) === null) return ack(fail('对方不存在'))
      invites.set(`${groupId}:${userId}`, { groupId, groupName: group.name, fromUserId: auth.id, fromNick: auth.nick ?? auth.username })
      io.to(userRoom(userId)).emit('group:invite', {
        groupId, groupName: group.name,
        from: { userId: auth.id, nick: auth.nick ?? auth.username }, ts: Date.now()
      })
      ack(ok())
    })

    // ---- 接受邀请入群 ----
    socket.on('group:acceptInvite', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const groupId = idOf((data as { groupId?: unknown } | null)?.groupId)
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      const inv = invites.get(`${groupId}:${auth.id}`)
      if (!inv) return ack(fail('没有待处理的邀请'))
      const group = await store.getGroupById(groupId)
      if (!group) { invites.delete(`${groupId}:${auth.id}`); return ack(fail('群不存在')) }
      if ((await store.getGroupMemberRole(groupId, auth.id)) !== null) { invites.delete(`${groupId}:${auth.id}`); return ack(fail('已在群中')) }
      if (group.companyId > 0 && (await store.getMemberRole(group.companyId, auth.id)) === null) {
        invites.delete(`${groupId}:${auth.id}`)
        return ack(fail('不在该公司，无法入群'))
      }
      await store.addGroupMember(groupId, auth.id, 'member')
      const conv = await store.getOrCreateGroupConversation(groupId)
      await store.addConversationMember(conv.id, auth.id)
      void socket.join(groupRoom(groupId))
      invites.delete(`${groupId}:${auth.id}`)
      broadcastMembers(groupId)
      ack(ok({ group }))
    })

    // ---- 拒绝邀请 ----
    socket.on('group:declineInvite', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const groupId = idOf((data as { groupId?: unknown } | null)?.groupId)
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      invites.delete(`${groupId}:${auth.id}`)
      ack(ok())
    })

    // ---- 转让群主（仅群主） ----
    socket.on('group:transfer', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; userId?: unknown }
      const groupId = idOf(d.groupId); const userId = idOf(d.userId)
      if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (myRole !== 'owner') return ack(fail('仅群主可转让'))
      const target = await store.getGroupMember(groupId, userId)
      if (!target) return ack(fail('目标不在群中'))
      if (userId === auth.id) return ack(fail('不能转让给自己'))
      await store.setGroupMemberRole(groupId, userId, 'owner')
      await store.setGroupMemberRole(groupId, auth.id, 'admin')
      await store.setGroupOwner(groupId, userId)
      broadcastMembers(groupId)
      ack(ok())
    })

    // ---- 解散群（仅群主） ----
    socket.on('group:dissolve', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const groupId = idOf((data as { groupId?: unknown } | null)?.groupId)
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      const myRole = await store.getGroupMemberRole(groupId, auth.id)
      if (myRole !== 'owner') return ack(fail('仅群主可解散群'))
      await store.deleteGroup(groupId)
      io.to(groupRoom(groupId)).emit('group:dissolved', { groupId })
      ack(ok())
    })
  })
}
