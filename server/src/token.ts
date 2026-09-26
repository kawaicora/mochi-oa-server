import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'node:crypto'

export interface TokenPayload {
  sub: string
  username: string
}

export function signToken(payload: TokenPayload, secret: string, expiresIn: string): string {
  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] })
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload
    if (typeof decoded.sub !== 'string' || typeof decoded.username !== 'string') return null
    return { sub: decoded.sub, username: decoded.username }
  } catch {
    return null
  }
}

// ---- 多会话：不透明随机 token，存 sha256 摘要（可单独撤销、支持多端） ----

/** 生成一个不可猜测的会话 token */
export function newSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** token 的 sha256 摘要，用于在会话表中查找/存储 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
