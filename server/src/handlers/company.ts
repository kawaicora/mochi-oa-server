import type { Socket } from 'socket.io'
import { AlreadyExistsError } from '../db/store'
import type { CompanyRole } from '../types'
import { isOnline } from '../presence'
import { companyRoom, fail, groupRoom, makeJoinCode, ok, userRoom } from '../util'
import type { AuthUser, Ctx } from './auth'

type Ack = (res: Record<string, unknown>) => void

const isName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 64
const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{3,32}$/.test(v)
const isCompanyRole = (v: unknown): v is CompanyRole => v === 'owner' || v === 'admin' || v === 'member'

function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

/** 角色比较：owner > admin > member */
function rank(role: CompanyRole): number {
  return role === 'owner' ? 3 : role === 'admin' ? 2 : 1
}

const idOf = (v: unknown): number => Number(v)

export function registerCompanyHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ================= 公司（管理员/创建人） =================

    // ---- 创建公司：创建人自动成为 owner(管理员) ----
    socket.on('company:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { name?: unknown; code?: unknown }
      if (!isName(d.name)) return ack(fail('组织名不合法'))
      if (d.code !== undefined && !isCode(d.code)) return ack(fail('加入码需 3-32 位字母数字'))
      if (await store.getCompanyByName(d.name.trim())) return ack(fail('已存在同名企业/团队'))

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = isCode(d.code) ? d.code : makeJoinCode()
        try {
          const company = await store.createCompany({ name: d.name.trim(), code, ownerId: auth.id })
          void socket.join(companyRoom(company.id))
          // 自动创建「全员群（总群）」：钉钉式，入职/入司自动加入
          for (let g = 0; g < 5; g++) {
            const gcode = makeJoinCode()
            try {
              const group = await store.createGroup({ companyId: company.id, name: `${company.name}总群`, code: gcode, ownerId: auth.id })
              await store.getOrCreateGroupConversation(group.id, auth.id)
              break
            } catch (e) {
              if (!(e instanceof AlreadyExistsError)) break
            }
          }
          return ack(ok({ company }))
        } catch (err) {
          if (err instanceof AlreadyExistsError && !isCode(d.code)) continue // 生成的码冲突，换一个
          return ack(fail(err instanceof AlreadyExistsError ? '加入码已被占用' : '创建失败'))
        }
      }
      ack(fail('加入码生成冲突，请重试'))
    })

    // ---- 我的公司 ----
    socket.on('company:list', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const raw = await store.getUserCompanies(auth.id)
      const companies = raw.map((c) => {
        const isAdmin = c.role === 'owner' || c.role === 'admin'
        return { ...c, company: { ...c.company, code: isAdmin ? c.company.code : '' } }
      })
      ack(ok({ companies }))
    })

    // ---- 搜索用户（按用户名/昵称/ID，用于管理员添加成员候选） ----
    socket.on('user:search', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const kw = typeof (data as { keyword?: unknown } | null)?.keyword === 'string' ? (data as { keyword: string }).keyword.trim() : ''
      if (!kw) return ack(ok({ users: [] }))
      const idMatch = /^\d+$/.test(kw) ? Number(kw) : 0
      const all = await store.listUsers()
      const k = kw.toLowerCase()
      const users = all
        .filter((u) => u.username.toLowerCase().includes(k) || (!!u.nick && u.nick.toLowerCase().includes(k)) || (idMatch && u.id === idMatch))
        .slice(0, 30)
        .map((u) => ({ id: u.id, username: u.username, nick: u.nick, avatar: u.avatar, phone: u.phone }))
      ack(ok({ users }))
    })

    // ---- 搜索公司（用于加入） ----
    socket.on('company:search', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const keyword = (data as { keyword?: unknown } | null)?.keyword
      const companies = await store.listCompanies(typeof keyword === 'string' ? keyword : undefined)
      ack(ok({ companies }))
    })

    // ---- 凭加入码加入公司 ----
    socket.on('company:join', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const code = (data as { code?: unknown } | null)?.code
      if (!isCode(code)) return ack(fail('加入码不合法'))
      const company = await store.getCompanyByCode(code)
      if (!company) return ack(fail('公司不存在或加入码错误'))
      try {
        await store.addMember(company.id, auth.id, 'member')
        void socket.join(companyRoom(company.id))
        io.to(companyRoom(company.id)).emit('company:updated', { companyId: company.id })
        ack(ok({ company }))
      } catch (err) {
        ack(fail(err instanceof AlreadyExistsError ? '已在公司中' : '加入失败'))
      }
    })

    // ---- 退出公司 ----
    socket.on('company:leave', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = idOf((data as { companyId?: unknown } | null)?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      const role = await store.getMemberRole(companyId, auth.id)
      if (role === null) return ack(fail('不在公司中'))
      if (role === 'owner') return ack(fail('创建人不能退出公司'))
      await store.removeMember(companyId, auth.id)
      void socket.leave(companyRoom(companyId))
      io.to(companyRoom(companyId)).emit('company:updated', { companyId })
      io.to(userRoom(auth.id)).emit('company:removed', { companyId })
      ack(ok())
    })

    // ---- 公司成员 ----
    socket.on('company:members', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = idOf((data as { companyId?: unknown } | null)?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if ((await store.getMemberRole(companyId, auth.id)) === null) return ack(fail('不在公司中'))
      const members = await store.getMembers(companyId)
      const infos = await Promise.all(members.map(async (m) => await store.getUserById(m.userId)))
      const locs = await Promise.all(members.map(async (m) => await store.getUserActiveLocation(m.userId)))
      members.forEach((m, i) => {
        const u = infos[i]
        if (u) { m.avatar = u.avatar; m.phone = u.phone; m.extra = u.extra }
        m.location = locs[i]
      })
      ack(ok({ members: members.map((m) => ({ ...m, online: isOnline(m.userId) })) }))
    })

    // ---- 设置公司角色（owner/admin 可） ----
    socket.on('company:setRole', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; userId?: unknown; role?: unknown }
      const companyId = idOf(d.companyId)
      const userId = idOf(d.userId)
      if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(userId) || userId <= 0) {
        return ack(fail('参数不合法'))
      }
      if (!isCompanyRole(d.role)) return ack(fail('角色不合法'))
      const myRole = await store.getMemberRole(companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('无权限'))

      const targetRole = await store.getMemberRole(companyId, userId)
      if (targetRole === null) return ack(fail('目标不在公司中'))
      if (rank(myRole) < rank(d.role as CompanyRole)) return ack(fail('无权限授予该角色'))
      if (d.role === 'owner' && myRole !== 'owner') return ack(fail('仅创建人可转移创建权'))
      if (targetRole === 'owner' && myRole !== 'owner') return ack(fail('不能修改创建人角色'))

      await store.setRole(companyId, userId, d.role as CompanyRole)
      io.to(companyRoom(companyId)).emit('company:updated', { companyId })
      ack(ok())
    })

    // ---- 移除公司成员（owner/admin 可；不可移除创建人） ----
    socket.on('company:kick', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; userId?: unknown }
      const companyId = idOf(d.companyId)
      const userId = idOf(d.userId)
      if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(userId) || userId <= 0) {
        return ack(fail('参数不合法'))
      }
      const myRole = await store.getMemberRole(companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('无权限'))
      const targetRole = await store.getMemberRole(companyId, userId)
      if (targetRole === null) return ack(fail('目标不在公司中'))
      if (targetRole === 'owner') return ack(fail('不能移除创建人'))
      if (targetRole === 'admin' && myRole !== 'owner') return ack(fail('仅创建人可移除管理员'))

      await store.removeMember(companyId, userId)
      for (const s of io.sockets.sockets.values()) {
        if (s.data.auth?.id === userId) void s.leave(companyRoom(companyId))
      }
      io.to(companyRoom(companyId)).emit('company:updated', { companyId })
      io.to(userRoom(userId)).emit('company:removed', { companyId })
      ack(ok())
    })

    // ---- 直接添加成员到公司（管理员；可选分配到部门，直接生效） ----
    socket.on('company:addMember', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; userId?: unknown; username?: unknown; departmentId?: unknown }
      const companyId = idOf(d.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      const myRole = await store.getMemberRole(companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可添加成员'))

      // 目标用户：优先 userId，否则按 username
      let target: { id: number } | null = null
      if (Number.isInteger(d.userId) && Number(d.userId as number) > 0) {
        target = await store.getUserById(Number(d.userId as number))
      } else if (typeof d.username === 'string' && d.username.trim()) {
        target = await store.getUserByUsername(d.username.trim())
      }
      if (!target) return ack(fail('用户不存在'))
      if (target.id === auth.id) return ack(fail('不能添加自己'))
      if (await store.getMemberRole(companyId, target.id)) return ack(fail('对方已在公司中'))

      // 校验部门属于本公司
      let departmentId: number | null = null
      if (d.departmentId !== undefined && d.departmentId !== null && d.departmentId !== 0) {
        departmentId = idOf(d.departmentId)
        const dept = await store.getDepartmentById(departmentId)
        if (!dept || dept.companyId !== companyId) return ack(fail('部门不属于该公司'))
      }

      await store.addMember(companyId, target.id, 'member')
      if (departmentId) await store.assignDepartment(departmentId, target.id).catch(() => {})
      io.to(companyRoom(companyId)).emit('company:updated', { companyId })
      for (const s of io.sockets.sockets.values()) {
        if (s.data.auth?.id === target.id) void s.join(companyRoom(companyId))
      }
      io.to(userRoom(target.id)).emit('company:added', { companyId })
      ack(ok())
    })

    // ================= 部门（公司管理员创建） =================

    // ---- 创建部门：仅公司 owner/admin ----
    socket.on('company:createDepartment', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; name?: unknown; parentId?: unknown }
      const companyId = idOf(d.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if (!isName(d.name)) return ack(fail('部门名不合法'))
      const myRole = await store.getMemberRole(companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可创建部门'))

      const parentId = d.parentId === undefined ? null : idOf(d.parentId)
      if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) return ack(fail('上级部门不合法'))
      const department = await store.createDepartment({ companyId, name: d.name.trim(), parentId })
      io.to(companyRoom(companyId)).emit('company:updated', { companyId })
      ack(ok({ department }))
    })

    // ---- 公司部门列表 ----
    socket.on('company:listDepartments', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = idOf((data as { companyId?: unknown } | null)?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if ((await store.getMemberRole(companyId, auth.id)) === null) return ack(fail('不在公司中'))
      const departments = await store.listDepartments(companyId)
      ack(ok({ departments }))
    })

    // ---- 分配成员到部门（owner/admin 可） ----
    socket.on('department:assign', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { departmentId?: unknown; userId?: unknown }
      const departmentId = idOf(d.departmentId)
      const userId = idOf(d.userId)
      if (!Number.isInteger(departmentId) || departmentId <= 0 || !Number.isInteger(userId) || userId <= 0) {
        return ack(fail('参数不合法'))
      }
      const department = await store.getDepartmentById(departmentId)
      if (!department) return ack(fail('部门不存在'))
      const myRole = await store.getMemberRole(department.companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可分配成员'))
      if ((await store.getMemberRole(department.companyId, userId)) === null) return ack(fail('目标不在公司中'))

      try {
        await store.assignDepartment(departmentId, userId)
        io.to(companyRoom(department.companyId)).emit('company:updated', { companyId: department.companyId })
        ack(ok())
      } catch (err) {
        ack(fail(err instanceof AlreadyExistsError ? '已在部门中' : '分配失败'))
      }
    })

    // ---- 移出部门（owner/admin 可） ----
    socket.on('department:removeMember', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { departmentId?: unknown; userId?: unknown }
      const departmentId = idOf(d.departmentId)
      const userId = idOf(d.userId)
      if (!Number.isInteger(departmentId) || departmentId <= 0 || !Number.isInteger(userId) || userId <= 0) {
        return ack(fail('参数不合法'))
      }
      const department = await store.getDepartmentById(departmentId)
      if (!department) return ack(fail('部门不存在'))
      const myRole = await store.getMemberRole(department.companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可操作'))
      await store.removeDepartmentMember(departmentId, userId).catch(() => {})
      io.to(companyRoom(department.companyId)).emit('company:updated', { companyId: department.companyId })
      ack(ok())
    })

    // ---- 部门成员 ----
    socket.on('department:members', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const departmentId = idOf((data as { departmentId?: unknown } | null)?.departmentId)
      if (!Number.isInteger(departmentId) || departmentId <= 0) return ack(fail('参数不合法'))
      const department = await store.getDepartmentById(departmentId)
      if (!department) return ack(fail('部门不存在'))
      if ((await store.getMemberRole(department.companyId, auth.id)) === null) return ack(fail('不在公司中'))
      const members = await store.getDepartmentMembers(departmentId)
      const infos = await Promise.all(members.map(async (m) => await store.getUserById(m.userId)))
      const locs = await Promise.all(members.map(async (m) => await store.getUserActiveLocation(m.userId)))
      members.forEach((m, i) => {
        const u = infos[i]
        if (u) { m.avatar = u.avatar; m.phone = u.phone; m.extra = u.extra }
        m.location = locs[i]
      })
      ack(ok({ members: members.map((m) => ({ ...m, online: isOnline(m.userId) })) }))
    })

    // ---- 重命名公司（owner/admin） ----
    socket.on('company:rename', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; name?: unknown }
      const companyId = idOf(d.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if (!isName(d.name)) return ack(fail('组织名不合法'))
      const myRole = await store.getMemberRole(companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可重命名公司'))
      const dupName = await store.getCompanyByName(d.name.trim())
      if (dupName && dupName.id !== companyId) return ack(fail('已存在同名企业/团队'))
      await store.renameCompany(companyId, d.name.trim())
      const company = await store.getCompanyById(companyId)
      io.to(companyRoom(companyId)).emit('company:updated', { company })
      ack(ok({ company }))
    })

    // ---- 删除部门（owner/admin；级联移除成员归属） ----
    socket.on('company:deleteDepartment', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const departmentId = idOf((data as { departmentId?: unknown } | null)?.departmentId)
      if (!Number.isInteger(departmentId) || departmentId <= 0) return ack(fail('参数不合法'))
      const department = await store.getDepartmentById(departmentId)
      if (!department) return ack(fail('部门不存在'))
      const myRole = await store.getMemberRole(department.companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可删除部门'))
      await store.deleteDepartment(departmentId)
      io.to(companyRoom(department.companyId)).emit('company:updated', { companyId: department.companyId })
      ack(ok())
    })

    // ---- 转让公司（仅 owner） ----
    socket.on('company:transfer', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; userId?: unknown }
      const companyId = idOf(d.companyId); const userId = idOf(d.userId)
      if (!Number.isInteger(companyId) || companyId <= 0 || !Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      const company = await store.getCompanyById(companyId)
      if (!company) return ack(fail('公司不存在'))
      if (company.ownerId !== auth.id) return ack(fail('仅创建者可转让'))
      const target = await store.getMemberRole(companyId, userId)
      if (target === null) return ack(fail('目标不在公司中'))
      if (userId === auth.id) return ack(fail('不能转让给自己'))
      await store.setRole(companyId, userId, 'owner')
      await store.setRole(companyId, auth.id, 'admin')
      await store.setCompanyOwner(companyId, userId)
      io.to(companyRoom(companyId)).emit('company:updated', { company })
      ack(ok())
    })

    // ---- 解散公司（仅 owner） ----
    socket.on('company:dissolve', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = idOf((data as { companyId?: unknown } | null)?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      const company = await store.getCompanyById(companyId)
      if (!company) return ack(fail('公司不存在'))
      if (company.ownerId !== auth.id) return ack(fail('仅创建者可解散'))
      const groups = await store.listGroups(companyId)
      for (const g of groups) io.to(groupRoom(g.id)).emit('group:dissolved', { groupId: g.id })
      await store.deleteCompany(companyId)
      io.to(companyRoom(companyId)).emit('company:dissolved', { companyId })
      ack(ok())
    })

    // ================= 入职流程：管理员邀请 → 用户同意 =================

    // ---- 管理员邀请用户加入公司（生成邀请码；可选过期时间；已用则标记 used） ----
    socket.on('company:invite', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; username?: unknown; departmentId?: unknown; expiresAt?: unknown }
      const companyId = idOf(d.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      const username = typeof d.username === 'string' ? d.username.trim() : ''
      if (!username) return ack(fail('请输入对方账号'))
      const myRole = await store.getMemberRole(companyId, auth.id)
      if (myRole === null) return ack(fail('不在公司中'))
      if (rank(myRole) < rank('admin')) return ack(fail('仅管理员可邀请'))
      const target = await store.getUserByUsername(username)
      if (!target) return ack(fail('账号不存在'))
      if (await store.getMemberRole(companyId, target.id)) return ack(fail('对方已在公司中'))

      // 校验部门属于本公司
      let departmentId: number | null = null
      if (d.departmentId !== undefined && d.departmentId !== null && d.departmentId !== 0) {
        departmentId = idOf(d.departmentId)
        const dept = await store.getDepartmentById(departmentId)
        if (!dept || dept.companyId !== companyId) return ack(fail('部门不属于该公司'))
      }
      // 可选过期时间
      let expiresAt: string | null = null
      if (d.expiresAt !== undefined && d.expiresAt !== null && d.expiresAt !== '') {
        const t = new Date(String(d.expiresAt))
        if (Number.isNaN(t.getTime())) return ack(fail('过期时间不合法'))
        expiresAt = t.toISOString()
      }
      try {
        const invitation = await store.createCompanyInvitation({
          companyId,
          userId: target.id,
          departmentId,
          invitedBy: auth.id,
          code: makeJoinCode() + makeJoinCode().slice(0, 2), // 8 位邀请码
          expiresAt
        })
        io.to(userRoom(target.id)).emit('company:inviteReceived', { invitation })
        ack(ok({ invitation }))
      } catch (err) {
        ack(fail(err instanceof AlreadyExistsError ? '已邀请过对方，等待其同意' : '邀请失败'))
      }
    })

    // ---- 用户：我的待处理邀请 ----
    socket.on('company:myInvites', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const invites = await store.listPendingInvitationsForUser(auth.id)
      ack(ok({ invites }))
    })

    // ---- 管理员：公司发出的邀请（含状态） ----
    socket.on('company:listInvitations', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = idOf((data as { companyId?: unknown } | null)?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if (rank((await store.getMemberRole(companyId, auth.id)) ?? 'member') < rank('admin')) return ack(fail('仅管理员可查看'))
      const invites = await store.listCompanyInvitations(companyId)
      ack(ok({ invites }))
    })

    // ---- 用户：同意邀请（邀请码标记已使用；自动加入公司 + 部门 + 全员群） ----
    socket.on('company:acceptInvite', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const invitationId = idOf((data as { invitationId?: unknown } | null)?.invitationId)
      if (!Number.isInteger(invitationId) || invitationId <= 0) return ack(fail('参数不合法'))
      const invitation = await store.getCompanyInvitationById(invitationId)
      if (!invitation) return ack(fail('邀请不存在'))
      if (invitation.userId !== auth.id) return ack(fail('无权处理该邀请'))
      if (invitation.status !== 'pending') return ack(fail('邀请已失效'))
      if (invitation.expiresAt && new Date(invitation.expiresAt).getTime() < Date.now()) {
        await store.setCompanyInvitationStatus(invitation.id, 'expired')
        return ack(fail('邀请已过期'))
      }
      try {
        await store.addMember(invitation.companyId, auth.id, 'member')
      } catch (err) {
        if (err instanceof AlreadyExistsError) return ack(fail('你已在公司中'))
        throw err
      }
      // 部门
      if (invitation.departmentId) await store.assignDepartment(invitation.departmentId, auth.id).catch(() => {})
      // 全员群（缺失则自动补建：兼容旧公司）
      let mainGroup = await store.getCompanyMainGroup(invitation.companyId)
      if (!mainGroup) {
        const company = await store.getCompanyById(invitation.companyId)
        for (let g = 0; g < 5; g++) {
          try {
            mainGroup = await store.createGroup({ companyId: invitation.companyId, name: `${company?.name ?? '公司'}总群`, code: makeJoinCode(), ownerId: invitation.invitedBy })
            break
          } catch (e) {
            if (!(e instanceof AlreadyExistsError)) break
          }
        }
      }
      if (mainGroup) {
        await store.addGroupMember(mainGroup.id, auth.id, 'member').catch(() => {})
        const conv = await store.getOrCreateGroupConversation(mainGroup.id)
        await store.addConversationMember(conv.id, auth.id).catch(() => {})
        io.to(groupRoom(mainGroup.id)).emit('group:members-updated', { groupId: mainGroup.id })
      }
      // 邀请码标记已使用
      await store.setCompanyInvitationStatus(invitation.id, 'accepted')
      invitation.status = 'accepted'
      void socket.join(companyRoom(invitation.companyId))
      io.to(companyRoom(invitation.companyId)).emit('company:updated', { companyId: invitation.companyId })
      io.to(userRoom(auth.id)).emit('company:added', { companyId: invitation.companyId })
      const company = await store.getCompanyById(invitation.companyId)
      io.to(userRoom(invitation.invitedBy)).emit('company:inviteResolved', { invitation, company })
      ack(ok({ company }))
    })

    // ---- 用户：拒绝邀请 ----
    socket.on('company:declineInvite', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const invitationId = idOf((data as { invitationId?: unknown } | null)?.invitationId)
      if (!Number.isInteger(invitationId) || invitationId <= 0) return ack(fail('参数不合法'))
      const invitation = await store.getCompanyInvitationById(invitationId)
      if (!invitation) return ack(fail('邀请不存在'))
      if (invitation.userId !== auth.id) return ack(fail('无权处理该邀请'))
      if (invitation.status !== 'pending') return ack(fail('邀请已失效'))
      await store.setCompanyInvitationStatus(invitation.id, 'declined')
      ack(ok())
    })

    // ================= 成员人事信息（绑定 用户×公司，入职填写） =================

    // ---- 读取我的某公司人事信息 ----
    socket.on('member:getProfile', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = idOf((data as { companyId?: unknown } | null)?.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if ((await store.getMemberRole(companyId, auth.id)) === null) return ack(fail('不在公司中'))
      const profile = await store.getMemberProfile(companyId, auth.id)
      ack(ok({ profile }))
    })

    // ---- 填写/更新我的某公司人事信息 ----
    socket.on('member:updateProfile', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; realName?: unknown; idCard?: unknown; bankCard?: unknown; resumeUrl?: unknown; portfolioUrl?: unknown }
      const companyId = idOf(d.companyId)
      if (!Number.isInteger(companyId) || companyId <= 0) return ack(fail('参数不合法'))
      if ((await store.getMemberRole(companyId, auth.id)) === null) return ack(fail('不在公司中'))
      const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
      const profile = await store.upsertMemberProfile(companyId, auth.id, {
        realName: str(d.realName),
        idCard: str(d.idCard),
        bankCard: str(d.bankCard),
        resumeUrl: str(d.resumeUrl),
        portfolioUrl: str(d.portfolioUrl)
      })
      io.to(companyRoom(companyId)).emit('company:updated', { companyId })
      ack(ok({ profile }))
    })
  })
}
