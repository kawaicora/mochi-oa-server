import type { Socket } from 'socket.io'
import { AlreadyExistsError } from '../db/store'
import { fail, ok, userRoom } from '../util'
import type { AuthUser, Ctx } from './auth'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

export function registerFriendHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ---- 加好友（与公司无关，钉钉无公司也能加） ----
    socket.on('friend:add', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const userId = Number((data as { userId?: unknown } | null)?.userId)
      if (!Number.isInteger(userId) || userId <= 0 || userId === auth.id) return ack(fail('参数不合法'))
      if ((await store.getUserById(userId)) === null) return ack(fail('对方不存在'))
      try {
        await store.addFriend(auth.id, userId)
        io.to(userRoom(auth.id)).emit('friends:updated', {})
        io.to(userRoom(userId)).emit('friends:updated', {})
        ack(ok())
      } catch (err) {
        // 互加语义：已是好友视为成功（幂等）
        ack(err instanceof AlreadyExistsError ? ok() : fail('添加失败'))
      }
    })

    // ---- 移除好友 ----
    socket.on('friend:remove', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const userId = Number((data as { userId?: unknown } | null)?.userId)
      if (!Number.isInteger(userId) || userId <= 0) return ack(fail('参数不合法'))
      await store.removeFriend(auth.id, userId).catch(() => ack(fail('不是好友')))
      io.to(userRoom(auth.id)).emit('friends:updated', {})
      io.to(userRoom(userId)).emit('friends:updated', {})
      ack(ok())
    })

    // ---- 好友列表 ----
    socket.on('friend:list', async (_data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const friends = await store.listFriends(auth.id)
      ack(ok({ friends }))
    })

  })
}
