import type { Server, Socket } from 'socket.io'
import type { ServerConfig } from '../config'
import type { Store, UserWithPassword } from '../db/store'
import type { Session, User } from '../types'
import { hashPassword, verifyPassword } from '../password'
import { hashToken, newSessionToken } from '../token'
import { addPresence } from '../presence'
import { broadcastPresence } from '../presence-broadcast'
import { fail, groupRoom, ok, sessionRoom, userRoom } from '../util'
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { verifyCodes } from '../verify-code'
import { resetTokens } from '../reset-tokens'
import type { Mailer } from '../mailer'

export interface Ctx {
  io: Server
  store: Store
  config: ServerConfig
  /** 邮件发送器（发送验证码等系统邮件）；未配置主邮件时为 undefined */
  mailer?: Mailer
}

/** 已认证 socket 上挂载的用户态（含当前登录会话） */
export interface AuthUser {
  id: number
  username: string
  nick: string
  sessionId: number
  sessionDevice: string
}

type Ack = (res: Record<string, unknown>) => void

/** 每次连接生成一次 RSA 密钥对（前向安全：私钥仅内存、随连接销毁），用于登录/注册凭据加密传输 */
const rsaKeys = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>()

/** 用本连接私钥解密客户端加密的登录/注册凭据（RSA PKCS1 → JSON） */
function decryptCreds(socketId: string, enc: string): { account?: string; username?: string; password?: string; code?: string } | null {
  const k = rsaKeys.get(socketId)
  if (!k) return null
  try {
    const buf = privateDecrypt({ key: k.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(enc, 'base64'))
    const obj = JSON.parse(buf.toString('utf8')) as { account?: unknown; username?: unknown; password?: unknown; code?: unknown }
    return {
      account: typeof obj.account === 'string' ? obj.account : undefined,
      username: typeof obj.username === 'string' ? obj.username : undefined,
      password: typeof obj.password === 'string' ? obj.password : undefined,
      code: typeof obj.code === 'string' ? obj.code : undefined
    }
  } catch {
    return null
  }
}

/** 按用户名或邮箱查找用户（登录支持账号=用户名/邮箱） */
async function findByAccount(store: Store, account: string): Promise<UserWithPassword | null> {
  const u = await store.getUserByUsername(account.trim()).catch(() => null)
  if (u) return u
  if (account.includes('@')) return store.getUserByEmail(account.trim()).catch(() => null)
  return null
}

const isUsername = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_\-.]{3,32}$/.test(v)
const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length >= 6 && v.length <= 128
const isNick = (v: unknown): v is string => typeof v === 'string' && v.length <= 32
const isEmail = (v: unknown): v is string => typeof v === 'string' && v.length <= 128

/** 认证 socket：要求当前 socket 已登录 */
function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

/** 解析会话有效期（登录有效期）：优先用户自设天数，否则用服务端默认 */
function parseDurationMs(s: string): number {
  const m = /^(\d+)([smhdw])$/.exec((s || '').trim().toLowerCase())
  if (!m) return 30 * 86400000
  const n = parseInt(m[1], 10)
  switch (m[2]) {
    case 's': return n * 1000
    case 'm': return n * 60000
    case 'h': return n * 3600000
    case 'd': return n * 86400000
    case 'w': return n * 7 * 86400000
  }
  return 30 * 86400000
}

async function sessionExpiry(store: Store, userId: number, config: ServerConfig): Promise<string> {
  const days = await store.getSessionDays(userId)
  const ms = days && days > 0 ? days * 86400000 : parseDurationMs(config.jwtExpiresIn)
  return new Date(Date.now() + ms).toISOString()
}

/** 设备标识：优先登录参数，否则握手 auth，最后兜底 */
function deviceLabel(socket: Socket, fromData?: unknown): string {
  if (typeof fromData === 'string' && fromData.trim()) return fromData.trim().slice(0, 120)
  const handshake = socket.handshake.auth as { device?: unknown }
  if (typeof handshake.device === 'string' && handshake.device.trim()) return handshake.device.trim().slice(0, 120)
  return '未知设备'
}

