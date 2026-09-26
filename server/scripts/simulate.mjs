// 全面模拟（钉钉式）：连接真实服务端，覆盖 3 用户 / 多公司 / 群 / 私聊 / 文件 / 好友 / 无公司建群私聊。
// 用法：SIM_URL=http://127.0.0.1:3000 node scripts/simulate.mjs
import { io } from 'socket.io-client'

const URL = process.env.SIM_URL || 'http://127.0.0.1:3000'

let failures = 0
let passed = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ok - ${msg}`)
  } else {
    failures++
    console.error(`  FAIL - ${msg}`)
  }
}

const once = (s, ev) => new Promise((r) => s.once(ev, r))
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))

async function connect(authToken) {
  const s = io(URL, { transports: ['websocket'], reconnection: false, auth: authToken ? { token: authToken } : {} })
  await new Promise((res, rej) => {
    s.once('connect', res)
    s.once('connect_error', rej)
  })
  return s
}

/** 走 HTTP /api/upload 上传，返回 {uuid,url} */
async function upload(token, company, filename, mime, bytes) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), filename)
  const res = await fetch(`${URL}/api/upload?token=${token}&company=${company ?? ''}`, { method: 'POST', body: form })
  const j = await res.json()
  return j
}

const run = async () => {
  const stamp = Date.now().toString(36)
  const uname = (n) => `sim_${n}_${stamp}`

  console.log(`target: ${URL}`)

  // ---- 注册三个用户 ----
  const c1 = await connect()
  const r1 = await emitAck(c1, 'auth:register', { username: uname('a'), password: 'secret123', nick: '甲' })
  ok(r1.ok && r1.token, `用户1(甲) 注册成功 token=${!!r1.token}`)
  const u1 = r1.user
  c1.auth = { token: r1.token }

  const c2 = await connect()
  const r2 = await emitAck(c2, 'auth:register', { username: uname('b'), password: 'secret456', nick: '乙' })
  ok(r2.ok, `用户2(乙) 注册成功`)
  const u2 = r2.user
  c2.auth = { token: r2.token }

  const c3 = await connect()
  const r3 = await emitAck(c3, 'auth:register', { username: uname('c'), password: 'secret789', nick: '丙' })
  ok(r3.ok, `用户3(丙) 注册成功`)
  const u3 = r3.user
  c3.auth = { token: r3.token }

  // ---- 用户1：成立公司 + 部门 + 总群 ----
  const co1 = await emitAck(c1, 'company:create', { name: `工作室${stamp}` })
  ok(co1.ok && co1.company, '用户1 成立公司成功')
  const company1 = co1.company

  const dept = await emitAck(c1, 'company:createDepartment', { companyId: company1.id, name: '研发部' })
  ok(dept.ok && dept.department, '用户1 创建部门成功')

  const g1 = await emitAck(c1, 'group:create', { companyId: company1.id, name: '总群' })
  ok(g1.ok && g1.group, '用户1 创建总群成功')
  const group1 = g1.group

  // 无公司也能建群（钉钉：上级 company=0）
  const g0 = await emitAck(c1, 'group:create', { companyId: 0, name: '无公司群' })
  ok(g0.ok && g0.group && g0.group.companyId === 0, '无公司(company=0)建群成功')

  // ---- 用户1 上传并发送 图片/视频/音频/表情 ----
  const img = await upload(r1.token, company1.id, 'a.png', 'image/png', Buffer.from([1, 2, 3]))
  ok(img.ok && img.uuid && img.url, '上传图片到公司 FTP 成功')
  const vid = await upload(r1.token, company1.id, 'a.mp4', 'video/mp4', Buffer.from([4, 5, 6]))
  ok(vid.ok && vid.url, '上传视频成功')
  const aud = await upload(r1.token, company1.id, 'a.mp3', 'audio/mpeg', Buffer.from([7, 8, 9]))
  ok(aud.ok && aud.url, '上传音频成功')

  const gImg = await emitAck(c1, 'chat:send', { groupId: group1.id, kind: 'image', content: img.uuid })
  ok(gImg.ok, '总群发图片消息成功')
  const gVid = await emitAck(c1, 'chat:send', { groupId: group1.id, kind: 'file', content: vid.uuid })
  ok(gVid.ok, '总群发视频消息成功')
  const gAud = await emitAck(c1, 'chat:send', { groupId: group1.id, kind: 'file', content: aud.uuid })
  ok(gAud.ok, '总群发音频消息成功')
  const gEmoji = await emitAck(c1, 'chat:send', { groupId: group1.id, kind: 'text', content: '😀🎉' })
  ok(gEmoji.ok, '总群发表情消息成功')

  // 无公司群发消息
  const g0Msg = await emitAck(c1, 'chat:send', { groupId: g0.group.id, text: '无公司群消息' })
  ok(g0Msg.ok, '无公司群发消息成功')

  // ---- 用户2：加入公司1，加入总群，收消息 ----
  const j2 = await emitAck(c2, 'company:join', { code: company1.code })
  ok(j2.ok, '用户2 凭码加入用户1的公司成功')
  const gj2 = await emitAck(c2, 'group:join', { code: group1.code })
  ok(gj2.ok, '用户2 加入总群成功')

  // 历史校验
  const hist2 = await emitAck(c2, 'chat:history', { groupId: group1.id })
  ok(
    hist2.ok && hist2.messages.length >= 4 &&
      hist2.messages.some((m) => m.kind === 'image') &&
      hist2.messages.some((m) => m.kind === 'file') &&
      hist2.messages.some((m) => m.content === '😀🎉'),
    '用户2 群历史含 图片/视频/音频/表情'
  )

  // 实时接收：用户1 再发一条，用户2 收到
  const recvP = once(c2, 'chat:message')
  const live = await emitAck(c1, 'chat:send', { groupId: group1.id, text: '直播消息' })
  ok(live.ok, '用户1 再发一条')
  const recv = await recvP
  ok(recv.content === '直播消息' && recv.fromId === u1.id, '用户2 实时收到群消息')

  // ---- 私聊：用户2 给用户1 发 图片/视频/音频/表情 ----
  const dmImgP = once(c1, 'dm:message')
  const dmImg = await emitAck(c2, 'dm:send', { toUserId: u1.id, kind: 'image', content: img.uuid })
  ok(dmImg.ok, '私聊发图片成功')
  const dmImgMsg = await dmImgP
  ok(dmImgMsg.kind === 'image' && dmImgMsg.type === 'dm', '用户1 收到私聊图片')

  const dmVidP = once(c1, 'dm:message')
  await emitAck(c2, 'dm:send', { toUserId: u1.id, kind: 'file', content: vid.uuid })
  const dmVidMsg = await dmVidP
  ok(dmVidMsg.kind === 'file' && dmVidMsg.content.includes('.mp4'), '用户1 收到私聊视频')

  const dmAudP = once(c1, 'dm:message')
  await emitAck(c2, 'dm:send', { toUserId: u1.id, kind: 'file', content: aud.uuid })
  const dmAudMsg = await dmAudP
  ok(dmAudMsg.kind === 'file' && dmAudMsg.content.includes('.mp3'), '用户1 收到私聊音频')

  const dmEmojiP = once(c1, 'dm:message')
  await emitAck(c2, 'dm:send', { toUserId: u1.id, kind: 'text', content: '💬😄' })
  const dmEmojiMsg = await dmEmojiP
  ok(dmEmojiMsg.kind === 'text' && dmEmojiMsg.content === '💬😄', '用户1 收到私聊表情')

  // ---- 好友（无公司也可加） ----
  const fa = await emitAck(c1, 'friend:add', { userId: u2.id })
  const fb = await emitAck(c2, 'friend:add', { userId: u1.id })
  ok(fa.ok && fb.ok, '互加好友成功')
  const fl1 = await emitAck(c1, 'friend:list', {})
  ok(fl1.ok && fl1.friends.some((f) => f.userId === u2.id && f.nick === '乙'), '用户1 好友列表含用户2')

  // ---- 用户3：同时成立公司 + 加入公司1（一个人多公司） ----
  const co3 = await emitAck(c3, 'company:create', { name: `丙司${stamp}` })
  ok(co3.ok && co3.company, '用户3 成立自己的公司成功')
  const company3 = co3.company

  const j3 = await emitAck(c3, 'company:join', { code: company1.code })
  ok(j3.ok, '用户3 也加入用户1的公司（一人多公司）成功')

  const coList = await emitAck(c3, 'company:list', {})
  ok(coList.ok && coList.companies.length >= 2, '用户3 持有多个公司')

  // 用户3 在自家公司建群发消息，同时在用户1公司群收消息
  const g3 = await emitAck(c3, 'group:create', { companyId: company3.id, name: '丙群' })
  ok(g3.ok && g3.group, '用户3 在自家公司建群成功')
  const gj3 = await emitAck(c3, 'group:join', { code: group1.code })
  ok(gj3.ok, '用户3 加入用户1总群成功')

  const recv3P = once(c3, 'chat:message')
  await emitAck(c1, 'chat:send', { groupId: group1.id, text: '给丙的群消息' })
  const recv3 = await recv3P
  ok(recv3.content === '给丙的群消息', '用户3 在用户1公司群收到消息')

  // 用户3 私聊用户1（跨公司）—— 模拟内容 = 前两者总和
  const d3P = once(c1, 'dm:message')
  await emitAck(c3, 'dm:send', { toUserId: u1.id, kind: 'text', content: '丙的私聊' })
  const d3 = await d3P
  ok(d3.content === '丙的私聊' && d3.fromId === u3.id, '用户3 私聊用户1成功')

  // 对话列表：用户1 应含 私聊+总群+无公司群，置顶+最新倒序
  const cl = await emitAck(c1, 'conversation:list', {})
  ok(cl.ok && cl.conversations.length >= 3, '用户1 对话列表含 总群/无公司群/私聊')
  const dmTo2 = cl.conversations.find((x) => x.type === 'dm' && x.dmUserId === u2.id)
  const pin = await emitAck(c1, 'conversation:pin', { conversationId: dmTo2.conversationId, pinned: true })
  ok(pin.ok, '用户1 置顶与用户2的私聊成功')
  const cl2 = await emitAck(c1, 'conversation:list', {})
  ok(cl2.conversations[0].pinned === true, '置顶对话排最前')

  // 软删
  const del = await emitAck(c2, 'message:delete', { conversationId: dmTo2.conversationId, messageId: dmEmojiMsg.id })
  ok(del.ok, '用户2 软删自己私聊消息成功')

  // 清理
  for (const s of [c1, c2, c3]) s.disconnect()

  console.log(failures === 0 ? `\nSIMULATE PASS (${passed} 项)` : `\nSIMULATE FAIL (${passed} 通过 / ${failures} 失败)`)
}

run().catch((err) => {
  failures++
  console.error('simulate error:', err)
  console.error(`SIMULATE FAIL (${passed} 通过 / ${failures} 失败)`)
  process.exit(1)
})
