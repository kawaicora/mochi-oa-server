// 会议房间内嵌聊天 rtc:chatMessage 中继测试
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
const log = (m) => process.stdout.write(m + '\n')
const emit = (s, ev, d) => new Promise((r) => { const t = setTimeout(() => r({ ok: false, error: 'timeout', ev }), 8000); s.emit(ev, d, (raw) => { clearTimeout(t); r(raw) }) })
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', (e) => rej(e)) })

let failures = 0
const assert = (c, m) => { if (c) log(`  ok - ${m}`); else { failures++; log(`  FAIL - ${m}`) } }

async function main() {
  const a = await connect()
  const b = await connect()
  const regA = await emit(a, 'auth:register', { username: `chata_${ts}`, password: 'secret123', nick: '甲', device: 'T' })
  const regB = await emit(b, 'auth:register', { username: `chatb_${ts}`, password: 'secret123', nick: '乙', device: 'T' })
  assert(regA.ok && regB.ok, '注册甲乙')

  // A 直接开始会议，B 加入
  const created = await emit(a, 'rtc:createMeeting', { title: '聊天测试', kind: 'video' })
  assert(created.ok && created.meeting, 'A 创建会议直接开始')
  const meetingNo = created.meeting.meetingNo
  const joined = await emit(b, 'rtc:join', { roomId: meetingNo, kind: 'video' })
  assert(joined.ok, 'B 加入会议')

  // B 收 A 的聊天
  const gotMsg = new Promise((resolve) => b.once('rtc:chatMessage', resolve))
  const sent = await emit(a, 'rtc:chatMessage', { roomId: meetingNo, content: '大家好，能听到吗' })
  assert(sent.ok, 'A 发聊天 ack ok')
  const m = await gotMsg
  assert(m && m.room === meetingNo && m.content === '大家好，能听到吗' && m.from.nick === '甲', 'B 收到 A 的聊天广播')

  // 发送方不会收到自己的广播（让 B 监听，B 自己发）
  let selfGot = false
  const selfListener = () => { selfGot = true }
  b.on('rtc:chatMessage', selfListener)
  await emit(b, 'rtc:chatMessage', { roomId: meetingNo, content: '我这边 OK' })
  await new Promise((r) => setTimeout(r, 500))
  b.off('rtc:chatMessage', selfListener)
  assert(!selfGot, '发送方不收到自己的广播')

  // 未加入房间者被拒
  const c = await connect()
  const regC = await emit(c, 'auth:register', { username: `chatc_${ts}`, password: 'secret123', nick: '丙', device: 'T' })
  const denied = await emit(c, 'rtc:chatMessage', { roomId: meetingNo, content: '混进来' })
  assert(denied.ok === false && denied.error === '不在该房间中', '未入房者被拒')

  // 空内容被拒
  const empty = await emit(a, 'rtc:chatMessage', { roomId: meetingNo, content: '   ' })
  assert(empty.ok === false, '空内容被拒')

  // 房间不存在
  const nope = await emit(a, 'rtc:chatMessage', { roomId: '123456', content: 'x' })
  assert(nope.ok === false, '不存在房间被拒')

  a.disconnect(); b.disconnect(); c.disconnect()
  log(failures === 0 ? '\nRTC CHAT TEST PASS' : `\nRTC CHAT TEST FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { log('error: ' + (e && e.message)); process.exit(1) })
