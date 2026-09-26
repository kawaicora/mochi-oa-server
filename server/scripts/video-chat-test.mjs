import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
const log = (m) => process.stdout.write(m + '\n')
const emit = (s, ev, d) => new Promise((r) => { const t = setTimeout(() => r({ ok: false, error: 'timeout', ev }), 8000); s.emit(ev, d, (raw) => { clearTimeout(t); r(raw) }) })
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', (e) => rej(e)) })

let failures = 0
const assert = (c, m) => { if (c) log(`  ok - ${m}`); else { failures++; log(`  FAIL - ${m}`) } }

async function main() {
  const s = await connect()
  log('connected')
  const reg = await emit(s, 'auth:register', { username: `vid_${ts}`, password: 'secret123', nick: 'v', device: 'T' })
  log('reg ok=' + !!reg.ok)
  const co = await emit(s, 'company:create', { name: `C${ts}`, code: `C${ts}` })
  log('company ok=' + !!co.ok)
  assert(co.ok, '创建公司')
  const grp = await emit(s, 'group:create', { companyId: co.company.id, name: '测试群', code: `g${ts}` })
  assert(grp.ok, '创建群')
  const send = await emit(s, 'chat:send', { groupId: grp.group.id, kind: 'video', content: 'http://127.0.0.1:3000/files/v.mp4' })
  log('send raw=' + JSON.stringify(send).slice(0, 200))
  assert(send.ok && !!send.id, 'video 群消息发送成功')
  const hist = await emit(s, 'chat:history', { groupId: grp.group.id })
  const msgs = hist.messages || []
  const last = msgs.find((m) => m.id === send.id)
  assert(last && last.kind === 'video' && String(last.content).includes('v.mp4'), '历史读到 video 消息')
  s.disconnect()
  log(failures === 0 ? '\nVIDEO CHAT TEST PASS' : `\nVIDEO CHAT TEST FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { log('error: ' + (e && e.message)); process.exit(1) })