/** 客户端上报的归属地 / 设备（登录、注册时随 data.clientInfo 传入）。 */
function clientInfoFrom(data: unknown): { ip: string; location: string; device: string } {
  const d = (data ?? {}) as { clientInfo?: unknown }
  const ci = (d.clientInfo && typeof d.clientInfo === 'object' ? d.clientInfo : {}) as { ip?: unknown; location?: unknown; device?: unknown }
  return {
    ip: typeof ci.ip === 'string' && ci.ip.trim() ? ci.ip.trim().slice(0, 64) : '',
    location: typeof ci.location === 'string' ? ci.location.trim().slice(0, 120) : '',
    device: typeof ci.device === 'string' ? ci.device.trim().slice(0, 120) : ''
  }
}

/** 解析客户端真实 IP：优先代理头（NGINX / Cloudflare / FRP 等反代会设置）。
 *  顺序：X-Forwarded-For 取最左（原始客户端）→ X-Real-IP → 直连 TCP 源地址。
 *  注：无条件信任代理头；若客户端能直连服务器并自伪造代理头会失真，生产反代场景适用。 */
function realIp(socket: Socket): string {
  const h = socket.handshake.headers ?? {}
  const read = (name: string): string => {
    const v = h[name]
    const raw = Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined
    return raw?.trim() ?? ''
  }
  const first = (s: string): string => s.split(',')[0].trim().slice(0, 64)
  const cf = read('cf-connecting-ip')
  if (cf) return first(cf)
  const xff = read('x-forwarded-for')
  if (xff) return first(xff)
  const rr = read('x-real-ip') || read('x-client-ip')
  if (rr) return first(rr)
  return socket.handshake.address
}

/** 会话记录的 IP：优先客户端自报的 IP（Docker/NAT 直连时服务端只能看到网关/内网地址，
 *  客户端自报的公网/局域网 IP 才接近真实；非空且非环回即采用），否则回退 realIp() 解析。 */
function resolveSessionIp(socket: Socket, clientIp: string): string {
  const cip = (clientIp ?? '').trim().toLowerCase()
  if (cip && cip !== '127.0.0.1' && cip !== '::1' && cip !== 'localhost') return cip.slice(0, 64)
  return realIp(socket)
}

/** 会话对外视图（不含 tokenHash） */
function sessionView(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    device: s.device,
    ip: s.ip,
    location: s.location ?? '',
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    lastActiveAt: s.lastActiveAt,
    expired: new Date(s.expiresAt).getTime() < Date.now()
  }
}

/** 当前会话之外，给该用户其他在线会话发「新设备登录」弹窗 */
async function notifyOtherSessions(io: Server, store: Store, userId: number, newSessionId: number, device: string, ip: string, location?: string): Promise<void> {
  const others = await store.listSessionsByUser(userId)
  const at = new Date().toISOString()
  for (const o of others) {
    if (o.id === newSessionId) continue
    if (new Date(o.expiresAt).getTime() < Date.now()) continue
    io.to(sessionRoom(o.id)).emit('auth:newDeviceLogin', { sessionId: o.id, device, ip, location: location ?? '', at })
  }
}

async function joinUserRooms(socket: Socket, store: Store): Promise<void> {
  const auth = authed(socket)
  if (!auth) return
  void socket.join(userRoom(auth.id)) // 私信定向送达房间
  if (auth.sessionId) void socket.join(sessionRoom(auth.sessionId)) // 会话定向推送房间
  const groups = await store.getUserGroups(auth.id)
  for (const g of groups) {
    void socket.join(groupRoom(g.id))
  }
}

/** 返回登录成功后的载荷（user + 公司 + 会话） */
async function loginPayload(store: Store, user: User, session: Session): Promise<Record<string, unknown>> {
  const companies = await store.getUserCompanies(user.id)
  return {
    user: { id: user.id, username: user.username, nick: user.nick, avatar: user.avatar, email: user.email, phone: user.phone, extra: user.extra },
    companies,
    session: sessionView(session)
  }
}

