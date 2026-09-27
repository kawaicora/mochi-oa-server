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
  MemberProfile,
  Membership,
  MailConfig,
  Session,
  User
} from '../types'
import { AlreadyExistsError, NotFoundError, type Store, type UserWithPassword } from './store'

/** 内存实现：无 MySQL 时的开发/测试用。生产走 MySqlStore。 */
export class MemoryStore implements Store {
  private users = new Map<number, UserWithPassword>()
  private companies = new Map<number, Company>()
  private companyMembers = new Map<string, { companyId: number; userId: number; role: CompanyRole; joinedAt: string }>()
  private departments = new Map<number, Department>()
  private departmentMembers = new Map<string, { departmentId: number; userId: number; joinedAt: string }>()
  private groups = new Map<number, Group>()
  private groupMembers = new Map<string, { groupId: number; userId: number; role: GroupRole; joinedAt: string; mutedUntil: string | null }>()
  private conversations = new Map<number, Conversation>()
  private conversationMembers = new Map<string, ConversationMember>()
  private messagesByConv = new Map<number, ChatMessage[]>()
  private deletedMessages = new Set<string>()
  private files = new Map<string, FileRecord>()
  private friendPairs = new Map<string, string>()
  private invitations = new Map<number, CompanyInvitation>()
  private sessions = new Map<number, Session>()
  private mailConfigs = new Map<number, MailConfig>()
  private holidays = new Map<number, Holiday>()
  private userIdSeq = 1
  private companyIdSeq = 1
  private departmentIdSeq = 1
  private groupIdSeq = 1
  private conversationIdSeq = 1
  private messageIdSeq = 1
  private invitationIdSeq = 1
  private sessionIdSeq = 1
  private mailConfigIdSeq = 1
  private holidayIdSeq = 1

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  // ---- 用户 ----
  async createUser(input: { username: string; passwordHash: string; nick?: string; email?: string; avatar?: string; phone?: string }): Promise<User> {
    const exists = [...this.users.values()].some((u) => u.username === input.username)
    if (exists) throw new AlreadyExistsError('username taken')
    const id = this.userIdSeq++
    const u: UserWithPassword = {
      id,
      username: input.username,
      passwordHash: input.passwordHash,
      nick: input.nick ?? '',
      avatar: input.avatar ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      extra: '',
      sessionDays: null,
      createdAt: new Date().toISOString()
    }
    this.users.set(id, u)
    return this.publicUser(u)
  }

  async getUserByUsername(username: string): Promise<UserWithPassword | null> {
    return [...this.users.values()].find((u) => u.username === username) ?? null
  }

  async getUserByEmail(email: string): Promise<UserWithPassword | null> {
    const e = email.toLowerCase().trim()
    return [...this.users.values()].find((u) => u.email && u.email.toLowerCase().trim() === e) ?? null
  }

  async getUserById(id: number): Promise<User | null> {
    const u = this.users.get(id)
    return u ? this.publicUser(u) : null
  }

  async updateUserProfile(userId: number, patch: { nick?: string; avatar?: string; phone?: string; extra?: string }): Promise<void> {
    const u = this.users.get(userId)
    if (!u) throw new NotFoundError('user not found')
    if (patch.nick !== undefined) u.nick = patch.nick
    if (patch.avatar !== undefined) u.avatar = patch.avatar
    if (patch.phone !== undefined) u.phone = patch.phone
    if (patch.extra !== undefined) u.extra = patch.extra
  }

  async updateUserPassword(userId: number, passwordHash: string): Promise<void> {
    const u = this.users.get(userId)
    if (!u) throw new NotFoundError('user not found')
    u.passwordHash = passwordHash
  }

  async listUsers(): Promise<User[]> {
    return [...this.users.values()].map((u) => this.publicUser(u))
  }


  // ---- 公司 ----
  async createCompany(input: { name: string; code: string; ownerId: number }): Promise<Company> {
    if ([...this.companies.values()].some((c) => c.code === input.code)) throw new AlreadyExistsError('code taken')
    const id = this.companyIdSeq++
    const c: Company = {
      id,
      name: input.name,
      code: input.code,
      ownerId: input.ownerId,
      createdAt: new Date().toISOString()
    }
    this.companies.set(id, c)
    await this.addMember(c.id, input.ownerId, 'owner')
    return c
  }

  async getCompanyById(id: number): Promise<Company | null> {
    return this.companies.get(id) ?? null
  }

