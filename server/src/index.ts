import { createServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { Server as SocketIoServer } from 'socket.io'
import { loadConfig } from './config'
import { MySqlStore } from './db/mysql-store'
import { MemoryStore } from './db/memory-store'
import type { Store } from './db/store'
import { hashToken } from './token'
import { hashPassword } from './password'
import { addPresence, removePresence } from './presence'
import { broadcastPresence } from './presence-broadcast'
import { registerAuthHandlers } from './handlers/auth'
import { registerCompanyHandlers } from './handlers/company'
import { registerGroupHandlers } from './handlers/group'
import { registerConversationHandlers } from './handlers/conversation'
import { registerFriendHandlers } from './handlers/friends'
import { registerOrgHandlers } from './handlers/org'
import { registerRtcHandlers } from './handlers/rtc'
import { registerUploadRoutes } from './files'
import { registerResetPwdRoutes } from './reset-pwd'
import { registerAdminRoutes } from './web/admin'
import { registerSysmonHandlers } from './handlers/sysmon'
import { registerAdminUsersHandlers } from './handlers/admin-users'
import { createMailer } from './mailer'
import { registerMailHandlers } from './handlers/mail'
import { registerHolidayHandlers, seedHolidays } from './handlers/holiday'
import { registerTaskHandlers } from './handlers/task'
import { registerProjectMgmtHandlers } from './handlers/project-mgmt'
import { fetchCloudflareIce } from './ice'
import { sessionRoom, userRoom } from './util'

async function main(): Promise<void> {
  const config = loadConfig()

  // ---- ICE：若启用 Cloudflare TURN API，则动态获取并覆盖静态配置（失败则回退 ICE_SERVERS） ----
  if (config.iceCloudflare?.enabled) {
    const cloudIce = await fetchCloudflareIce(config)
    if (cloudIce) {
      config.iceServers = cloudIce
      console.log(`[mochioa-server] 已通过 Cloudflare TURN API 获取 ${cloudIce.length} 个 ICE 服务器`)
    } else {
      console.warn('[mochioa-server] Cloudflare ICE 获取失败，回退到 ICE_SERVERS 静态配置')
    }
  }

  // ---- 存储层 ----
  const store: Store = config.storage === 'memory' ? new MemoryStore() : new MySqlStore(config.mysql)
  await store.init()

  // ---- 邮件客户端（SMTP）：主/全局 MainMailConfig + 公司级预留。登录/注册验证码等业务逻辑后续接入 ----
  const mailer = createMailer(store, config.mail)
  if (config.mail?.enabled) {
    console.log(`[mochioa-server] 主邮件已由环境(.env/Docker)配置：${config.mail.fromEmail} → ${config.mail.host}:${config.mail.port}`)
  } else {
    const mainMailCount = (await mailer.listConfigs(null)).length
    console.log(`[mochioa-server] 主邮件未配置环境变量，当前数据库主邮件 ${mainMailCount} 个（可由 SERVER_ADMIN 在客户端设置）；公司级配置默认空、由公司设置配置`)
  }

  // ---- 播种内置法定假期（节假日可增删改、多端同步） ----
  await seedHolidays(store).catch((err) => {
    console.error('[mochioa-server] 法定假期种子写入失败：', err instanceof Error ? err.message : err)
  })

  // ---- 播种初始管理员（静态配置 ADMIN_USER/ADMIN_PASSWORD，写入数据库） ----
  if (config.admin.username && config.admin.password) {
    try {
      const existing = await store.getUserByUsername(config.admin.username)
      if (!existing) {
        await store.createUser({ username: config.admin.username, passwordHash: hashPassword(config.admin.password), nick: '管理员' })
        console.log(`[mochioa-server] 已创建初始管理员：${config.admin.username}`)
      }
    } catch (err) {
      console.error('[mochioa-server] 初始管理员播种失败：', err instanceof Error ? err.message : err)
    }
  }

  // ---- HTTP(S) + Socket.IO ----
  const http: HttpServer = config.https
    ? createHttpsServer({ key: readFileSync(config.https.key), cert: readFileSync(config.https.cert) })
    : createServer()

  const io = new SocketIoServer(http, {
    path: config.path,
    transports: config.transports,
    serveClient: false,
    cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6
  })

  // ---- 认证中间件：握手携带 token 时自动登录（多会话：按 token 摘要查会话，过期即失效） ----
  io.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown }
    const q = socket.handshake.query as { token?: unknown }
    const token = typeof auth?.token === 'string' && auth.token ? auth.token : typeof q?.token === 'string' ? q.token : undefined
    if (!token) return next()
    const hash = hashToken(token)
    store
      .getSessionByTokenHash(hash)
      .then(async (session) => {
        if (!session) return next()
        if (new Date(session.expiresAt).getTime() < Date.now()) {
          await store.deleteSession(session.id).catch(() => {}) // 过期：删除该会话
          return next()
        }
        const user = await store.getUserById(session.userId)
        if (!user) return next()
        await store.touchSession(session.id).catch(() => {})
        socket.data.auth = { id: user.id, username: user.username, nick: user.nick || user.username, sessionId: session.id, sessionDevice: session.device }
        next()
      })
      .catch(() => next())
  })

  registerAuthHandlers({ io, store, config, mailer })
  registerCompanyHandlers({ io, store, config })
  registerGroupHandlers({ io, store, config })
  registerConversationHandlers({ io, store, config })
  registerFriendHandlers({ io, store, config })
  registerOrgHandlers({ io, store, config })
  registerRtcHandlers({ io, store, config })
  registerMailHandlers({ io, store, config, mailer })
  registerHolidayHandlers({ io, store, config })
  registerTaskHandlers({ io, store, config })
  registerProjectMgmtHandlers({ io, store, config })
  registerSysmonHandlers({ io, store, config })
  registerAdminUsersHandlers({ io, store, config })

  // ---- HTTP 上传/文件路由（POST /api/upload、GET /files/*） ----
  registerUploadRoutes(http, store, config)

  // ---- 忘记密码：GET/POST /view/reset-pwd（服务端渲染重置密码页；改密成功后断开其在线会话） ----
  registerResetPwdRoutes(http, store, io)

  // ---- 管理后台网页端：GET /view/admin（登录 + 房间 + 已登录电脑控制 + 用户管理；/view/room 301 到此） ----
  registerAdminRoutes(http, store, io, config)

  // ---- 在线状态：连接上线 / 断线下线 ----
  io.on('connection', (socket) => {
    const auth = socket.data.auth as { id: number; sessionId: number } | undefined
    if (auth) {
      addPresence(auth.id, socket.id)
      void socket.join(userRoom(auth.id)) // 私信定向送达房间
      void socket.join(sessionRoom(auth.sessionId)) // 会话定向推送（踢下线/新设备登录）
      resolveNick(store, socket)
        .then(() => broadcastPresence(io, store, socket, true))
        .catch(() => {})
    }
    socket.on('disconnect', async () => {
      const a = socket.data.auth as { id: number } | undefined
      if (a) {
        const stillOnline = removePresence(a.id, socket.id)
        if (!stillOnline) {
          await broadcastPresence(io, store, socket, false).catch(() => {})
        }
      }
    })
  })

  // ---- 监听 ----
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(config.port, config.host, resolve)
  })

  console.log(
    `[mochioa-server] 已启动  mode=${config.storage === 'memory' ? 'memory(测试)' : 'mysql'} ` +
      `${config.https ? 'https' : 'http'}://${config.host}:${config.port}${config.path} ` +
      `transports=${config.transports.join(',')}`
  )

  // ---- 优雅退出 ----
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[mochioa-server] 收到 ${sig}，正在关闭...`)
    io.close()
    http.close()
    await store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/** 从存储补齐昵称（token 里没有 nick） */
async function resolveNick(store: Store, socket: { data: { auth?: { id: number; nick: string } } }): Promise<void> {
  const auth = socket.data.auth
  if (!auth) return
  const user = await store.getUserById(auth.id)
  if (user) {
    auth.nick = user.nick || user.username
    socket.data.auth = auth
  }
}

main().catch((err) => {
  console.error('[mochioa-server] 启动失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
