// 用户资料：更新昵称/头像 + 读取确认
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
let failures = 0
const assert = (c, m) => { if (c) console.log(`  ok - ${m}`); else { failures++; console.error(`  FAIL - ${m}`) } }
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
const connect = (token) => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: token ? { token, device: 'T' } : { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', rej) })

async function main() {
  const s = await connect()
  const reg = await emit(s, 'auth:register', { username: `prof_${ts}`, password: 'secret123', nick: '原昵称', device: 'T' })
  assert(reg && reg.ok, '注册成功')
  const uid = reg.user.id
  // 只改昵称
  const r1 = await emit(s, 'user:updateProfile', { nick: '新昵称' })
  assert(r1 && r1.ok && r1.user.nick === '新昵称' && r1.user.id === uid, '更新昵称成功')
  // 只改头像
  const r2 = await emit(s, 'user:updateProfile', { avatar: 'https://x/files/a.png' })
  assert(r2 && r2.ok && r2.user.avatar === 'https://x/files/a.png', '更新头像成功')
  // 同时改两者
  const r3 = await emit(s, 'user:updateProfile', { nick: '再次', avatar: 'https://x/files/b.png' })
  assert(r3 && r3.ok && r3.user.nick === '再次' && r3.user.avatar === 'https://x/files/b.png', '同时更新昵称+头像')
  // 空字段被拒
  const r4 = await emit(s, 'user:updateProfile', {})
  assert(r4 && !r4.ok, '无字段更新被拒')
  // 未登录被拒
  const s2 = await connect()
  const r5 = await emit(s2, 'user:updateProfile', { nick: 'x' })
  assert(r5 && !r5.ok, '未登录被拒')
  // 持久化：auth:me 读到新资料
  const me = await emit(s, 'auth:me', {})
  assert(me && me.ok && me.user.nick === '再次' && me.user.avatar === 'https://x/files/b.png', 'auth:me 读到最新资料(持久化)')
  s.disconnect(); s2.disconnect()
  console.log(failures === 0 ? '\nPROFILE TEST PASS' : `\nPROFILE TEST FAIL (${failures})`)
}
main().then(() => process.exit(failures === 0 ? 0 : 1)).catch((e) => { console.error('error:', e); process.exit(1) })
