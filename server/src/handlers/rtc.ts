import type { Server, Socket } from 'socket.io'
import type { ServerConfig, IceServer } from '../config'
import type { Store } from '../db/store'
import type { AuthUser } from './auth'
import { fail, groupRoom, ok, userRoom } from '../util'
import { getIceServers } from '../ice'
import { isServerAdmin } from './mail'

export interface RtcCtx {
  io: Server
  store: Store
  config: ServerConfig
}

export type RtcKind = 'video' | 'voice'
type RtcType = 'dm' | 'conf' | 'group'

/**
 * WebRTC 信令房间（内存态）。
 * - conf（会议）：rtcId == meetingNo（会议号），预约创建/直接开始，开始+结束后删除；未开始超 356 天自动清除。
 * - dm（私聊通话）：rtcId = dm:{小userId}:{大userId}。
 * - group（群视频/语音）：rtcId = group:{groupId}，无会议号，群里直接开始。
 * 密码为临时会话口令，只存内存。
 */
interface RtcSession {
  rtcId: string
  type: RtcType
  kind: RtcKind
  meetingNo?: string
  title?: string
  password?: string
  hostId: number
  groupId?: number
  dmA?: number
  dmB?: number
  createdAt: number
  startedAt: number | null
  ended: boolean
}

type Ack = (res: Record<string, unknown>) => void

/** 356 天（预约会议未开始即失效） */
const SCHEDULE_MAX_MS = 356 * 86400000

