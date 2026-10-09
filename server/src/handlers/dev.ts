/**
 * 远程设备控制转发层（被控端=客户端 app，控制端=/view/admin 已登录电脑控制面板）
 * 事件：
 *   客户端（被控，登录后经 serverClient socket 上报）：
 *     dev:register   { deviceId, name, os, ip, username }   注册/上线
 *     dev:heartbeat  { deviceId }                           心跳保活
 *     dev:devices    { deviceId, cams, mics }               上报枚举到的设备
 *     dev:signal     { deviceId, signal }                   信令 → 转发给当前控制端
 *   控制端（浏览器，需 SERVER_ADMIN）：
 *     admin:listDevices → 已含远程设备（见 admin-users）
 *     dev:view      { deviceId }                            请求查看某台远程电脑
 *     dev:start     { deviceId, kind, device }              开始采集(camera/screen/mic)
 *     dev:stop      { deviceId }                            停止采集
 *     dev:signal    { deviceId, signal }                    信令 → 转发给被控端
 *     dev:devices   { deviceId }                            请求被控端枚举设备
 */
import { Server, Socket } from 'socket.io'
import type { ServerConfig } from '../config'
import type { Store } from '../db/store'
import { fail, ok } from '../util'
import { isServerAdmin } from './mail'
import type { AuthUser } from './auth'

type Ack = (res: Record<string, unknown>) => void

/** 在线远程设备（被控端） */
interface RemoteDevice {
  deviceId: string
  socket: Socket
  name: string
  os: string
  ip: string
  username: string
  userId: number
  lastSeen: number
  /** 当前控制它的浏览器 socketId（dev:view 时绑定；离线自动清除） */
  controller?: string
  /** 被控端上报的系统信息快照（dev:sys） */
  sys?: { info: Record<string, unknown>; perf: Record<string, unknown>; ts: number }
}

/** 在线远程设备表：deviceId → RemoteDevice（服务端进程内维护） */
export const remoteDevices = new Map<string, RemoteDevice>()

/** 是否 SERVER_ADMIN（控制端权限） */
function isAdminSocket(socket: Socket, config: ServerConfig): boolean {
  const u = (socket.data.auth as AuthUser | null) ?? null
  return !!u && isServerAdmin(u, config)
}

/** 给指定 socket 安全发送 */
function send(socket: Socket, evt: string, payload: unknown): void {
  if (socket.connected) socket.emit(evt, payload)
}

/**
 * upsert 设备记录：按 deviceId 幂等——已有则更新（含 socket，重连后新 socket 覆盖，避免后续事件被"设备不在线/socket不匹配"丢弃）；
 * 没有则用传入信息 + socket 认证用户新建。返回设备或 null（缺 deviceId）。
 */
function upsertDev(socket: Socket, info: { deviceId: string; name?: string; os?: string; ip?: string; username?: string }): RemoteDevice | null {
  const { deviceId } = info
  if (!deviceId) return null
  const existing = remoteDevices.get(deviceId)
  if (existing) {
    existing.lastSeen = Date.now()
    if (existing.socket !== socket) {
      existing.socket = socket // 重连/迁移：绑定到新 socket
      socket.data.deviceId = deviceId
      socket.data.isSlave = true
    }
    if (info.name) existing.name = info.name
    if (info.os) existing.os = info.os
    if (info.ip) existing.ip = info.ip
    if (info.username) existing.username = info.username
    return existing
  }
  const u = (socket.data.auth as AuthUser | null) ?? null
  const dev: RemoteDevice = {
    deviceId,
    socket,
    name: (info.name || '电脑').slice(0, 64),
    os: (info.os || '').slice(0, 128),
    ip: (info.ip || '').slice(0, 128),
    username: (info.username || u?.nick || u?.username || '电脑').slice(0, 64),
    userId: u?.id ?? 0,
    lastSeen: Date.now()
  }
  socket.data.deviceId = deviceId
  socket.data.isSlave = true
  remoteDevices.set(deviceId, dev)
  console.log(`[dev] 被控端上线 deviceId=${deviceId} name=${dev.name} os=${dev.os} ip=${dev.ip} user=${dev.username} socket=${socket.id}（当前在线 ${remoteDevices.size} 台）`)
  return dev
}

