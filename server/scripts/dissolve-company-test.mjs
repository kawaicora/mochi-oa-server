// 端到端验证「解散公司」逻辑修复：
//   1) 注册临时账号 → 创建公司
//   2) 断言创建者角色=owner（验证 createCompany ROLE 修复）
//   3) company:dissolve 成功（验证 ownerId 权威判断）
//   4) 公司已彻底删除
import { io } from 'socket.io-client'

const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
const user = `dissolve_${ts}`
const pass = 'secret123'

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
  const s = await connect()
  // 1) 注册 + 创建公司
  const reg = await emitAck(s, 'auth:register', { username: user, password: pass, nick: '解散验证' })
  assert(reg.ok && reg.user?.id, '注册成功')
  const cc = await emitAck(s, 'company:create', { name: `解散验证${ts}` })
  const cid = cc.company?.id ?? cc.data?.company?.id
  if (!cc.ok) console.log(`  info - 创建公司 ack: ${JSON.stringify(cc)}`)
  assert(cc.ok && cid, `创建公司成功 id=${cid}`)

  // 2) 创建者角色应为 owner（company:list 返回我的公司及角色）
  const list = await emitAck(s, 'company:list', {})
  const myComp = list.companies?.find((c) => c.company.id === cid)
  assert(myComp && myComp.role === 'owner', `创建者角色=owner（实际: ${myComp?.role ?? '未找到'}）`)

  // 3) 解散公司（owner_id 权威判断应放行）
  const dis = await emitAck(s, 'company:dissolve', { companyId: cid })
  assert(dis.ok, `解散公司成功（${dis.error || 'ok'}）`)

  // 4) 公司已删除
  const search = await emitAck(s, 'company:search', { keyword: `解散验证${ts}` })
  const found = search.data?.companies?.some((c) => c.id === cid)
  assert(!found, '公司已彻底删除')

  s.disconnect()
  console.log(failures === 0 ? '\nDISSOLVE-COMPANY TEST PASS' : `\nDISSOLVE-COMPANY TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
