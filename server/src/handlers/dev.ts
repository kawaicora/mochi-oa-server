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

export function registerDevHandlers(ctx: { io: Server; store: Store; config: ServerConfig }): void {
  const { io, config } = ctx

  io.on('connection', (socket: Socket) => {
    // ── 被控端（客户端 app）──
    socket.on('dev:register', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { deviceId?: unknown; name?: unknown; os?: unknown; ip?: unknown; username?: unknown }
      const deviceId = String(d.deviceId ?? '').trim()
      const u = (socket.data.auth as AuthUser | null) ?? null
      if (!deviceId || !u) return ack(fail('参数不合法'))
      const dev: RemoteDevice = {
        deviceId,
        socket,
        name: String(d.name ?? '电脑').slice(0, 64),
        os: String(d.os ?? '').slice(0, 128),
        ip: String(d.ip ?? '').slice(0, 128),
        username: String(d.username ?? u.nick ?? u.username).slice(0, 64),
        userId: u.id,
        lastSeen: Date.now(),
        controller: devByDeviceId(deviceId)?.controller
      }
      remoteDevices.set(deviceId, dev)
      socket.data.deviceId = deviceId
      socket.data.isSlave = true
      // 清理同名/同 socket 旧记录
      for (const [k, v] of remoteDevices) if (v.socket === socket && k !== deviceId) remoteDevices.delete(k)
      ack(ok({ deviceId }))
    })

    socket.on('dev:heartbeat', (data: unknown) => {
      const d = (data ?? {}) as { deviceId?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (dev && dev.socket === socket) dev.lastSeen = Date.now()
    })

    // 被控端上报枚举设备 → 转发给控制端
    socket.on('dev:devices', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { deviceId?: unknown; cams?: unknown; mics?: unknown }
      const deviceId = String(d.deviceId ?? '')
      const dev = remoteDevices.get(deviceId)
      if (!dev || dev.socket !== socket) return ack(fail('设备不存在'))
      const payload = { deviceId, cams: d.cams ?? [], mics: d.mics ?? [] }
      if (dev.controller) {
        const ctrl = io.sockets.sockets.get(dev.controller)
        if (ctrl) send(ctrl, 'dev:devices', payload)
      }
      ack(ok({ deviceId }))
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
        }
        ack(ok())
        return
      }
      // 控制端：需 SERVER_ADMIN 且为当前控制器
      if (!isAdminSocket(socket, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      if (dev.controller !== socket.id) return ack(fail('你不是该设备的控制器'))
      send(dev.socket, 'dev:signal', { deviceId, signal: d.signal })
      ack(ok())
    })

    // 断开：清在线表
    socket.on('disconnect', () => {
      for (const [k, v] of remoteDevices) {
        if (v.socket === socket) remoteDevices.delete(k)
      }
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
      if (!dev) return ack(fail('该设备已离线'))
      // 绑定控制器（同一设备仅一个控制端；抢占时替换）
      dev.controller = socket.id
      send(dev.socket, 'dev:view', { deviceId })
      ack(ok({ deviceId, name: dev.name, username: dev.username, os: dev.os, ip: dev.ip, iceServers: config.iceServers }))
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

function devByDeviceId(deviceId: string): RemoteDevice | undefined {
  return remoteDevices.get(deviceId)
}
