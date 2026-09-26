import { DataTypes, Model, type Sequelize } from 'sequelize'
import type { ChatKind, CompanyRole, ConversationType, GroupRole } from '../types'

/** ORM 模型定义（Sequelize，声明式，类似 SQLAlchemy；建表用 sequelize.sync()，无手写 SQL） */

export class UserModel extends Model {
  declare id: number
  declare username: string
  declare passwordHash: string
  declare nick: string
  declare avatar: string
  declare email: string
  declare phone: string
  declare extra: string | null
  declare sessionDays: number | null
  declare createdAt: string
}

export class CompanyModel extends Model {
  declare id: number
  declare name: string
  declare code: string
  declare ownerId: number
  declare createdAt: string
}

export class CompanyMemberModel extends Model {
  declare companyId: number
  declare userId: number
  declare role: CompanyRole
  declare joinedAt: string
}

export class DepartmentModel extends Model {
  declare id: number
  declare companyId: number
  declare name: string
  declare parentId: number | null
  declare createdAt: string
}

export class DepartmentMemberModel extends Model {
  declare departmentId: number
  declare userId: number
  declare joinedAt: string
}

export class GroupModel extends Model {
  declare id: number
  declare companyId: number
  declare departmentId: number | null
  declare name: string
  declare code: string
  declare ownerId: number
  declare createdAt: string
}

export class GroupMemberModel extends Model {
  declare groupId: number
  declare userId: number
  declare role: GroupRole
  declare joinedAt: string
  declare mutedUntil: Date | null
}

export class ConversationModel extends Model {
  declare id: number
  declare type: ConversationType
  declare groupId: number | null
  declare dmUserA: number | null
  declare dmUserB: number | null
  declare createdAt: string
}

export class ConversationMemberModel extends Model {
  declare conversationId: number
  declare userId: number
  declare pinned: boolean
  declare lastMessageAt: string | null
  declare lastPreview: string | null
  declare unread: number
}

export class MessageModel extends Model {
  declare id: number
  declare conversationId: number
  declare fromId: number
  declare kind: ChatKind
  declare content: string
  declare createdAt: string
}

export class FileModel extends Model {
  declare uuid: string
  declare filename: string
  declare mime: string
  declare size: number
  declare storage: 'local'
  declare url: string
  declare createdAt: string
}

export class FriendModel extends Model {
  declare userA: number
  declare userB: number
  declare createdAt: string
}

export class CompanyInvitationModel extends Model {
  declare id: number
  declare companyId: number
  declare userId: number
  declare departmentId: number | null
  declare invitedBy: number
  declare code: string
  declare expiresAt: string | null
  declare status: 'pending' | 'accepted' | 'declined' | 'expired'
  declare createdAt: string
}

/** 成员人事信息：绑定「用户 × 公司」。同一用户在不同公司可填不同职位/银行卡；默认全空，入职时填写。 */
export class MemberProfileModel extends Model {
  declare companyId: number
  declare userId: number
  declare realName: string
  declare idCard: string
  declare bankCard: string
  declare resumeUrl: string
  declare portfolioUrl: string
  declare updatedAt: string
}

/** 登录会话（多端）：每行 = 一次登录产生的 token 摘要，支持多客户端同时在线 */
export class SessionModel extends Model {
  declare id: number
  declare userId: number
  declare tokenHash: string
  declare device: string
  declare ip: string
  declare location: string
  declare expiresAt: string
  declare lastActiveAt: string
  declare createdAt: string
}


/** 邮件发送配置（SMTP 客户端）。companyId=null → 主/全局配置（系统级，多邮箱每行一条）；非 null → 公司级配置（默认为空，在公司设置里配置）。 */
export class MailConfigModel extends Model {
  declare id: number
  declare companyId: number | null
  declare email: string
  declare displayName: string
  declare host: string
  declare port: number
  declare secure: boolean
  declare user: string
  declare password: string
  declare isDefault: boolean
  declare enabled: boolean
  declare priority: number
  declare createdAt: string
}