export function registerAuthHandlers(ctx: Ctx): void {
  const { io, store, config, mailer } = ctx

  io.on('connection', (socket) => {
    // 登录优化：每次连接生成 RSA 密钥对（私钥仅内存、随连接销毁），登录/注册凭据用公钥加密传输
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    rsaKeys.set(socket.id, pair)
    socket.on('disconnect', () => rsaKeys.delete(socket.id))

    // ---- 获取登录加密公钥（PEM / SPKI） ----
    socket.on('auth:getPublicKey', (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const k = rsaKeys.get(socket.id)
      if (!k) return ack(fail('密钥未就绪'))
      ack(ok({ publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
    })

    // ---- 发送邮箱验证码（注册验证 / 验证码登录 等通用用途） ----
    socket.on('auth:sendEmailCode', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { email?: unknown; purpose?: unknown }
      const email = typeof d.email === 'string' ? d.email.trim() : ''
      if (!isEmail(email)) return ack(fail('邮箱不合法'))
      const purpose = typeof d.purpose === 'string' && d.purpose ? d.purpose : 'register'
      if (!['register', 'login'].includes(purpose)) return ack(fail('不支持的验证码用途'))
      if (!mailer) return ack(fail('主邮件未配置，无法发送验证码'))

      const issued = verifyCodes.issue(purpose, email)
      if (!issued || issued.code === '') {
        const left = issued?.remainingMs ?? 0
        return ack(fail(`发送太频繁，请 ${Math.max(1, Math.ceil(left / 1000))} 秒后重试`))
      }
      try {
        const res = await mailer.sendMail({
          to: email,
          subject: '【Mochi OA】邮箱验证码',
          text: `您好：\n您的邮箱验证码是 ${issued.code}，10 分钟内有效。若非本人操作请忽略本邮件。`,
          html: `<p>您好：</p><p>您的邮箱验证码是 <b style="font-size:20px">${issued.code}</b>，10 分钟内有效。</p><p>若非本人操作请忽略本邮件。</p>`
        })
        if (!res.ok) return ack(fail('验证码发送失败：' + (res.error || '未知原因')))
        ack(ok())
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ack(fail('验证码发送失败：' + msg))
      }
    })

    // ---- 忘记密码：向绑定邮箱发送重置验证码（purpose=reset） ----
    socket.on('auth:sendResetCode', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { email?: unknown }
      const email = typeof d.email === 'string' ? d.email.trim() : ''
      if (!isEmail(email) || !/.+@.+\..+/.test(email)) return ack(fail('邮箱格式不合法'))
      const user = await store.getUserByEmail(email).catch(() => null)
      if (!user || !user.email) return ack(fail('该邮箱未注册'))
      if (!mailer) return ack(fail('主邮件未配置，无法发送验证码'))

      const issued = verifyCodes.issue('reset', email)
      if (!issued || issued.code === '') {
        const left = issued?.remainingMs ?? 0
        return ack(fail(`发送太频繁，请 ${Math.max(1, Math.ceil(left / 1000))} 秒后重试`))
      }
      try {
        const res = await mailer.sendMail({
          to: email,
          subject: '【Mochi OA】重置密码验证码',
          text: `您好：\n您的重置密码验证码是 ${issued.code}，10 分钟内有效。若非本人操作请忽略本邮件。`,
          html: `<p>您好：</p><p>您的重置密码验证码是 <b style="font-size:20px">${issued.code}</b>，10 分钟内有效。</p><p>若非本人操作请忽略本邮件。</p>`
        })
        if (!res.ok) return ack(fail('验证码发送失败：' + (res.error || '未知原因')))
        ack(ok())
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ack(fail('验证码发送失败：' + msg))
      }
    })

    // ---- 忘记密码：验证码通过 → 生成一次性重置令牌 → 发送重置密码邮件（含 /view/reset-pwd 链接） ----
    socket.on('auth:sendResetMail', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { email?: unknown; code?: unknown; baseUrl?: unknown }
      const email = typeof d.email === 'string' ? d.email.trim() : ''
      const code = typeof d.code === 'string' ? d.code.trim() : ''
      let baseUrl = typeof d.baseUrl === 'string' ? d.baseUrl.trim().replace(/\/$/, '') : ''
      if (!isEmail(email) || !/.+@.+\..+/.test(email)) return ack(fail('邮箱格式不合法'))
      if (!code) return ack(fail('请输入验证码'))
      const user = await store.getUserByEmail(email).catch(() => null)
      if (!user || !user.email) return ack(fail('该邮箱未注册'))
      if (!mailer) return ack(fail('主邮件未配置，无法发送重置邮件'))

      const v = verifyCodes.verify('reset', email, code)
      if (!v.ok) return ack(fail(v.error))

      // baseUrl：客户端传的服务访问地址（外部域名/内网 IP 均可），拼出重置链接；非法则退回相对路径
      if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(baseUrl)) baseUrl = ''
      const token = resetTokens.issue(user.id, user.email)
      const link = baseUrl ? `${baseUrl}/view/reset-pwd?token=${token}` : `/view/reset-pwd?token=${token}`
      try {
        const res = await mailer.sendMail({
          to: email,
          subject: '【Mochi OA】重置密码',
          text: `您好：\n请点击以下链接重置密码（30 分钟内有效）：\n${link}\n若非本人操作请忽略本邮件。`,
          html: `<p>您好：</p><p>请点击下方链接重置密码（30 分钟内有效）：</p><p><a href="${link}">${link}</a></p><p>若非本人操作请忽略本邮件。</p>`
        })
        if (!res.ok) return ack(fail('重置邮件发送失败：' + (res.error || '未知原因')))
        ack(ok())
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ack(fail('重置邮件发送失败：' + msg))
      }
    })

    // ---- 注册 ----
    socket.on('auth:register', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { username?: unknown; password?: unknown; nick?: unknown; email?: unknown; avatar?: unknown; phone?: unknown; device?: unknown; clientInfo?: unknown; enc?: unknown; code?: unknown }
      if (typeof d.enc === 'string') {
        const creds = decryptCreds(socket.id, d.enc)
        if (!creds?.username || !creds.password) return ack(fail('注册凭据解密失败'))
        d.username = creds.username
        d.password = creds.password
      }
      if (!isUsername(d.username)) return ack(fail('用户名不合法（3-32 位字母数字_-.）'))
      if (!isPassword(d.password)) return ack(fail('密码长度需 6-128'))
      if (d.nick !== undefined && !isNick(d.nick)) return ack(fail('昵称过长'))
      // 邮箱可选：填了邮箱必须通过邮箱验证码（purpose=register）
      let email: string | undefined
      if (typeof d.email === 'string' && d.email.trim()) {
        email = d.email.trim()
        if (!isEmail(email)) return ack(fail('邮箱格式不合法'))
        const code = typeof d.code === 'string' ? d.code.trim() : ''
        if (!code) return ack(fail('请输入邮箱验证码'))
        const v = verifyCodes.verify('register', email, code)
        if (!v.ok) return ack(fail(v.error))
      }
      const avatar = typeof d.avatar === 'string' ? d.avatar.trim().slice(0, 255) : undefined
      const phone = typeof d.phone === 'string' ? d.phone.trim().slice(0, 32) : undefined

      try {
        const user = await store.createUser({
          username: d.username,
          passwordHash: hashPassword(d.password),
          nick: d.nick ?? '',
          email: email ?? '',
          avatar,
          phone
        })
        // 注册也建立一个会话（客户端随后登出会删除它）
        const token = newSessionToken()
        const ci = clientInfoFrom(data)
        const session = await store.createSession({
          userId: user.id,
          tokenHash: hashToken(token),
          device: deviceLabel(socket, ci.device || d.device),
          ip: resolveSessionIp(socket, ci.ip),
          location: ci.location,
          expiresAt: await sessionExpiry(store, user.id, config)
        })
        socket.data.auth = { id: user.id, username: user.username, nick: user.nick || user.username, sessionId: session.id, sessionDevice: session.device }
        await joinUserRooms(socket, store)
        addPresence(user.id, socket.id)
        await broadcastPresence(io, store, socket, true).catch(() => {})
        const payload = await loginPayload(store, user, session)
        payload.token = token
        ack(ok(payload))
      } catch (err) {
        ack(fail((err as Error).message === 'username taken' ? '用户名已被占用' : '注册失败'))
      }
    })

    // ---- 登录（多会话：每次登录建一个新会话；已有其他会话则通知其设备） ----
    socket.on('auth:login', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { account?: unknown; username?: unknown; password?: unknown; code?: unknown; device?: unknown; clientInfo?: unknown; enc?: unknown }
      let account = typeof d.account === 'string' ? d.account.trim() : typeof d.username === 'string' ? d.username.trim() : ''
      let password = typeof d.password === 'string' ? d.password : undefined
      let code = typeof d.code === 'string' ? d.code.trim() : undefined
      if (typeof d.enc === 'string') {
        const creds = decryptCreds(socket.id, d.enc)
        if (!creds?.account && !creds?.username) return ack(fail('登录凭据解密失败'))
        account = (creds.account || creds.username || '').trim()
        password = creds.password
        code = creds.code
      }
      if (!account) return ack(fail('参数缺失'))

      // 账号可以是用户名或邮箱
      const user = await findByAccount(store, account)
      if (!user) return ack(fail('用户名或密码错误'))

      if (code) {
        // 验证码登录：验证码发送到该账号绑定的邮箱
        if (!user.email) return ack(fail('该账号未绑定邮箱，无法使用验证码登录'))
        const v = verifyCodes.verify('login', user.email, code)
        if (!v.ok) return ack(fail(v.error))
      } else {
        if (!password || !verifyPassword(password, user.passwordHash)) return ack(fail('用户名或密码错误'))
      }

      const token = newSessionToken()
      const ci = clientInfoFrom(data)
      const device = deviceLabel(socket, ci.device || d.device)
      const session = await store.createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        device,
        ip: resolveSessionIp(socket, ci.ip),
        location: ci.location,
        expiresAt: await sessionExpiry(store, user.id, config)
      })
      socket.data.auth = { id: user.id, username: user.username, nick: user.nick || user.username, sessionId: session.id, sessionDevice: device }
      await joinUserRooms(socket, store)
      addPresence(user.id, socket.id)
      await broadcastPresence(io, store, socket, true).catch(() => {})
      await notifyOtherSessions(io, store, user.id, session.id, device, resolveSessionIp(socket, ci.ip), ci.location)

      const payload = await loginPayload(store, user, session)
      payload.token = token
      ack(ok(payload))
    })

    // ---- 凭 token 恢复会话（握手已自动登录）：返回当前用户、公司、会话 ----
    socket.on('auth:me', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const user = await store.getUserById(auth.id)
      if (!user) return ack(fail('用户不存在'))
      await store.touchSession(auth.sessionId).catch(() => {})
      const session = (await store.listSessionsByUser(user.id)).find((s) => s.id === auth.sessionId)
      const companies = await store.getUserCompanies(user.id)
      ack(
        ok({
          user: { id: user.id, username: user.username, nick: user.nick, avatar: user.avatar, email: user.email, phone: user.phone, extra: user.extra },
          companies,
          session: session ? sessionView(session) : null
        })
      )
    })

    // ---- 登出：删除当前会话（token 随即失效，不可再自动登录） ----
    socket.on('auth:logout', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (auth?.sessionId) await store.deleteSession(auth.sessionId).catch(() => {})
      socket.data.auth = undefined
      ack(ok())
    })

    // ---- 我的登录会话列表 + 登录有效期 ----
    socket.on('auth:sessions', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const sessions = await store.listSessionsByUser(auth.id)
      ack(
        ok({
          sessions: sessions.map(sessionView),
          currentSessionId: auth.sessionId,
          sessionDays: await store.getSessionDays(auth.id)
        })
      )
    })

    // ---- 踢下线某个会话（不能踢当前会话，当前用登出） ----
    socket.on('auth:endSession', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const sessionId = Number((data as { sessionId?: unknown } | null)?.sessionId)
      if (!Number.isInteger(sessionId) || sessionId <= 0) return ack(fail('参数不合法'))
      const mine = await store.listSessionsByUser(auth.id)
      const target = mine.find((s) => s.id === sessionId)
      if (!target) return ack(fail('会话不存在'))
      if (target.id === auth.sessionId) return ack(fail('不能退出当前会话'))
      await store.deleteSession(sessionId)
      io.to(sessionRoom(sessionId)).emit('auth:sessionRevoked', { sessionId, reason: 'ended', device: target.device, at: new Date().toISOString() })
      // 强制断开该会话的在线 socket：断线重连后 token 已失效 → 回登录页
      io.in(sessionRoom(sessionId)).disconnectSockets(true)
      ack(ok())
    })

    // ---- 退出所有其他设备（保留当前） ----
    socket.on('auth:endAllSessions', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const mine = await store.listSessionsByUser(auth.id)
      let n = 0
      for (const s of mine) {
        if (s.id === auth.sessionId) continue
        await store.deleteSession(s.id)
        io.to(sessionRoom(s.id)).emit('auth:sessionRevoked', { sessionId: s.id, reason: 'ended', device: s.device, at: new Date().toISOString() })
        io.in(sessionRoom(s.id)).disconnectSockets(true)
        n++
      }
      ack(ok({ ended: n }))
    })

    // ---- 修改密码：校验旧密码 → 更新散列；成功后踢下线所有其他会话，仅保留当前 ----
    socket.on('auth:changePassword', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { oldPassword?: unknown; newPassword?: unknown }
      if (typeof d.oldPassword !== 'string' || typeof d.newPassword !== 'string') return ack(fail('参数缺失'))
      if (!isPassword(d.newPassword)) return ack(fail('新密码长度需 6-128'))
      if (d.oldPassword === d.newPassword) return ack(fail('新密码不能与旧密码相同'))
      const user = await store.getUserByUsername(auth.username)
      if (!user || !verifyPassword(d.oldPassword, user.passwordHash)) return ack(fail('旧密码错误'))
      await store.updateUserPassword(auth.id, hashPassword(d.newPassword))
      // 使其他设备会话失效（要求重新登录）；当前会话保留
      const mine = await store.listSessionsByUser(auth.id)
      for (const s of mine) {
        if (s.id === auth.sessionId) continue
        await store.deleteSession(s.id)
        io.to(sessionRoom(s.id)).emit('auth:sessionRevoked', { sessionId: s.id, reason: 'password-changed', device: s.device, at: new Date().toISOString() })
        io.in(sessionRoom(s.id)).disconnectSockets(true)
      }
      ack(ok())
    })

    // ---- 设置我的登录有效期（天；0/空=用服务端默认） ----
    socket.on('auth:setSessionDays', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const raw = (data as { days?: unknown } | null)?.days
      let days: number | null = null
      if (raw !== undefined && raw !== null && raw !== 0) {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1 || n > 365) return ack(fail('登录有效期需在 1-365 天之间'))
        days = n
      }
      await store.setSessionDays(auth.id, days)
      ack(ok({ sessionDays: days }))
    })

    // ---- 更新我的资料（昵称/头像；头像为已上传文件的 URL，走 /api/upload） ----
    socket.on('user:updateProfile', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { nick?: unknown; avatar?: unknown; phone?: unknown; extra?: unknown }
      const nick = typeof d.nick === 'string' ? d.nick.trim().slice(0, 32) : undefined
      const avatar = typeof d.avatar === 'string' ? d.avatar.trim().slice(0, 255) : undefined
      const phone = typeof d.phone === 'string' ? d.phone.trim().slice(0, 32) : undefined
      // 拓展信息：紧急联系人（最多 3 组，序列化为 JSON 存储）
      let extra: string | undefined
      if (d.extra !== undefined && d.extra !== null && typeof d.extra === 'object') {
        const obj = d.extra as { emergency?: unknown }
        const raw = Array.isArray(obj.emergency) ? obj.emergency.slice(0, 3) : []
        const emergency = raw.map((e) => {
          const it = (e ?? {}) as { name?: unknown; phone?: unknown }
          return {
            name: typeof it.name === 'string' ? it.name.slice(0, 32) : '',
            phone: typeof it.phone === 'string' ? it.phone.slice(0, 32) : ''
          }
        })
        extra = JSON.stringify({ emergency })
      }
      if (nick === undefined && avatar === undefined && phone === undefined && extra === undefined) return ack(fail('没有可更新的字段'))
      await store.updateUserProfile(auth.id, { nick, avatar, phone, extra })
      const user = await store.getUserById(auth.id)
      if (!user) return ack(fail('用户不存在'))
      // 同步当前 socket 显示名
      if (user) socket.data.auth = { ...auth, nick: user.nick || user.username }
      // 广播资料变更给所有在线端（好友/公司成员/会话显示同步刷新）
      io.emit('user:profileUpdated', { user: { id: user.id, username: user.username, nick: user.nick, avatar: user.avatar, email: user.email, phone: user.phone, extra: user.extra } })
      ack(ok({ user: { id: user.id, username: user.username, nick: user.nick, avatar: user.avatar, email: user.email, phone: user.phone, extra: user.extra } }))
    })
  })
}
