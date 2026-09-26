// 复现「注册后登录失败」：直接打 Docker(mysql) 服务
// 流程：注册 → 断开 → 重连 → 登录（同账号同密码） → 看是否成功
import { io } from 'socket.io-client'

const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
const user = `loginreg_${ts}`
const pass = 'secret123'

let failures = 0
const assert = (c, m) => {
  if (c) console.log(`  ok - ${m}`)
  else {
    failures++
    console.error(`  FAIL - ${m}`)
  }
}
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
async function connect() {
  const s = io(URL, { transports, reconnection: false })
  await new Promise((res, rej) => {
    s.once('connect', res)
    s.once('connect_error', rej)
  })
  return s
}

async function main() {
  // ---- 1) 注册 ----
  const s1 = await connect()
  const reg = await emitAck(s1, 'auth:register', { username: user, password: pass, nick: '登录回归用户' })
  assert(reg.ok && reg.token && reg.user.username === user, `注册成功 token=${!!reg.token}`)
  console.log(`  info - 服务端注册 ack 原文: ${JSON.stringify({ ok: reg.ok, error: reg.error, hasUser: !!reg.user, hasToken: !!reg.token })}`)

  // ---- 2) 断开重连，走登录 ----
  s1.disconnect()
  const s2 = await connect()
  const login = await emitAck(s2, 'auth:login', { username: user, password: pass })
  assert(login.ok && login.token, '登录成功（同密码）')
  if (!login.ok) console.log(`  info - 登录 ack 原文: ${JSON.stringify(login)}`)
  s2.disconnect()

  // ---- 3) 换一个密码，应失败（验证校验确实在工作） ----
  const s3 = await connect()
  const wrong = await emitAck(s3, 'auth:login', { username: user, password: 'wrongpass123' })
  assert(wrong.ok === false, '错误密码被拒绝')
  s3.disconnect()

  console.log(failures === 0 ? '\nLOGIN-REG TEST PASS' : `\nLOGIN-REG TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
