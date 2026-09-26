/**
 * 一次性密码重置令牌。
 *
 * 只负责令牌的「生成、存储、校验、过期、一次性消费」——不绑定发送通道。
 * 由忘记密码流程使用：邮箱验证码通过后 issue 一个令牌，把含 /view/reset-pwd?token= 的
 * 链接发到用户邮箱；GET 渲染表单时 peek（不消费），POST 提交新密码时 consume（一次性）。
 *
 * 进程内 Map（单实例足够）；多实例/重启会失效，需要持久化时换 Redis/DB 即可，接口不变。
 */

import { randomBytes } from 'node:crypto'

interface Entry {
  userId: number
  email: string
  expiresAt: number
}

const DEFAULT_TTL = 30 * 60 * 1000 // 30 分钟
const map = new Map<string, Entry>()

function sweep(): void {
  const now = Date.now()
  for (const [k, e] of map) if (now > e.expiresAt) map.delete(k)
}

export const resetTokens = {
  /** 生成一次性重置令牌并缓存。返回令牌（含进链接发给用户） */
  issue(userId: number, email: string, ttlMs: number = DEFAULT_TTL): string {
    const token = randomBytes(32).toString('hex')
    map.set(token, { userId, email, expiresAt: Date.now() + ttlMs })
    sweep()
    return token
  },

  /** 仅校验令牌有效性（渲染表单页用，不消费，可重复调用直到提交） */
  peek(token: string): { userId: number; email: string } | null {
    const e = map.get(token)
    if (!e) return null
    if (Date.now() > e.expiresAt) {
      map.delete(token)
      return null
    }
    return { userId: e.userId, email: e.email }
  },

  /** 校验并消费（一次性，POST 改密时调用，成功即删除） */
  consume(token: string): { userId: number; email: string } | null {
    const e = map.get(token)
    if (!e) return null
    if (Date.now() > e.expiresAt) {
      map.delete(token)
      return null
    }
    map.delete(token)
    return { userId: e.userId, email: e.email }
  },

  /** 清理过期令牌（防内存膨胀；issue 时也会触发） */
  sweep
}
