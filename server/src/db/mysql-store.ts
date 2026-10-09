import { Op, Sequelize, UniqueConstraintError } from 'sequelize'
import type {
  ChatMessage,
  ChatKind,
  Company,
  CompanyInvitation,
  CompanyRole,
  Conversation,
  ConversationItem,
  ConversationMember,
  ConversationType,
  Department,
  DepartmentMember,
  FileRecord,
  Friend,
  Group,
  GroupMember,
  GroupRole,
  Holiday,
  HolidayType,
  InvitationStatus,
  Member,
  MailConfig,
  MemberProfile,
  Membership,
  Session,
  User,
  Project,
  ProjectMember,
  ProjectRole,
  TaskItem,
  TaskAssignment,
  TaskComment,
  TaskAttachment,
  TaskIssue,
  TaskStatusLog,
  TaskExtension,
  TaskStatus,
  AssignmentStatus,
  IssueStatus,
  ExtensionStatus,
  TaskDetail,
  Requirement,
  RequirementStatus,
  RequirementPriority,
  RequirementCategory,
  Bug,
  BugStatus,
  BugSeverity,
  BugPriority,
  Plan,
  PlanStatus,
  ProjectDocument,
  WikiPage,
  DashboardStats,
  MemberTrackItem
} from '../types'
import { AlreadyExistsError, NotFoundError, type Store, type UserWithPassword } from './store'
import {
  CompanyInvitationModel,
  CompanyMemberModel,
  CompanyModel,
  ConversationMemberModel,
  ConversationModel,
  DepartmentMemberModel,
  DepartmentModel,
  FileModel,
  FriendModel,
  GroupMemberModel,
  GroupModel,
  HolidayModel,
  MailConfigModel,
  MemberProfileModel,
  MessageModel,
  ProjectMemberModel,
  ProjectModel,
  SessionModel,
  TaskAssignmentModel,
  TaskCommentModel,
  TaskExtensionModel,
  TaskIssueModel,
  TaskModel,
  TaskStatusLogModel,
  RequirementModel,
  BugModel,
  PlanModel,
  ProjectDocumentModel,
  WikiPageModel,
  RequirementLinkModel,
  UserModel,
  initModels
} from './models'

export interface MySqlStoreOptions {
  host: string
  port: number
  user: string
  password: string
  database: string
  /** 是否启动时自动建表（sequelize.sync）；默认 true */
  autoSchema?: boolean
}

const toIso = (v: unknown): string => {
  const d = new Date(v as string | number | Date)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

const parseAttachments = (raw: unknown): TaskAttachment[] => {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.slice(0, 9).map((x): TaskAttachment | null => {
      if (typeof x === 'string') return { kind: 'image', url: x, name: '' }
      const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
      const url = typeof o.url === 'string' && o.url.trim() ? o.url.trim() : ''
      if (!url) return null
      const kind = ['image', 'video', 'audio', 'folder', 'file'].includes(String(o.kind)) ? (String(o.kind) as TaskAttachment['kind']) : 'file'
      return { kind, url, name: typeof o.name === 'string' ? o.name.slice(0, 255) : '' }
    }).filter((x): x is TaskAttachment => x !== null)
  } catch { return [] }
}

const toUser = (m: UserModel): User => ({
  id: Number(m.id),
  username: m.username,
  nick: m.nick,
  avatar: m.avatar,
  email: m.email,
  phone: m.phone ?? '',
  extra: m.extra ?? '',
  sessionDays: m.sessionDays === null ? null : Number(m.sessionDays),
  createdAt: toIso(m.createdAt)
})

const toSession = (m: SessionModel): Session => ({
  id: Number(m.id),
  userId: Number(m.userId),
  tokenHash: m.tokenHash,
  device: m.device,
  ip: m.ip,
  location: m.location ?? '',
  createdAt: toIso(m.createdAt),
  expiresAt: toIso(m.expiresAt),
  lastActiveAt: toIso(m.lastActiveAt)
})

const toCompany = (m: CompanyModel): Company => ({
  id: Number(m.id),
  name: m.name,
  code: m.code,
  ownerId: Number(m.ownerId),
  createdAt: toIso(m.createdAt)
})

const toDepartment = (m: DepartmentModel): Department => ({
  id: Number(m.id),
  companyId: Number(m.companyId),
  name: m.name,
  parentId: m.parentId === null ? null : Number(m.parentId),
  createdAt: toIso(m.createdAt)
})

const toGroup = (m: GroupModel): Group => ({
  id: Number(m.id),
  companyId: m.companyId === null ? 0 : Number(m.companyId), // NULL(无公司)→0
  departmentId: m.departmentId === null ? null : Number(m.departmentId),
  name: m.name,
  code: m.code,
  ownerId: Number(m.ownerId),
  createdAt: toIso(m.createdAt)
})

const toConversation = (m: ConversationModel): Conversation => ({
  id: Number(m.id),
  type: m.type as ConversationType,
  groupId: m.groupId === null ? null : Number(m.groupId),
  dmUserA: m.dmUserA === null ? null : Number(m.dmUserA),
  dmUserB: m.dmUserB === null ? null : Number(m.dmUserB),
  createdAt: toIso(m.createdAt)
})

const toMessage = (m: MessageModel, type: ConversationType): ChatMessage => ({
  id: String(m.id),
  conversationId: Number(m.conversationId),
  type,
  fromId: Number(m.fromId),
  nick: '',
  kind: m.kind as ChatKind,
  content: m.content,
  ts: new Date(m.createdAt).getTime()
})

const isUnique = (err: unknown): boolean => err instanceof UniqueConstraintError

export class MySqlStore implements Store {
  private sequelize: Sequelize

  constructor(private readonly opts: MySqlStoreOptions) {
    this.sequelize = new Sequelize({
      database: opts.database,
      username: opts.user,
      password: opts.password,
      host: opts.host,
      port: opts.port,
      dialect: 'mysql',
      logging: false,
      pool: { max: 10, min: 0 },
      define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
    })
    initModels(this.sequelize)
  }

  async init(): Promise<void> {
    // 自动建库（先连到服务器，不带 database）
    const admin = new Sequelize({
      database: '',
      username: this.opts.user,
      password: this.opts.password,
      host: this.opts.host,
      port: this.opts.port,
      dialect: 'mysql',
      logging: false
    })
    try {
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${this.opts.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      )
    } finally {
      await admin.close()
    }
    await this.sequelize.authenticate()
    if (this.opts.autoSchema ?? true) {
      // 由 ORM 模型自动建表，无手写 SQL
      await this.sequelize.sync()
      // 已读回执：为已存在的 conversation_members 补 last_read_message_id 列（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，先查列再补，幂等兼容老库）
      const [infoRows] = (await this.sequelize.query(
        "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation_members' AND COLUMN_NAME = 'last_read_message_id'"
      )) as [Array<{ c: number }>, unknown]
      const colExists = Array.isArray(infoRows) && infoRows.length > 0 && Number(infoRows[0]?.c) > 0
      if (!colExists) {
        await this.sequelize.query('ALTER TABLE `conversation_members` ADD COLUMN `last_read_message_id` BIGINT UNSIGNED NULL AFTER `unread`')
      }
    }
  }

  async close(): Promise<void> {
    await this.sequelize.close()
  }

  // ---- 用户 ----
  async createUser(input: { username: string; passwordHash: string; nick?: string; email?: string; avatar?: string; phone?: string }): Promise<User> {
    const m = await UserModel.create({
      username: input.username,
      passwordHash: input.passwordHash,
      nick: input.nick ?? '',
      email: input.email ?? '',
      avatar: input.avatar ?? '',
      phone: input.phone ?? '',
      extra: null
    })
    return toUser(m)
  }

  async getUserByUsername(username: string): Promise<UserWithPassword | null> {
    const m = await UserModel.findOne({ where: { username } })
    return m ? { ...toUser(m), passwordHash: m.passwordHash } : null
  }

  async getUserByEmail(email: string): Promise<UserWithPassword | null> {
    const m = await UserModel.findOne({ where: { email } })
    return m ? { ...toUser(m), passwordHash: m.passwordHash } : null
  }

  async getUserById(id: number): Promise<User | null> {
    const m = await UserModel.findByPk(id)
    return m ? toUser(m) : null
  }

  async updateUserProfile(userId: number, patch: { nick?: string; avatar?: string; phone?: string; email?: string; extra?: string }): Promise<void> {
    const fields: Record<string, string | null> = {}
    if (patch.nick !== undefined) fields.nick = patch.nick
    if (patch.avatar !== undefined) fields.avatar = patch.avatar
    if (patch.phone !== undefined) fields.phone = patch.phone
    if (patch.email !== undefined) fields.email = patch.email
    if (patch.extra !== undefined) fields.extra = patch.extra
    if (Object.keys(fields).length === 0) return
    await UserModel.update(fields, { where: { id: userId } })
  }

