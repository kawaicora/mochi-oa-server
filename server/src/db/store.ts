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
  InvitationStatus,
  Member,
  MemberProfile,
  Membership,
  MailConfig,
  Session,
  User
} from '../types'

/** 带密码散列的用户记录（仅内部使用） */
export interface UserWithPassword extends User {
  passwordHash: string
}

export class AlreadyExistsError extends Error {}
export class NotFoundError extends Error {}
export class NotMemberError extends Error {}
export class PermissionError extends Error {}

/** 存储层抽象：生产用 MySqlStore，开发/测试用 MemoryStore */
export interface Store {
  init(): Promise<void>
  close(): Promise<void>

  // ---- 用户 ----
  createUser(input: { username: string; passwordHash: string; nick?: string; email?: string; avatar?: string; phone?: string }): Promise<User>
  getUserByUsername(username: string): Promise<UserWithPassword | null>
  getUserByEmail(email: string): Promise<UserWithPassword | null>
  getUserById(id: number): Promise<User | null>
  listUsers(): Promise<User[]>
  updateUserProfile(userId: number, patch: { nick?: string; avatar?: string; phone?: string; extra?: string }): Promise<void>
  /** 更新密码散列（修改密码用） */
  updateUserPassword(userId: number, passwordHash: string): Promise<void>

  // ---- 公司 ----
  createCompany(input: { name: string; code: string; ownerId: number }): Promise<Company>
  getCompanyById(id: number): Promise<Company | null>
  getCompanyByCode(code: string): Promise<Company | null>
  getCompanyByName(name: string): Promise<Company | null>
  listCompanies(keyword?: string): Promise<Company[]>
  addMember(companyId: number, userId: number, role: CompanyRole): Promise<void>
  removeMember(companyId: number, userId: number): Promise<void>
  setRole(companyId: number, userId: number, role: CompanyRole): Promise<void>
  getMemberRole(companyId: number, userId: number): Promise<CompanyRole | null>
  getMembers(companyId: number): Promise<Member[]>
  getUserCompanies(userId: number): Promise<Membership[]>
  /** 重命名公司（owner/admin） */
  renameCompany(companyId: number, name: string): Promise<void>
  /** 转让公司：更新 owner_id */
  setCompanyOwner(companyId: number, ownerId: number): Promise<void>
  /** 解散公司：删除成员、部门、群、会话与邀请 */
  deleteCompany(companyId: number): Promise<void>

  // ---- 部门（管理员创建） ----
  createDepartment(input: { companyId: number; name: string; parentId?: number | null }): Promise<Department>
  getDepartmentById(id: number): Promise<Department | null>
  listDepartments(companyId: number): Promise<Department[]>
  assignDepartment(departmentId: number, userId: number): Promise<void>
  removeDepartmentMember(departmentId: number, userId: number): Promise<void>
  getDepartmentMembers(departmentId: number): Promise<DepartmentMember[]>
  /** 删除部门（owner/admin）：级联移除成员归属 */
  deleteDepartment(departmentId: number): Promise<void>

  // ---- 群（成员创建） ----
  createGroup(input: { companyId: number; departmentId?: number | null; name: string; code: string; ownerId: number }): Promise<Group>
  getGroupById(id: number): Promise<Group | null>
  getGroupByCode(code: string): Promise<Group | null>
  getGroupByName(companyId: number, name: string): Promise<Group | null>
  listGroups(companyId?: number, keyword?: string): Promise<Group[]>
  addGroupMember(groupId: number, userId: number, role: GroupRole): Promise<void>
  removeGroupMember(groupId: number, userId: number): Promise<void>
  getGroupMemberRole(groupId: number, userId: number): Promise<GroupRole | null>
  /** 取群成员（含禁言截止时间）；不在群返回 null */
  getGroupMember(groupId: number, userId: number): Promise<{ role: GroupRole; mutedUntil: Date | null } | null>
  setGroupMemberRole(groupId: number, userId: number, role: GroupRole): Promise<void>
  setGroupMemberMuted(groupId: number, userId: number, mutedUntil: Date | null): Promise<void>
  /** 转让群主：更新群 owner_id */
  setGroupOwner(groupId: number, ownerId: number): Promise<void>
  /** 解散群：删除群成员、关联会话与消息 */
  deleteGroup(groupId: number): Promise<void>
  getGroupMembers(groupId: number): Promise<GroupMember[]>
  getUserGroups(userId: number): Promise<Group[]>

  // ---- 对话（群聊 + 私信统一） ----
  /** 取某群对应的对话；不存在则按需创建（ownerId 为建群者） */
  getOrCreateGroupConversation(groupId: number, ownerId?: number): Promise<Conversation>
  /** 取 a、b 两人间的私信对话；不存在则创建（无序） */
  getOrCreateDmConversation(a: number, b: number): Promise<Conversation>
  getConversationById(id: number): Promise<Conversation | null>
  addConversationMember(conversationId: number, userId: number): Promise<void>
  removeConversationMember(conversationId: number, userId: number): Promise<void>
  setConversationPinned(conversationId: number, userId: number, pinned: boolean): Promise<void>
  getConversationMember(conversationId: number, userId: number): Promise<ConversationMember | null>
  /** 对话列表：置顶优先，再按最新消息时间倒序 */
  listConversations(userId: number, type?: ConversationType): Promise<ConversationItem[]>

