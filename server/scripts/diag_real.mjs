// 诊断真实 IP 198.44.178.149 的 SMTP 行为
import net from 'node:net'
import tls from 'node:tls'

const USER = 'admin@kawaimoe.org'
const PASS = 'DTV92zn8iNkqGPBH'
const IP = '198.44.178.149'

function diag(port, useTls) {
  return new Promise((resolve) => {
    let sock
    let buf = ''
    const lines = []
    const log = (tag, s) => { const t = s.trim(); if (t) { console.log(`[${tag}] ${t}`); lines.push(t) } }
    const netSock = net.connect({ host: IP, port })
    sock = useTls
      ? tls.connect({ socket: netSock, servername: 'mail.kawaimoe.org', rejectUnauthorized: false })
      : netSock
    sock.setEncoding('utf8')
    sock.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        log('S:', line)
      }
    })
    sock.on('error', (e) => { log('ERR', e.message); resolve(lines.join('\n')) })
    sock.on('close', () => resolve(lines.join('\n')))
    sock.on('secureConnect', () => log('TLS', 'encrypted'))

    const send = (cmd, delay) => setTimeout(() => { log('C:', cmd); sock.write(cmd + '\r\n') }, delay)
    if (!useTls) {
      send('EHLO probe', 1200)
      send('STARTTLS', 2500)
      send('EHLO probe', 4000)
      send('AUTH LOGIN', 5500)
      send(Buffer.from(USER).toString('base64'), 6500)
      send(Buffer.from(PASS).toString('base64'), 7500)
      send('QUIT', 9000)
    } else {
      send('EHLO probe', 1200)
      send('AUTH LOGIN', 2500)
      send(Buffer.from(USER).toString('base64'), 3500)
      send(Buffer.from(PASS).toString('base64'), 4500)
      send('QUIT', 6000)
    }
    setTimeout(() => { sock.destroy(); resolve(lines.join('\n')) }, 12000)
  })
}

for (const p of [25, 465, 587]) {
  console.log(`\n========== ${IP}:${p} ==========`)
  await diag(p, p === 465)
}
