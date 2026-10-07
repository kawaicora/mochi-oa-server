/** 服务端配置：全部来自 .env（dotenv 注入 process.env）或环境变量。传输方式直接用 TRANSPORTS=websocket,polling 配（默认都开）。 */
import 'dotenv/config'

export type Transport = 'websocket' | 'polling'

/** WebRTC ICE 服务器（turn/stun）。来自环境变量 ICE_SERVERS：JSON 数组 或 逗号分隔的 stun/turn URL */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface ServerConfig {
  /** 监听地址；对外部署用 0.0.0.0 */
  host: string
  /** 监听端口 */
  port: number
  /** 直接提供 HTTPS 时的证书；为 null 表示 HTTP */
  https: { key: string; cert: string } | null
  /** CORS 来源：'*'、单个来源、逗号分隔的多个来源 */
  corsOrigin: string | string[]
  /** Socket.IO 传输方式。Cloudflare 等只放行 HTTP 时设为 polling */
  transports: Transport[]
  /** 是否位于反向代理（Cloudflare/nginx）之后，信任 x-forwarded-* */
  trustProxy: boolean
  /** Socket.IO 路径，默认 /socket.io */
  path: string
  /** 存储实现：mysql（生产）| memory（开发/测试） */
  storage: 'mysql' | 'memory'
  mysql: {
    host: string
    port: number
    user: string
    password: string
    database: string
  }
  jwtSecret: string
  jwtExpiresIn: string
  /** WebRTC ICE 服务器：返回给客户端用于建立 P2P 连接（stun/turn） */
  iceServers: IceServer[]
  /** 是否改用 Cloudflare TURN API 动态获取 ICE（不再用静态 ICE_SERVERS） */
  iceCloudflare: {
    enabled: boolean
    /** Cloudflare TURN key id（用于拼接 API URL） */
    keyId: string
    /** CLOUDFLARE_TURN_TOKEN */
    token: string
    /** 凭证有效期（秒），默认 86400 */
    ttl: number
  } | null
  /** 本地文件存储 */
  file: {
    dir: string
    /** 公开访问的源（origin，不带 /files），如 http://192.168.2.57；useRelativeUrl=false 时拼到 /files/ 前 */
    publicBase: string
    /** 单文件大小上限（字节） */
    maxBytes: number
    /** 对外返回的文件 URL 是否用相对路径（/files/...，默认 true，便于迁移）；false 时用 publicBase 拼接绝对 URL。数据库始终存相对路径 */
    useRelativeUrl: boolean
  }
  /** 初始管理员账号密码：首次启动时播种到数据库 */
  admin: { username: string | null; password: string | null }
  /**
   * 服务器管理员（SERVER_ADMIN）用户列表（用户名，大小写不敏感）。
   * 由 SERVER_ADMIN_USERS 指定（逗号分隔）；为空时回退到播种的初始管理员 ADMIN_USER。
   * 基于用户、与公司/群角色无关。
   */
  serverAdmins: string[]
  /** 主邮件配置（来自 .env/Docker，第一优先级）。为 null 表示未在环境配置，此时由客户端（SERVER_ADMIN）在设置里写入数据库 */
  mail: ServerMailConfig | null
}

/** 服务器级主邮件配置（来自 .env / Docker 环境变量） */
export interface ServerMailConfig {
  host: string
  port: number
  /** true=SSL/TLS 直连（465）；false=明文/STARTTLS */
  secure: boolean
  /** SMTP 认证用户名（通常=发信邮箱） */
  user: string
  password: string
  /** 发信地址（from），缺省用 user */
  fromEmail: string
  /** 发件显示名 */
  fromName: string
  /** 是否启用（默认 true） */
  enabled: boolean
}

const bool = (v: string | undefined, dft: boolean): boolean =>
  v === undefined ? dft : v === '1' || v.toLowerCase() === 'true'