  async getCompanyByName(name: string): Promise<Company | null> {
    return [...this.companies.values()].find((c) => c.name === name) ?? null
  }

  async getCompanyByCode(code: string): Promise<Company | null> {
    return [...this.companies.values()].find((c) => c.code === code) ?? null
  }

  async listCompanies(keyword?: string): Promise<Company[]> {
    let list = [...this.companies.values()]
    if (keyword && keyword.trim().length > 0) {
      const k = keyword.trim().toLowerCase()
      list = list.filter((c) => c.name.toLowerCase().includes(k))
    }
    return list.slice(0, 100)
  }

  async addMember(companyId: number, userId: number, role: CompanyRole): Promise<void> {
    const key = this.mkey(companyId, userId)
    if (this.companyMembers.has(key)) throw new AlreadyExistsError('already a member')
    this.companyMembers.set(key, { companyId, userId, role, joinedAt: new Date().toISOString() })
  }

  async removeMember(companyId: number, userId: number): Promise<void> {
    const key = this.mkey(companyId, userId)
    if (!this.companyMembers.delete(key)) throw new NotFoundError('not a member')
  }

  async setRole(companyId: number, userId: number, role: CompanyRole): Promise<void> {
    const m = this.companyMembers.get(this.mkey(companyId, userId))
    if (!m) throw new NotFoundError('not a member')
    m.role = role
  }

  async getMemberRole(companyId: number, userId: number): Promise<CompanyRole | null> {
    return this.companyMembers.get(this.mkey(companyId, userId))?.role ?? null
  }

  async getMembers(companyId: number): Promise<Member[]> {
    const out: Member[] = []
    for (const m of this.companyMembers.values()) {
      if (m.companyId !== companyId) continue
      const u = this.users.get(m.userId)
      out.push({
        companyId: m.companyId,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        username: u?.username,
        nick: u?.nick
      })
    }
    return out
  }

  async getUserCompanies(userId: number): Promise<Membership[]> {
    const out: Membership[] = []
    for (const m of this.companyMembers.values()) {
      if (m.userId !== userId) continue
      const c = this.companies.get(m.companyId)
      if (c) out.push({ company: c, role: m.role })
    }
    return out
  }

  // ---- 部门 ----
  async createDepartment(input: { companyId: number; name: string; parentId?: number | null }): Promise<Department> {
    const id = this.departmentIdSeq++
    const d: Department = {
      id,
      companyId: input.companyId,
      name: input.name,
      parentId: input.parentId ?? null,
      createdAt: new Date().toISOString()
    }
    this.departments.set(id, d)
    return d
  }

  async getDepartmentById(id: number): Promise<Department | null> {
    return this.departments.get(id) ?? null
  }

  async listDepartments(companyId: number): Promise<Department[]> {
    return [...this.departments.values()].filter((d) => d.companyId === companyId)
  }

  async assignDepartment(departmentId: number, userId: number): Promise<void> {
    const key = this.mkey(departmentId, userId)
    if (this.departmentMembers.has(key)) throw new AlreadyExistsError('already in department')
    this.departmentMembers.set(key, { departmentId, userId, joinedAt: new Date().toISOString() })
  }

  async removeDepartmentMember(departmentId: number, userId: number): Promise<void> {
    const key = this.mkey(departmentId, userId)
    if (!this.departmentMembers.delete(key)) throw new NotFoundError('not in department')
  }

  async getDepartmentMembers(departmentId: number): Promise<DepartmentMember[]> {
    const out: DepartmentMember[] = []
    for (const m of this.departmentMembers.values()) {
      if (m.departmentId !== departmentId) continue
      const u = this.users.get(m.userId)
      out.push({
        departmentId: m.departmentId,
        userId: m.userId,
        joinedAt: m.joinedAt,
        username: u?.username,
        nick: u?.nick
      })
    }
    return out
  }

  // ---- 群 ----
  async createGroup(input: { companyId: number; departmentId?: number | null; name: string; code: string; ownerId: number }): Promise<Group> {
    if ([...this.groups.values()].some((g) => g.code === input.code)) throw new AlreadyExistsError('code taken')
    const id = this.groupIdSeq++
    const g: Group = {
      id,
      companyId: input.companyId,
      departmentId: input.departmentId ?? null,
      name: input.name,
      code: input.code,
      ownerId: input.ownerId,
      createdAt: new Date().toISOString()
    }
    this.groups.set(id, g)
    await this.addGroupMember(g.id, input.ownerId, 'owner')
    return g
  }