  async updateUserPassword(userId: number, passwordHash: string): Promise<void> {
    await UserModel.update({ passwordHash }, { where: { id: userId } })
  }

  async listUsers(): Promise<User[]> {
    const rows = await UserModel.findAll({ order: [['id', 'ASC']] })
    return rows.map(toUser)
  }


  // ---- 公司 ----
  async createCompany(input: { name: string; code: string; ownerId: number }): Promise<Company> {
    const m = await CompanyModel.create({ name: input.name, code: input.code, ownerId: input.ownerId })
    await CompanyMemberModel.create({ companyId: m.id, userId: input.ownerId, role: 'owner' })
    return toCompany(m)
  }

  async getCompanyById(id: number): Promise<Company | null> {
    const m = await CompanyModel.findByPk(id)
    return m ? toCompany(m) : null
  }

  async getCompanyByName(name: string): Promise<Company | null> {
    const m = await CompanyModel.findOne({ where: { name } })
    return m ? toCompany(m) : null
  }

  async getCompanyByCode(code: string): Promise<Company | null> {
    const m = await CompanyModel.findOne({ where: { code } })
    return m ? toCompany(m) : null
  }

  async listCompanies(keyword?: string): Promise<Company[]> {
    const where = keyword && keyword.trim().length > 0 ? { name: { [Op.like]: `%${keyword.trim()}%` } } : {}
    const rows = await CompanyModel.findAll({ where, order: [['id', 'ASC']], limit: 100 })
    return rows.map(toCompany)
  }

  async addMember(companyId: number, userId: number, role: CompanyRole): Promise<void> {
    try {
      await CompanyMemberModel.create({ companyId, userId, role })
    } catch (err) {
      if (isUnique(err)) throw new AlreadyExistsError('already a member')
      throw err
    }
  }

  async removeMember(companyId: number, userId: number): Promise<void> {
    const n = await CompanyMemberModel.destroy({ where: { companyId, userId } })
    if (n === 0) throw new NotFoundError('not a member')
  }

  async setRole(companyId: number, userId: number, role: CompanyRole): Promise<void> {
    const n = await CompanyMemberModel.update({ role }, { where: { companyId, userId } })
    if (n[0] === 0) throw new NotFoundError('not a member')
  }

  async getMemberRole(companyId: number, userId: number): Promise<CompanyRole | null> {
    const m = await CompanyMemberModel.findOne({ where: { companyId, userId } })
    return m ? (m.role as CompanyRole) : null
  }

  async getMembers(companyId: number): Promise<Member[]> {
    const rows = await CompanyMemberModel.findAll({
      where: { companyId },
      include: [{ model: UserModel }],
      order: [['joined_at', 'ASC']]
    })
    return rows.map((m) => {
      const u = (m as unknown as { user?: UserModel }).user
      return {
        companyId: Number(m.companyId),
        userId: Number(m.userId),
        role: m.role as CompanyRole,
        joinedAt: toIso(m.joinedAt),
        username: u?.username,
        nick: u?.nick
      }
    })
  }

  async getUserCompanies(userId: number): Promise<Membership[]> {
    const rows = await CompanyMemberModel.findAll({
      where: { userId },
      include: [{ model: CompanyModel }],
      order: [['company_id', 'ASC']]
    })
    const out: Membership[] = []
    for (const m of rows) {
      const c = (m as unknown as { company?: CompanyModel }).company
      if (c) out.push({ company: toCompany(c), role: m.role as CompanyRole })
    }
    return out
  }

  async renameCompany(companyId: number, name: string): Promise<void> {
    const n = await CompanyModel.update({ name }, { where: { id: companyId } })
    if (n[0] === 0) throw new NotFoundError('company not found')
  }

  async setCompanyOwner(companyId: number, ownerId: number): Promise<void> {
    const n = await CompanyModel.update({ ownerId }, { where: { id: companyId } })
    if (n[0] === 0) throw new NotFoundError('company not found')
  }

  async deleteCompany(companyId: number): Promise<void> {
    const groups = await GroupModel.findAll({ where: { companyId } })
    for (const g of groups) await this.deleteGroup(g.id)
    const deps = await DepartmentModel.findAll({ where: { companyId } })
    const depIds = deps.map((d) => d.id)
    if (depIds.length) await DepartmentMemberModel.destroy({ where: { departmentId: depIds } })
    await DepartmentModel.destroy({ where: { companyId } })
    await CompanyMemberModel.destroy({ where: { companyId } })
    await CompanyInvitationModel.destroy({ where: { companyId } })
    await CompanyModel.destroy({ where: { id: companyId } })
  }

  // ---- 部门 ----
  async createDepartment(input: { companyId: number; name: string; parentId?: number | null }): Promise<Department> {
    const m = await DepartmentModel.create({
      companyId: input.companyId,
      name: input.name,
      parentId: input.parentId ?? null
    })
    return toDepartment(m)
  }

  async getDepartmentById(id: number): Promise<Department | null> {
    const m = await DepartmentModel.findByPk(id)
    return m ? toDepartment(m) : null
  }

  async listDepartments(companyId: number): Promise<Department[]> {
    const rows = await DepartmentModel.findAll({ where: { companyId }, order: [['id', 'ASC']] })
    return rows.map(toDepartment)
  }

  async assignDepartment(departmentId: number, userId: number): Promise<void> {
    try {
      await DepartmentMemberModel.create({ departmentId, userId })
    } catch (err) {
      if (isUnique(err)) throw new AlreadyExistsError('already in department')
      throw err
    }
  }

  async removeDepartmentMember(departmentId: number, userId: number): Promise<void> {
    const n = await DepartmentMemberModel.destroy({ where: { departmentId, userId } })
    if (n === 0) throw new NotFoundError('not in department')
  }

  async getDepartmentMembers(departmentId: number): Promise<DepartmentMember[]> {
    const rows = await DepartmentMemberModel.findAll({
      where: { departmentId },
      include: [{ model: UserModel }],
      order: [['joined_at', 'ASC']]
    })
    return rows.map((m) => {
      const u = (m as unknown as { user?: UserModel }).user
      return {
        departmentId: Number(m.departmentId),
        userId: Number(m.userId),
        joinedAt: toIso(m.joinedAt),
        username: u?.username,
        nick: u?.nick
      }
    })
  }

  async deleteDepartment(departmentId: number): Promise<void> {
    await DepartmentMemberModel.destroy({ where: { departmentId } })
    const n = await DepartmentModel.destroy({ where: { id: departmentId } })
    if (n === 0) throw new NotFoundError('department not found')
  }

  // ---- 群 ----
  async createGroup(input: { companyId: number; departmentId?: number | null; name: string; code: string; ownerId: number }): Promise<Group> {
    const m = await GroupModel.create({
      companyId: input.companyId > 0 ? input.companyId : null, // 0=无公司(上级 company 为 0)，存 NULL 以过外键
      departmentId: input.departmentId ?? null,
      name: input.name,
      code: input.code,
      ownerId: input.ownerId
    })
    await GroupMemberModel.create({ groupId: m.id, userId: input.ownerId, role: 'owner' })
    return toGroup(m)
  }

  async getGroupById(id: number): Promise<Group | null> {
    const m = await GroupModel.findByPk(id)
    return m ? toGroup(m) : null
  }

  async getGroupByName(companyId: number, name: string): Promise<Group | null> {
    const cid = companyId > 0 ? companyId : null
    const m = await GroupModel.findOne({ where: { name, companyId: cid } })
    return m ? toGroup(m) : null
  }

  async getGroupByCode(code: string): Promise<Group | null> {
    const m = await GroupModel.findOne({ where: { code } })
    return m ? toGroup(m) : null
  }

  async listGroups(companyId?: number, keyword?: string): Promise<Group[]> {
    const where: Record<string, unknown> = {}
    if (companyId) where.companyId = companyId
    if (keyword && keyword.trim().length > 0) where.name = { [Op.like]: `%${keyword.trim()}%` }
    const rows = await GroupModel.findAll({ where, order: [['id', 'ASC']], limit: 100 })
    return rows.map(toGroup)
  }

  async addGroupMember(groupId: number, userId: number, role: GroupRole): Promise<void> {
    try {
      await GroupMemberModel.create({ groupId, userId, role })
    } catch (err) {
      if (isUnique(err)) throw new AlreadyExistsError('already in group')
      throw err
    }
  }

  async removeGroupMember(groupId: number, userId: number): Promise<void> {
    const n = await GroupMemberModel.destroy({ where: { groupId, userId } })
    if (n === 0) throw new NotFoundError('not in group')
  }

  async getGroupMemberRole(groupId: number, userId: number): Promise<GroupRole | null> {
    const m = await GroupMemberModel.findOne({ where: { groupId, userId } })
    return m ? (m.role as GroupRole) : null
  }

  async getGroupMember(groupId: number, userId: number): Promise<{ role: GroupRole; mutedUntil: Date | null } | null> {
    const m = await GroupMemberModel.findOne({ where: { groupId, userId } })
    return m ? { role: m.role as GroupRole, mutedUntil: m.mutedUntil ? new Date(m.mutedUntil) : null } : null
  }