function transports(v: string | undefined): Transport[] {
  const list = (v ?? 'websocket,polling')
    .split(',')
    .map((s) => s.trim() as Transport)
    .filter((t) => t === 'websocket' || t === 'polling')
  return list.length > 0 ? list : ['websocket', 'polling']
}

/** 解析 ICE_SERVERS：JSON 数组 或 逗号分隔 stun/turn URL；默认公共 STUN */
function iceServers(v: string | undefined): IceServer[] {
  const raw = v?.trim()
  const dft: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  if (!raw) return dft
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) && arr.length ? (arr as IceServer[]) : dft
    } catch {
      return dft
    }
  }
  const list = raw.split(',').map((u) => u.trim()).filter(Boolean).map((u) => ({ urls: u }))
  return list.length ? list : dft
}

/** 服务器管理员用户列表：SERVER_ADMIN_USERS 优先；为空则回退到播种的 ADMIN_USER */
function serverAdmins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.SERVER_ADMIN_USERS?.trim()
  const list = raw
    ? raw.split(',').map((u) => u.trim()).filter(Boolean)
    : env.ADMIN_USER?.trim()
      ? [env.ADMIN_USER.trim()]
      : []
  return [...new Set(list)]
}

/** 主邮件配置：MAIL_HOST 存在即视为配置了环境级主邮件 */
function serverMail(env: NodeJS.ProcessEnv): ServerMailConfig | null {
  const host = env.MAIL_HOST?.trim()
  if (!host) return null
  const user = env.MAIL_USER?.trim() ?? ''
  return {
    host,
    port: Number(env.MAIL_PORT ?? 465),
    secure: bool(env.MAIL_SECURE, true),
    user,
    password: env.MAIL_PASSWORD ?? '',
    fromEmail: env.MAIL_FROM?.trim() ?? user,
    fromName: env.MAIL_FROM_NAME?.trim() ?? '',
    enabled: bool(env.MAIL_ENABLED, true)
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const corsRaw = env.CORS_ORIGIN
  const corsOrigin = corsRaw === undefined || corsRaw === '*' ? '*' : corsRaw.split(',').map((s) => s.trim())

  let https: ServerConfig['https'] = null
  if (env.SSL_KEY && env.SSL_CERT) {
    https = { key: env.SSL_KEY, cert: env.SSL_CERT }
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    https,
    corsOrigin,
    transports: transports(env.TRANSPORTS),
    trustProxy: bool(env.TRUST_PROXY, false),
    path: env.SOCKET_PATH ?? '/socket.io',
    storage: env.STORAGE === 'memory' ? 'memory' : 'mysql',
    mysql: {
      host: env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(env.MYSQL_PORT ?? 3306),
      user: env.MYSQL_USER ?? 'root',
      password: env.MYSQL_PASSWORD ?? '',
      database: env.MYSQL_DATABASE ?? 'mochioa'
    },
    jwtSecret: env.JWT_SECRET ?? 'change-me-in-production',
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '30d',
    iceServers: iceServers(env.ICE_SERVERS),
    iceCloudflare:
      bool(env.ICE_USE_CLOUDFLARE, false) && env.CLOUDFLARE_TURN_TOKEN
        ? {
            enabled: true,
            keyId: env.CLOUDFLARE_TURN_KEY_ID ?? '',
            token: env.CLOUDFLARE_TURN_TOKEN,
            ttl: Number(env.ICE_SERVERS_TOKEN_SECOND ?? 86400)
          }
        : null,
    file: {
      dir: env.FILE_DIR ?? './data',
      publicBase: (env.FILE_BASE_URL ?? `http://${env.HOST ?? '0.0.0.0'}:${Number(env.PORT ?? 3000)}`).replace(/\/$/, ''),
      maxBytes: Number(env.FILE_MAX_BYTES ?? 20 * 1024 * 1024),
      useRelativeUrl: bool(env.USE_RELATIVE_FILE_URL, true)
    },
    admin: { username: env.ADMIN_USER ?? null, password: env.ADMIN_PASSWORD ?? null },
    serverAdmins: serverAdmins(env),
    mail: serverMail(env)
  }
}
