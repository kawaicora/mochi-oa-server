// 验证 company:members / department:members / group:members 回填 avatar
import { io } from 'socket.io-client'

const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
let failures = 0
const assert = (c, m) => {
  if (c) console.log(`  ok - ${m}`)
  else { failures++; console.error(`  FAIL - ${m}`) }
}
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
async function connect() {
  const s = io(URL, { transports, reconnection: false })
  await new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej) })
  return s
}

async function main() {
  const a = `ma_a_${ts}`
  const b = `ma_b_${ts}`
  const pass = 'secret123'
  const sA = await connect()
  const sB = await connect()

  const ra = await emitAck(sA, 'auth:register', { username: a, password: pass, nick: '甲' })
  const rb = await emitAck(sB, 'auth:register', { username: b, password: pass, nick: '乙', avatar: 'http://x/b.png' })
  assert(ra.ok && rb.ok, '两用户注册成功')
  // 给用户 A 设置头像
  const upA = await emitAck(sA, 'user:updateProfile', { avatar: 'http://x/a.png' })
  assert(upA.ok, '用户A设置头像成功')

  const company = await emitAck(sA, 'company:create', { name: `测试公司${ts}` })
  assert(company.ok && company.company, '创建公司成功')
  const cid = company.company.id
  // B 凭码加入
  const join = await emitAck(sB, 'company:join', { code: company.company.code })
  assert(join.ok, 'B 加入公司成功')

  const members = await emitAck(sA, 'company:members', { companyId: cid })
  const mA = members.members.find((m) => m.userId === ra.user.id)
  const mB = members.members.find((m) => m.userId === rb.user.id)
  assert(mA && mA.avatar === 'http://x/a.png', `company:members A avatar=${mA?.avatar}`)
  assert(mB && mB.avatar === 'http://x/b.png', `company:members B avatar=${mB?.avatar}`)

  // 建群并拉两人 → group:members avatar
  const g = await emitAck(sA, 'group:create', { companyId: cid, name: '群X' })
  assert(g.ok && g.group, '建群成功')
  const joinG = await emitAck(sB, 'group:join', { code: g.group.code })
  assert(joinG.ok, 'B 入群成功')
  const gMembers = await emitAck(sA, 'group:members', { groupId: g.group.id })
  const gmB = gMembers.members.find((m) => m.userId === rb.user.id)
  assert(gmB && gmB.avatar === 'http://x/b.png', `group:members B avatar=${gmB?.avatar}`)

  sA.disconnect(); sB.disconnect()
  console.log(failures === 0 ? '\nMEMBER-AVATAR TEST PASS' : `\nMEMBER-AVATAR TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