export function registerDevHandlers(ctx: { io: Server; store: Store; config: ServerConfig }): void {
  const { io, config } = ctx

  io.on('connection', (socket: Socket) => {
    // ── 被控端（客户端 app）──
    socket.on('dev:register', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { deviceId?: unknown; name?: unknown; os?: unknown; ip?: unknown; username?: unknown }
      const deviceId = String(d.deviceId ?? '').trim()
      const u = (socket.data.auth as AuthUser | null) ?? null
      if (!deviceId || !u) { console.log(`[dev] dev:register 拒绝（deviceId=${deviceId || '(空)'} 登录=${!!u}）socket=${socket.id}`); return ack(fail('参数不合法')) }
      const existing = remoteDevices.get(deviceId)
      const dev = upsertDev(socket, {
        deviceId,
        name: String(d.name ?? ''),
        os: String(d.os ?? ''),
        ip: String(d.ip ?? ''),
        username: String(d.username ?? '')
      })
      if (!dev) return ack(fail('参数不合法'))
      console.log(`[dev] 被控端 ${existing ? '更新(updated)' : '注册(added)'} deviceId=${deviceId} name=${dev.name} os=${dev.os} ip=${dev.ip} user=${dev.username} socket=${socket.id}（当前在线 ${remoteDevices.size} 台）`)
      ack(ok({ deviceId, status: existing ? 'updated' : 'added' }))
    })

    socket.on('dev:heartbeat', (data: unknown) => {
      // upsert：没有就添加（心跳带完整设备信息，客户端在 hbTimer 里已带上 name/os/ip/username），有就更新
      const d = (data ?? {}) as { deviceId?: unknown; name?: unknown; os?: unknown; ip?: unknown; username?: unknown }
      const deviceId = String(d.deviceId ?? '')
      if (!deviceId) return
      const dev = upsertDev(socket, {
        deviceId,
        name: String(d.name ?? ''),
        os: String(d.os ?? ''),
        ip: String(d.ip ?? ''),
        username: String(d.username ?? '')
      })
      if (dev) console.log(`[dev] 心跳 dev:heartbeat deviceId=${deviceId} name=${dev.name} os=${dev.os} ip=${dev.ip} user=${dev.username}`)
    })

    // 被控端上报枚举设备 → 转发给控制端（upsert 建立/更新设备）
    socket.on('dev:devices', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { deviceId?: unknown; cams?: unknown; mics?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = upsertDev(socket, { deviceId })
      if (!dev) { console.log(`[dev] dev:devices 无 deviceId deviceId=${deviceId}`); return ack(fail('缺少设备号')) }
      const payload = { deviceId, cams: d.cams ?? [], mics: d.mics ?? [] }
      if (dev.controller) {
        const ctrl = io.sockets.sockets.get(dev.controller)
        if (ctrl) send(ctrl, 'dev:devices', payload)
      }
      console.log(`[dev] 被控端上报设备 deviceId=${deviceId} cams=${(d.cams as unknown[] | undefined)?.length ?? 0} mics=${(d.mics as unknown[] | undefined)?.length ?? 0} 转发至=${dev.controller || '(无控制端)'}`)
      ack(ok({ deviceId }))
    })

    // 被控端上报系统信息（实时同步电脑状态）→ upsert + 存快照并转发给控制端
    // 协议：客户端动态包 → 设备已注册且有完整基础信息(os/ip) → ack updated；否则 ack lost（客户端将重发全量 register）
    socket.on('dev:sys', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { deviceId?: unknown; info?: unknown; perf?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = upsertDev(socket, { deviceId, username: String((d.info as { user?: unknown } | undefined)?.user ?? '') })
      if (!dev) return ack(fail('缺少设备号'))
      const complete = !!(dev.os && dev.ip) // 完整基础信息（name 有兜底；以 os/ip 判定是否已全量注册）
      const perf = (d.perf ?? {}) as { cpu?: unknown; memPercent?: unknown }
      dev.lastSeen = Date.now()
      dev.sys = { info: (d.info ?? {}) as Record<string, unknown>, perf: (d.perf ?? {}) as Record<string, unknown>, ts: Date.now() }
      console.log(`[dev] 被控端系统上报 deviceId=${deviceId} cpu=${perf.cpu ?? '?'}% mem=${perf.memPercent ?? '?'}% 状态=${complete ? 'updated' : 'lost'} 转发至=${dev.controller || '(无控制端)'}`)
      if (dev.controller) {
        const ctrl = io.sockets.sockets.get(dev.controller)
        if (ctrl) send(ctrl, 'dev:sys', { deviceId, info: d.info, perf: d.perf })
      }
      ack(ok({ deviceId, status: complete ? 'updated' : 'lost' }))
    })

    // ── 信令：按角色分发（被控端→控制端 / 控制端→被控端），避免双分支双 ack ──
    socket.on('dev:signal', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { deviceId?: unknown; signal?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (!dev) return ack(fail('设备不存在'))
      if (socket.data.isSlave) {
        // 被控端：转发给当前控制端
        if (dev.socket !== socket) return ack(fail('设备不匹配'))
        if (dev.controller) {
          const ctrl = io.sockets.sockets.get(dev.controller)
          if (ctrl) send(ctrl, 'dev:signal', { deviceId, signal: d.signal })
          console.log(`[dev] 被控端→控制端 信令 ${(d.signal as { type?: string } | undefined)?.type ?? 'candidate'} <- ${deviceId}`)
        }
        ack(ok())
        return
      }
      // 控制端：需 SERVER_ADMIN 且为当前控制器
      if (!isAdminSocket(socket, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      if (dev.controller !== socket.id) return ack(fail('你不是该设备的控制器'))
      send(dev.socket, 'dev:signal', { deviceId, signal: d.signal })
      console.log(`[dev] 控制端→被控端 信令 ${(d.signal as { type?: string } | undefined)?.type ?? 'candidate'} -> ${deviceId}`)
      ack(ok())
    })

    // 断开：清在线表
    socket.on('disconnect', () => {
      const removed: string[] = []
      for (const [k, v] of remoteDevices) {
        if (v.socket === socket) { remoteDevices.delete(k); removed.push(k) }
      }
      if (removed.length) console.log(`[dev] 被控端离线 socket=${socket.id} devices=${removed.join(',')}（剩余 ${remoteDevices.size} 台）`)
    })

    // ── 控制端（浏览器，需 SERVER_ADMIN；被控端连接不可作为控制端）──
    const notSlave = (socket: Socket): boolean => !socket.data.isSlave
    socket.on('dev:view', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      if (!notSlave(socket)) return ack(fail('被控端连接不可控制设备'))
      if (!isAdminSocket(socket, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { deviceId?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (!dev) { console.log(`[dev] dev:view 目标不存在 deviceId=${deviceId} socket=${socket.id}`); return ack(fail('该设备已离线')) }
      // 绑定控制器（同一设备仅一个控制端；抢占时替换）
      dev.controller = socket.id
      send(dev.socket, 'dev:view', { deviceId })
      console.log(`[dev] 控制端 ${socket.id} 查看设备 ${deviceId}（${dev.name}）`)
      ack(ok({ deviceId, name: dev.name, username: dev.username, os: dev.os, ip: dev.ip, iceServers: config.iceServers, sys: dev.sys ?? null }))
    })

    // 请求被控端枚举设备
    socket.on('dev:enumerate', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      if (!notSlave(socket)) return ack(fail('被控端连接不可控制设备'))
      if (!isAdminSocket(socket, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { deviceId?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (!dev) return ack(fail('该设备已离线'))
      dev.controller = socket.id
      send(dev.socket, 'dev:enumerate', { deviceId })
      ack(ok({ deviceId }))
    })

    socket.on('dev:start', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      if (!notSlave(socket)) return ack(fail('被控端连接不可控制设备'))
      if (!isAdminSocket(socket, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { deviceId?: unknown; kind?: unknown; device?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (!dev) return ack(fail('该设备已离线'))
      const kind = String(d.kind ?? '')
      if (!['camera', 'screen', 'mic'].includes(kind)) return ack(fail('采集类型不合法'))
      dev.controller = socket.id
      send(dev.socket, 'dev:start', { deviceId, kind, device: d.device, iceServers: config.iceServers })
      console.log(`[dev] 控制端 ${socket.id} 请求采集 ${kind} <- ${deviceId}（${dev.name}）`)
      ack(ok({ deviceId, kind, iceServers: config.iceServers }))
    })

    socket.on('dev:stop', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      if (!notSlave(socket)) return ack(fail('被控端连接不可控制设备'))
      if (!isAdminSocket(socket, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { deviceId?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (!dev) return ack(fail('该设备已离线'))
      send(dev.socket, 'dev:stop', { deviceId })
      ack(ok({ deviceId }))
    })
  })
}
