// 复现客户端真实时序：注册自动登录 → 回到登录页 → 登录
// 场景 A: 同一 socket 注册 → auth:logout → auth:login
// 场景 B: 同一 socket 注册 → 直接 auth:login（不登出）
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
let failures = 0
const assert = (c, m) => { if (c) console.log(`  ok - ${m}`); else { failures++; console.error(`  FAIL - ${m}`) } }
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
async function connect() {
  const s = io(URL, { transports, reconnection: false })
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej) })
  return s
}

async function scenarioA() {
  const user = `seqA_${ts}`, pass = 'secret123'
  const s = await connect()
  const reg = await emitAck(s, 'auth:register', { username: user, password: pass, nick: '时序A' })
  assert(reg.ok, 'A: 注册 ok')
  // 客户端 register 后 socket 已被自动登录；client 应 logout 回登录页
  const out = await emitAck(s, 'auth:logout', {})
  assert(out.ok, 'A: logout ok')
  const login = await emitAck(s, 'auth:login', { username: user, password: pass })
  assert(login.ok && login.token, 'A: 登出后同 socket 登录成功')
  s.disconnect()
}

async function scenarioB() {
  const user = `seqB_${ts}`, pass = 'secret123'
  const s = await connect()
  const reg = await emitAck(s, 'auth:register', { username: user, password: pass, nick: '时序B' })
  assert(reg.ok, 'B: 注册 ok')
  const login = await emitAck(s, 'auth:login', { username: user, password: pass })
  assert(login.ok && login.token, 'B: 注册后(不登出)直接同 socket 登录成功')
  if (!login.ok) console.log(`  info - B login ack: ${JSON.stringify(login)}`)
  s.disconnect()
}

async function main() {
  await scenarioA()
  await scenarioB()
  console.log(failures === 0 ? '\nSEQ TEST PASS' : `\nSEQ TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