  async setGroupMemberRole(groupId: number, userId: number, role: GroupRole): Promise<void> {
    await GroupMemberModel.update({ role }, { where: { groupId, userId } })
  }

  async setGroupMemberMuted(groupId: number, userId: number, mutedUntil: Date | null): Promise<void> {
    await GroupMemberModel.update({ mutedUntil }, { where: { groupId, userId } })
  }

  async setGroupOwner(groupId: number, ownerId: number): Promise<void> {
    const n = await GroupModel.update({ ownerId }, { where: { id: groupId } })
    if (n[0] === 0) throw new NotFoundError('group not found')
  }

  async deleteGroup(groupId: number): Promise<void> {
    const convs = await ConversationModel.findAll({ where: { type: 'group', groupId } })
    for (const c of convs) {
      await MessageModel.destroy({ where: { conversationId: c.id } })
      await ConversationMemberModel.destroy({ where: { conversationId: c.id } })
      await c.destroy()
    }
    await GroupMemberModel.destroy({ where: { groupId } })
    await GroupModel.destroy({ where: { id: groupId } })
  }

  async getGroupMembers(groupId: number): Promise<GroupMember[]> {
    const rows = await GroupMemberModel.findAll({
      where: { groupId },
      include: [{ model: UserModel }],
      order: [['joined_at', 'ASC']]
    })
    return rows.map((m) => {
      const u = (m as unknown as { user?: UserModel }).user
      return {
        groupId: Number(m.groupId),
        userId: Number(m.userId),
        role: m.role as GroupRole,
        joinedAt: toIso(m.joinedAt),
        mutedUntil: m.mutedUntil ? toIso(m.mutedUntil) : undefined,
        username: u?.username,
        nick: u?.nick
      }
    })
  }

  async getUserGroups(userId: number): Promise<Group[]> {
    const rows = await GroupMemberModel.findAll({
      where: { userId },
      include: [{ model: GroupModel }],
      order: [['group_id', 'ASC']]
    })
    return rows.map((m) => toGroup((m as unknown as { group: GroupModel }).group))
  }

  // ---- 对话（群聊 + 私信统一） ----
  private async conversationType(id: number): Promise<ConversationType> {
    const c = await ConversationModel.findByPk(id)
    return (c?.type as ConversationType) ?? 'group'
  }

  async getOrCreateGroupConversation(groupId: number, ownerId?: number): Promise<Conversation> {
    const existing = await ConversationModel.findOne({ where: { type: 'group', groupId } })
    if (existing) return toConversation(existing)
    const c = await ConversationModel.create({ type: 'group', groupId })
    if (ownerId) await this.addConversationMember(c.id, ownerId)
    return toConversation(c)
  }

  async getOrCreateDmConversation(a: number, b: number): Promise<Conversation> {
    const x = Math.min(a, b)
    const y = Math.max(a, b)
    const existing = await ConversationModel.findOne({ where: { type: 'dm', dmUserA: x, dmUserB: y } })
    if (existing) return toConversation(existing)
    const c = await ConversationModel.create({ type: 'dm', dmUserA: x, dmUserB: y })
    await this.addConversationMember(c.id, x)
    await this.addConversationMember(c.id, y)
    return toConversation(c)
  }

  async getConversationById(id: number): Promise<Conversation | null> {
    const m = await ConversationModel.findByPk(id)
    return m ? toConversation(m) : null
  }

  async addConversationMember(conversationId: number, userId: number): Promise<void> {
    try {
      await ConversationMemberModel.create({ conversationId, userId })
    } catch (err) {
      if (isUnique(err)) throw new AlreadyExistsError('already in conversation')
      throw err
    }
  }

  async removeConversationMember(conversationId: number, userId: number): Promise<void> {
    const n = await ConversationMemberModel.destroy({ where: { conversationId, userId } })
    if (n === 0) throw new NotFoundError('not in conversation')
  }

  async setConversationPinned(conversationId: number, userId: number, pinned: boolean): Promise<void> {
    const n = await ConversationMemberModel.update({ pinned }, { where: { conversationId, userId } })
    if (n[0] === 0) throw new NotFoundError('not in conversation')
  }

  async getConversationMember(conversationId: number, userId: number): Promise<ConversationMember | null> {
    const m = await ConversationMemberModel.findOne({ where: { conversationId, userId } })
    return m
      ? {
          conversationId: Number(m.conversationId),
          userId: Number(m.userId),
          pinned: m.pinned,
          lastMessageAt: m.lastMessageAt ? toIso(m.lastMessageAt) : null,
          lastPreview: m.lastPreview,
          unread: m.unread
        }
      : null
  }

  async listConversations(userId: number, type?: ConversationType): Promise<ConversationItem[]> {
    const whereC: Record<string, unknown> = {}
    if (type) whereC.type = type
    const rows = await ConversationMemberModel.findAll({
      where: { userId },
      include: [{ model: ConversationModel, where: whereC }],
      order: [
        ['pinned', 'DESC'],
        ['last_message_at', 'DESC']
      ]
    })
    const out: ConversationItem[] = []
    for (const m of rows) {
      const c = (m as unknown as { conversation?: ConversationModel }).conversation
      if (!c) continue
      let dmUserId: number | null = null
      if (c.type === 'dm') {
        dmUserId = Number(c.dmUserA === userId ? c.dmUserB : c.dmUserA)
      }
      out.push({
        conversationId: Number(m.conversationId),
        type: c.type as ConversationType,
        groupId: c.groupId === null ? null : Number(c.groupId),
        dmUserId,
        pinned: m.pinned,
        lastMessageAt: m.lastMessageAt ? toIso(m.lastMessageAt) : null,
        lastPreview: m.lastPreview,
        unread: m.unread,
        readReceipts: await this.getReadReceipts(Number(m.conversationId))
      })
    }
    return out
  }

  // ---- 消息 ----
  async saveMessage(input: { conversationId: number; fromId: number; kind: ChatKind; content: string }): Promise<ChatMessage> {
    const m = await MessageModel.create({
      conversationId: input.conversationId,
      fromId: input.fromId,
      kind: input.kind,
      content: input.content
    })
    const type = await this.conversationType(input.conversationId)
    return toMessage(m, type)
  }

  async listMessages(conversationId: number, beforeTs?: number, limit = 50): Promise<ChatMessage[]> {
    const where: Record<string, unknown> = { conversationId, deletedAt: null }
    if (beforeTs) where.createdAt = { [Op.lt]: new Date(beforeTs) }
    const rows = await MessageModel.findAll({ where, order: [['created_at', 'DESC']], limit })
    const type = await this.conversationType(conversationId)
    return rows.map((m) => toMessage(m, type))
  }

  async getMessage(conversationId: number, messageId: string): Promise<ChatMessage | null> {
    const m = await MessageModel.findOne({ where: { id: Number(messageId), conversationId } })
    if (!m) return null
    const type = await this.conversationType(conversationId)
    return toMessage(m, type)
  }

  async findOwnMessageByContent(conversationId: number, userId: number, content: string): Promise<ChatMessage | null> {
    const m = await MessageModel.findOne({ where: { conversationId, fromId: userId, content, deletedAt: null }, order: [['created_at', 'DESC']] })
    if (!m) return null
    const type = await this.conversationType(conversationId)
    return toMessage(m, type)
  }

  async findOwnMessageByContentGlobal(userId: number, content: string): Promise<ChatMessage | null> {
    const m = await MessageModel.findOne({ where: { fromId: userId, content, deletedAt: null }, order: [['created_at', 'DESC']] })
    if (!m) return null
    const type = await this.conversationType(Number(m.conversationId))
    return toMessage(m, type)
  }

  async softDeleteMessage(conversationId: number, messageId: string): Promise<boolean> {
    const n = await MessageModel.update({ deletedAt: new Date() }, { where: { id: Number(messageId), conversationId, deletedAt: null } })
    return n[0] > 0
  }

  async hardDeleteMessage(conversationId: number, messageId: string): Promise<boolean> {
    const n = await MessageModel.destroy({ where: { id: Number(messageId), conversationId } })
    return n > 0
  }

  async touchConversation(conversationId: number, userId: number, preview: string, fromId?: number): Promise<void> {
    const where: Record<string, unknown> = { conversationId, userId }
    const data: Record<string, unknown> = { lastMessageAt: new Date(), lastPreview: preview.slice(0, 200) }
    if (fromId !== undefined && fromId !== userId) data.unread = Sequelize.literal('unread + 1')
    await ConversationMemberModel.update(data, { where })
  }

  async markRead(conversationId: number, userId: number, lastReadMessageId?: number | null): Promise<void> {
    const data: Record<string, unknown> = { unread: 0 }
    if (lastReadMessageId !== null && lastReadMessageId !== undefined && lastReadMessageId > 0) data.lastReadMessageId = lastReadMessageId
    await ConversationMemberModel.update(data, { where: { conversationId, userId } })
  }