  async getGroupById(id: number): Promise<Group | null> {
    return this.groups.get(id) ?? null
  }

  async getGroupByName(companyId: number, name: string): Promise<Group | null> {
    const cid = companyId > 0 ? companyId : null
    return [...this.groups.values()].find((g) => g.name === name && (g.companyId ?? null) === cid) ?? null
  }

  async getGroupByCode(code: string): Promise<Group | null> {
    return [...this.groups.values()].find((g) => g.code === code) ?? null
  }

  async listGroups(companyId?: number, keyword?: string): Promise<Group[]> {
    let list = [...this.groups.values()]
    if (companyId) list = list.filter((g) => g.companyId === companyId)
    if (keyword && keyword.trim().length > 0) {
      const k = keyword.trim().toLowerCase()
      list = list.filter((g) => g.name.toLowerCase().includes(k))
    }
    return list.slice(0, 100)
  }

  async addGroupMember(groupId: number, userId: number, role: GroupRole): Promise<void> {
    const key = this.mkey(groupId, userId)
    if (this.groupMembers.has(key)) throw new AlreadyExistsError('already in group')
    this.groupMembers.set(key, { groupId, userId, role, joinedAt: new Date().toISOString(), mutedUntil: null })
  }

  async removeGroupMember(groupId: number, userId: number): Promise<void> {
    const key = this.mkey(groupId, userId)
    if (!this.groupMembers.delete(key)) throw new NotFoundError('not in group')
  }

  async getGroupMemberRole(groupId: number, userId: number): Promise<GroupRole | null> {
    return this.groupMembers.get(this.mkey(groupId, userId))?.role ?? null
  }

  async getGroupMember(groupId: number, userId: number): Promise<{ role: GroupRole; mutedUntil: Date | null } | null> {
    const m = this.groupMembers.get(this.mkey(groupId, userId))
    return m ? { role: m.role, mutedUntil: m.mutedUntil ? new Date(m.mutedUntil) : null } : null
  }

  async setGroupMemberRole(groupId: number, userId: number, role: GroupRole): Promise<void> {
    const m = this.groupMembers.get(this.mkey(groupId, userId))
    if (!m) throw new NotFoundError('not in group')
    m.role = role
  }

  async setCompanyOwner(companyId: number, ownerId: number): Promise<void> {
    const c = this.companies.get(companyId)
    if (!c) throw new NotFoundError('company not found')
    c.ownerId = ownerId
  }

  async deleteCompany(companyId: number): Promise<void> {
    const gids: number[] = []
    for (const g of this.groups.values()) {
      if (g.companyId === companyId) gids.push(g.id)
    }
    for (const gid of gids) await this.deleteGroup(gid)
    const depIds: number[] = []
    for (const d of this.departments.values()) {
      if (d.companyId === companyId) depIds.push(d.id)
    }
    for (const [k, dm] of this.departmentMembers) {
      if (depIds.includes(dm.departmentId)) this.departmentMembers.delete(k)
    }
    for (const id of depIds) this.departments.delete(id)
    for (const [k, m] of this.companyMembers) {
      if (m.companyId === companyId) this.companyMembers.delete(k)
    }
    for (const [k, inv] of this.invitations) {
      if (inv.companyId === companyId) this.invitations.delete(k)
    }
    this.companies.delete(companyId)
  }

  async setGroupMemberMuted(groupId: number, userId: number, mutedUntil: Date | null): Promise<void> {
    const m = this.groupMembers.get(this.mkey(groupId, userId))
    if (!m) throw new NotFoundError('not in group')
    m.mutedUntil = mutedUntil ? mutedUntil.toISOString() : null
  }

  async setGroupOwner(groupId: number, ownerId: number): Promise<void> {
    const g = this.groups.get(groupId)
    if (!g) throw new NotFoundError('group not found')
    g.ownerId = ownerId
  }

  async deleteGroup(groupId: number): Promise<void> {
    for (const [k, m] of this.groupMembers) {
      if (m.groupId === groupId) this.groupMembers.delete(k)
    }
    for (const [k, c] of this.conversations) {
      if (c.type === 'group' && c.groupId === groupId) {
        this.messagesByConv.delete(c.id)
        for (const [ck, cm] of this.conversationMembers) {
          if (cm.conversationId === c.id) this.conversationMembers.delete(ck)
        }
        this.conversations.delete(k)
      }
    }
    this.groups.delete(groupId)
  }

