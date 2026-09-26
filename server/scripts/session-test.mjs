// 多会话（登录有效期）端到端验证：打 Docker(mysql)
// 覆盖：注册/登录→多端登录→新设备登录推送到其他端→会话列表→设置有效期→踢下线(其他端收 sessionRevoked)→过期 token 失效
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
let failures = 0
const assert = (c, m) => { if (c) console.log(`  ok - ${m}`); else { failures++; console.error(`  FAIL - ${m}`) } }
const once = (s, ev, ms = 4000) => new Promise((r) => { const t = setTimeout(() => r(null), ms); s.once(ev, (d) => { clearTimeout(t); r(d) }) })
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
async function connect(token) {
  const s = io(URL, { transports, reconnection: false, auth: token ? { token, device: 'TEST_DEVICE' } : { device: 'TEST_DEVICE' } })
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej) })
  return s
}

async function main() {
  const user = `sess_${ts}`, pass = 'secret123'

  // 1) 注册（获得 token），随后登出清掉该会话
  const a = await connect()
  const reg = await emitAck(a, 'auth:register', { username: user, password: pass, nick: '多端用户', device: 'DEV-A' })
  assert(reg.ok && reg.token && reg.session, '注册成功并返回 token+session')
  assert(reg.session.expiresAt && new Date(reg.session.expiresAt).getTime() > Date.now(), '注册会话带过期时间')
  await emitAck(a, 'auth:logout', {})
  a.disconnect()

  // 2) 设备 A 登录（第 1 个会话）
  const devA = await connect()
  const loginA = await emitAck(devA, 'auth:login', { username: user, password: pass, device: 'DEV-A' })
  assert(loginA.ok && loginA.token && loginA.session, '设备 A 登录成功（会话1）')
  const tokenA = loginA.token

  // 3) 设备 B 登录（第 2 个会话）→ 设备 A 收到新设备登录弹窗
  const newDevP = once(devA, 'auth:newDeviceLogin')
  const devB = await connect()
  const loginB = await emitAck(devB, 'auth:login', { username: user, password: pass, device: 'DEV-B' })
  assert(loginB.ok && loginB.token, '设备 B 登录成功（会话2）')
  const tokenB = loginB.token
  const nd = await newDevP
  assert(nd && nd.device === 'DEV-B', '设备 A 实时收到「新设备登录」弹窗（DEV-B）')
  if (!nd) console.log('  info - newDeviceLogin 未收到')

  // 4) 设备 C 登录（第 3 个会话）→ A、B 都收到
  const newDevA2 = once(devA, 'auth:newDeviceLogin')
  const newDevB = once(devB, 'auth:newDeviceLogin')
  const devC = await connect()
  const loginC = await emitAck(devC, 'auth:login', { username: user, password: pass, device: 'DEV-C' })
  assert(loginC.ok, '设备 C 登录成功（会话3）')
  const ndA2 = await newDevA2
  const ndB = await newDevB
  assert(ndA2 && ndA2.device === 'DEV-C' && ndB && ndB.device === 'DEV-C', 'A、B 均收到 DEV-C 新设备登录弹窗')

  // 5) 会话列表：应有 3 个会话，含当前会话标记
  const sessList = await emitAck(devB, 'auth:sessions', {})
  assert(sessList.ok && sessList.sessions.length === 3, '会话列表含 3 个会话')
  assert(sessList.currentSessionId === loginB.session.id, '当前会话标记正确')

  // 6) 设置登录有效期 = 7 天
  const setDays = await emitAck(devB, 'auth:setSessionDays', { days: 7 })
  assert(setDays.ok && setDays.sessionDays === 7, '设置登录有效期为 7 天')

  // 7) 新登录一次（设备 D），其过期时间 ≈ 现在 + 7 天
  const devD = await connect()
  const loginD = await emitAck(devD, 'auth:login', { username: user, password: pass, device: 'DEV-D' })
  const diffDays = (new Date(loginD.session.expiresAt).getTime() - Date.now()) / 86400000
  assert(loginD.ok && diffDays > 6 && diffDays <= 7.1, `新会话有效期约 7 天（实测 ${diffDays.toFixed(2)} 天）`)
  devD.disconnect()

  // 8) 设备 A 踢掉设备 C → 设备 C 收到 auth:sessionRevoked 并被强制断开；用 C 的 token 新建连接应被拒
  const revokedC = once(devC, 'auth:sessionRevoked')
  const endC = await emitAck(devA, 'auth:endSession', { sessionId: loginC.session.id })
  assert(endC.ok, '设备 A 踢下线设备 C 成功')
  const rc = await revokedC
  assert(rc && rc.reason === 'ended' && rc.device === 'DEV-C', '设备 C 收到 sessionRevoked')
  const tokenC = loginC.token
  devC.disconnect()
  const reconC = await connect(tokenC)
  const meC = await emitAck(reconC, 'auth:me', {})
  assert(meC.ok === false, '被踢设备 C 的 token 已失效（新连接 auth:me 拒绝）')
  reconC.disconnect()

  // 9) 过期 token 失效：伪造一个不存在/已删除的会话 token 重连 → auth:me 拒绝
  const bad = await connect('deadbeef'.repeat(8))
  const meBad = await emitAck(bad, 'auth:me', {})
  assert(meBad.ok === false, '失效 token 重连后 auth:me 拒绝')
  bad.disconnect()

  // 10) 全部退出其他设备：A 退出 B、D（保留自己）
  const endAll = await emitAck(devA, 'auth:endAllSessions', {})
  assert(endAll.ok && endAll.ended >= 2, '退出所有其他设备')
  const sessAfter = await emitAck(devA, 'auth:sessions', {})
  assert(sessAfter.sessions.length === 1 && sessAfter.currentSessionId === loginA.session.id, '仅剩当前设备 A 的会话')

  devA.disconnect()
  devB.disconnect()
  console.log(failures === 0 ? '\nSESSION TEST PASS' : `\nSESSION TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
