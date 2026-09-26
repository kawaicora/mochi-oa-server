// 存储路径结构验证：单文件（default + 公司id）与分块（带 relativePath 保留文件夹结构）
import { io } from 'socket.io-client'
const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', rej) })

const okCount = { n: 0 }
function expect(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label)
  okCount.n++
  console.log('  ✓', label)
}

async function main() {
  const s = await connect()
  const reg = await emit(s, 'auth:register', { username: `st_${ts}`, password: 'secret123', nick: 'n', device: 'T' })
  if (!reg || !reg.ok) throw new Error('register failed')
  const tok = reg.token

  // 1) 单文件，无公司 → data/default/hello.jpg
  const fd1 = new FormData()
  fd1.append('file', new Blob([Buffer.from('default-jpg')], { type: 'image/jpeg' }), `hello-${ts}.jpg`)
  const r1 = await (await fetch(`${URL}/api/upload?token=${tok}`, { method: 'POST', body: fd1 })).json()
  expect(r1.ok && new RegExp(`\\/files\\/default\\/hello-${ts}\\.jpg$`).test(r1.url), `单文件 default 路径: ${r1.url}`)
  const d1 = await (await fetch(r1.url)).arrayBuffer()
  expect(Buffer.from(d1).toString() === 'default-jpg', 'default 文件可下载且内容一致')

  // 2) 单文件，公司 id=5 → data/5/hello.jpg
  const fd2 = new FormData()
  fd2.append('file', new Blob([Buffer.from('comp-jpg')], { type: 'image/jpeg' }), `hello-${ts}.jpg`)
  const r2 = await (await fetch(`${URL}/api/upload?token=${tok}&company=5`, { method: 'POST', body: fd2 })).json()
  expect(r2.ok && new RegExp(`\\/files\\/5\\/hello-${ts}\\.jpg$`).test(r2.url), `单文件 公司id 路径: ${r2.url}`)

  // 3) 分块上传 + relativePath → data/default/策划文件/子目录/xx.txt（保留文件夹结构）
  const CHUNK = 1
  const content = 'folder-content-文件内容'
  const buf = Buffer.from(content)
  const uploadId = 'chunk-' + ts
  const total = 1
  const field = (b, k, v) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
  const b = '----test-boundary'
  const head = Buffer.from(field(b, 'uploadId', uploadId) + field(b, 'chunkIndex', '0') + field(b, 'totalChunks', String(total)) + `--${b}\r\nContent-Disposition: form-data; name="file"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${b}--\r\n`)
  const body = Buffer.concat([head, buf, tail])
  const rc = await (await fetch(`${URL}/api/upload/chunk?token=${tok}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
    body
  })).json()
  expect(rc.ok === true, '分块上传成功')
  const comp = await (await fetch(`${URL}/api/upload/chunk/complete?token=${tok}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, filename: `xx-${ts}.txt`, totalChunks: total, mime: 'text/plain', relativePath: `策划文件-${ts}/子目录` })
  })).json()
  expect(comp.ok && new RegExp(`\\/files\\/default\\/策划文件-${ts}\\/子目录\\/xx-${ts}\\.txt$`).test(comp.url), `分块 relativePath 路径: ${comp.url}`)
  const d3 = await (await fetch(comp.url)).arrayBuffer()
  expect(Buffer.from(d3).toString() === content, '分块文件内容一致')

  s.disconnect()
  console.log(`STORAGE-PATH TEST PASS (${okCount.n} checks)`)
}
main().catch((e) => { console.error('error:', e); process.exit(1) })