  async getGroupMembers(groupId: number): Promise<GroupMember[]> {
    const out: GroupMember[] = []
    for (const m of this.groupMembers.values()) {
      if (m.groupId !== groupId) continue
      const u = this.users.get(m.userId)
      out.push({
        groupId: m.groupId,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        mutedUntil: m.mutedUntil ?? undefined,
        username: u?.username,
        nick: u?.nick
      })
    }
    return out
  }

  async getUserGroups(userId: number): Promise<Group[]> {
    const out: Group[] = []
    for (const m of this.groupMembers.values()) {
      if (m.userId !== userId) continue
      const g = this.groups.get(m.groupId)
      if (g) out.push(g)
    }
    return out
  }

  // ---- 对话（群聊 + 私信统一） ----
  private async conversationType(id: number): Promise<ConversationType> {
    return this.conversations.get(id)?.type ?? 'group'
  }

  async getOrCreateGroupConversation(groupId: number, ownerId?: number): Promise<Conversation> {
    const existing = [...this.conversations.values()].find((c) => c.type === 'group' && c.groupId === groupId)
    if (existing) return existing
    const id = this.conversationIdSeq++
    const c: Conversation = { id, type: 'group', groupId, dmUserA: null, dmUserB: null, createdAt: new Date().toISOString() }
    this.conversations.set(id, c)
    if (ownerId) await this.addConversationMember(id, ownerId)
    return c
  }

  async getOrCreateDmConversation(a: number, b: number): Promise<Conversation> {
    const x = Math.min(a, b)
    const y = Math.max(a, b)
    const existing = [...this.conversations.values()].find((c) => c.type === 'dm' && c.dmUserA === x && c.dmUserB === y)
    if (existing) return existing
    const id = this.conversationIdSeq++
    const c: Conversation = { id, type: 'dm', groupId: null, dmUserA: x, dmUserB: y, createdAt: new Date().toISOString() }
    this.conversations.set(id, c)
    await this.addConversationMember(id, x)
    await this.addConversationMember(id, y)
    return c
  }

