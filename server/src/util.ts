/** 生成 8 位加入码（大写字母数字，去掉易混淆字符） */
export function makeJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

/** 公司房间名 */
export function companyRoom(companyId: number): string {
  return `company:${companyId}`
}

/** 群房间名 */
export function groupRoom(groupId: number): string {
  return `group:${groupId}`
}

/** 用户房间名（在线时加入，私信/离线广播定向送达用） */
export function userRoom(userId: number): string {
  return `user:${userId}`
}

/** 会话房间名（一个登录会话对应一个房间，便于踢下线/新设备登录时定向推送） */
export function sessionRoom(sessionId: number): string {
  return `session:${sessionId}`
}

export const ok = (data: Record<string, unknown> = {}): Record<string, unknown> => ({ ok: true, ...data })

export const fail = (error: string): Record<string, unknown> => ({ ok: false, error })
