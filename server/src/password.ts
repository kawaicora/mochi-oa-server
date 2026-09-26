import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEYLEN = 64

/** 密码散列：scrypt（纯 Node 内置，无需原生依赖，便于 pkg 打包） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, KEYLEN).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, hash] = parts
  const candidate = scryptSync(password, salt, KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
