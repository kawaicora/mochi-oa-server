// 对照：测本网络能否连接知名 SMTP 的 465/587 加密端口（TCP 连通性）
import net from 'node:net'

const targets = [
  ['smtp.qq.com', 465],
  ['smtp.qq.com', 587],
  ['smtp.163.com', 465],
  ['smtp.163.com', 587],
  ['smtp.gmail.com', 465],
  ['smtp.gmail.com', 587],
  ['mail.kawaimoe.org', 25]
]

function check(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const t = setTimeout(() => { s.destroy(); resolve({ host, port, ok: false, err: 'timeout' }) }, timeout)
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve({ host, port, ok: true }) })
    s.once('error', (e) => { clearTimeout(t); resolve({ host, port, ok: false, err: e.code }) })
  })
}

for (const [h, p] of targets) {
  const r = await check(h, p)
  console.log(`${r.ok ? 'OPEN ' : 'closed'} ${r.host}:${p}${r.err ? '  (' + r.err + ')' : ''}`)
}