  async getConversationById(id: number): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null
  }

  async addConversationMember(conversationId: number, userId: number): Promise<void> {
    const key = this.mkey(conversationId, userId)
    if (this.conversationMembers.has(key)) throw new AlreadyExistsError('already in conversation')
    this.conversationMembers.set(key, {
      conversationId,
      userId,
      pinned: false,
      lastMessageAt: null,
      lastPreview: null,
      unread: 0
    })
  }

  async removeConversationMember(conversationId: number, userId: number): Promise<void> {
    const key = this.mkey(conversationId, userId)
    if (!this.conversationMembers.delete(key)) throw new NotFoundError('not in conversation')
  }

  async setConversationPinned(conversationId: number, userId: number, pinned: boolean): Promise<void> {
    const m = this.conversationMembers.get(this.mkey(conversationId, userId))
    if (!m) throw new NotFoundError('not in conversation')
    m.pinned = pinned
  }

  async getConversationMember(conversationId: number, userId: number): Promise<ConversationMember | null> {
    return this.conversationMembers.get(this.mkey(conversationId, userId)) ?? null
  }

  async listConversations(userId: number, type?: ConversationType): Promise<ConversationItem[]> {
    const out: ConversationItem[] = []
    for (const m of this.conversationMembers.values()) {
      if (m.userId !== userId) continue
      const c = this.conversations.get(m.conversationId)
      if (!c) continue
      if (type && c.type !== type) continue
      let dmUserId: number | null = null
      if (c.type === 'dm') dmUserId = c.dmUserA === userId ? c.dmUserB : c.dmUserA
      out.push({
        conversationId: c.id,
        type: c.type,
        groupId: c.groupId,
        dmUserId,
        pinned: m.pinned,
        lastMessageAt: m.lastMessageAt,
        lastPreview: m.lastPreview,
        unread: m.unread
      })
    }
    out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')
    })
    return out
  }

  // ---- 消息 ----
  async saveMessage(input: { conversationId: number; fromId: number; kind: ChatKind; content: string }): Promise<ChatMessage> {
    const id = this.messageIdSeq++
    const now = new Date().toISOString()
    const msg: ChatMessage = {
      id: String(id),
      conversationId: input.conversationId,
      type: await this.conversationType(input.conversationId),
      fromId: input.fromId,
      nick: '',
      kind: input.kind,
      content: input.content,
      ts: new Date(now).getTime()
    }
    const arr = this.messagesByConv.get(input.conversationId) ?? []
    arr.push(msg)
    this.messagesByConv.set(input.conversationId, arr)
    return msg
  }

  async listMessages(conversationId: number, beforeTs?: number, limit = 50): Promise<ChatMessage[]> {
    let arr = this.messagesByConv.get(conversationId) ?? []
    arr = arr.filter((m) => !this.deletedMessages.has(this.dkey(conversationId, m.id)))
    if (beforeTs) arr = arr.filter((m) => m.ts < beforeTs)
    return [...arr].sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  async getMessage(conversationId: number, messageId: string): Promise<ChatMessage | null> {
    const arr = this.messagesByConv.get(conversationId) ?? []
    return arr.find((m) => m.id === messageId) ?? null
  }

  async findOwnMessageByContent(conversationId: number, userId: number, content: string): Promise<ChatMessage | null> {
    const arr = this.messagesByConv.get(conversationId) ?? []
    return arr.find((m) => m.fromId === userId && m.content === content && !this.deletedMessages.has(this.dkey(conversationId, m.id))) ?? null
  }

  async findOwnMessageByContentGlobal(userId: number, content: string): Promise<ChatMessage | null> {
    for (const [cid, arr] of this.messagesByConv) {
      const m = arr.find((x) => x.fromId === userId && x.content === content && !this.deletedMessages.has(this.dkey(cid, x.id)))
      if (m) return m
    }
    return null
  }

  async softDeleteMessage(conversationId: number, messageId: string): Promise<boolean> {
    const key = this.dkey(conversationId, messageId)
    if (this.deletedMessages.has(key)) return false
    this.deletedMessages.add(key)
    return true
  }

  async hardDeleteMessage(conversationId: number, messageId: string): Promise<boolean> {
    const arr = this.messagesByConv.get(conversationId)
    if (!arr) return false
    const idx = arr.findIndex((m) => m.id === messageId)
    if (idx < 0) return false
    arr.splice(idx, 1)
    this.deletedMessages.delete(this.dkey(conversationId, messageId))
    return true
  }

  async touchConversation(conversationId: number, userId: number, preview: string, fromId?: number): Promise<void> {
    const m = this.conversationMembers.get(this.mkey(conversationId, userId))
    if (!m) return
    m.lastMessageAt = new Date().toISOString()
    m.lastPreview = preview.slice(0, 200)
    if (fromId !== undefined && fromId !== userId) m.unread += 1
  }

  async markRead(conversationId: number, userId: number): Promise<void> {
    const m = this.conversationMembers.get(this.mkey(conversationId, userId))
    if (m) m.unread = 0
  }

  // ---- 文件（UUID 表） ----
  async saveFile(input: { uuid: string; filename: string; mime: string; size: number; storage: 'local'; url: string }): Promise<FileRecord> {
    const r: FileRecord = { ...input, createdAt: new Date().toISOString() }
    this.files.set(r.uuid, r)
    return r
  }

  async getFileByUuid(uuid: string): Promise<FileRecord | null> {
    return this.files.get(uuid) ?? null
  }

  // ---- 好友（与公司无关） ----
  async addFriend(a: number, b: number): Promise<void> {
    const x = Math.min(a, b)
    const y = Math.max(a, b)
    const key = `${x}:${y}`
    if (this.friendPairs.has(key)) throw new AlreadyExistsError('already friends')
    this.friendPairs.set(key, new Date().toISOString())
  }

  async removeFriend(a: number, b: number): Promise<void> {
    const x = Math.min(a, b)
    const y = Math.max(a, b)
    if (!this.friendPairs.delete(`${x}:${y}`)) throw new NotFoundError('not friends')
  }

  async listFriends(userId: number): Promise<Friend[]> {
    const out: Friend[] = []
    for (const [key, addedAt] of this.friendPairs) {
      const [x, y] = key.split(':').map(Number)
      if (x !== userId && y !== userId) continue
      const other = x === userId ? y : x
      const u = this.users.get(other)
      if (u) out.push({ userId: other, username: u.username, nick: u.nick || u.username, avatar: u.avatar, addedAt })
    }
    return out
  }

  async renameCompany(companyId: number, name: string): Promise<void> {
    const c = this.companies.get(companyId)
    if (!c) throw new NotFoundError('company not found')
    c.name = name
  }

  async deleteDepartment(departmentId: number): Promise<void> {
    for (const key of [...this.departmentMembers.keys()]) {
      if (key.startsWith(`${departmentId}:`)) this.departmentMembers.delete(key)
    }
    if (!this.departments.delete(departmentId)) throw new NotFoundError('department not found')
  }

  // ---- 公司邀请（入职流程） ----
  async createCompanyInvitation(input: { companyId: number; userId: number; departmentId?: number | null; invitedBy: number; code: string; expiresAt?: string | null }): Promise<CompanyInvitation> {
    const dup = [...this.invitations.values()].find((i) => i.companyId === input.companyId && i.userId === input.userId && i.status === 'pending')
    if (dup) throw new AlreadyExistsError('invitation pending')
    const company = this.companies.get(input.companyId)
    const invited = this.users.get(input.userId)
    const inviter = this.users.get(input.invitedBy)
    const id = this.invitationIdSeq++
    let deptName: string | null = null
    if (input.departmentId) deptName = this.departments.get(input.departmentId)?.name ?? null
    const inv: CompanyInvitation = {
      id,
      companyId: input.companyId,
      companyName: company?.name ?? '',
      companyCode: company?.code ?? '',
      userId: input.userId,
      username: invited?.username ?? '',
      userNick: invited?.nick || invited?.username || '',
      departmentId: input.departmentId ?? null,
      departmentName: deptName,
      invitedBy: input.invitedBy,
      inviterNick: inviter?.nick || inviter?.username || '',
      code: input.code,
      expiresAt: input.expiresAt ?? null,
      status: 'pending',
      createdAt: new Date().toISOString()
    }
    this.invitations.set(id, inv)
    return inv
  }

  async getCompanyInvitationById(id: number): Promise<CompanyInvitation | null> {
    return this.invitations.get(id) ?? null
  }

  async getCompanyInvitationByCode(code: string): Promise<CompanyInvitation | null> {
    return [...this.invitations.values()].find((i) => i.code === code) ?? null
  }

  async listCompanyInvitations(companyId: number): Promise<CompanyInvitation[]> {
    return [...this.invitations.values()].filter((i) => i.companyId === companyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async listPendingInvitationsForUser(userId: number): Promise<CompanyInvitation[]> {
    return [...this.invitations.values()].filter((i) => i.userId === userId && i.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async setCompanyInvitationStatus(id: number, status: InvitationStatus): Promise<void> {
    const i = this.invitations.get(id)
    if (!i) throw new NotFoundError('invitation not found')
    i.status = status
  }

  async getCompanyMainGroup(companyId: number): Promise<Group | null> {
    const groups = await this.listGroups(companyId)
    const company = this.companies.get(companyId)
    if (groups.length === 0) return null
    return groups.find((g) => g.name === `${company?.name ?? ''}总群`) ?? groups.find((g) => g.name.endsWith('总群')) ?? null
  }

  // ---- 成员人事信息（绑定 用户×公司） ----
  private profiles = new Map<string, MemberProfile>()

  async getMemberProfile(companyId: number, userId: number): Promise<MemberProfile | null> {
    return this.profiles.get(this.mkey(companyId, userId)) ?? null
  }

  async upsertMemberProfile(companyId: number, userId: number, input: Partial<Omit<MemberProfile, 'companyId' | 'userId'>>): Promise<MemberProfile> {
    const base = await this.getMemberProfile(companyId, userId)
    const p: MemberProfile = {
      companyId,
      userId,
      realName: input.realName ?? base?.realName ?? '',
      idCard: input.idCard ?? base?.idCard ?? '',
      bankCard: input.bankCard ?? base?.bankCard ?? '',
      resumeUrl: input.resumeUrl ?? base?.resumeUrl ?? '',
      portfolioUrl: input.portfolioUrl ?? base?.portfolioUrl ?? '',
      updatedAt: new Date().toISOString()
    }
    this.profiles.set(this.mkey(companyId, userId), p)
    return p
  }

  private mkey(a: number, b: number): string {
    return `${a}:${b}`
  }

  private dkey(conversationId: number, messageId: string): string {
    return `${conversationId}:${messageId}`
  }

  private publicUser(u: UserWithPassword): User {
    return {
      id: u.id,
      username: u.username,
      nick: u.nick,
      avatar: u.avatar,
      email: u.email,
      phone: u.phone ?? '',
      extra: u.extra ?? '',
      sessionDays: u.sessionDays,
      createdAt: u.createdAt
    }
  }

  // ---- 登录会话（多端） ----

  private toSession(s: { id: number; userId: number; tokenHash: string; device: string; ip: string; location?: string; createdAt: string; expiresAt: string; lastActiveAt: string }): Session {
    return {
      id: s.id,
      userId: s.userId,
      tokenHash: s.tokenHash,
      device: s.device,
      ip: s.ip,
      location: s.location ?? '',
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastActiveAt: s.lastActiveAt
    }
  }

  async createSession(input: { userId: number; tokenHash: string; device: string; ip: string; location?: string; expiresAt: string }): Promise<Session> {
    const id = this.sessionIdSeq++
    const s: Session = {
      id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      device: input.device,
      ip: input.ip,
      location: input.location ?? '',
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      lastActiveAt: new Date().toISOString()
    }
    this.sessions.set(id, s)
    return this.toSession(s)
  }

  async getSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    for (const s of this.sessions.values()) {
      if (s.tokenHash === tokenHash) return this.toSession(s)
    }
    return null
  }

  async getUserActiveLocation(userId: number): Promise<string> {
    const arr = [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)))
    for (const s of arr) {
      if (new Date(s.expiresAt).getTime() > Date.now()) return s.location ?? ''
    }
    return arr.length ? (arr[0].location ?? '') : ''
  }

  async listSessionsByUser(userId: number): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => this.toSession(s))
  }

  async touchSession(id: number): Promise<void> {
    const s = this.sessions.get(id)
    if (s) s.lastActiveAt = new Date().toISOString()
  }

  async deleteSession(id: number): Promise<void> {
    this.sessions.delete(id)
  }

  async deleteExpiredSessions(now: number): Promise<number> {
    let n = 0
    for (const [id, s] of [...this.sessions.entries()]) {
      if (new Date(s.expiresAt).getTime() < now) {
        this.sessions.delete(id)
        n++
      }
    }
    return n
  }

  async getSessionDays(userId: number): Promise<number | null> {
    return this.users.get(userId)?.sessionDays ?? null
  }

  async setSessionDays(userId: number, days: number | null): Promise<void> {
    const u = this.users.get(userId)
    if (!u) throw new NotFoundError('user not found')
    u.sessionDays = days
  }

  // ---- 邮件配置（SMTP 客户端：主/全局 MainMailConfig + 公司级预留） ----
  async listMailConfigs(scope: { companyId?: number | null }): Promise<MailConfig[]> {
    const companyId = scope.companyId === undefined ? null : scope.companyId
    return [...this.mailConfigs.values()]
      .filter((c) => (c.companyId ?? null) === (companyId ?? null))
      .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.priority - b.priority || a.id - b.id)
  }

  async getMailConfig(id: number): Promise<MailConfig | null> {
    return this.mailConfigs.get(id) ?? null
  }

  async getDefaultMailConfig(scope: { companyId?: number | null }): Promise<MailConfig | null> {
    const list = await this.listMailConfigs(scope)
    return list.find((c) => c.enabled && c.isDefault) ?? list.find((c) => c.enabled) ?? null
  }

  async saveMailConfig(input: { id?: number; companyId?: number | null; email: string; displayName?: string; host: string; port?: number; secure?: boolean; user?: string; password?: string; isDefault?: boolean; enabled?: boolean; priority?: number }): Promise<MailConfig> {
    const existing = input.id ? this.mailConfigs.get(input.id) : undefined
    const cfg: MailConfig = {
      id: input.id ?? this.mailConfigIdSeq++,
      companyId: input.companyId === undefined ? (existing?.companyId ?? null) : input.companyId,
      email: input.email,
      displayName: input.displayName ?? existing?.displayName ?? '',
      host: input.host,
      port: input.port ?? existing?.port ?? 465,
      secure: input.secure ?? existing?.secure ?? true,
      user: input.user ?? existing?.user ?? input.email,
      password: input.password ?? existing?.password ?? '',
      isDefault: input.isDefault ?? existing?.isDefault ?? false,
      enabled: input.enabled ?? existing?.enabled ?? true,
      priority: input.priority ?? existing?.priority ?? 100,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    }
    this.mailConfigs.set(cfg.id, cfg)
    return cfg
  }

  async deleteMailConfig(id: number): Promise<void> {
    this.mailConfigs.delete(id)
  }

  // ---- 假期（全局，供日历显示与多端同步；可增删改） ----
  async listHolidays(year?: number): Promise<Holiday[]> {
    const list = [...this.holidays.values()]
    if (year) {
      const prefix = `${year}-`
      return list.filter((h) => h.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date))
    }
    return list.sort((a, b) => a.date.localeCompare(b.date))
  }

  async saveHoliday(input: { date: string; name: string; type: HolidayType }): Promise<Holiday> {
    const existing = [...this.holidays.values()].find((h) => h.date === input.date)
    const h: Holiday = {
      id: existing?.id ?? this.holidayIdSeq++,
      date: input.date,
      name: input.name,
      type: input.type,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    }
    this.holidays.set(h.id, h)
    return h
  }


  async deleteHoliday(date: string): Promise<void> {
    const hit = [...this.holidays.values()].find((h) => h.date === date)
    if (hit) this.holidays.delete(hit.id)
  }

  // ---- 任务流程系统（memory 存储不支持，仅满足 Store 接口） ----
  private async _taskNotSupported(): Promise<never> {
    throw new Error('任务流程系统仅支持 MySQL 存储')
  }
  createProject(): Promise<never> { return this._taskNotSupported() }
  listProjects(): Promise<never> { return this._taskNotSupported() }
  deleteProject(): Promise<never> { return this._taskNotSupported() }
  setProjectRole(): Promise<never> { return this._taskNotSupported() }
  listProjectMembers(): Promise<never> { return this._taskNotSupported() }
  createTask(): Promise<never> { return this._taskNotSupported() }
  listTasks(): Promise<never> { return this._taskNotSupported() }
  getTask(): Promise<never> { return this._taskNotSupported() }
  getTaskDetail(): Promise<never> { return this._taskNotSupported() }
  updateTask(): Promise<never> { return this._taskNotSupported() }
  deleteTask(): Promise<never> { return this._taskNotSupported() }
  setTaskStatus(): Promise<never> { return this._taskNotSupported() }
  updateTaskReminder(): Promise<never> { return this._taskNotSupported() }
  addAssignment(): Promise<never> { return this._taskNotSupported() }
  removeAssignment(): Promise<never> { return this._taskNotSupported() }
  setAssignmentStatus(): Promise<never> { return this._taskNotSupported() }
  addTaskComment(): Promise<never> { return this._taskNotSupported() }
  addTaskIssue(): Promise<never> { return this._taskNotSupported() }
  resolveTaskIssue(): Promise<never> { return this._taskNotSupported() }
  requestTaskExtension(): Promise<never> { return this._taskNotSupported() }
  decideTaskExtension(): Promise<never> { return this._taskNotSupported() }
  createRequirement(): Promise<never> { return this._taskNotSupported() }
  listRequirements(): Promise<never> { return this._taskNotSupported() }
  getRequirement(): Promise<never> { return this._taskNotSupported() }
  updateRequirement(): Promise<never> { return this._taskNotSupported() }
  setRequirementStatus(): Promise<never> { return this._taskNotSupported() }
  deleteRequirement(): Promise<never> { return this._taskNotSupported() }
  linkRequirementTasks(): Promise<never> { return this._taskNotSupported() }
  createBug(): Promise<never> { return this._taskNotSupported() }
  listBugs(): Promise<never> { return this._taskNotSupported() }
  getBug(): Promise<never> { return this._taskNotSupported() }
  updateBug(): Promise<never> { return this._taskNotSupported() }
  setBugStatus(): Promise<never> { return this._taskNotSupported() }
  deleteBug(): Promise<never> { return this._taskNotSupported() }
  createPlan(): Promise<never> { return this._taskNotSupported() }
  listPlans(): Promise<never> { return this._taskNotSupported() }
  updatePlan(): Promise<never> { return this._taskNotSupported() }
  deletePlan(): Promise<never> { return this._taskNotSupported() }
  createDocument(): Promise<never> { return this._taskNotSupported() }
  listDocuments(): Promise<never> { return this._taskNotSupported() }
  updateDocument(): Promise<never> { return this._taskNotSupported() }
  deleteDocument(): Promise<never> { return this._taskNotSupported() }
  createWikiPage(): Promise<never> { return this._taskNotSupported() }
  listWikiPages(): Promise<never> { return this._taskNotSupported() }
  updateWikiPage(): Promise<never> { return this._taskNotSupported() }
  deleteWikiPage(): Promise<never> { return this._taskNotSupported() }
  dashboardStats(): Promise<never> { return this._taskNotSupported() }
  memberTracking(): Promise<never> { return this._taskNotSupported() }
}
