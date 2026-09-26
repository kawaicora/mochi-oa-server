// 群消息回显计数：发送方应恰好收到 1 份 chat:message（不重复）
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
const emit = (s, ev, d) => new Promise((r) => { const t = setTimeout(() => r({ ok: false, error: 'timeout', ev }), 8000); s.emit(ev, d, (raw) => { clearTimeout(t); r(raw) }) })
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', rej) })

async function main() {
  const A = await connect()
  const ra = await emit(A, 'auth:register', { username: `ec${ts}`, password: 'secret123', nick: 'A', device: 'T' })
  if (!ra.ok) throw new Error('register failed')
  const ca = await emit(A, 'company:create', { name: `c${ts}` })
  if (!ca.ok) throw new Error('company failed: ' + JSON.stringify(ca).slice(0, 200))
  const g = await emit(A, 'group:create', { companyId: ca.company.id, name: 'g' })
  if (!g.ok) throw new Error('group failed: ' + JSON.stringify(g).slice(0, 200))
  let got = 0
  A.on('chat:message', () => got++)
  await emit(A, 'chat:send', { groupId: g.group.id, kind: 'text', content: 'hi-' + ts })
  await new Promise((r) => setTimeout(r, 700))
  console.log('sender got chat:message =', got)
  A.disconnect()
  if (got !== 1) process.exit(1)
  console.log('ECHO-COUNT TEST PASS')
}
main().catch((e) => { console.error('error:', e); process.exit(1) })
