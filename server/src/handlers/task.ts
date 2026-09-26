import type { Socket } from 'socket.io'
import { ok, fail } from '../util'
import type { Ctx } from './auth'
import type { Store } from '../db/store'
import type { TaskStatus, ProjectRole, AssignmentStatus, CompanyRole } from '../types'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): { id: number } | null {
  return socket.data.auth ? (socket.data.auth as { id: number }) : null
}

const TASK_STATUSES: TaskStatus[] = ['created', 'in_progress', 'completed', 'pending_extension', 'extended', 'overdue']
const PROJ_ROLES: ProjectRole[] = ['pm', 'leader', 'member']
const ASSIGN_STATUSES: AssignmentStatus[] = ['created', 'in_progress', 'completed']

async function memberRoleOf(store: Store, companyId: number, userId: number): Promise<CompanyRole | null> {
  if (!companyId || companyId <= 0) return null
  return store.getMemberRole(companyId, userId)
}

async function isCompanyAdmin(store: Store, companyId: number, userId: number): Promise<boolean> {
  const role = await memberRoleOf(store, companyId, userId)
  return role === 'owner' || role === 'admin'
}

async function isProjectManager(store: Store, projectId: number | null | undefined, userId: number): Promise<boolean> {
  if (!projectId || projectId <= 0) return false
  const members = await store.listProjectMembers(projectId)
  const me = members.find((m) => m.userId === userId)
  return !!me && (me.role === 'pm' || me.role === 'leader')
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

export function registerTaskHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ==================== 项目 ====================
    socket.on('task:projectList', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const companyId = int((data as { companyId?: unknown } | null)?.companyId)
      if (!(await memberRoleOf(store, companyId, auth.id))) return ack(fail('非本公司成员'))
      const projects = await store.listProjects(companyId)
      ack(ok({ projects }))
    })

    socket.on('task:projectCreate', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; name?: unknown }
      const companyId = int(d.companyId)
      const name = str(d.name, 64)
      if (!(await isCompanyAdmin(store, companyId, auth.id))) return ack(fail('无权限：仅公司 owner/admin 可创建项目'))
      if (!name) return ack(fail('项目名称不能为空'))
      const project = await store.createProject({ companyId, name, pmId: auth.id })
      io.emit('task:projectsUpdated', { companyId })
      ack(ok({ project }))
    })

    socket.on('task:projectDelete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      const projectId = int(d.projectId)
      if (!(await memberRoleOf(store, companyId, auth.id))) return ack(fail('非本公司成员'))
      const project = (await store.listProjects(companyId)).find((p) => p.id === projectId)
      if (!project) return ack(fail('项目不存在'))
      if (!(await isCompanyAdmin(store, companyId, auth.id)) && project.pmId !== auth.id) return ack(fail('无权限：仅公司管理员或 PM 可删除项目'))
      await store.deleteProject(projectId)
      io.emit('task:projectsUpdated', { companyId })
      ack(ok())
    })

    socket.on('task:projectSetRole', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown; userId?: unknown; role?: unknown }
      const companyId = int(d.companyId)
      const projectId = int(d.projectId)
      const userId = int(d.userId)
      const role = str(d.role, 16) as ProjectRole
      if (!(await memberRoleOf(store, companyId, auth.id))) return ack(fail('非本公司成员'))
      const project = (await store.listProjects(companyId)).find((p) => p.id === projectId)
      if (!project) return ack(fail('项目不存在'))
      if (project.pmId !== auth.id) return ack(fail('无权限：仅 PM 可下放组长权限'))
      if (!PROJ_ROLES.includes(role)) return ack(fail('角色不合法'))
      await store.setProjectRole(projectId, userId, role)
      io.emit('task:projectsUpdated', { companyId })
      ack(ok())
    })

    socket.on('task:projectMembers', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const projectId = int((data as { projectId?: unknown } | null)?.projectId)
      const members = await store.listProjectMembers(projectId)
      ack(ok({ members }))
    })

    // ==================== 任务 ====================
    socket.on('task:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; projectId?: unknown }
      const companyId = int(d.companyId)
      const projectId = d.projectId ? int(d.projectId) : null
      if (!(await memberRoleOf(store, companyId, auth.id))) return ack(fail('非本公司成员'))
      const tasks = await store.listTasks(companyId, projectId)
      ack(ok({ tasks }))
    })

    socket.on('task:detail', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const taskId = int((data as { taskId?: unknown } | null)?.taskId)
      const detail = await store.getTaskDetail(taskId)
      if (!detail) return ack(fail('任务不存在'))
      const role = await memberRoleOf(store, detail.task.companyId, auth.id)
      if (!role) return ack(fail('非本公司成员'))
      ack(ok({ detail }))
    })

    socket.on('task:create', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as {
        companyId?: unknown; projectId?: unknown; title?: unknown; description?: unknown
        startTime?: unknown; dueTime?: unknown; images?: unknown; assignments?: unknown
      }
      const companyId = int(d.companyId)
      const projectId = d.projectId ? int(d.projectId) : null
      const title = str(d.title, 128)
      const description = typeof d.description === 'string' ? d.description.trim().slice(0, 2000) : ''
      const startTime = toIsoStr(d.startTime)
      const dueTime = toIsoStr(d.dueTime)
      const images = Array.isArray(d.images) ? (d.images.filter((x): x is string => typeof x === 'string').slice(0, 9)) : []
      if (!(await memberRoleOf(store, companyId, auth.id))) return ack(fail('非本公司成员'))
      const admin = await isCompanyAdmin(store, companyId, auth.id)
      const pm = await isProjectManager(store, projectId, auth.id)
      if (!admin && !pm) return ack(fail('无权限：仅公司管理员或项目 PM/组长可创建任务'))
      if (!title) return ack(fail('任务名称不能为空'))
      if (!startTime || !dueTime) return ack(fail('开始/预期结束时间不能为空'))
      if (Date.parse(dueTime) < Date.parse(startTime)) return ack(fail('预期结束时间不能早于开始时间'))
      try {
        const task = await store.createTask({ companyId, projectId, title, description, startTime, dueTime, images, createdBy: auth.id })
        if (Array.isArray(d.assignments)) {
          for (const a of d.assignments) {
            const o = (a ?? {}) as { userId?: unknown; content?: unknown }
            const u = int(o.userId)
            if (u > 0) await store.addAssignment({ taskId: task.id, userId: u, content: typeof o.content === 'string' ? o.content.trim().slice(0, 500) : '' })
          }
        }
        io.emit('task:tasksUpdated', { companyId })
        ack(ok({ task }))
      } catch (e) {
        console.error('[task:create] error:', e)
        ack(fail(e instanceof Error ? e.message : String(e)))
      }
    })

    socket.on('task:update', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; title?: unknown; description?: unknown; startTime?: unknown; dueTime?: unknown; images?: unknown }
      const taskId = int(d.taskId)
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      if (!(await memberRoleOf(store, t.companyId, auth.id))) return ack(fail('非本公司成员'))
      const admin = await isCompanyAdmin(store, t.companyId, auth.id)
      const pm = await isProjectManager(store, t.projectId, auth.id)
      if (!admin && !pm && t.createdBy !== auth.id) return ack(fail('无权限'))
      const v: Record<string, unknown> = {}
      if (d.title !== undefined) v.title = str(d.title, 128)
      if (d.description !== undefined) v.description = typeof d.description === 'string' ? d.description.trim().slice(0, 2000) : ''
      if (d.startTime !== undefined) v.startTime = toIsoStr(d.startTime)
      if (d.dueTime !== undefined) v.dueTime = toIsoStr(d.dueTime)
      if (Array.isArray(d.images)) v.images = d.images.filter((x): x is string => typeof x === 'string').slice(0, 9)
      if (Object.keys(v).length === 0) return ack(fail('无变更'))
      if (v.startTime === '' || v.dueTime === '') return ack(fail('时间不能为空'))
      const task = await store.updateTask({ id: taskId, ...v })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ task }))
    })

    socket.on('task:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const taskId = int((data as { taskId?: unknown } | null)?.taskId)
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      const admin = await isCompanyAdmin(store, t.companyId, auth.id)
      const pm = await isProjectManager(store, t.projectId, auth.id)
      if (!admin && !pm) return ack(fail('无权限：仅公司管理员或项目 PM/组长可删除任务'))
      await store.deleteTask(taskId)
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok())
    })

    socket.on('task:setStatus', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; status?: unknown; note?: unknown }
      const taskId = int(d.taskId)
      const status = str(d.status, 32) as TaskStatus
      const note = typeof d.note === 'string' ? d.note.trim().slice(0, 500) : ''
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      if (!(await memberRoleOf(store, t.companyId, auth.id))) return ack(fail('非本公司成员'))
      if (!TASK_STATUSES.includes(status)) return ack(fail('状态不合法'))
      if (!note) return ack(fail('流转需填写说明'))
      // 状态流转按顺序：只允许合法的相邻流转
      const TRANSITIONS: Record<string, string[]> = {
        created: ['in_progress', 'completed', 'pending_extension'],
        in_progress: ['completed', 'pending_extension'],
        completed: [],
        pending_extension: ['extended', 'in_progress'],
        extended: ['in_progress', 'completed'],
        overdue: ['in_progress', 'completed', 'pending_extension']
      }
      if (!TRANSITIONS[t.status as string]?.includes(status)) return ack(fail(`不可从「${t.status}」流转到「${status}」`))
      const task = await store.setTaskStatus({ taskId, status, userId: auth.id, note })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ task }))
    })

    socket.on('task:setReminder', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; reminderYellow?: unknown; reminderRed?: unknown }
      const taskId = int(d.taskId)
      const reminderYellow = int(d.reminderYellow)
      const reminderRed = int(d.reminderRed)
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      if (!(await memberRoleOf(store, t.companyId, auth.id))) return ack(fail('非本公司成员'))
      const admin = await isCompanyAdmin(store, t.companyId, auth.id)
      const pm = await isProjectManager(store, t.projectId, auth.id)
      if (!admin && !pm && t.createdBy !== auth.id) return ack(fail('无权限'))
      if (reminderRed > reminderYellow) return ack(fail('红色提醒阈值不能大于黄色'))
      const task = await store.updateTaskReminder({ taskId, reminderYellow, reminderRed })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ task }))
    })

    // ==================== 分配（执行人） ====================
    socket.on('task:addAssignment', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; userId?: unknown; content?: unknown }
      const taskId = int(d.taskId)
      const userId = int(d.userId)
      const content = typeof d.content === 'string' ? d.content.trim().slice(0, 500) : ''
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      const admin = await isCompanyAdmin(store, t.companyId, auth.id)
      const pm = await isProjectManager(store, t.projectId, auth.id)
      if (!admin && !pm && t.createdBy !== auth.id) return ack(fail('无权限'))
      if (userId <= 0) return ack(fail('执行人不能为空'))
      const assignment = await store.addAssignment({ taskId, userId, content })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ assignment }))
    })

    socket.on('task:removeAssignment', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const id = int((data as { id?: unknown } | null)?.id)
      await store.removeAssignment(id)
      ack(ok())
    })

    socket.on('task:setAssignmentStatus', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { id?: unknown; status?: unknown }
      const id = int(d.id)
      const status = str(d.status, 32) as AssignmentStatus
      if (!ASSIGN_STATUSES.includes(status)) return ack(fail('状态不合法'))
      const assignment = await store.setAssignmentStatus({ id, status, userId: auth.id })
      if (!assignment) return ack(fail('仅本人可提交分配状态'))
      ack(ok({ assignment }))
    })

    // ==================== 留言 ====================
    socket.on('task:comment', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; content?: unknown; images?: unknown }
      const taskId = int(d.taskId)
      const content = typeof d.content === 'string' ? d.content.trim().slice(0, 1000) : ''
      const images = Array.isArray(d.images) ? d.images.filter((x): x is string => typeof x === 'string').slice(0, 9) : []
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      if (!(await memberRoleOf(store, t.companyId, auth.id))) return ack(fail('非本公司成员'))
      if (!content && images.length === 0) return ack(fail('留言不能为空'))
      const comment = await store.addTaskComment({ taskId, userId: auth.id, content, images })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ comment }))
    })

    // ==================== 问题（QA） ====================
    socket.on('task:addIssue', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; title?: unknown; content?: unknown }
      const taskId = int(d.taskId)
      const title = str(d.title, 128)
      const content = typeof d.content === 'string' ? d.content.trim().slice(0, 1000) : ''
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      if (!(await memberRoleOf(store, t.companyId, auth.id))) return ack(fail('非本公司成员'))
      if (!title) return ack(fail('问题标题不能为空'))
      const issue = await store.addTaskIssue({ taskId, userId: auth.id, title, content })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ issue }))
    })

    socket.on('task:resolveIssue', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const issueId = int((data as { issueId?: unknown } | null)?.issueId)
      const issue = await store.resolveTaskIssue(issueId)
      if (!issue) return ack(fail('问题不存在'))
      ack(ok({ issue }))
    })

    // ==================== 延期 ====================
    socket.on('task:requestExtension', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { taskId?: unknown; requestedDueTime?: unknown; reason?: unknown }
      const taskId = int(d.taskId)
      const requestedDueTime = toIsoStr(d.requestedDueTime)
      const reason = typeof d.reason === 'string' ? d.reason.trim().slice(0, 500) : ''
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      if (!(await memberRoleOf(store, t.companyId, auth.id))) return ack(fail('非本公司成员'))
      if (!requestedDueTime) return ack(fail('新截止时间不能为空'))
      if (!reason) return ack(fail('请填写延期原因'))
      const extension = await store.requestTaskExtension({ taskId, userId: auth.id, requestedDueTime, reason })
      io.emit('task:tasksUpdated', { companyId: t.companyId })
      ack(ok({ extension }))
    })

    socket.on('task:decideExtension', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { companyId?: unknown; taskId?: unknown; extensionId?: unknown; approved?: unknown }
      const companyId = int(d.companyId)
      const taskId = int(d.taskId)
      const extensionId = int(d.extensionId)
      const approved = Boolean(d.approved)
      if (!(await memberRoleOf(store, companyId, auth.id))) return ack(fail('非本公司成员'))
      const t = await store.getTask(taskId)
      if (!t) return ack(fail('任务不存在'))
      const admin = await isCompanyAdmin(store, companyId, auth.id)
      const pm = await isProjectManager(store, t.projectId, auth.id)
      if (!admin && !pm) return ack(fail('无权限：仅公司管理员或项目 PM/组长可审批'))
      const extension = await store.decideTaskExtension({ extensionId, approved, decidedBy: auth.id })
      if (!extension) return ack(fail('延期申请不存在'))
      io.emit('task:tasksUpdated', { companyId })
      ack(ok({ extension }))
    })
  })
}