export function initModels(sequelize: Sequelize): void {
  UserModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
      nick: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
      avatar: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
      email: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
      phone: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '' },
      extra: { type: DataTypes.TEXT, allowNull: true },
      sessionDays: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'session_days' }
    },
    { sequelize, modelName: 'users', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  CompanyModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(128), allowNull: false },
      code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      ownerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'owner_id' }
    },
    { sequelize, modelName: 'companies', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  CompanyMemberModel.init(
    {
      companyId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'company_id' },
      userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_id' },
      role: { type: DataTypes.ENUM('owner', 'admin', 'member'), allowNull: false, defaultValue: 'member' }
    },
    { sequelize, modelName: 'company_members', timestamps: true, underscored: true, createdAt: 'joinedAt', updatedAt: false }
  )

  DepartmentModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'company_id' },
      name: { type: DataTypes.STRING(64), allowNull: false },
      parentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'parent_id' }
    },
    { sequelize, modelName: 'departments', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  DepartmentMemberModel.init(
    {
      departmentId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'department_id' },
      userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_id' }
    },
    { sequelize, modelName: 'department_members', timestamps: true, underscored: true, createdAt: 'joinedAt', updatedAt: false }
  )

  GroupModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'company_id' }, // 0=无公司(钉钉：上级 company 为 0)
      departmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'department_id' },
      name: { type: DataTypes.STRING(64), allowNull: false },
      code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      ownerId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'owner_id' }
    },
    { sequelize, modelName: 'groups', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  GroupMemberModel.init(
    {
      groupId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'group_id' },
      userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_id' },
      role: { type: DataTypes.ENUM('owner', 'admin', 'member'), allowNull: false, defaultValue: 'member' },
      mutedUntil: { type: DataTypes.DATE, allowNull: true, field: 'muted_until' }
    },
    { sequelize, modelName: 'group_members', timestamps: true, underscored: true, createdAt: 'joinedAt', updatedAt: false }
  )

  ConversationModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      type: { type: DataTypes.ENUM('group', 'dm'), allowNull: false },
      groupId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'group_id' },
      dmUserA: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'dm_user_a' },
      dmUserB: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'dm_user_b' }
    },
    { sequelize, modelName: 'conversations', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  ConversationMemberModel.init(
    {
      conversationId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'conversation_id' },
      userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_id' },
      pinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lastMessageAt: { type: DataTypes.DATE(3), allowNull: true, field: 'last_message_at' },
      lastPreview: { type: DataTypes.STRING(255), allowNull: true, field: 'last_preview' },
      unread: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
    },
    { sequelize, modelName: 'conversation_members', timestamps: false }
  )

  MessageModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      conversationId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'conversation_id' },
      fromId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'from_id' },
      kind: { type: DataTypes.ENUM('text', 'image', 'file', 'video', 'folder'), allowNull: false, defaultValue: 'text' },
      content: { type: DataTypes.TEXT, allowNull: false },
      deletedAt: { type: DataTypes.DATE(3), allowNull: true, field: 'deleted_at' }
    },
    { sequelize, modelName: 'messages', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  FileModel.init(
    {
      uuid: { type: DataTypes.CHAR(36), primaryKey: true },
      filename: { type: DataTypes.STRING(255), allowNull: false },
      mime: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
      size: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      storage: { type: DataTypes.ENUM('local', 'ftp'), allowNull: false, defaultValue: 'local' },
      url: { type: DataTypes.STRING(512), allowNull: false }
    },
    { sequelize, modelName: 'files', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  FriendModel.init(
    {
      userA: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_a' },
      userB: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_b' }
    },
    { sequelize, modelName: 'friends', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  CompanyInvitationModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'company_id' },
      userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'user_id' },
      departmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'department_id' },
      invitedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'invited_by' },
      code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      expiresAt: { type: DataTypes.DATE(3), allowNull: true, field: 'expires_at' },
      status: { type: DataTypes.ENUM('pending', 'accepted', 'declined', 'expired'), allowNull: false, defaultValue: 'pending' }
    },
    { sequelize, modelName: 'company_invitations', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  MemberProfileModel.init(
    {
      companyId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'company_id' },
      userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, field: 'user_id' },
      realName: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '', field: 'real_name' },
      idCard: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '', field: 'id_card' },
      bankCard: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '', field: 'bank_card' },
      resumeUrl: { type: DataTypes.STRING(512), allowNull: false, defaultValue: '', field: 'resume_url' },
      portfolioUrl: { type: DataTypes.STRING(512), allowNull: false, defaultValue: '', field: 'portfolio_url' }
    },
    { sequelize, modelName: 'member_profiles', timestamps: true, underscored: true, updatedAt: 'updatedAt', createdAt: false }
  )

  SessionModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'user_id' },
      tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true, field: 'token_hash' },
      device: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
      ip: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
      location: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
      expiresAt: { type: DataTypes.DATE(3), allowNull: false, field: 'expires_at' },
      lastActiveAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW, field: 'last_active_at' }
    },
    { sequelize, modelName: 'sessions', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )

  MailConfigModel.init(
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, field: 'company_id' }, // null=主配置（全局）；非 null=公司级
      email: { type: DataTypes.STRING(128), allowNull: false },
      displayName: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '', field: 'display_name' },
      host: { type: DataTypes.STRING(255), allowNull: false },
      port: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 465 },
      secure: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      user: { type: DataTypes.STRING(128), allowNull: false, defaultValue: '' },
      password: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_default' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 }
    },
    { sequelize, modelName: 'mail_configs', timestamps: true, underscored: true, createdAt: 'createdAt', updatedAt: false }
  )


  // 关联（映射表关系，供 join 查询使用）
  MailConfigModel.belongsTo(CompanyModel, { foreignKey: 'companyId' })
  CompanyModel.belongsTo(UserModel, { as: 'owner', foreignKey: 'ownerId' })
  CompanyModel.hasMany(CompanyMemberModel, { foreignKey: 'companyId' })
  CompanyModel.hasMany(DepartmentModel, { foreignKey: 'companyId' })
  CompanyMemberModel.belongsTo(CompanyModel, { foreignKey: 'companyId' })
  CompanyMemberModel.belongsTo(UserModel, { foreignKey: 'userId' })

  DepartmentModel.belongsTo(CompanyModel, { foreignKey: 'companyId' })
  DepartmentModel.belongsTo(DepartmentModel, { as: 'parent', foreignKey: 'parentId' })
  DepartmentMemberModel.belongsTo(DepartmentModel, { foreignKey: 'departmentId' })
  DepartmentMemberModel.belongsTo(UserModel, { foreignKey: 'userId' })

  GroupModel.belongsTo(CompanyModel, { foreignKey: 'companyId' })
  GroupModel.belongsTo(DepartmentModel, { foreignKey: 'departmentId' })
  GroupModel.belongsTo(UserModel, { as: 'owner', foreignKey: 'ownerId' })
  GroupMemberModel.belongsTo(GroupModel, { foreignKey: 'groupId' })
  GroupMemberModel.belongsTo(UserModel, { foreignKey: 'userId' })

  ConversationMemberModel.belongsTo(ConversationModel, { foreignKey: 'conversationId' })
  MessageModel.belongsTo(ConversationModel, { foreignKey: 'conversationId' })

  CompanyInvitationModel.belongsTo(CompanyModel, { foreignKey: 'companyId' })
  CompanyInvitationModel.belongsTo(UserModel, { as: 'user', foreignKey: 'userId' })
  CompanyInvitationModel.belongsTo(UserModel, { as: 'inviter', foreignKey: 'invitedBy' })
  CompanyInvitationModel.belongsTo(DepartmentModel, { foreignKey: 'departmentId' })
}