  // ---- 消息 ----
  saveMessage(input: { conversationId: number; fromId: number; kind: ChatKind; content: string }): Promise<ChatMessage>
  /** 拉取消息（最新在前）；beforeTs 提供则只取更早的（分页）；不含软删除的 */
  listMessages(conversationId: number, beforeTs?: number, limit?: number): Promise<ChatMessage[]>
  /** 取单条消息（含已删除），删除前校验归属用 */
  getMessage(conversationId: number, messageId: string): Promise<ChatMessage | null>
  /** 软删除：客户端删除/清空只打 deletedAt 标记 */
  softDeleteMessage(conversationId: number, messageId: string): Promise<boolean>
  /** 真正删除：仅管理员（公司 owner/admin） */
  hardDeleteMessage(conversationId: number, messageId: string): Promise<boolean>
  /** 更新某会话成员的 最新消息/预览/未读（fromId 除外） */
  touchConversation(conversationId: number, userId: number, preview: string, fromId?: number): Promise<void>
  /** 清除未读 */
  markRead(conversationId: number, userId: number): Promise<void>

  // ---- 文件（UUID 表） ----
  saveFile(input: { uuid: string; filename: string; mime: string; size: number; storage: 'local'; url: string }): Promise<FileRecord>
  getFileByUuid(uuid: string): Promise<FileRecord | null>

  // ---- 好友（与公司无关） ----
  addFriend(a: number, b: number): Promise<void>
  removeFriend(a: number, b: number): Promise<void>
  listFriends(userId: number): Promise<Friend[]>

  // ---- 公司邀请（入职流程） ----
  createCompanyInvitation(input: { companyId: number; userId: number; departmentId?: number | null; invitedBy: number; code: string; expiresAt?: string | null }): Promise<CompanyInvitation>
  getCompanyInvitationById(id: number): Promise<CompanyInvitation | null>
  getCompanyInvitationByCode(code: string): Promise<CompanyInvitation | null>
  listCompanyInvitations(companyId: number): Promise<CompanyInvitation[]>
  listPendingInvitationsForUser(userId: number): Promise<CompanyInvitation[]>
  setCompanyInvitationStatus(id: number, status: InvitationStatus): Promise<void>
  /** 找公司的全员群（总群）：按「{公司名}总群」约定，回退到创建人自建群 */
  getCompanyMainGroup(companyId: number): Promise<Group | null>

  // ---- 成员人事信息（绑定 用户×公司，入职填写） ----
  getMemberProfile(companyId: number, userId: number): Promise<MemberProfile | null>
  upsertMemberProfile(companyId: number, userId: number, input: Partial<Omit<MemberProfile, 'companyId' | 'userId'>>): Promise<MemberProfile>

  // ---- 登录会话（多端） ----
  /** 新建会话，返回会话记录 */
  createSession(input: { userId: number; tokenHash: string; device: string; ip: string; location?: string; expiresAt: string }): Promise<Session>
  /** 按 token 摘要找会话 */
  getSessionByTokenHash(tokenHash: string): Promise<Session | null>
  /** 某用户的全部会话（新→旧） */
  listSessionsByUser(userId: number): Promise<Session[]>
  getUserActiveLocation(userId: number): Promise<string>
  getUserActiveLocation(userId: number): Promise<string>
  /** 刷新会话最近活跃时间 */
  touchSession(id: number): Promise<void>
  /** 删除会话（登出 / 踢下线） */
  deleteSession(id: number): Promise<void>
  /** 清理已过期会话，返回删除条数 */
  deleteExpiredSessions(now: number): Promise<number>
  /** 用户登录有效期（天） */
  getSessionDays(userId: number): Promise<number | null>
  /** 设置用户登录有效期（天） */
  setSessionDays(userId: number, days: number | null): Promise<void>

  // ---- 邮件配置（SMTP 客户端：主/全局 MainMailConfig + 公司级预留） ----
  /** 列出发件配置：companyId 省略/null=主配置（多邮箱多行）；传具体 id=该公司配置（默认空） */
  listMailConfigs(scope: { companyId?: number | null }): Promise<MailConfig[]>
  /** 取单条配置 */
  getMailConfig(id: number): Promise<MailConfig | null>
  /** 取作用域下用于发送的配置：优先 isDefault，其次 priority 最小且 enabled；无则 null */
  getDefaultMailConfig(scope: { companyId?: number | null }): Promise<MailConfig | null>
  /** 新增或更新一条邮件配置（id 有=更新，无=新增） */
  saveMailConfig(input: { id?: number; companyId?: number | null; email: string; displayName?: string; host: string; port?: number; secure?: boolean; user?: string; password?: string; isDefault?: boolean; enabled?: boolean; priority?: number }): Promise<MailConfig>
  /** 删除一条配置 */
  deleteMailConfig(id: number): Promise<void>
}
