/**
 * 通用验证码模块。
 *
 * 只负责验证码的「生成、存储、校验、冷却、过期」——不绑定任何发送通道（邮件/短信等）。
 * 发送由调用方完成（例如用主邮件 SMTP 发到邮箱），因此可复用于：注册、登录、改密、
 * 绑定邮箱、手机号验证等任意场景。
 *
 * 存储为进程内 Map（单实例足够）；多实例部署时换成 Redis/DB 即可，接口不变。
 */

import { randomInt } from 'node:crypto'

export interface VerifyCodeOptions {
  /** 有效期（毫秒），默认 10 分钟 */
  ttlMs?: number
  /** 重发冷却（毫秒），默认 60 秒 */
  cooldownMs?: number
  /** 最大尝试次数，超过后验证码作废，默认 5 次 */
  maxAttempts?: number
  /** 验证码长度，默认 6 位 */
  codeLen?: number
  /** 是否纯数字（默认 true，6 位数字）；false 时用去易混淆的字母+数字 */
  digits?: boolean
}

interface Entry {
  code: string
  expiresAt: number
  attempts: number
}

const key = (purpose: string, to: string): string => `${purpose}:${to.toLowerCase().trim()}`

export class VerifyCodeManager {
  private readonly ttlMs: number
  private readonly cooldownMs: number
  private readonly maxAttempts: number
  private readonly codeLen: number
  private readonly digits: boolean
  private readonly entries = new Map<string, Entry>()
  private readonly cooldowns = new Map<string, number>()

  constructor(options: VerifyCodeOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.cooldownMs = options.cooldownMs ?? 60 * 1000
    this.maxAttempts = options.maxAttempts ?? 5
    this.codeLen = options.codeLen ?? 6
    this.digits = options.digits ?? true
  }

  private makeCode(): string {
    if (this.digits) {
      return String(randomInt(0, 10 ** this.codeLen)).padStart(this.codeLen, '0')
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去 I/O/0/1
    let out = ''
    for (let i = 0; i < this.codeLen; i++) out += chars[randomInt(0, chars.length)]
    return out
  }

  /**
   * 生成验证码并缓存。冷却期内返回 null（附带剩余冷却毫秒）。
   * @returns { code, remainingMs } ｜ null（仍在冷却期）
   */
  issue(purpose: string, to: string): { code: string; remainingMs: number } | null {
    const k = key(purpose, to)
    const now = Date.now()
    const last = this.cooldowns.get(k)
    if (last && now < last + this.cooldownMs) {
      return { code: '', remainingMs: last + this.cooldownMs - now }
    }
    const code = this.makeCode()
    this.entries.set(k, { code, expiresAt: now + this.ttlMs, attempts: 0 })
    this.cooldowns.set(k, now)
    this.sweep()
    return { code, remainingMs: 0 }
  }

  /** 校验并消费（一次性）。成功即删除记录；失败累计次数，超限作废。 */
  verify(purpose: string, to: string, input: string): { ok: true } | { ok: false; error: string } {
    const k = key(purpose, to)
    const e = this.entries.get(k)
    if (!e) return { ok: false, error: '验证码不存在或已过期' }
    if (Date.now() > e.expiresAt) {
      this.entries.delete(k)
      return { ok: false, error: '验证码已过期' }
    }
    const value = String(input ?? '').trim()
    if (e.attempts >= this.maxAttempts) {
      this.entries.delete(k)
      return { ok: false, error: '尝试次数过多，请重新获取验证码' }
    }
    if (e.code !== value) {
      e.attempts += 1
      if (e.attempts >= this.maxAttempts) {
        this.entries.delete(k)
        return { ok: false, error: '尝试次数过多，请重新获取验证码' }
      }
      return { ok: false, error: '验证码错误' }
    }
    this.entries.delete(k)
    return { ok: true }
  }

  /** 主动作废（如邮箱绑定成功后） */
  revoke(purpose: string, to: string): void {
    this.entries.delete(key(purpose, to))
  }

  /** 清理过期记录（防内存膨胀） */
  sweep(): void {
    const now = Date.now()
    for (const [k, e] of this.entries) if (now > e.expiresAt) this.entries.delete(k)
    for (const [k, t] of this.cooldowns) if (now > t + this.cooldownMs) this.cooldowns.delete(k)
  }
}

/** 默认单例：多数场景直接用这一个（可自行 new VerifyCodeManager({...}) 定制） */
export const verifyCodes = new VerifyCodeManager()
