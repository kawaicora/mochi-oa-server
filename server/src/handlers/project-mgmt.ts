import type { Socket } from 'socket.io'
import { ok, fail } from '../util'
import type { Ctx } from './auth'
import type { Store } from '../db/store'
import type { RequirementStatus, BugStatus, CompanyRole } from '../types'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): { id: number } | null {
  return socket.data.auth ? (socket.data.auth as { id: number }) : null
}
async function memberRoleOf(store: Store, companyId: number, userId: number): Promise<CompanyRole | null> {
  if (!companyId || companyId <= 0) return null
  return store.getMemberRole(companyId, userId)
}
function isAdmin(role: CompanyRole | null): boolean {
  return role === 'owner' || role === 'admin'
}
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}
function toIsoStr(v: unknown): string {
  if (typeof v !== 'string' || !v) return ''
  const t = Date.parse(v)
  return Number.isNaN(t) ? '' : new Date(t).toISOString()
}
function int(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}
function intArr(v: unknown): number[] {
  return Array.isArray(v) ? v.map(int).filter((n) => n > 0) : []
}

/** 校验公司归属，返回 role；不通过则 ack 失败并返回 null */
async function guardCompany(store: Store, companyId: number, socket: Socket, ack: Ack): Promise<CompanyRole | null> {
  const auth = authed(socket)
  if (!auth) { ack(fail('未登录')); return null }
  const role = await memberRoleOf(store, companyId, auth.id)
  if (!role) { ack(fail('非本公司成员')); return null }
  return role
}

const REQ_STATUS: RequirementStatus[] = ['planning', 'in_progress', 'done', 'closed']
const BUG_STATUS: BugStatus[] = ['pending', 'processing', 'verified', 'closed']

