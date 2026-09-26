export interface User {
  id: number
  username: string
  nick: string
  avatar: string
  email: string
  /** 手机号（直接存储于数据库列） */
  phone: string
  /** 拓展信息（JSON 字符串）：紧急联系人等 */
  extra: string
  /** 登录有效期（天）：该用户新建登录会话的存活天数；null=用服务端默认值 */
  sessionDays: number | null
  createdAt: string
}

/** 公司在组织中的角色 */
export type CompanyRole = 'owner' | 'admin' | 'member'
/** 群内的角色 */
export type GroupRole = 'owner' | 'admin' | 'member'

export interface Company {
  id: number
  name: string
  /** 加入码：其它成员凭 code 加入 */
  code: string
  ownerId: number
  createdAt: string
}

export interface Member {
  companyId: number
  userId: number
  role: CompanyRole
  joinedAt: string
  username?: string
  nick?: string
  avatar?: string
  phone?: string
  extra?: string
  /** 登录归属地（最近有效会话） */
  location?: string
  /** 当前是否在线（由服务端按 presence 填充） */
  online?: boolean
}

/** 用户所持公司的摘要 */
export interface Membership {
  company: Company
  role: CompanyRole
}

/** 部门：由公司管理员创建，挂在公司下（可嵌套） */
export interface Department {
  id: number
  companyId: number
  name: string
  parentId: number | null
  createdAt: string
}

export interface DepartmentMember {
  departmentId: number
  userId: number
  joinedAt: string
  phone?: string
  extra?: string
  location?: string
  username?: string
  nick?: string
  avatar?: string
  online?: boolean
}

/** 群：由公司成员创建，可挂到公司或部门下 */
export interface Group {
  id: number
  companyId: number
  departmentId: number | null
  name: string
  code: string
  ownerId: number
  createdAt: string
}

export interface GroupMember {
  groupId: number
  userId: number
  role: GroupRole
  joinedAt: string
  mutedUntil?: string | null
  username?: string
  nick?: string
  avatar?: string
  online?: boolean
}

// ==================== 对话 / 消息 / 文件 ====================

/** 对话类型：群聊 或 一对一私信 */
export type ConversationType = 'group' | 'dm'
/** 消息种类：text 文本(含表情字串)、image 图片、video 视频、file 文件、folder 文件夹 */
export type ChatKind = 'text' | 'image' | 'video' | 'file' | 'folder'

/** 对话：群聊(groupId)或私信(dmUserA/dmUserB 无序二元组) */
export interface Conversation {
  id: number
  type: ConversationType
  groupId: number | null
  dmUserA: number | null
  dmUserB: number | null
  createdAt: string
}

/** 会话成员（每个用户在每个对话里的个人状态：置顶/最新消息/未读） */
export interface ConversationMember {
  conversationId: number
  userId: number
  pinned: boolean
  lastMessageAt: string | null
  lastPreview: string | null
  unread: number
}

/** 对话列表条目（按 置顶优先 + 最新消息倒序） */
export interface ConversationItem {
  conversationId: number
  type: ConversationType
  groupId: number | null
  /** 私信时对方的 userId（用于解析昵称/头像） */
  dmUserId: number | null
  pinned: boolean
  lastMessageAt: string | null
  lastPreview: string | null
  unread: number
}

/** 消息 */
export interface ChatMessage {
  id: string
  conversationId: number
  type: ConversationType
  fromId: number
  nick: string
  avatar?: string
  kind: ChatKind
  /** 文本/表情字串，或图片/文件对应的 UUID（多文件用逗号分隔） */
  content: string
  ts: number
}

/** 上传文件记录（UUID 表） */
export interface FileRecord {
  uuid: string
  filename: string
  mime: string
  size: number
  storage: 'local'
  url: string
  createdAt: string
}

/** 好友（与公司无关，钉钉无公司也可加好友） */
export interface Friend {
  userId: number
  username: string
  nick: string
  avatar: string
  addedAt: string
}

// ==================== 公司邀请（入职流程：管理员邀请 → 用户同意） ====================

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired'

/** 公司入司邀请（含公司/邀请人/部门摘要，供双方页面展示） */
export interface CompanyInvitation {
  id: number
  companyId: number
  companyName: string
  companyCode: string
  userId: number
  username: string
  userNick: string
  departmentId: number | null
  departmentName: string | null
  invitedBy: number
  inviterNick: string
  /** 邀请码：管理员生成，用户可凭码加入；被使用（接受）后标记已使用 */
  code: string
  /** 可选过期时间（ISO）；过期未用标记为 expired */
  expiresAt: string | null
  status: InvitationStatus
  createdAt: string
}

/** 成员人事信息：绑定「用户 × 公司」，不同公司可用不同职位/银行卡；默认全空，入职时填写 */
export interface MemberProfile {
  companyId: number
  userId: number
  realName: string
  idCard: string
  bankCard: string
  resumeUrl: string
  portfolioUrl: string
  updatedAt: string
}

// ==================== 登录会话（多端） ====================

/** 一个登录会话 = 一次登录产生的 token（支持多客户端同时登录）。 */
export interface Session {
  id: number
  userId: number
  /** token 的 sha256 摘要（不存明文） */
  tokenHash: string
  /** 设备标识（客户端上报，如 "Windows / Chrome"） */
  device: string
  ip: string
  /** IP 归属地（客户端上报） */
  location: string
  /** 登录时间 */
  createdAt: string
  /** 过期时间（登录有效期）；过期后该会话失效，token 不可再用 */
  expiresAt: string
  /** 最近活跃时间 */
  lastActiveAt: string
}

// ==================== 邮件配置（SMTP 客户端） ====================

/**
 * 邮件发送配置（SMTP 客户端）。
 *
 * 作用域划分：
 * - `companyId = null` → 主/全局配置（系统级）：用户注册、登录验证、验证码等，未配置公司邮件的场合都用它。支持多个邮箱（每行一条）。
 * - `companyId != null` → 公司专属配置（默认为空，在公司设置里配置）；配置后该公司相关邮件用公司邮箱发送。
 */
export interface MailConfig {
  id: number
  /** null=主配置（全局/系统级）；非 null=公司级配置 */
  companyId: number | null
  /** 发送邮箱，如 admin@example.com */
  email: string
  /** 发件显示名，如「某某OA」 */
  displayName: string
  /** SMTP 服务器主机 */
  host: string
  /** SMTP 端口（465/587/25 等） */
  port: number
  /** true=SSL/TLS 直连（465）；false=明文/STARTTLS（587/25） */
  secure: boolean
  /** SMTP 认证用户名（通常=email） */
  user: string
  /** SMTP 密码 / 授权码 */
  password: string
  /** 作用域内是否默认发件账号（多邮箱时优先用） */
  isDefault: boolean
  /** 是否启用 */
  enabled: boolean
  /** 发送优先级（越小越优先；作用域多邮箱时按此顺序尝试） */
  priority: number
  createdAt: string
}