  async getReadReceipts(conversationId: number): Promise<{ userId: number; lastReadMessageId: number | null }[]> {
    const rows = await ConversationMemberModel.findAll({ where: { conversationId }, attributes: ['userId', 'lastReadMessageId'] })
    return rows.map((r) => ({ userId: Number(r.userId), lastReadMessageId: r.lastReadMessageId ? Number(r.lastReadMessageId) : null }))
  }

  // ---- 文件（UUID 表） ----
  async saveFile(input: { uuid: string; filename: string; mime: string; size: number; storage: 'local'; url: string }): Promise<FileRecord> {
    const m = await FileModel.create(input)
    return { uuid: m.uuid, filename: m.filename, mime: m.mime, size: Number(m.size), storage: m.storage, url: m.url, createdAt: toIso(m.createdAt) }
  }

  async getFileByUuid(uuid: string): Promise<FileRecord | null> {
    const m = await FileModel.findByPk(uuid)
    return m ? { uuid: m.uuid, filename: m.filename, mime: m.mime, size: Number(m.size), storage: m.storage, url: m.url, createdAt: toIso(m.createdAt) } : null
  }

  // ---- 好友（与公司无关） ----
  async addFriend(a: number, b: number): Promise<void> {
    const x = Math.min(a, b)
    const y = Math.max(a, b)
    try {
      await FriendModel.create({ userA: x, userB: y })
    } catch (err) {
      if (isUnique(err)) throw new AlreadyExistsError('already friends')
      throw err
    }
  }

  async removeFriend(a: number, b: number): Promise<void> {
    const x = Math.min(a, b)
    const y = Math.max(a, b)
    const n = await FriendModel.destroy({ where: { userA: x, userB: y } })
    if (n === 0) throw new NotFoundError('not friends')
  }

  async listFriends(userId: number): Promise<Friend[]> {
    const rows = await FriendModel.findAll({
      where: { [Op.or]: [{ userA: userId }, { userB: userId }] },
      order: [['created_at', 'ASC']]
    })
    const out: Friend[] = []
    for (const r of rows) {
      const other = Number(r.userA === userId ? r.userB : r.userA)
      const u = await this.getUserById(other)
      if (u) out.push({ userId: u.id, username: u.username, nick: u.nick || u.username, avatar: u.avatar, addedAt: toIso(r.createdAt) })
    }
    return out
  }

  // ---- 公司邀请（入职流程） ----
  private async toInvitation(m: CompanyInvitationModel): Promise<CompanyInvitation> {
    const company = await CompanyModel.findByPk(m.companyId)
    const user = await UserModel.findByPk(m.userId)
    const inviter = await UserModel.findByPk(m.invitedBy)
    let deptName: string | null = null
    if (m.departmentId) {
      const d = await DepartmentModel.findByPk(m.departmentId)
      deptName = d?.name ?? null
    }
    return {
      id: Number(m.id),
      companyId: Number(m.companyId),
      companyName: company?.name ?? '',
      companyCode: company?.code ?? '',
      userId: Number(m.userId),
      username: user?.username ?? '',
      userNick: user?.nick || user?.username || '',
      departmentId: m.departmentId === null ? null : Number(m.departmentId),
      departmentName: deptName,
      invitedBy: Number(m.invitedBy),
      inviterNick: inviter?.nick || inviter?.username || '',
      code: m.code,
      expiresAt: m.expiresAt ? toIso(m.expiresAt) : null,
      status: m.status as InvitationStatus,
      createdAt: toIso(m.createdAt)
    }
  }

  async createCompanyInvitation(input: { companyId: number; userId: number; departmentId?: number | null; invitedBy: number; code: string; expiresAt?: string | null }): Promise<CompanyInvitation> {
    const dup = await CompanyInvitationModel.findOne({
      where: { companyId: input.companyId, userId: input.userId, status: 'pending' }
    })
    if (dup) throw new AlreadyExistsError('invitation pending')
    const m = await CompanyInvitationModel.create({
      companyId: input.companyId,
      userId: input.userId,
      departmentId: input.departmentId ?? null,
      invitedBy: input.invitedBy,
      code: input.code,
      expiresAt: input.expiresAt ?? null
    })
    return this.toInvitation(m)
  }

  async getCompanyInvitationById(id: number): Promise<CompanyInvitation | null> {
    const m = await CompanyInvitationModel.findByPk(id)
    return m ? this.toInvitation(m) : null
  }

  async getCompanyInvitationByCode(code: string): Promise<CompanyInvitation | null> {
    const m = await CompanyInvitationModel.findOne({ where: { code } })
    return m ? this.toInvitation(m) : null
  }

  async listCompanyInvitations(companyId: number): Promise<CompanyInvitation[]> {
    const rows = await CompanyInvitationModel.findAll({
      where: { companyId },
      order: [['created_at', 'DESC']]
    })
    return Promise.all(rows.map((m) => this.toInvitation(m)))
  }

  async listPendingInvitationsForUser(userId: number): Promise<CompanyInvitation[]> {
    const rows = await CompanyInvitationModel.findAll({
      where: { userId, status: 'pending' },
      order: [['created_at', 'DESC']]
    })
    return Promise.all(rows.map((m) => this.toInvitation(m)))
  }

  async setCompanyInvitationStatus(id: number, status: InvitationStatus): Promise<void> {
    await CompanyInvitationModel.update({ status }, { where: { id } })
  }

  async getCompanyMainGroup(companyId: number): Promise<Group | null> {
    const company = await CompanyModel.findByPk(companyId)
    const groups = await this.listGroups(companyId)
    if (groups.length === 0) return null
    const suffix = '总群'
    const exact = groups.find((g) => g.name === `${company?.name ?? ''}${suffix}`)
    if (exact) return exact
    const suffixAny = groups.find((g) => g.name.endsWith(suffix))
    if (suffixAny) return suffixAny
    const owned = groups.find((g) => g.ownerId === Number(company?.ownerId ?? 0))
    return owned ?? null
  }

  // ---- 成员人事信息（绑定 用户×公司） ----
  private toProfile(m: MemberProfileModel): MemberProfile {
    return {
      companyId: Number(m.companyId),
      userId: Number(m.userId),
      realName: m.realName,
      idCard: m.idCard,
      bankCard: m.bankCard,
      resumeUrl: m.resumeUrl,
      portfolioUrl: m.portfolioUrl,
      updatedAt: toIso(m.updatedAt)
    }
  }

  async getMemberProfile(companyId: number, userId: number): Promise<MemberProfile | null> {
    const m = await MemberProfileModel.findOne({ where: { companyId, userId } })
    return m ? this.toProfile(m) : null
  }

  async upsertMemberProfile(companyId: number, userId: number, input: Partial<Omit<MemberProfile, 'companyId' | 'userId'>>): Promise<MemberProfile> {
    const base = await this.getMemberProfile(companyId, userId)
    const next = {
      realName: input.realName ?? base?.realName ?? '',
      idCard: input.idCard ?? base?.idCard ?? '',
      bankCard: input.bankCard ?? base?.bankCard ?? '',
      resumeUrl: input.resumeUrl ?? base?.resumeUrl ?? '',
      portfolioUrl: input.portfolioUrl ?? base?.portfolioUrl ?? ''
    }
    await MemberProfileModel.upsert({ companyId, userId, ...next })
    const m = await MemberProfileModel.findOne({ where: { companyId, userId } })
    return this.toProfile(m!)
  }

  // ---- 登录会话（多端） ----

  async createSession(input: { userId: number; tokenHash: string; device: string; ip: string; location?: string; expiresAt: string }): Promise<Session> {
    const m = await SessionModel.create({
      userId: input.userId,
      tokenHash: input.tokenHash,
      device: input.device,
      ip: input.ip,
      location: input.location ?? '',
      expiresAt: new Date(input.expiresAt)
    })
    return toSession(m)
  }

