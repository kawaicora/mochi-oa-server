/** 在线状态登记：userId → 当前连接的 socket id 集合（同用户可多端在线） */

const presence = new Map<number, Set<string>>()

export function addPresence(userId: number, socketId: string): void {
  let set = presence.get(userId)
  if (!set) {
    set = new Set()
    presence.set(userId, set)
  }
  set.add(socketId)
}

/** 返回该用户是否仍在线（至少还有其它连接） */
export function removePresence(userId: number, socketId: string): boolean {
  const set = presence.get(userId)
  if (!set) return false
  set.delete(socketId)
  if (set.size === 0) {
    presence.delete(userId)
    return false
  }
  return true
}

export function isOnline(userId: number): boolean {
  const set = presence.get(userId)
  return set !== undefined && set.size > 0
}
