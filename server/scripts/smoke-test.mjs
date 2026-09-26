// 端到端冒烟测试：内存存储起真实服务，验证 注册→建公司→建部门→加入→建群→群聊→在线状态。
// 用法：node scripts/smoke-test.mjs （需先 npm run build）
import { spawn } from 'node:child_process'
import { io } from 'socket.io-client'

const PORT = 3999
const URL = `http://127.0.0.1:${PORT}`

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  ok - ${msg}`)
  else {
    failures++
    console.error(`  FAIL - ${msg}`)
  }
}

const once = (s, ev) => new Promise((r) => s.once(ev, r))
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))

async function connect() {
  const s = io(URL, { transports: ['websocket'], reconnection: false })
  await new Promise((res, rej) => {
    s.once('connect', res)
    s.once('connect_error', rej)
  })
  return s
}

const server = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, STORAGE: 'memory', HOST: '127.0.0.1', PORT: String(PORT), JWT_SECRET: 'smoke-test-secret' },
  stdio: ['ignore', 'pipe', 'pipe']
})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
const readyP = new Promise((resolve) => {
  server.stdout.on('data', (d) => {
    if (d.toString().includes('已启动')) resolve()
  })
})

try {
  await Promise.race([readyP, new Promise((_, rej) => setTimeout(() => rej(new Error('server not ready')), 10000))])
  console.log('server ready')

  const alice = await connect()
  const regA = await emitAck(alice, 'auth:register', { username: 'alice', password: 'secret123', nick: 'Alice' })
  assert(regA.ok && regA.token, 'alice 注册成功')

  // ---- 管理员建公司 ----
  const create = await emitAck(alice, 'company:create', { name: 'Acme 工作室' })
  assert(create.ok && create.company, 'alice 创建公司成功')
  const company = create.company

  // ---- 管理员建部门 ----
  const dept = await emitAck(alice, 'company:createDepartment', { companyId: company.id, name: '研发部' })
  assert(dept.ok && dept.department, 'alice(owner) 创建部门成功')

  // ---- 普通成员(bob)不能建部门 ----
  const bob = await connect()
  const regB = await emitAck(bob, 'auth:register', { username: 'bob', password: 'secret456', nick: 'Bob' })
  assert(regB.ok, 'bob 注册成功')
  const joinCo = await emitAck(bob, 'company:join', { code: company.code })
  assert(joinCo.ok, 'bob 凭公司码加入公司成功')

  const deptByBob = await emitAck(bob, 'company:createDepartment', { companyId: company.id, name: '秘密部' })
  assert(deptByBob.ok === false, 'bob(普通成员) 建部门被拒绝')

  // ---- 成员建群 ----
  const gcreate = await emitAck(bob, 'group:create', { companyId: company.id, name: '项目A 群' })
  assert(gcreate.ok && gcreate.group, 'bob(成员) 创建群成功')
  const group = gcreate.group

  const glistA = await emitAck(alice, 'group:list', {})
  assert(glistA.ok && glistA.groups.length === 0, 'alice 尚未入群，群列表为空')

  // ---- alice 凭群码入群 ----
  const gjoin = await emitAck(alice, 'group:join', { code: group.code })
  assert(gjoin.ok, 'alice 凭群码加入群成功')

  // ---- 群聊：bob 发 → alice 收 ----
  const msgP = once(alice, 'chat:message')
  const send = await emitAck(bob, 'chat:send', { groupId: group.id, text: '大家好' })
  assert(send.ok, 'bob 在群内发消息成功')
  const msg = await msgP
  assert(msg.content === '大家好' && msg.nick === 'Bob' && msg.kind === 'text', 'alice 收到群消息')

  // ---- 群成员 + 在线 ----
  const gmembers = await emitAck(alice, 'group:members', { groupId: group.id })
  assert(gmembers.ok && gmembers.members.length === 2, '群成员 2 人')
  assert(gmembers.members.find((m) => m.username === 'bob')?.online === true, 'bob 在线')

  // ---- 群主踢非群主？alice 是成员非群主，踢人应被拒 ----
  const kickByAlice = await emitAck(alice, 'group:kick', { groupId: group.id, userId: regB.user.id })
  assert(kickByAlice.ok === false, '非群主踢人被拒绝')

  // ---- 私信：bob → alice ----
  const dmP = once(alice, 'dm:message')
  const dmSend = await emitAck(bob, 'dm:send', { toUserId: regA.user.id, text: '你好 Alice' })
  assert(dmSend.ok, 'bob 给 alice 发私信成功')
  const dmMsg = await dmP
  assert(dmMsg.content === '你好 Alice' && dmMsg.fromId === regB.user.id && dmMsg.type === 'dm', 'alice 收到私信')

  // ---- 对话列表：含 群+私信，最新倒序 ----
  const cList = await emitAck(alice, 'conversation:list', {})
  assert(cList.ok && cList.conversations.length >= 2, 'alice 对话列表含群+私信')
  const dmItem = cList.conversations.find((c) => c.type === 'dm')
  assert(dmItem && dmItem.dmUserId === regB.user.id && dmItem.name === 'Bob', '私信条目解析对方昵称')
  assert(cList.conversations[0].type === 'dm', '对话列表按最新倒序（私信在前）')

  // ---- 置顶 ----
  const pin = await emitAck(alice, 'conversation:pin', { conversationId: dmItem.conversationId, pinned: true })
  assert(pin.ok && pin.pinned === true, 'alice 置顶私信对话成功')
  const cList2 = await emitAck(alice, 'conversation:list', {})
  const pinnedItem = cList2.conversations.find((c) => c.type === 'dm')
  assert(pinnedItem && pinnedItem.pinned === true && cList2.conversations[0].type === 'dm', '置顶后仍排最前')

  // ---- 私信历史 ----
  const dmHist = await emitAck(alice, 'dm:history', { withUserId: regB.user.id })
  assert(dmHist.ok && dmHist.messages.length >= 1 && dmHist.messages[0].content === '你好 Alice', 'alice 私信历史含消息')

  // ---- 群历史 ----
  const gHist = await emitAck(alice, 'chat:history', { groupId: group.id })
  assert(gHist.ok && gHist.messages.length >= 1 && gHist.messages[0].content === '大家好', '群历史含消息')

  // ---- 软删：bob 删自己的私信（打 deletedAt 标记） ----
  const delOwn = await emitAck(bob, 'message:delete', { conversationId: dmItem.conversationId, messageId: dmMsg.id })
  assert(delOwn.ok, 'bob 软删自己私信成功')
  const dmHist2 = await emitAck(alice, 'dm:history', { withUserId: regB.user.id })
  assert(dmHist2.ok && dmHist2.messages.every((m) => m.id !== dmMsg.id), '软删后历史不再返回该消息')

  // ---- 真正删除：仅本人（私信无公司管理员） ----
  const dmMsg2P = once(alice, 'dm:message')
  const dmSend2 = await emitAck(bob, 'dm:send', { toUserId: regA.user.id, text: '第二条' })
  await dmMsg2P
  const hardByAlice = await emitAck(alice, 'message:hardDelete', { conversationId: dmItem.conversationId, messageId: dmSend2.id })
  assert(hardByAlice.ok === false, '私信非本人不能真正删除')
  const hardByBob = await emitAck(bob, 'message:hardDelete', { conversationId: dmItem.conversationId, messageId: dmSend2.id })
  assert(hardByBob.ok === true, '私信本人可真正删除')

  // ---- 离线广播 ----
  const offlineP = once(alice, 'presence:update')
  bob.disconnect()
  const off = await offlineP
  assert(off.online === false && off.userId === regB.user.id, 'bob 断开后 alice 收到离线广播')

  alice.disconnect()
  console.log(failures === 0 ? '\nSMOKE TEST PASS' : `\nSMOKE TEST FAIL (${failures})`)
} catch (err) {
  failures++
  console.error('smoke test error:', err)
} finally {
  server.kill()
}
process.exit(failures === 0 ? 0 : 1)
