import type { Server, Socket } from 'socket.io'
import type { Store } from './db/store'
import { groupRoom } from './util'

/** 向该用户所属的所有群房间广播在线状态变更 */
export async function broadcastPresence(io: Server, store: Store, socket: Socket, online: boolean): Promise<void> {
  const auth = socket.data.auth as { id: number; nick: string } | undefined
  if (!auth) return
  const groups = await store.getUserGroups(auth.id)
  for (const g of groups) {
    io.to(groupRoom(g.id)).emit('presence:update', {
      userId: auth.id,
      nick: auth.nick,
      online
    })
  }
}
