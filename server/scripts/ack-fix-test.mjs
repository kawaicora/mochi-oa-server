// 验证客户端 ack 规整逻辑：服务端返回顶层字段 ack，客户端 normalize 后 ack.data 可读 → 不再误报「登录失败」
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
let failures = 0
const assert = (c, m) => { if (c) console.log(`  ok - ${m}`); else { failures++; console.error(`  FAIL - ${m}`) } }
const emitRaw = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
async function connect(token) {
  const s = io(URL, { transports, reconnection: false, auth: token ? { token, device: 'T' } : { device: 'T' } })
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej) })
  return s
}

// 与客户端 server-client.ts 相同的规整函数
function normalizeAck(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '无响应' }
  const a = raw
  const data = {}
  for (const k of Object.keys(a)) { if (k !== 'ok' && k !== 'error') data[k] = a[k] }
  return { ok: a.ok === true, error: typeof a.error === 'string' && a.error ? a.error : undefined, data: Object.keys(data).length ? data : undefined }
}
// 与客户端 applyAuthAck 相同的判定
function applyAuthAck(ack) {
  if (ack.ok && ack.data) return { ok: true, token: ack.data.token, userId: ack.data.user.id }
  return { ok: false, error: ack.error || '登录失败' }
}

async function main() {
  const user = `ackfix_${ts}`, pass = 'secret123'
  const s = await connect()
  const rawReg = await emitRaw(s, 'auth:register', { username: user, password: pass, nick: 'ACK', device: 'T' })
  assert(rawReg && rawReg.ok === true && rawReg.token && rawReg.user, '服务端注册 ack 为顶层字段（ok/token/user）')
  const reg = applyAuthAck(normalizeAck(rawReg))
  assert(reg.ok && reg.token && reg.userId, '规整后注册不再误报「登录失败」，能读到 token/userId')
  const regErr = reg.ok ? '' : reg.error
  if (!reg.ok) console.log(`  info - reg.error=${regErr}`)
  await s.emit('auth:logout', {}, (a) => void a)
  s.disconnect()

  const s2 = await connect()
  const rawLogin = await emitRaw(s2, 'auth:login', { username: user, password: pass, device: 'T' })
  const login = applyAuthAck(normalizeAck(rawLogin))
  assert(login.ok && login.token && login.userId, '登录规整后正常，不再误报「登录失败」')
  const s3 = await connect()
  const rawWrong = await emitRaw(s3, 'auth:login', { username: user, password: 'nope123', device: 'T' })
  const wrong = applyAuthAck(normalizeAck(rawWrong))
  assert(wrong.ok === false && wrong.error === '用户名或密码错误', '错误密码正确返回「用户名或密码错误」')
  s2.disconnect(); s3.disconnect()
  console.log(failures === 0 ? '\nACK-FIX TEST PASS' : `\nACK-FIX TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
