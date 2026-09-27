import type { Server, Socket } from 'socket.io'
import { fail, groupRoom, ok, userRoom } from '../util'
import type { AuthUser, Ctx } from './auth'
import type { ChatKind, Conversation } from '../types'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 4000
const isKind = (v: unknown): v is ChatKind => v === 'text' || v === 'image' || v === 'file' || v === 'video' || v === 'audio' || v === 'folder'
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v)

/** 文件夹消息的相对路径（如 6/p20260921_merge 或 default/p20260921_merge）：逐段清洗、拒绝穿越/根目录 */
function isFolderPath(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const parts = v.split('/').filter(Boolean)
  if (parts.length < 2) return false
  return parts.every((s) => {
    if (s === '.' || s === '..' || s === '~') return false
    return /^[\w\u4e00-\u9fa5\-\s.()（）]+$/.test(s) && !s.includes('\\')
  })
}

/** 发送兜底：文本内容是否为音频引用（服务器 URL / 本地路径 / file://），识别为 audio 类型 */
function isAudioRef(v: unknown): boolean {
  if (typeof v !== 'string') return false
  if (!/\.(mp3|wav|flac|aac|ogg|oga|opus|weba|m4a|m4b|wma|ac3|aiff|aif|au|amr|alac|mka|mid|midi|cda|cue)(\?|$)/i.test(v)) return false
  if (/^https?:\/\//i.test(v)) return true
  if (/^file:\/\//i.test(v)) return true
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true
  if (/^\/[^/]/.test(v)) return true
  return false
}

/** 内容归一：文本/表情字串直接存；图片/文件把 UUID 解析成地址(URL)再存；文件夹直接存相对路径 */
async function resolveContent(store: Ctx['store'], kind: ChatKind, raw: string): Promise<string | null> {
  if (kind === 'text') return raw.trim()
  if (kind === 'folder') return isFolderPath(raw) ? raw : null
  if (isUuid(raw)) {
    const f = await store.getFileByUuid(raw)
    return f ? f.url : null
  }
  return raw
}

/** 对话列表/历史条目的预览文本：文本直接显示（含表情字串），图片/视频/文件给占位 */
const previewOf = (kind: ChatKind, content: string): string =>
  kind === 'text' ? content : kind === 'image' ? '[图片]' : kind === 'video' ? '[视频]' : kind === 'audio' ? '[音频]' : kind === 'folder' ? '[文件夹]' : '[文件]'

/** 填消息里的发送者昵称 + 头像 */
async function fillNicks(store: Ctx['store'], msgs: { fromId: number; nick: string; avatar?: string }[]): Promise<void> {
  const ids = [...new Set(msgs.map((m) => m.fromId))]
  const cache = new Map<number, { nick: string; avatar: string }>()
  for (const id of ids) {
    const u = await store.getUserById(id)
    cache.set(id, { nick: u ? u.nick || u.username : '', avatar: u?.avatar ?? '' })
  }
  for (const m of msgs) {
    const c = cache.get(m.fromId)
    if (c) {
      m.nick = c.nick
      m.avatar = c.avatar
    }
  }
}

/** 是否公司管理员（owner/admin，权限组：创建公司默认 owner，可添加子管理员） */
async function isCompanyAdmin(store: Ctx['store'], companyId: number, userId: number): Promise<boolean> {
  const role = await store.getMemberRole(companyId, userId)
  return role === 'owner' || role === 'admin'
}

/** 删除后通知同对话的在线客户端隐藏该消息 */
function broadcastDeleted(io: Server, conv: Conversation, conversationId: number, messageId: string): void {
  const payload = { conversationId, messageId }
  if (conv.type === 'group' && conv.groupId) {
    io.to(groupRoom(conv.groupId)).emit('message:deleted', payload)
  } else {
    if (conv.dmUserA) io.to(userRoom(conv.dmUserA)).emit('message:deleted', payload)
    if (conv.dmUserB) io.to(userRoom(conv.dmUserB)).emit('message:deleted', payload)
  }
}

export function registerConversationHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ---- 群聊发消息（落库 + 群内广播） ----
    socket.on('chat:send', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; kind?: unknown; content?: unknown; text?: unknown }
      const groupId = Number(d.groupId)
      const kind0: ChatKind = isKind(d.kind) ? d.kind : 'text'
      const raw = d.content !== undefined ? d.content : d.text
      // 发送兜底：文本内容若是音频引用（服务器URL/本地路径）→ 记为 audio 类型
      const kind = kind0 === 'text' && isAudioRef(raw) ? 'audio' : kind0
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      if (kind === 'text' && !isText(raw)) return ack(fail('消息不合法（1-4000 字）'))
      if ((kind === 'image' || kind === 'file' || kind === 'video' || kind === 'audio' || kind === 'folder') && typeof raw !== 'string') return ack(fail('需要文件地址、UUID 或文件夹路径'))
      if ((await store.getGroupMemberRole(groupId, auth.id)) === null) return ack(fail('不在群中'))
      const me = await store.getGroupMember(groupId, auth.id)
      if (me && me.mutedUntil && me.mutedUntil.getTime() > Date.now()) return ack(fail('您已被禁言'))

      const content = await resolveContent(store, kind, String(raw))
      if (!content) return ack(fail('文件不存在'))
      const conv = await store.getOrCreateGroupConversation(groupId)
      const msg = await store.saveMessage({ conversationId: conv.id, fromId: auth.id, kind, content })
      msg.nick = auth.nick
      msg.avatar = (await store.getUserById(auth.id))?.avatar ?? ''

      // 更新该群所有成员的会话列表（最新消息/预览/未读）
      const members = await store.getGroupMembers(groupId)
      for (const mem of members) {
        await store.touchConversation(conv.id, mem.userId, previewOf(kind, content), auth.id)
      }
      // 群内其他成员收一份；发送方经自己的 userRoom 收一份（避免同时进 groupRoom+userRoom 造成双份）
      io.to(groupRoom(groupId)).except(socket.id).emit('chat:message', msg)
      io.to(userRoom(auth.id)).emit('chat:message', msg)
      ack(ok({ id: msg.id }))
    })

    // ---- 群聊历史 ----
    socket.on('chat:history', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; beforeTs?: unknown; limit?: unknown }
      const groupId = Number(d.groupId)
      if (!Number.isInteger(groupId) || groupId <= 0) return ack(fail('参数不合法'))
      if ((await store.getGroupMemberRole(groupId, auth.id)) === null) return ack(fail('不在群中'))
      const beforeTs = d.beforeTs === undefined ? undefined : Number(d.beforeTs)
      const limit = Math.min(Math.max(Number(d.limit ?? 50), 1), 200)
      const conv = await store.getOrCreateGroupConversation(groupId)
      const msgs = await store.listMessages(conv.id, beforeTs, limit)
      await fillNicks(store, msgs)
      ack(ok({ messages: msgs }))
    })

    // ---- 一对一私信 ----
    socket.on('dm:send', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { toUserId?: unknown; kind?: unknown; content?: unknown; text?: unknown }
      const toUserId = Number(d.toUserId)
      const kind0: ChatKind = isKind(d.kind) ? d.kind : 'text'
      const raw = d.content !== undefined ? d.content : d.text
      // 发送兜底：文本内容若是音频引用（服务器URL/本地路径）→ 记为 audio 类型
      const kind = kind0 === 'text' && isAudioRef(raw) ? 'audio' : kind0
      if (!Number.isInteger(toUserId) || toUserId <= 0 || toUserId === auth.id) return ack(fail('参数不合法'))
      if (kind === 'text' && !isText(raw)) return ack(fail('消息不合法（1-4000 字）'))
      if ((kind === 'image' || kind === 'file' || kind === 'video' || kind === 'audio' || kind === 'folder') && typeof raw !== 'string') return ack(fail('需要文件地址、UUID 或文件夹路径'))
      if ((await store.getUserById(toUserId)) === null) return ack(fail('对方不存在'))

      const content = await resolveContent(store, kind, String(raw))
      if (!content) return ack(fail('文件不存在'))
      const conv = await store.getOrCreateDmConversation(auth.id, toUserId)
      const msg = await store.saveMessage({ conversationId: conv.id, fromId: auth.id, kind, content })
      msg.nick = auth.nick
      msg.avatar = (await store.getUserById(auth.id))?.avatar ?? ''
      msg.type = 'dm'

      await store.touchConversation(conv.id, auth.id, previewOf(kind, content))
      await store.touchConversation(conv.id, toUserId, previewOf(kind, content), auth.id)
      // 回显给发送方（自己也能看到发出的私信）+ 推送给接收方
      io.to(userRoom(auth.id)).emit('dm:message', msg)
      io.to(userRoom(toUserId)).emit('dm:message', msg)
      ack(ok({ id: msg.id }))
    })

    // ---- 私信历史 ----
    socket.on('dm:history', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { withUserId?: unknown; beforeTs?: unknown; limit?: unknown }
      const withUserId = Number(d.withUserId)
      if (!Number.isInteger(withUserId) || withUserId <= 0) return ack(fail('参数不合法'))
      const beforeTs = d.beforeTs === undefined ? undefined : Number(d.beforeTs)
      const limit = Math.min(Math.max(Number(d.limit ?? 50), 1), 200)
      const conv = await store.getOrCreateDmConversation(auth.id, withUserId)
      const msgs = await store.listMessages(conv.id, beforeTs, limit)
      for (const m of msgs) m.type = 'dm'
      await fillNicks(store, msgs)
      ack(ok({ messages: msgs }))
    })

    // ---- 对话列表（群聊 + 私信统一；按 置顶优先、最新消息倒序） ----
    socket.on('conversation:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { type?: unknown }
      const type = d.type === 'group' || d.type === 'dm' ? d.type : undefined
      const items = await store.listConversations(auth.id, type)

      const named = await Promise.all(
        items.map(async (it) => {
          let name = ''
          let avatar = ''
          if (it.type === 'group' && it.groupId) {
            const g = await store.getGroupById(it.groupId)
            name = g?.name ?? ''
          } else if (it.dmUserId) {
            const u = await store.getUserById(it.dmUserId)
            name = u ? u.nick || u.username : ''
            avatar = u?.avatar ?? ''
          }
          return { ...it, name, avatar }
        })
      )
      ack(ok({ conversations: named }))
    })

    // ---- 置顶 ----
    socket.on('conversation:pin', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { conversationId?: unknown; pinned?: unknown }
      const conversationId = Number(d.conversationId)
      if (!Number.isInteger(conversationId) || conversationId <= 0) return ack(fail('参数不合法'))
      const pinned = d.pinned === true || d.pinned === 1
      try {
        await store.setConversationPinned(conversationId, auth.id, pinned)
        io.to(userRoom(auth.id)).emit('conversations:updated', { conversationId, pinned })
        ack(ok({ pinned }))
      } catch {
        ack(fail('不在该对话中'))
      }
    })

    // ---- 已读 ----
    socket.on('conversation:read', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { conversationId?: unknown }
      const conversationId = Number(d.conversationId)
      if (!Number.isInteger(conversationId) || conversationId <= 0) return ack(fail('参数不合法'))
      await store.markRead(conversationId, auth.id)
      io.to(userRoom(auth.id)).emit('conversations:updated', { conversationId, unread: 0 })
      ack(ok())
    })

    // ---- 软删除（客户端删除/清空：只打 deletedAt 标记，不真删） ----
    socket.on('message:delete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { conversationId?: unknown; messageId?: unknown }
      const conversationId = Number(d.conversationId)
      const messageId = typeof d.messageId === 'string' ? d.messageId : ''
      if (!Number.isInteger(conversationId) || conversationId <= 0 || messageId.length === 0) {
        return ack(fail('参数不合法'))
      }
      const conv = await store.getConversationById(conversationId)
      if (!conv) return ack(fail('对话不存在'))
      if ((await store.getConversationMember(conversationId, auth.id)) === null) return ack(fail('不在该对话中'))
      const msg = await store.getMessage(conversationId, messageId)
      // 本地临时消息（id 未落到服务端）视为已撤回，容忍——避免"消息不存在"导致客户端无法撤回
      if (!msg) return ack(ok())
      // 权限：本人可删自己的；公司管理员可删群内任意
      const own = msg.fromId === auth.id
      let admin = false
      if (conv.type === 'group' && conv.groupId) {
        const g = await store.getGroupById(conv.groupId)
        if (g) admin = await isCompanyAdmin(store, g.companyId, auth.id)
      }
      if (!own && !admin) return ack(fail('仅可删除自己的消息'))
      if (!(await store.softDeleteMessage(conversationId, messageId))) return ack(fail('消息不存在或已删除'))
      broadcastDeleted(io, conv, conversationId, messageId)
      ack(ok())
    })

    // ---- 真正删除（仅公司管理员；私信仅发送者本人） ----
    socket.on('message:hardDelete', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { conversationId?: unknown; messageId?: unknown }
      const conversationId = Number(d.conversationId)
      const messageId = typeof d.messageId === 'string' ? d.messageId : ''
      if (!Number.isInteger(conversationId) || conversationId <= 0 || messageId.length === 0) {
        return ack(fail('参数不合法'))
      }
      const conv = await store.getConversationById(conversationId)
      if (!conv) return ack(fail('对话不存在'))
      const msg = await store.getMessage(conversationId, messageId)
      if (!msg) return ack(fail('消息不存在'))
      let allowed = false
      if (conv.type === 'group' && conv.groupId) {
        const g = await store.getGroupById(conv.groupId)
        if (g) allowed = await isCompanyAdmin(store, g.companyId, auth.id)
      } else {
        allowed = msg.fromId === auth.id // 私信无公司管理员，仅发送者本人
      }
      if (!allowed) return ack(fail('仅管理员可真正删除'))
      if (!(await store.hardDeleteMessage(conversationId, messageId))) return ack(fail('消息不存在'))
      broadcastDeleted(io, conv, conversationId, messageId)
      ack(ok())
    })
  })
}
