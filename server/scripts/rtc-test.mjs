// WebRTC 信令服务器测试：会议(会议号/预约/密码/直接开始/结束删除)、私聊视频、群语音视频、信令中继、ICE 返回
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']
const ts = Date.now()
let failures = 0
const assert = (c, m) => { if (c) console.log(`  ok - ${m}`); else { failures++; console.error(`  FAIL - ${m}`) } }

const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
function connect(token) {
  return new Promise((res, rej) => {
    const s = io(URL, { transports, reconnection: false, auth: token ? { token, device: 'T' } : { device: 'T' } })
    s.once('connect', () => res(s)); s.once('connect_error', rej)
  })
}
function waitEvent(s, ev, timeout = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), timeout)
    s.once(ev, (d) => { clearTimeout(t); res(d) })
  })
}

async function registerUser(suffix) {
  const u = `rtc_${suffix}_${ts}`
  const s = await connect()
  const r = await emit(s, 'auth:register', { username: u, password: 'secret123', nick: suffix.toUpperCase(), device: 'T' })
  if (!r || !r.ok) throw new Error(`register ${suffix} failed: ${JSON.stringify(r)}`)
  return { socket: s, id: r.user.id, nick: r.user.nick, token: r.token }
}

async function main() {
  console.log('连接并注册 3 个用户…')
  const alice = await registerUser('alice')
  const bob = await registerUser('bob')
  const carol = await registerUser('carol')
  console.log('  alice id=' + alice.id + ', bob id=' + bob.id + ', carol id=' + carol.id)

  // ── A. 会议直接开始 + 加入 + 信令中继 ──
  console.log('\n[A] 会议（直接开始）')
  const a1 = await emit(alice.socket, 'rtc:createMeeting', { title: '直接开始', kind: 'video' })
  assert(a1 && a1.ok && /^\d{6}$/.test(a1.meeting.meetingNo || ''), 'createMeeting 返回 6 位会议号且直接开始')
  const meetingNo = a1.meeting.meetingNo
  assert(a1.meeting.started === true, '直接开始会议 started=true')
  const bobOffer = waitEvent(bob.socket, 'rtc:signal')
  const a2 = await emit(bob.socket, 'rtc:join', { roomId: meetingNo, kind: 'video' })
  assert(a2 && a2.ok, 'bob 按会议号加入成功')
  assert(Array.isArray(a2.peers) && a2.peers.length === 1 && a2.peers[0].userId === alice.id, 'join 返回在线参与者(含 alice)')
  assert(Array.isArray(a2.iceServers) && a2.iceServers.length > 0, 'join 返回 ICE servers')
  await emit(alice.socket, 'rtc:signal', { roomId: meetingNo, signal: { sdp: 'offer', type: 'offer' } })
  const sig = await bobOffer
  assert(sig && sig.from && sig.from.userId === alice.id && sig.signal && sig.signal.sdp === 'offer', '信令 offer 中继给 bob')

  // ── B. 会议密码（临时内存口令） ──
  console.log('\n[B] 会议密码')
  const b1 = await emit(carol.socket, 'rtc:createMeeting', { title: '加密会议', password: 'abc123', kind: 'video' })
  const meetingNo2 = b1.meeting.meetingNo
  const b2 = await emit(alice.socket, 'rtc:join', { roomId: meetingNo2, password: 'wrong' })
  assert(b2 && !b2.ok && b2.error === '会议密码错误', '错误密码被拒')
  const b3 = await emit(alice.socket, 'rtc:join', { roomId: meetingNo2, password: 'abc123' })
  assert(b3 && b3.ok, '正确密码加入成功')

  // ── C. 预约会议：创建不开始、可查询、首个加入即开始 ──
  console.log('\n[C] 预约会议')
  const c1 = await emit(alice.socket, 'rtc:createMeeting', { title: '预约会议', startAt: '2027-01-01T00:00:00Z', kind: 'voice' })
  assert(c1 && c1.ok && c1.scheduled === true, '预约创建返回 scheduled=true')
  const meetingNo3 = c1.meeting.meetingNo
  const c2 = await emit(alice.socket, 'rtc:getMeeting', { meetingNo: meetingNo3 })
  assert(c2 && c2.ok && c2.meeting.title === '预约会议' && c2.meeting.kind === 'voice', 'getMeeting 查到预约会议(voice)')
  const c3 = await emit(bob.socket, 'rtc:join', { roomId: meetingNo3 })
  assert(c3 && c3.ok && c3.started === false, '预约会议首个加入者开始它（started=false 表示此前未开始）')

  // ── D. 私聊视频通话 ──
  console.log('\n[D] 私聊视频通话')
  const dIncoming = waitEvent(bob.socket, 'rtc:dmIncoming')
  const d1 = await emit(alice.socket, 'rtc:dmCall', { userId: bob.id, kind: 'video' })
  assert(d1 && d1.ok && d1.room && d1.room.id === `dm:${Math.min(alice.id, bob.id)}:${Math.max(alice.id, bob.id)}`, 'dmCall 返回 dm 房间')
  const inc = await dIncoming
  assert(inc && inc.from.userId === alice.id && inc.kind === 'video', 'bob 收到 rtc:dmIncoming 来电')
  const dAnsSig = waitEvent(alice.socket, 'rtc:signal')
  const d2 = await emit(bob.socket, 'rtc:dmAnswer', { roomId: inc.room, accept: true })
  assert(d2 && d2.ok, 'bob 接受来电加入房间')
  await emit(bob.socket, 'rtc:signal', { roomId: inc.room, signal: { sdp: 'answer', type: 'answer' } })
  const dSig = await dAnsSig
  assert(dSig && dSig.signal && dSig.signal.type === 'answer', '私聊 answer 信令中继给 alice')

  // ── E. 群视频/语音（无会议号，群内直接开始） ──
  console.log('\n[E] 群通话')
  const e0 = await emit(alice.socket, 'company:create', { name: `rtc公司${ts}` })
  assert(e0 && e0.ok, 'alice 创建公司')
  const companyId = e0.company.id
  const e1 = await emit(alice.socket, 'group:create', { companyId, name: '研发群' })
  assert(e1 && e1.ok, 'alice 创建群')
  const groupId = e1.group.id
  const e2 = await emit(alice.socket, 'rtc:groupCall', { groupId, kind: 'voice' })
  assert(e2 && e2.ok && e2.room && e2.room.id === `group:${groupId}` && e2.room.kind === 'voice', 'groupCall 群语音直接开始')
  const e3 = await emit(bob.socket, 'rtc:join', { roomId: `group:${groupId}` })
  assert(e3 && e3.ok && e3.room.kind === 'voice', 'bob 加入群语音房间，kind=voice')

  // ── F. 结束会议 → 会议号删除 ──
  console.log('\n[F] 结束会议')
  const fEnded = waitEvent(bob.socket, 'rtc:ended')
  const f1 = await emit(alice.socket, 'rtc:end', { roomId: meetingNo })
  assert(f1 && f1.ok, 'alice 结束会议')
  const ended = await fEnded
  assert(ended && ended.reason === 'ended', 'bob 收到 rtc:ended')
  const f2 = await emit(bob.socket, 'rtc:join', { roomId: meetingNo })
  assert(f2 && !f2.ok && /不存在|已结束/.test(f2.error || ''), '结束后会议号作废（再加入失败）')

  console.log(failures === 0 ? '\nRTC TEST PASS' : `\nRTC TEST FAIL (${failures})`)
  ;[alice, bob, carol].forEach((u) => u.socket.disconnect())
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