export function registerProjectMgmtHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ==================== 需求 ====================
    socket.on('req:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const projectId = int(d.projectId) || undefined
      const requirements = await store.listRequirements(companyId, projectId)
      ack(ok({ requirements }))
    })

    socket.on('req:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown; title?: unknown; description?: unknown; category?: unknown; priority?: unknown; handlerId?: unknown; startTime?: unknown; dueTime?: unknown; taskIds?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const title = str(d.title, 128)
      if (!title) return ack(fail('标题不能为空'))
      const st = toIsoStr(d.startTime), dt = toIsoStr(d.dueTime)
      if (!st || !dt) return ack(fail('请填写开始与结束时间'))
      if (Date.parse(dt) < Date.parse(st)) return ack(fail('结束时间不能早于开始'))
      const requirement = await store.createRequirement({
        companyId, projectId: int(d.projectId) || null,
        title, description: str(d.description, 8000),
        category: str(d.category, 32) || undefined, priority: str(d.priority, 32) || undefined,
        handlerId: int(d.handlerId) || null, startTime: st, dueTime: dt, creatorId: auth.id
      })
      const taskIds = intArr(d.taskIds)
      if (taskIds.length) await store.linkRequirementTasks({ requirementId: requirement.id, taskIds, userId: auth.id, companyId })
      ack(ok({ requirement }))
    })

    socket.on('req:update', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; title?: unknown; description?: unknown; category?: unknown; priority?: unknown; handlerId?: unknown; startTime?: unknown; dueTime?: unknown }
      const req = await store.getRequirement(int(d.id))
      if (!req) return ack(fail('需求不存在'))
      if (!isAdmin(await memberRoleOf(store, req.companyId, auth.id))) return ack(fail('仅管理员可编辑'))
      const updated = await store.updateRequirement({
        id: req.id,
        title: d.title !== undefined ? str(d.title, 128) : undefined,
        description: d.description !== undefined ? str(d.description, 8000) : undefined,
        category: d.category !== undefined ? str(d.category, 32) : undefined,
        priority: d.priority !== undefined ? str(d.priority, 32) : undefined,
        handlerId: d.handlerId !== undefined ? int(d.handlerId) || null : undefined,
        startTime: d.startTime !== undefined ? toIsoStr(d.startTime) || undefined : undefined,
        dueTime: d.dueTime !== undefined ? toIsoStr(d.dueTime) || undefined : undefined
      })
      ack(ok({ requirement: updated }))
    })

    socket.on('req:status', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; status?: unknown }
      const req = await store.getRequirement(int(d.id))
      if (!req) return ack(fail('需求不存在'))
      const status = str(d.status, 32) as RequirementStatus
      if (!REQ_STATUS.includes(status)) return ack(fail('非法状态'))
      const role = await memberRoleOf(store, req.companyId, auth.id)
      if (!isAdmin(role) && req.handlerId !== auth.id) return ack(fail('仅管理员或处理人可流转'))
      const updated = await store.setRequirementStatus({ requirementId: req.id, status, userId: auth.id })
      ack(ok({ requirement: updated }))
    })

    socket.on('req:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const req = await store.getRequirement(int((data as { id?: unknown } | null)?.id))
      if (!req) return ack(fail('需求不存在'))
      if (!isAdmin(await memberRoleOf(store, req.companyId, auth.id))) return ack(fail('仅管理员可删除'))
      await store.deleteRequirement(req.id)
      ack(ok({ ok: true }))
    })

    socket.on('req:linkTasks', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; taskIds?: unknown }
      const req = await store.getRequirement(int(d.id))
      if (!req) return ack(fail('需求不存在'))
      if (!isAdmin(await memberRoleOf(store, req.companyId, auth.id))) return ack(fail('仅管理员可关联任务'))
      const taskIds = intArr(d.taskIds)
      const linked = await store.linkRequirementTasks({ requirementId: req.id, taskIds, userId: auth.id, companyId: req.companyId })
      ack(ok({ linkedTaskIds: linked }))
    })

    // ==================== 缺陷 ====================
    socket.on('bug:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const bugs = await store.listBugs(companyId, int(d.projectId) || undefined)
      ack(ok({ bugs }))
    })

    socket.on('bug:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown; requirementId?: unknown; title?: unknown; description?: unknown; severity?: unknown; priority?: unknown; handlerId?: unknown; foundVersion?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const title = str(d.title, 128)
      if (!title) return ack(fail('标题不能为空'))
      const bug = await store.createBug({
        companyId, projectId: int(d.projectId) || null, requirementId: int(d.requirementId) || null,
        title, description: str(d.description, 8000),
        severity: str(d.severity, 32) || undefined, priority: str(d.priority, 32) || undefined,
        handlerId: int(d.handlerId) || null, foundVersion: str(d.foundVersion, 64), creatorId: auth.id
      })
      ack(ok({ bug }))
    })

    socket.on('bug:update', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; title?: unknown; description?: unknown; severity?: unknown; priority?: unknown; handlerId?: unknown; foundVersion?: unknown }
      const bug = await store.getBug(int(d.id))
      if (!bug) return ack(fail('缺陷不存在'))
      if (!isAdmin(await memberRoleOf(store, bug.companyId, auth.id))) return ack(fail('仅管理员可编辑'))
      const updated = await store.updateBug({
        id: bug.id,
        title: d.title !== undefined ? str(d.title, 128) : undefined,
        description: d.description !== undefined ? str(d.description, 8000) : undefined,
        severity: d.severity !== undefined ? str(d.severity, 32) : undefined,
        priority: d.priority !== undefined ? str(d.priority, 32) : undefined,
        handlerId: d.handlerId !== undefined ? int(d.handlerId) || null : undefined,
        foundVersion: d.foundVersion !== undefined ? str(d.foundVersion, 64) : undefined
      })
      ack(ok({ bug: updated }))
    })

    socket.on('bug:status', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; status?: unknown }
      const bug = await store.getBug(int(d.id))
      if (!bug) return ack(fail('缺陷不存在'))
      const status = str(d.status, 32) as BugStatus
      if (!BUG_STATUS.includes(status)) return ack(fail('非法状态'))
      const role = await memberRoleOf(store, bug.companyId, auth.id)
      if (!isAdmin(role) && bug.handlerId !== auth.id) return ack(fail('仅管理员或处理人可流转'))
      const updated = await store.setBugStatus({ bugId: bug.id, status, userId: auth.id })
      ack(ok({ bug: updated }))
    })

    socket.on('bug:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const bug = await store.getBug(int((data as { id?: unknown } | null)?.id))
      if (!bug) return ack(fail('缺陷不存在'))
      if (!isAdmin(await memberRoleOf(store, bug.companyId, auth.id))) return ack(fail('仅管理员可删除'))
      await store.deleteBug(bug.id)
      ack(ok({ ok: true }))
    })

    // ==================== 计划 ====================
    socket.on('plan:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const plans = await store.listPlans(companyId, int(d.projectId) || undefined)
      ack(ok({ plans }))
    })

    socket.on('plan:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown; name?: unknown; description?: unknown; startTime?: unknown; dueTime?: unknown }
      const companyId = int(d.companyId)
      const role = await guardCompany(store, companyId, socket, ack)
      if (!role) return
      if (!isAdmin(role)) return ack(fail('仅管理员可创建计划'))
      const name = str(d.name, 128)
      if (!name) return ack(fail('计划名称不能为空'))
      const st = toIsoStr(d.startTime), dt = toIsoStr(d.dueTime)
      if (!st || !dt) return ack(fail('请填写开始与结束时间'))
      if (Date.parse(dt) < Date.parse(st)) return ack(fail('结束时间不能早于开始'))
      const plan = await store.createPlan({ companyId, projectId: int(d.projectId) || null, name, description: str(d.description, 8000), startTime: st, dueTime: dt, creatorId: auth.id })
      ack(ok({ plan }))
    })

    socket.on('plan:update', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; name?: unknown; description?: unknown; startTime?: unknown; dueTime?: unknown; status?: unknown }
      const planId = int(d.id)
      // 直接校验：通过 store 无法按 id 取 plan，改为先取公司全部再做归属校验不现实；
      // 计划本身带 companyId，此处用 create 时的归属简化：仅管理员可改，取数时按 id 过滤。
      const all = await store.listPlans(0)
      const target = all.find((p) => p.id === planId)
      if (!target) return ack(fail('计划不存在'))
      if (!isAdmin(await memberRoleOf(store, target.companyId, auth.id))) return ack(fail('仅管理员可编辑'))
      const updated = await store.updatePlan({
        id: planId,
        name: d.name !== undefined ? str(d.name, 128) : undefined,
        description: d.description !== undefined ? str(d.description, 8000) : undefined,
        startTime: d.startTime !== undefined ? toIsoStr(d.startTime) || undefined : undefined,
        dueTime: d.dueTime !== undefined ? toIsoStr(d.dueTime) || undefined : undefined,
        status: d.status !== undefined ? str(d.status, 32) : undefined
      })
      ack(ok({ plan: updated }))
    })

    socket.on('plan:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const planId = int((data as { id?: unknown } | null)?.id)
      const all = await store.listPlans(0)
      const target = all.find((p) => p.id === planId)
      if (!target) return ack(fail('计划不存在'))
      if (!isAdmin(await memberRoleOf(store, target.companyId, auth.id))) return ack(fail('仅管理员可删除'))
      await store.deletePlan(planId)
      ack(ok({ ok: true }))
    })

    // ==================== 文档 ====================
    socket.on('doc:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const docs = await store.listDocuments(companyId, int(d.projectId) || undefined)
      ack(ok({ docs }))
    })

    socket.on('doc:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown; title?: unknown; content?: unknown }
      const companyId = int(d.companyId)
      const role = await guardCompany(store, companyId, socket, ack)
      if (!role) return
      const title = str(d.title, 128)
      if (!title) return ack(fail('标题不能为空'))
      const doc = await store.createDocument({ companyId, projectId: int(d.projectId) || null, title, content: str(d.content, 100000), creatorId: auth.id })
      ack(ok({ doc }))
    })

    socket.on('doc:update', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; title?: unknown; content?: unknown }
      const docId = int(d.id)
      const docs = await store.listDocuments(0)
      const target = docs.find((x) => x.id === docId)
      if (!target) return ack(fail('文档不存在'))
      if (!isAdmin(await memberRoleOf(store, target.companyId, auth.id))) return ack(fail('仅管理员可编辑'))
      const updated = await store.updateDocument({ id: docId, title: d.title !== undefined ? str(d.title, 128) : undefined, content: d.content !== undefined ? str(d.content, 100000) : undefined })
      ack(ok({ doc: updated }))
    })

    socket.on('doc:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const docId = int((data as { id?: unknown } | null)?.id)
      const docs = await store.listDocuments(0)
      const target = docs.find((x) => x.id === docId)
      if (!target) return ack(fail('文档不存在'))
      if (!isAdmin(await memberRoleOf(store, target.companyId, auth.id))) return ack(fail('仅管理员可删除'))
      await store.deleteDocument(docId)
      ack(ok({ ok: true }))
    })

    // ==================== Wiki ====================
    socket.on('wiki:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const pages = await store.listWikiPages(companyId, int(d.projectId) || undefined)
      ack(ok({ pages }))
    })

    socket.on('wiki:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown; title?: unknown; content?: unknown }
      const companyId = int(d.companyId)
      const role = await guardCompany(store, companyId, socket, ack)
      if (!role) return
      const title = str(d.title, 128)
      if (!title) return ack(fail('标题不能为空'))
      const page = await store.createWikiPage({ companyId, projectId: int(d.projectId) || null, title, content: str(d.content, 100000), creatorId: auth.id })
      ack(ok({ page }))
    })

    socket.on('wiki:update', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; title?: unknown; content?: unknown }
      const wikiId = int(d.id)
      const pages = await store.listWikiPages(0)
      const target = pages.find((x) => x.id === wikiId)
      if (!target) return ack(fail('Wiki 页面不存在'))
      if (!isAdmin(await memberRoleOf(store, target.companyId, auth.id))) return ack(fail('仅管理员可编辑'))
      const updated = await store.updateWikiPage({ id: wikiId, title: d.title !== undefined ? str(d.title, 128) : undefined, content: d.content !== undefined ? str(d.content, 100000) : undefined })
      ack(ok({ page: updated }))
    })

    socket.on('wiki:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const wikiId = int((data as { id?: unknown } | null)?.id)
      const pages = await store.listWikiPages(0)
      const target = pages.find((x) => x.id === wikiId)
      if (!target) return ack(fail('Wiki 页面不存在'))
      if (!isAdmin(await memberRoleOf(store, target.companyId, auth.id))) return ack(fail('仅管理员可删除'))
      await store.deleteWikiPage(wikiId)
      ack(ok({ ok: true }))
    })

    // ==================== 仪表盘 + 成员跟踪 ====================
    socket.on('pm:dashboard', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const stats = await store.dashboardStats(companyId, int(d.projectId) || undefined)
      ack(ok({ stats }))
    })

    socket.on('pm:memberTracking', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      if (!(await guardCompany(store, companyId, socket, ack))) return
      const members = await store.memberTracking(companyId, int(d.projectId) || undefined)
      ack(ok({ members }))
    })
  })
}
