// 会话 token 上传头像 + user:updateProfile 端到端
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', rej) })

async function main() {
  const s = await connect()
  const reg = await emit(s, 'auth:register', { username: `up_${ts}`, password: 'secret123', nick: 'n', device: 'T' })
  if (!reg || !reg.ok) throw new Error('register failed')
  const tok = reg.token
  const fd = new FormData()
  fd.append('file', new Blob([Buffer.from('fakeavatar')], { type: 'image/png' }), 'a.png')
  const resp = await fetch(`${URL}/api/upload?token=${tok}`, { method: 'POST', body: fd })
  const j = await resp.json()
  console.log('upload ok=', !!j.ok, 'url=', j.url)
  const u = await emit(s, 'user:updateProfile', { avatar: j.url })
  console.log('profile ok=', !!(u && u.ok), 'avatar=', u && u.user && u.user.avatar)
  const me = await emit(s, 'auth:me', {})
  console.log('me.avatar=', me && me.user && me.user.avatar)
  s.disconnect()
  if (!j.ok || !u.ok || !me.user || me.user.avatar !== j.url) process.exit(1)
  console.log('UPLOAD-AVATAR TEST PASS')
}
main().catch((e) => { console.error('error:', e); process.exit(1) })