export function registerRtcHandlers(ctx: RtcCtx): void {
  const { io, store, config } = ctx

  // 全部会议/通话会话：conf rtcId=meetingNo；dm/group rtcId=对应标识
  const rooms = new Map<string, RtcSession>()

  const rtcRoom = (rtcId: string): string => `rtc:${rtcId}`
  const authed = (socket: Socket): AuthUser | null => (socket.data.auth as AuthUser | null) ?? null

  function makeMeetingNo(): string {
    let n: string
    do {
      n = String(100000 + Math.floor(Math.random() * 900000))
    } while (rooms.has(n))
    return n
  }

  /** 清除超 356 天仍未开始的预约会议（会议号作废） */
  function expireSweep(): void {
    const cutoff = Date.now() - SCHEDULE_MAX_MS
    for (const [id, r] of rooms) {
      if (r.type === 'conf' && r.startedAt === null && r.createdAt < cutoff) {
        rooms.delete(id)
      }
    }
  }

  /** 房间内在线参与者（socketId 维度，支持多端同时在线；含头像供语音通话头像列表） */
  function peersInfo(rtcId: string): { socketId: string; userId: number; nick: string; avatar: string }[] {
    const ids = io.sockets.adapter.rooms.get(rtcRoom(rtcId))
    const out: { socketId: string; userId: number; nick: string; avatar: string }[] = []
    if (!ids) return out
    for (const sid of ids) {
      const s = io.sockets.sockets.get(sid)
      if (!s) continue
      const rtc = s.data.rtc as { userId: number; nick: string; avatar: string } | undefined
      const a = s.data.auth as AuthUser | undefined
      out.push({ socketId: sid, userId: rtc?.userId ?? a?.id ?? 0, nick: rtc?.nick ?? a?.nick ?? '', avatar: rtc?.avatar ?? '' })
    }
    return out
  }

  /** 从 socket 取参与者信息（含头像） */
  function peerOf(socket: Socket): { socketId: string; userId: number; nick: string; avatar: string } {
    const rtc = socket.data.rtc as { userId: number; nick: string; avatar: string } | undefined
    const a = socket.data.auth as AuthUser | undefined
    return { socketId: socket.id, userId: rtc?.userId ?? a?.id ?? 0, nick: rtc?.nick ?? a?.nick ?? '', avatar: rtc?.avatar ?? '' }
  }

  function view(r: RtcSession): Record<string, unknown> {
    return {
      id: r.rtcId,
      type: r.type,
      kind: r.kind,
      meetingNo: r.meetingNo,
      title: r.title,
      hasPassword: !!r.password,
      hostId: r.hostId,
      groupId: r.groupId,
      started: r.startedAt != null,
      createdAt: r.createdAt
    }
  }

  async function addSocket(socket: Socket, rtcId: string, u: AuthUser): Promise<void> {
    socket.join(rtcRoom(rtcId))
    let avatar = ''
    try {
      avatar = (await store.getUserById(u.id))?.avatar ?? ''
    } catch {
      avatar = ''
    }
    socket.data.rtc = { userId: u.id, nick: u.nick, avatar }
    const set = (socket.data.rtcRooms as Set<string> | undefined) ?? new Set<string>()
    set.add(rtcId)
    socket.data.rtcRooms = set
  }

  function removeSocket(socket: Socket, rtcId: string): void {
    socket.leave(rtcRoom(rtcId))
    const set = socket.data.rtcRooms as Set<string> | undefined
    if (set) set.delete(rtcId)
    if (socket.data.rtc && (socket.data.rtc as { userId: number }).userId) socket.data.rtc = undefined
  }

  /** 离开后若房间空 → 结束会话：会议开始后即结束则删除会议号；dm/group 空房即删 */
  function cleanupIfEmpty(rtcId: string): void {
    const r = rooms.get(rtcId)
    if (!r) return
    if (peersInfo(rtcId).length > 0) return
    r.ended = true
    rooms.delete(rtcId)
    broadcastRoomsChanged()
  }

  /** 强制结束：通知所有参与者、踢出房间、删除会话（会议号作废） */
  function forceEnd(rtcId: string, by: { userId: number; nick: string }): void {
    const r = rooms.get(rtcId)
    if (!r) return
    r.ended = true
    rooms.delete(rtcId)
    io.to(rtcRoom(rtcId)).emit('rtc:ended', { room: rtcId, reason: 'ended', by })
    broadcastRoomsChanged()
    for (const sid of io.sockets.adapter.rooms.get(rtcRoom(rtcId)) ?? []) {
      const s = io.sockets.sockets.get(sid)
      if (s) {
        const set = s.data.rtcRooms as Set<string> | undefined
        set?.delete(rtcId)
        s.leave(rtcRoom(rtcId))
      }
    }
  }

  // 每小时清理超期预约会议
  const sweepTimer = setInterval(expireSweep, 3600000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  /** 进行中的房间列表（网页端 /view/room 据此展示所有可加入的会议/通话） */
  function liveRooms(): Array<{
    id: string
    type: RtcType
    kind: RtcKind
    meetingNo?: string
    title?: string
    hasPassword: boolean
    hostId: number
    groupId?: number
    peerCount: number
    startedAt: number
  }> {
    const out: ReturnType<typeof liveRooms> = []
    for (const r of rooms.values()) {
      if (r.ended || r.startedAt == null) continue
      out.push({
        id: r.rtcId,
        type: r.type,
        kind: r.kind,
        meetingNo: r.meetingNo,
        title: r.title,
        hasPassword: !!r.password,
        hostId: r.hostId,
        groupId: r.groupId,
        peerCount: peersInfo(r.rtcId).length,
        startedAt: r.startedAt
      })
    }
    return out
  }

  /** 进行中房间列表变化 → 通知所有在线端（/view/room 网页端据此实时刷新列表） */
  function broadcastRoomsChanged(): void {
    io.emit('rtc:roomsChanged', { ts: Date.now() })
  }

  io.on('connection', (socket) => {
    // 断线清理：从它所在的所有 rtc 房间退出并通知
    socket.on('disconnect', () => {
      const set = socket.data.rtcRooms as Set<string> | undefined
      if (!set) return
      for (const rtcId of set) {
        socket.to(rtcRoom(rtcId)).emit('rtc:peerLeft', { room: rtcId, peerId: socket.id })
        cleanupIfEmpty(rtcId)
      }
    })

    // ─── 创建会议（会议号，可预约或直接开始） ───
    socket.on('rtc:createMeeting', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { title?: unknown; startAt?: unknown; password?: unknown; kind?: unknown }
      expireSweep()
      const meetingNo = makeMeetingNo()
      const kind: RtcKind = d.kind === 'voice' ? 'voice' : 'video'
      const session: RtcSession = {
        rtcId: meetingNo,
        type: 'conf',
        kind,
        meetingNo,
        title: typeof d.title === 'string' && d.title.trim() ? d.title.trim().slice(0, 64) : undefined,
        password: typeof d.password === 'string' && d.password ? d.password.slice(0, 32) : undefined,
        hostId: u.id,
        createdAt: Date.now(),
        startedAt: null,
        ended: false
      }
      rooms.set(meetingNo, session)
      if (d.startAt != null && d.startAt !== '') {
        // 预约会议：不立即开始，保留会议号；由首个加入者开始（或按 startAt 由客户端触发 join）
        ack(ok({ meeting: view(session), scheduled: true }))
      } else {
        // 会议可以直接开始
        session.startedAt = Date.now()
        await addSocket(socket, meetingNo, u)
        broadcastRoomsChanged()
        ack(ok({ meeting: view(session), scheduled: false, peers: peersInfo(meetingNo).filter((p) => p.socketId !== socket.id), iceServers: await getIceServers(config) }))
      }
    })

    // ─── 查询会议信息（预约会议按会议号查） ───
    socket.on('rtc:getMeeting', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { meetingNo?: unknown }
      const meetingNo = typeof d.meetingNo === 'string' ? d.meetingNo.trim() : ''
      if (!/^\d{6}$/.test(meetingNo)) return ack(fail('会议号格式不正确'))
      expireSweep()
      const r = rooms.get(meetingNo)
      if (!r || r.type !== 'conf') return ack(fail('会议不存在或已结束'))
      ack(ok({ meeting: view(r) }))
    })

    // ─── 查询所有进行中的会议/通话（网页端 /view/room 拉取列表） ───
    socket.on('rtc:listRooms', (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      // 会议大厅（/view/room 数据层）仅 SERVER_ADMIN 可查：登录已判，此处兜底
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      expireSweep()
      ack(ok({ rooms: liveRooms() }))
    })

    // ─── 加入房间（会议按会议号；dm/group 按 rtcId） ───
    socket.on('rtc:join', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { roomId?: unknown; password?: unknown; kind?: unknown }
      const roomId = typeof d.roomId === 'string' && d.roomId ? d.roomId.trim() : ''
      if (!roomId) return ack(fail('缺少房间号/会议号'))
      expireSweep()
      const r = rooms.get(roomId)
      if (!r) return ack(fail('会议或房间不存在'))
      if (r.ended) return ack(fail('会议已结束'))
      if (r.type === 'conf' && r.password && (typeof d.password !== 'string' || d.password !== r.password)) {
        return ack(fail('会议密码错误'))
      }
      const wasStarted = r.startedAt != null
      if (!wasStarted) r.startedAt = Date.now() // 首个加入者即开始会议
      await addSocket(socket, roomId, u)
      socket.to(rtcRoom(roomId)).emit('rtc:peerJoined', { room: roomId, peer: peerOf(socket) })
      broadcastRoomsChanged()
      ack(
        ok({
          room: view(r),
          peers: peersInfo(roomId).filter((p) => p.socketId !== socket.id),
          iceServers: (await getIceServers(config)) as IceServer[],
          started: wasStarted
        })
      )
    })

    // ─── 信令中继（SDP offer/answer + ICE candidate）→ 转发给房间内其他参与者 ───
    socket.on('rtc:signal', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { roomId?: unknown; signal?: unknown }
      const roomId = typeof d.roomId === 'string' ? d.roomId : ''
      if (!roomId) return ack(fail('缺少房间号'))
      const r = rooms.get(roomId)
      if (!r) return ack(fail('房间不存在'))
      const raw = d.signal
      const sigType = raw && typeof raw === 'object' ? String((raw as { type?: unknown }).type ?? '') : ''
      let sigDetail = ''
      if (sigType === 'ice') sigDetail = String((raw as { candidate?: unknown }).candidate ?? '')
      else if (sigType === 'offer' || sigType === 'answer') sigDetail = 'sdpLen=' + String((raw as { sdp?: unknown }).sdp ?? '').length
      console.log('[rtc:signal] from user=' + u.id + ' room=' + roomId + ' type=' + sigType + (sigDetail ? ' ' + sigDetail : ''))
      socket.to(rtcRoom(roomId)).emit('rtc:signal', { room: roomId, from: peerOf(socket), signal: d.signal })
      ack(ok())
    })

    // ─── 房间内嵌聊天（与 rtc:signal 信令分离，广播给房间内其他参与者） ───
    socket.on('rtc:chatMessage', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { roomId?: unknown; content?: unknown }
      const roomId = typeof d.roomId === 'string' ? d.roomId.trim() : ''
      if (!roomId) return ack(fail('缺少房间号'))
      const content = typeof d.content === 'string' ? d.content.trim() : ''
      if (!content) return ack(fail('消息内容为空'))
      if (content.length > 2000) return ack(fail('消息内容过长'))
      const r = rooms.get(roomId)
      if (!r) return ack(fail('房间不存在'))
      const inRoom = (socket.data.rtcRooms as Set<string> | undefined)?.has(roomId) ?? false
      if (!inRoom) return ack(fail('不在该房间中'))
      socket.to(rtcRoom(roomId)).emit('rtc:chatMessage', { room: roomId, from: peerOf(socket), content, ts: Date.now() })
      ack(ok())
    })

    // ─── 离开房间 ───
    socket.on('rtc:leave', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const d = (data ?? {}) as { roomId?: unknown }
      const roomId = typeof d.roomId === 'string' ? d.roomId : ''
      if (!roomId) return ack(fail('缺少房间号'))
      removeSocket(socket, roomId)
      socket.to(rtcRoom(roomId)).emit('rtc:peerLeft', { room: roomId, peerId: socket.id })
      cleanupIfEmpty(roomId)
      broadcastRoomsChanged()
      ack(ok())
    })

    // ─── 结束会议/通话（会议开始+结束后会议号删除） ───
    socket.on('rtc:end', (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      const d = (data ?? {}) as { roomId?: unknown }
      const roomId = typeof d.roomId === 'string' ? d.roomId : ''
      if (!roomId) return ack(fail('缺少房间号'))
      if (!rooms.has(roomId)) return ack(fail('房间不存在'))
      forceEnd(roomId, { userId: u?.id ?? 0, nick: u?.nick ?? '' })
      ack(ok())
    })

    // ─── 私聊视频/语音通话：主叫方发起 ───
    socket.on('rtc:dmCall', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { userId?: unknown; kind?: unknown }
      const targetId = Number(d.userId)
      if (!Number.isInteger(targetId) || targetId <= 0) return ack(fail('参数不合法'))
      if (targetId === u.id) return ack(fail('不能呼叫自己'))
      const kind: RtcKind = d.kind === 'voice' ? 'voice' : 'video'
      const rtcId = `dm:${Math.min(u.id, targetId)}:${Math.max(u.id, targetId)}`
      let r = rooms.get(rtcId)
      if (!r) {
        r = { rtcId, type: 'dm', kind, hostId: u.id, dmA: Math.min(u.id, targetId), dmB: Math.max(u.id, targetId), createdAt: Date.now(), startedAt: Date.now(), ended: false }
        rooms.set(rtcId, r)
      } else if (r.ended) {
        return ack(fail('通话已结束'))
      }
      await addSocket(socket, rtcId, u)
      // 通知对方所有在线端
      io.to(userRoom(targetId)).emit('rtc:dmIncoming', { room: rtcId, kind, from: peerOf(socket), ts: Date.now() })
      broadcastRoomsChanged()
      ack(ok({ room: view(r), kind }))
    })

    // ─── 私聊通话：被叫方应答（accept=true 加入房间） ───
    socket.on('rtc:dmAnswer', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { roomId?: unknown; accept?: unknown }
      const roomId = typeof d.roomId === 'string' ? d.roomId : ''
      const r = rooms.get(roomId)
      if (!r || r.type !== 'dm') return ack(fail('通话不存在'))
      if (d.accept === true) {
        await addSocket(socket, roomId, u)
        socket.to(rtcRoom(roomId)).emit('rtc:peerJoined', { room: roomId, peer: peerOf(socket) })
        broadcastRoomsChanged()
        ack(ok({ room: view(r), peers: peersInfo(roomId).filter((p) => p.socketId !== socket.id), iceServers: (await getIceServers(config)) as IceServer[] }))
      } else {
        socket.to(rtcRoom(roomId)).emit('rtc:dmRejected', { room: roomId, by: peerOf(socket) })
        ack(ok())
      }
    })

    // ─── 群视频/语音：无会议号，群里直接开始（kind=voice 即群语音=无视频的 WebRTC） ───
    socket.on('rtc:groupCall', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authed(socket)
      if (!u) return ack(fail('未登录'))
      const d = (data ?? {}) as { groupId?: unknown; kind?: unknown }
      const gid = Number(d.groupId)
      if (!Number.isInteger(gid) || gid <= 0) return ack(fail('参数不合法'))
      // 校验发起者是群成员
      const groups = await store.getUserGroups(u.id).catch(() => [])
      if (!groups.some((g) => g.id === gid)) return ack(fail('不是该群成员'))
      const kind: RtcKind = d.kind === 'voice' ? 'voice' : 'video'
      const rtcId = `group:${gid}`
      let r = rooms.get(rtcId)
      if (!r) {
        r = { rtcId, type: 'group', kind, groupId: gid, hostId: u.id, createdAt: Date.now(), startedAt: Date.now(), ended: false }
        rooms.set(rtcId, r)
      } else if (r.ended) {
        return ack(fail('通话已结束'))
      }
      await addSocket(socket, rtcId, u)
      socket.to(rtcRoom(rtcId)).emit('rtc:peerJoined', { room: rtcId, peer: peerOf(socket) })
      // 通知在线群成员（群房间）
      // 只通知群内其它成员（socket.to 排除发起人自己，避免发起人也弹接听窗口）
      socket.to(groupRoom(gid)).emit('rtc:groupCall', { room: rtcId, kind, groupId: gid, from: peerOf(socket), ts: Date.now() })
      broadcastRoomsChanged()
      ack(
        ok({
          room: view(r),
          peers: peersInfo(rtcId).filter((p) => p.socketId !== socket.id),
          iceServers: (await getIceServers(config)) as IceServer[]
        })
      )
    })
  })
}