  async getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const m = await SessionModel.findOne({ where: { tokenHash } })
    return m ? toSession(m) : null
  }

  async listSessionsByUser(userId: number): Promise<Session[]> {
    const rows = await SessionModel.findAll({ where: { userId }, order: [['created_at', 'DESC']] })
    return rows.map(toSession)
  }

  async getUserActiveLocation(userId: number): Promise<string> {
    const rows = await SessionModel.findAll({ where: { userId }, order: [['last_active_at', 'DESC']] })
    for (const s of rows) {
      if (new Date(s.expiresAt).getTime() > Date.now()) return s.location ?? ''
    }
    return rows.length ? (rows[0].location ?? '') : ''
  }

  async touchSession(id: number): Promise<void> {
    await SessionModel.update({ lastActiveAt: new Date() }, { where: { id } })
  }

  async deleteSession(id: number): Promise<void> {
    await SessionModel.destroy({ where: { id } })
  }

  async deleteExpiredSessions(now: number): Promise<number> {
    return await SessionModel.destroy({ where: { expiresAt: { [Op.lt]: new Date(now) } } })
  }

  async getSessionDays(userId: number): Promise<number | null> {
    const u = await UserModel.findByPk(userId)
    return u?.sessionDays === null || u?.sessionDays === undefined ? null : Number(u.sessionDays)
  }

  async setSessionDays(userId: number, days: number | null): Promise<void> {
    await UserModel.update({ sessionDays: days }, { where: { id: userId } })
  }

  // ---- 邮件配置（SMTP 客户端：主/全局 MainMailConfig + 公司级预留） ----
  private toMailConfig(m: MailConfigModel): MailConfig {
    return {
      id: Number(m.id),
      companyId: m.companyId === null ? null : Number(m.companyId),
      email: m.email,
      displayName: m.displayName,
      host: m.host,
      port: Number(m.port),
      secure: m.secure,
      user: m.user,
      password: m.password,
      isDefault: m.isDefault,
      enabled: m.enabled,
      priority: Number(m.priority),
      createdAt: toIso(m.createdAt)
    }
  }

  async listMailConfigs(scope: { companyId?: number | null }): Promise<MailConfig[]> {
    const companyId = scope.companyId === undefined ? null : scope.companyId
    const rows = await MailConfigModel.findAll({
      where: { companyId },
      order: [['is_default', 'DESC'], ['priority', 'ASC'], ['id', 'ASC']]
    })
    return rows.map((m) => this.toMailConfig(m))
  }

  async getMailConfig(id: number): Promise<MailConfig | null> {
    const m = await MailConfigModel.findByPk(id)
    return m ? this.toMailConfig(m) : null
  }

  async getDefaultMailConfig(scope: { companyId?: number | null }): Promise<MailConfig | null> {
    const list = await this.listMailConfigs(scope)
    return list.find((c) => c.enabled && c.isDefault) ?? list.find((c) => c.enabled) ?? null
  }

  async saveMailConfig(input: { id?: number; companyId?: number | null; email: string; displayName?: string; host: string; port?: number; secure?: boolean; user?: string; password?: string; isDefault?: boolean; enabled?: boolean; priority?: number }): Promise<MailConfig> {
    if (input.id) {
      const existing = await MailConfigModel.findByPk(input.id)
      if (!existing) throw new NotFoundError('mail config not found')
      const values: Partial<Record<string, string | number | boolean | null>> = {
        email: input.email,
        displayName: input.displayName ?? existing.displayName,
        host: input.host,
        port: input.port ?? Number(existing.port),
        secure: input.secure ?? existing.secure,
        user: input.user ?? existing.user,
        password: input.password ?? existing.password,
        isDefault: input.isDefault ?? existing.isDefault,
        enabled: input.enabled ?? existing.enabled,
        priority: input.priority ?? Number(existing.priority)
      }
      if (input.companyId !== undefined) values.companyId = input.companyId
      await MailConfigModel.update(values, { where: { id: input.id } })
      const m = await MailConfigModel.findByPk(input.id)
      return this.toMailConfig(m!)
    }
    const companyId = input.companyId === undefined ? null : input.companyId
    const m = await MailConfigModel.create({
      companyId,
      email: input.email,
      displayName: input.displayName ?? '',
      host: input.host,
      port: input.port ?? 465,
      secure: input.secure ?? true,
      user: input.user ?? input.email,
      password: input.password ?? '',
      isDefault: input.isDefault ?? false,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100
    })
    return this.toMailConfig(m)
  }

  async deleteMailConfig(id: number): Promise<void> {
    await MailConfigModel.destroy({ where: { id } })
  }

  // ---- 假期（全局，供日历显示与多端同步；可增删改） ----
  private toHoliday(m: HolidayModel): Holiday {
    return {
      id: Number(m.id),
      date: m.date,
      name: m.name,
      type: m.type as HolidayType,
      createdAt: toIso(m.createdAt)
    }
  }

  async listHolidays(year?: number): Promise<Holiday[]> {
    const where = year ? { date: { [Op.startsWith]: `${year}-` } } : {}
    const rows = await HolidayModel.findAll({ where, order: [['date', 'ASC']] })
    return rows.map((m) => this.toHoliday(m))
  }

  async saveHoliday(input: { date: string; name: string; type: HolidayType }): Promise<Holiday> {
    const existing = await HolidayModel.findOne({ where: { date: input.date } })
    if (existing) {
      await existing.update({ name: input.name, type: input.type })
      const m = await HolidayModel.findByPk(existing.id)
      return this.toHoliday(m!)
    }
    const m = await HolidayModel.create({ date: input.date, name: input.name, type: input.type })
    return this.toHoliday(m)
  }


  async deleteHoliday(date: string): Promise<void> {
    await HolidayModel.destroy({ where: { date } })
  }

  // ==================== 任务流程系统 ====================
  private parseJson(v: string | null | undefined, fallback: unknown): unknown {
    if (!v) return fallback
    try {
      return JSON.parse(v)
    } catch {
      return fallback
    }
  }

  private toProject(m: ProjectModel): Project {
    return { id: Number(m.id), companyId: Number(m.companyId), name: m.name, pmId: Number(m.pmId), createdAt: toIso(m.createdAt) }
  }

  private toTask(m: TaskModel): TaskItem {
    const now = Date.now()
    const due = Date.parse(toIso(m.dueTime))
    const notDone = m.status !== 'completed' && m.status !== 'extended'
    const overdue = notDone && !Number.isNaN(due) && due <= now
    const status = overdue ? 'overdue' : (m.status as TaskStatus)
    return {
      id: Number(m.id),
      companyId: Number(m.companyId),
      projectId: m.projectId === null ? null : Number(m.projectId),
      title: m.title,
      description: m.description ?? '',
      startTime: toIso(m.startTime),
      dueTime: toIso(m.dueTime),
      completedTime: m.completedTime ? toIso(m.completedTime) : null,
      status,
      isOverdue: overdue,
      reminderYellow: Number(m.reminderYellow ?? 2),
      reminderRed: Number(m.reminderRed ?? 1),
      images: (this.parseJson(m.images, []) as string[]) ?? [],
      createdBy: Number(m.createdBy),
      createdAt: toIso(m.createdAt),
      updatedAt: toIso(m.updatedAt)
    }
  }

  private toAssignment(m: TaskAssignmentModel): TaskAssignment {
    return {
      id: Number(m.id),
      taskId: Number(m.taskId),
      userId: Number(m.userId),
      content: m.content ?? '',
      status: m.status as AssignmentStatus,
      completedAt: m.completedAt ? toIso(m.completedAt) : null
    }
  }

  private toComment(m: TaskCommentModel): TaskComment {
    return { id: Number(m.id), taskId: Number(m.taskId), userId: Number(m.userId), content: m.content, attachments: parseAttachments(m.images), createdAt: toIso(m.createdAt) }
  }

  private toIssue(m: TaskIssueModel): TaskIssue {
    return {
      id: Number(m.id), taskId: Number(m.taskId), userId: Number(m.userId), title: m.title,
      content: m.content ?? '', status: m.status as IssueStatus,
      resolvedAt: m.resolvedAt ? toIso(m.resolvedAt) : null, createdAt: toIso(m.createdAt)
    }
  }

  private toLog(m: TaskStatusLogModel): TaskStatusLog {
    return { id: Number(m.id), taskId: Number(m.taskId), userId: Number(m.userId), fromStatus: m.fromStatus ?? '', toStatus: m.toStatus as TaskStatus, note: m.note ?? '', createdAt: toIso(m.createdAt) }
  }

  private toExtension(m: TaskExtensionModel): TaskExtension {
    return {
      id: Number(m.id), taskId: Number(m.taskId), userId: Number(m.userId),
      requestedDueTime: toIso(m.requestedDueTime), reason: m.reason ?? '',
      status: m.status as ExtensionStatus, decidedBy: m.decidedBy === null ? null : Number(m.decidedBy),
      decidedAt: m.decidedAt ? toIso(m.decidedAt) : null, createdAt: toIso(m.createdAt)
    }
  }

  private async withUser<T extends { userId: number }>(rows: T[]): Promise<T[]> {
    const ids = Array.from(new Set(rows.map((r) => r.userId)))
    const users = await UserModel.findAll({ where: { id: { [Op.in]: ids } } })
    const map = new Map(users.map((u) => [Number(u.id), { username: u.username, nick: u.nick, avatar: u.avatar }]))
    return rows.map((r) => ({ ...r, ...(map.get(r.userId) ?? {}) }))
  }

  private toRequirement(m: RequirementModel): Requirement {
    return {
      id: Number(m.id), companyId: Number(m.companyId), projectId: m.projectId === null ? null : Number(m.projectId),
      code: m.code, title: m.title, description: m.description ?? '',
      category: (m.category as RequirementCategory) ?? 'uncategorized',
      priority: (m.priority as RequirementPriority) ?? 'middle',
      status: (m.status as RequirementStatus) ?? 'planning',
      handlerId: m.handlerId === null ? null : Number(m.handlerId),
      creatorId: Number(m.creatorId),
      startTime: toIso(m.startTime), dueTime: toIso(m.dueTime),
      completedTime: m.completedTime ? toIso(m.completedTime) : null,
      linkedTaskIds: [],
      createdAt: toIso(m.createdAt), updatedAt: toIso(m.updatedAt)
    }
  }

  private toBug(m: BugModel): Bug {
    return {
      id: Number(m.id), companyId: Number(m.companyId), projectId: m.projectId === null ? null : Number(m.projectId),
      requirementId: m.requirementId === null ? null : Number(m.requirementId),
      code: m.code, title: m.title, description: m.description ?? '',
      severity: (m.severity as BugSeverity) ?? 'normal',
      priority: (m.priority as BugPriority) ?? 'middle',
      status: (m.status as BugStatus) ?? 'pending',
      handlerId: m.handlerId === null ? null : Number(m.handlerId),
      creatorId: Number(m.creatorId),
      foundVersion: m.foundVersion ?? '',
      createdAt: toIso(m.createdAt), updatedAt: toIso(m.updatedAt)
    }
  }

  private toPlan(m: PlanModel): Plan {
    return {
      id: Number(m.id), companyId: Number(m.companyId), projectId: m.projectId === null ? null : Number(m.projectId),
      name: m.name, description: m.description ?? '',
      startTime: toIso(m.startTime), dueTime: toIso(m.dueTime),
      status: (m.status as PlanStatus) ?? 'not_started', creatorId: Number(m.creatorId),
      createdAt: toIso(m.createdAt), updatedAt: toIso(m.updatedAt)
    }
  }

  private toDocument(m: ProjectDocumentModel): ProjectDocument {
    return {
      id: Number(m.id), companyId: Number(m.companyId), projectId: m.projectId === null ? null : Number(m.projectId),
      title: m.title, content: m.content ?? '', creatorId: Number(m.creatorId),
      createdAt: toIso(m.createdAt), updatedAt: toIso(m.updatedAt)
    }
  }

  private toWikiPage(m: WikiPageModel): WikiPage {
    return {
      id: Number(m.id), companyId: Number(m.companyId), projectId: m.projectId === null ? null : Number(m.projectId),
      title: m.title, content: m.content ?? '', creatorId: Number(m.creatorId),
      createdAt: toIso(m.createdAt), updatedAt: toIso(m.updatedAt)
    }
  }

  /** 给需求/缺陷补充 处理人、创建人 名字 */
  private async enrichUsers(rows: Array<{ handlerId: number | null; creatorId: number }>): Promise<Map<number, string>> {
    const ids = new Set<number>()
    for (const r of rows) { if (r.handlerId) ids.add(r.handlerId); ids.add(r.creatorId) }
    const users = await UserModel.findAll({ where: { id: { [Op.in]: [...ids] } } })
    const map = new Map<number, { nick: string; username: string }>()
    for (const u of users) map.set(Number(u.id), { nick: u.nick, username: u.username })
    const names = new Map<number, string>()
    for (const id of ids) { const u = map.get(id); names.set(id, u ? (u.nick || u.username || '') : '') }
    return names
  }
  private async enrichReq(rows: Requirement[]): Promise<Requirement[]> {
    const names = await this.enrichUsers(rows)
    return rows.map((r) => ({
      ...r,
      handlerName: r.handlerId ? names.get(r.handlerId) ?? '' : '',
      creatorName: names.get(r.creatorId) ?? ''
    }))
  }
  private async enrichBug(rows: Bug[]): Promise<Bug[]> {
    const names = await this.enrichUsers(rows)
    return rows.map((r) => ({
      ...r,
      handlerName: r.handlerId ? names.get(r.handlerId) ?? '' : '',
      creatorName: names.get(r.creatorId) ?? ''
    }))
  }

  async createProject(input: { companyId: number; name: string; pmId: number }): Promise<Project> {
    const m = await ProjectModel.create({ companyId: input.companyId, name: input.name, pmId: input.pmId })
    await ProjectMemberModel.create({ projectId: Number(m.id), userId: input.pmId, role: 'pm' })
    return this.toProject(m)
  }

  async listProjects(companyId: number): Promise<Project[]> {
    const rows = await ProjectModel.findAll({ where: { companyId }, order: [['id', 'ASC']] })
    return rows.map((m) => this.toProject(m))
  }

  async deleteProject(projectId: number): Promise<void> {
    await ProjectMemberModel.destroy({ where: { projectId } })
    await TaskModel.update({ projectId: null }, { where: { projectId } })
    await ProjectModel.destroy({ where: { id: projectId } })
  }

  async setProjectRole(projectId: number, userId: number, role: ProjectRole): Promise<void> {
    const existing = await ProjectMemberModel.findOne({ where: { projectId, userId } })
    if (existing) await existing.update({ role })
    else await ProjectMemberModel.create({ projectId, userId, role })
  }

  async listProjectMembers(projectId: number): Promise<ProjectMember[]> {
    const rows = await ProjectMemberModel.findAll({ where: { projectId } })
    return rows.map((m) => ({ projectId: Number(m.projectId), userId: Number(m.userId), role: m.role as ProjectRole, joinedAt: toIso(m.joinedAt) }))
  }

  async createTask(input: { companyId: number; projectId?: number | null; title: string; description?: string; startTime: string; dueTime: string; images?: string[]; createdBy: number }): Promise<TaskItem> {
    const m = await TaskModel.create({
      companyId: input.companyId,
      projectId: input.projectId && input.projectId > 0 ? input.projectId : null,
      title: input.title,
      description: input.description ?? '',
      startTime: new Date(input.startTime),
      dueTime: new Date(input.dueTime),
      images: JSON.stringify(input.images ?? []),
      createdBy: input.createdBy,
      status: 'created'
    })
    await TaskStatusLogModel.create({ taskId: Number(m.id), userId: input.createdBy, fromStatus: '', toStatus: 'created', note: '创建任务' })
    return this.toTask(m)
  }

  async listTasks(companyId: number, projectId?: number | null): Promise<TaskItem[]> {
    const where: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) where.projectId = projectId
    const rows = await TaskModel.findAll({ where, order: [['dueTime', 'ASC']] })
    return rows.map((m) => this.toTask(m))
  }

  async getTask(taskId: number): Promise<TaskItem | null> {
    const m = await TaskModel.findByPk(taskId)
    return m ? this.toTask(m) : null
  }

  async getTaskDetail(taskId: number): Promise<TaskDetail | null> {
    const t = await TaskModel.findByPk(taskId)
    if (!t) return null
    const [assignments, comments, issues, extensions, logs] = await Promise.all([
      TaskAssignmentModel.findAll({ where: { taskId }, order: [['id', 'ASC']] }),
      TaskCommentModel.findAll({ where: { taskId }, order: [['id', 'ASC']] }),
      TaskIssueModel.findAll({ where: { taskId }, order: [['id', 'ASC']] }),
      TaskExtensionModel.findAll({ where: { taskId }, order: [['id', 'ASC']] }),
      TaskStatusLogModel.findAll({ where: { taskId }, order: [['id', 'ASC']] })
    ])
    return {
      task: this.toTask(t),
      assignments: await this.withUser(assignments.map((a) => this.toAssignment(a))),
      comments: await this.withUser(comments.map((c) => this.toComment(c))),
      issues: await this.withUser(issues.map((i) => this.toIssue(i))),
      extensions: await this.withUser(extensions.map((e) => this.toExtension(e))),
      logs: await this.withUser(logs.map((l) => this.toLog(l)))
    }
  }

  async updateTask(input: { id: number; title?: string; description?: string; startTime?: string; dueTime?: string; images?: string[] }): Promise<TaskItem | null> {
    const t = await TaskModel.findByPk(input.id)
    if (!t) return null
    const v: Record<string, unknown> = {}
    if (input.title !== undefined) v.title = input.title
    if (input.description !== undefined) v.description = input.description
    if (input.startTime !== undefined) v.startTime = new Date(input.startTime)
    if (input.dueTime !== undefined) v.dueTime = new Date(input.dueTime)
    if (input.images !== undefined) v.images = JSON.stringify(input.images)
    await t.update(v)
    const m = await TaskModel.findByPk(input.id)
    return this.toTask(m!)
  }

  async deleteTask(taskId: number): Promise<void> {
    await TaskAssignmentModel.destroy({ where: { taskId } })
    await TaskCommentModel.destroy({ where: { taskId } })
    await TaskIssueModel.destroy({ where: { taskId } })
    await TaskExtensionModel.destroy({ where: { taskId } })
    await TaskStatusLogModel.destroy({ where: { taskId } })
    await TaskModel.destroy({ where: { id: taskId } })
  }

  async setTaskStatus(input: { taskId: number; status: TaskStatus; userId: number; note: string }): Promise<TaskItem | null> {
    const t = await TaskModel.findByPk(input.taskId)
    if (!t) return null
    const old = t.status as TaskStatus
    const v: Record<string, unknown> = { status: input.status }
    if (input.status === 'completed') v.completedTime = new Date()
    if (input.status === 'extended') v.isOverdue = false // 延期后关闭超时
    await t.update(v)
    await TaskStatusLogModel.create({ taskId: input.taskId, userId: input.userId, fromStatus: old, toStatus: input.status, note: input.note ?? '' })
    const m = await TaskModel.findByPk(input.taskId)
    return this.toTask(m!)
  }

  async updateTaskReminder(input: { taskId: number; reminderYellow: number; reminderRed: number }): Promise<TaskItem | null> {
    const t = await TaskModel.findByPk(input.taskId)
    if (!t) return null
    await t.update({ reminderYellow: input.reminderYellow, reminderRed: input.reminderRed })
    const m = await TaskModel.findByPk(input.taskId)
    return this.toTask(m!)
  }

  async addAssignment(input: { taskId: number; userId: number; content: string }): Promise<TaskAssignment> {
    const m = await TaskAssignmentModel.create({ taskId: input.taskId, userId: input.userId, content: input.content, status: 'created' })
    return this.toAssignment(m)
  }

  async removeAssignment(id: number): Promise<void> {
    await TaskAssignmentModel.destroy({ where: { id } })
  }

  async setAssignmentStatus(input: { id: number; status: AssignmentStatus; userId: number }): Promise<TaskAssignment | null> {
    const a = await TaskAssignmentModel.findByPk(input.id)
    if (!a) return null
    if (Number(a.userId) !== input.userId) return null // 仅本人可提交
    const v: Record<string, unknown> = { status: input.status }
    if (input.status === 'completed') v.completedAt = new Date()
    else v.completedAt = null
    await a.update(v)
    const m = await TaskAssignmentModel.findByPk(input.id)
    return this.toAssignment(m!)
  }

  async addTaskComment(input: { taskId: number; userId: number; content: string; attachments?: TaskAttachment[] }): Promise<TaskComment> {
    const m = await TaskCommentModel.create({ taskId: input.taskId, userId: input.userId, content: input.content, images: JSON.stringify(input.attachments ?? []) })
    return this.toComment(m)
  }

  async addTaskIssue(input: { taskId: number; userId: number; title: string; content: string }): Promise<TaskIssue> {
    const m = await TaskIssueModel.create({ taskId: input.taskId, userId: input.userId, title: input.title, content: input.content, status: 'open' })
    return this.toIssue(m)
  }

  async resolveTaskIssue(issueId: number): Promise<TaskIssue | null> {
    const i = await TaskIssueModel.findByPk(issueId)
    if (!i) return null
    await i.update({ status: 'resolved', resolvedAt: new Date() })
    const m = await TaskIssueModel.findByPk(issueId)
    return this.toIssue(m!)
  }

  async requestTaskExtension(input: { taskId: number; userId: number; requestedDueTime: string; reason: string }): Promise<TaskExtension> {
    const m = await TaskExtensionModel.create({ taskId: input.taskId, userId: input.userId, requestedDueTime: new Date(input.requestedDueTime), reason: input.reason, status: 'pending' })
    await TaskModel.update({ status: 'pending_extension' }, { where: { id: input.taskId } })
    await TaskStatusLogModel.create({ taskId: input.taskId, userId: input.userId, fromStatus: 'in_progress', toStatus: 'pending_extension', note: '申请延期：' + input.reason })
    return this.toExtension(m)
  }

  async decideTaskExtension(input: { extensionId: number; approved: boolean; decidedBy: number }): Promise<TaskExtension | null> {
    const e = await TaskExtensionModel.findByPk(input.extensionId)
    if (!e) return null
    await e.update({ status: input.approved ? 'approved' : 'rejected', decidedBy: input.decidedBy, decidedAt: new Date() })
    if (input.approved) {
      await TaskModel.update({ dueTime: new Date(e.requestedDueTime), status: 'extended', isOverdue: false }, { where: { id: Number(e.taskId) } })
      await TaskStatusLogModel.create({ taskId: Number(e.taskId), userId: input.decidedBy, fromStatus: 'pending_extension', toStatus: 'extended', note: '审批通过延期申请' })
    }
    const m = await TaskExtensionModel.findByPk(input.extensionId)
    return this.toExtension(m!)
  }

  // ---- TAPD：需求 ----
  async createRequirement(input: { companyId: number; projectId?: number | null; title: string; description?: string; category?: string; priority?: string; handlerId?: number | null; startTime: string; dueTime: string; creatorId: number }): Promise<Requirement> {
    const m = await RequirementModel.create({
      companyId: input.companyId,
      projectId: input.projectId && input.projectId > 0 ? input.projectId : null,
      title: input.title, description: input.description ?? '',
      category: input.category ?? 'uncategorized', priority: input.priority ?? 'middle',
      status: 'planning',
      handlerId: input.handlerId && input.handlerId > 0 ? input.handlerId : null,
      creatorId: input.creatorId,
      startTime: new Date(input.startTime), dueTime: new Date(input.dueTime),
      code: ''
    })
    const code = 'REQ-' + (100000 + Number(m.id))
    await m.update({ code })
    return this.toRequirement(m)
  }

  async listRequirements(companyId: number, projectId?: number | null): Promise<Requirement[]> {
    const where: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) where.projectId = projectId
    const rows = await RequirementModel.findAll({ where, order: [['id', 'DESC']] })
    const links = await RequirementLinkModel.findAll({ where: { companyId } })
    const map = new Map<number, number[]>()
    for (const l of links) { const arr = map.get(Number(l.requirementId)) ?? []; arr.push(Number(l.taskId)); map.set(Number(l.requirementId), arr) }
    const list = rows.map((m) => { const r = this.toRequirement(m); r.linkedTaskIds = map.get(r.id) ?? []; return r })
    return this.enrichReq(list)
  }

  async getRequirement(requirementId: number): Promise<Requirement | null> {
    const m = await RequirementModel.findByPk(requirementId)
    return m ? this.toRequirement(m) : null
  }

  async updateRequirement(input: { id: number; title?: string; description?: string; category?: string; priority?: string; handlerId?: number | null; startTime?: string; dueTime?: string }): Promise<Requirement | null> {
    const r = await RequirementModel.findByPk(input.id)
    if (!r) return null
    const v: Record<string, unknown> = {}
    if (input.title !== undefined) v.title = input.title
    if (input.description !== undefined) v.description = input.description
    if (input.category !== undefined) v.category = input.category
    if (input.priority !== undefined) v.priority = input.priority
    if (input.handlerId !== undefined) v.handlerId = input.handlerId && input.handlerId > 0 ? input.handlerId : null
    if (input.startTime !== undefined) v.startTime = new Date(input.startTime)
    if (input.dueTime !== undefined) v.dueTime = new Date(input.dueTime)
    await r.update(v)
    const m = await RequirementModel.findByPk(input.id)
    return m ? this.toRequirement(m) : null
  }

  async setRequirementStatus(input: { requirementId: number; status: RequirementStatus; userId: number }): Promise<Requirement | null> {
    const r = await RequirementModel.findByPk(input.requirementId)
    if (!r) return null
    const v: Record<string, unknown> = { status: input.status }
    if (input.status === 'done') v.completedTime = new Date()
    await r.update(v)
    const m = await RequirementModel.findByPk(input.requirementId)
    return m ? this.toRequirement(m) : null
  }

  async deleteRequirement(requirementId: number): Promise<void> {
    await RequirementLinkModel.destroy({ where: { requirementId } })
    await RequirementModel.destroy({ where: { id: requirementId } })
  }

  async linkRequirementTasks(input: { requirementId: number; taskIds: number[]; userId: number; companyId: number }): Promise<number[]> {
    await RequirementLinkModel.destroy({ where: { requirementId: input.requirementId } })
    for (const tid of input.taskIds) {
      await RequirementLinkModel.create({ companyId: input.companyId, requirementId: input.requirementId, taskId: tid, userId: input.userId })
    }
    return input.taskIds
  }

  // ---- TAPD：缺陷 ----
  async createBug(input: { companyId: number; projectId?: number | null; requirementId?: number | null; title: string; description?: string; severity?: string; priority?: string; handlerId?: number | null; foundVersion?: string; creatorId: number }): Promise<Bug> {
    const m = await BugModel.create({
      companyId: input.companyId,
      projectId: input.projectId && input.projectId > 0 ? input.projectId : null,
      requirementId: input.requirementId && input.requirementId > 0 ? input.requirementId : null,
      title: input.title, description: input.description ?? '',
      severity: input.severity ?? 'normal', priority: input.priority ?? 'middle',
      status: 'pending',
      handlerId: input.handlerId && input.handlerId > 0 ? input.handlerId : null,
      creatorId: input.creatorId, foundVersion: input.foundVersion ?? '',
      code: ''
    })
    const code = 'BUG-' + (100000 + Number(m.id))
    await m.update({ code })
    return this.toBug(m)
  }

  async listBugs(companyId: number, projectId?: number | null): Promise<Bug[]> {
    const where: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) where.projectId = projectId
    const rows = await BugModel.findAll({ where, order: [['id', 'DESC']] })
    return this.enrichBug(rows.map((m) => this.toBug(m)))
  }

  async getBug(bugId: number): Promise<Bug | null> {
    const m = await BugModel.findByPk(bugId)
    return m ? this.toBug(m) : null
  }

  async updateBug(input: { id: number; title?: string; description?: string; severity?: string; priority?: string; handlerId?: number | null; foundVersion?: string }): Promise<Bug | null> {
    const b = await BugModel.findByPk(input.id)
    if (!b) return null
    const v: Record<string, unknown> = {}
    if (input.title !== undefined) v.title = input.title
    if (input.description !== undefined) v.description = input.description
    if (input.severity !== undefined) v.severity = input.severity
    if (input.priority !== undefined) v.priority = input.priority
    if (input.handlerId !== undefined) v.handlerId = input.handlerId && input.handlerId > 0 ? input.handlerId : null
    if (input.foundVersion !== undefined) v.foundVersion = input.foundVersion
    await b.update(v)
    const m = await BugModel.findByPk(input.id)
    return m ? this.toBug(m) : null
  }

  async setBugStatus(input: { bugId: number; status: BugStatus; userId: number }): Promise<Bug | null> {
    const b = await BugModel.findByPk(input.bugId)
    if (!b) return null
    await b.update({ status: input.status })
    const m = await BugModel.findByPk(input.bugId)
    return m ? this.toBug(m) : null
  }

  async deleteBug(bugId: number): Promise<void> {
    await BugModel.destroy({ where: { id: bugId } })
  }

  // ---- TAPD：计划 ----
  async createPlan(input: { companyId: number; projectId?: number | null; name: string; description?: string; startTime: string; dueTime: string; creatorId: number }): Promise<Plan> {
    const m = await PlanModel.create({
      companyId: input.companyId,
      projectId: input.projectId && input.projectId > 0 ? input.projectId : null,
      name: input.name, description: input.description ?? '',
      startTime: new Date(input.startTime), dueTime: new Date(input.dueTime),
      status: 'not_started', creatorId: input.creatorId
    })
    return this.toPlan(m)
  }

  async listPlans(companyId: number, projectId?: number | null): Promise<Plan[]> {
    const where: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) where.projectId = projectId
    const rows = await PlanModel.findAll({ where, order: [['id', 'ASC']] })
    return rows.map((m) => this.toPlan(m))
  }

  async updatePlan(input: { id: number; name?: string; description?: string; startTime?: string; dueTime?: string; status?: string }): Promise<Plan | null> {
    const p = await PlanModel.findByPk(input.id)
    if (!p) return null
    const v: Record<string, unknown> = {}
    if (input.name !== undefined) v.name = input.name
    if (input.description !== undefined) v.description = input.description
    if (input.startTime !== undefined) v.startTime = new Date(input.startTime)
    if (input.dueTime !== undefined) v.dueTime = new Date(input.dueTime)
    if (input.status !== undefined) v.status = input.status
    await p.update(v)
    const m = await PlanModel.findByPk(input.id)
    return m ? this.toPlan(m) : null
  }

  async deletePlan(planId: number): Promise<void> {
    await PlanModel.destroy({ where: { id: planId } })
  }

  // ---- TAPD：文档 ----
  async createDocument(input: { companyId: number; projectId?: number | null; title: string; content?: string; creatorId: number }): Promise<ProjectDocument> {
    const m = await ProjectDocumentModel.create({ companyId: input.companyId, projectId: input.projectId && input.projectId > 0 ? input.projectId : null, title: input.title, content: input.content ?? '', creatorId: input.creatorId })
    return this.toDocument(m)
  }

  async listDocuments(companyId: number, projectId?: number | null): Promise<ProjectDocument[]> {
    const where: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) where.projectId = projectId
    const rows = await ProjectDocumentModel.findAll({ where, order: [['id', 'DESC']] })
    return rows.map((m) => this.toDocument(m))
  }

  async updateDocument(input: { id: number; title?: string; content?: string }): Promise<ProjectDocument | null> {
    const d = await ProjectDocumentModel.findByPk(input.id)
    if (!d) return null
    const v: Record<string, unknown> = {}
    if (input.title !== undefined) v.title = input.title
    if (input.content !== undefined) v.content = input.content
    await d.update(v)
    const m = await ProjectDocumentModel.findByPk(input.id)
    return m ? this.toDocument(m) : null
  }

  async deleteDocument(documentId: number): Promise<void> {
    await ProjectDocumentModel.destroy({ where: { id: documentId } })
  }

  // ---- TAPD：Wiki ----
  async createWikiPage(input: { companyId: number; projectId?: number | null; title: string; content?: string; creatorId: number }): Promise<WikiPage> {
    const m = await WikiPageModel.create({ companyId: input.companyId, projectId: input.projectId && input.projectId > 0 ? input.projectId : null, title: input.title, content: input.content ?? '', creatorId: input.creatorId })
    return this.toWikiPage(m)
  }

  async listWikiPages(companyId: number, projectId?: number | null): Promise<WikiPage[]> {
    const where: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) where.projectId = projectId
    const rows = await WikiPageModel.findAll({ where, order: [['id', 'DESC']] })
    return rows.map((m) => this.toWikiPage(m))
  }

  async updateWikiPage(input: { id: number; title?: string; content?: string }): Promise<WikiPage | null> {
    const w = await WikiPageModel.findByPk(input.id)
    if (!w) return null
    const v: Record<string, unknown> = {}
    if (input.title !== undefined) v.title = input.title
    if (input.content !== undefined) v.content = input.content
    await w.update(v)
    const m = await WikiPageModel.findByPk(input.id)
    return m ? this.toWikiPage(m) : null
  }

  async deleteWikiPage(wikiId: number): Promise<void> {
    await WikiPageModel.destroy({ where: { id: wikiId } })
  }

  // ---- TAPD：仪表盘 + 成员跟踪 ----
  async dashboardStats(companyId: number, projectId?: number | null): Promise<DashboardStats> {
    const rw: Record<string, unknown> = { companyId }
    const tw: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) { rw.projectId = projectId; tw.projectId = projectId }
    const reqs = await RequirementModel.findAll({ where: rw })
    const bugs = await BugModel.findAll({ where: rw })
    const now = Date.now()
    const thirty = now - 30 * 86400000
    const newReq = reqs.filter((r) => new Date(r.createdAt).getTime() >= thirty).length
    const overdueReq = reqs.filter((r) => r.status !== 'done' && r.status !== 'closed' && new Date(r.dueTime).getTime() < now).length
    const closedBugs = bugs.filter((b) => b.status === 'closed' || b.status === 'verified').length
    const resolveRate = bugs.length ? Math.round((closedBugs / bugs.length) * 100) : 0
    const unresolved = bugs.filter((b) => b.status === 'pending' || b.status === 'processing').length
    const requirementByStatus: Record<string, number> = {}
    for (const r of reqs) requirementByStatus[r.status] = (requirementByStatus[r.status] ?? 0) + 1
    const bugBySeverity: Record<string, number> = {}
    for (const b of bugs) bugBySeverity[b.severity] = (bugBySeverity[b.severity] ?? 0) + 1
    return { newRequirement30d: newReq, overdueRequirement: overdueReq, bugResolveRate: resolveRate, unresolvedBug: unresolved, requirementByStatus, bugBySeverity }
  }

  async memberTracking(companyId: number, projectId?: number | null): Promise<MemberTrackItem[]> {
    const tw: Record<string, unknown> = { companyId }
    if (projectId && projectId > 0) tw.projectId = projectId
    const tasks = await TaskModel.findAll({ where: tw })
    const assigns = await TaskAssignmentModel.findAll()
    const members = await this.getMembers(companyId)
    const rows: MemberTrackItem[] = []
    for (const mem of members) {
      const myTaskIds = new Set(assigns.filter((a) => Number(a.userId) === mem.userId).map((a) => Number(a.taskId)))
      const myTasks = tasks.filter((t) => myTaskIds.has(Number(t.id)))
      if (!myTasks.length) continue
      const completed = myTasks.filter((t) => t.status === 'completed' || t.status === 'extended').length
      const inProgress = myTasks.filter((t) => t.status === 'in_progress').length
      const overdue = myTasks.filter((t) => t.status === 'overdue' || (t.status !== 'completed' && t.status !== 'extended' && new Date(t.dueTime).getTime() < Date.now())).length
      rows.push({ userId: mem.userId, nick: mem.nick ?? '', username: mem.username ?? '', total: myTasks.length, completed, inProgress, overdue })
    }
    return rows
  }
}
