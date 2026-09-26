// 文件夹消息 + 文件夹下载清单验证
import { io } from 'socket.io-client'
import { randomUUID } from 'node:crypto'
import { writeFile, rm, readFile } from 'node:fs/promises'
import path from 'node:path'

const URL = process.env.URL || 'http://127.0.0.1:3000'
const ts = Date.now()
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))
const connect = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { device: 'T' } }); s.once('connect', () => res(s)); s.once('connect_error', rej) })
let checks = 0
const expect = (c, l) => { if (!c) throw new Error('FAIL: ' + l); checks++; console.log('  ✓', l) }

// 复刻客户端 uploadFileChunked：单块上传到指定 relativePath
async function chunkUpload(tok, filePath, relativePath, companyId) {
  const base = URL.replace(/\/$/, '')
  const authQ = `token=${encodeURIComponent(tok)}&company=${companyId}`
  const uploadId = randomUUID()
  const name = path.basename(filePath)
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
  const mime = /^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext) ? `image/${ext}` : 'application/octet-stream'
  const buf = await readFile(filePath)
  const CRLF = '\r\n'
  const field = (b, k, v) => `--${b}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`
  const b = '----ft-' + Math.random().toString(16).slice(2)
  const head = Buffer.from(field(b, 'uploadId', uploadId) + field(b, 'chunkIndex', '0') + field(b, 'totalChunks', '1') + `--${b}${CRLF}Content-Disposition: form-data; name="file"; filename="chunk"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`)
  const tail = Buffer.from(`${CRLF}--${b}--${CRLF}`)
  const body = Buffer.concat([head, buf, tail])
  const rc = await (await fetch(`${base}/api/upload/chunk?${authQ}`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${b}` }, body })).json()
  if (!rc.ok) throw new Error('chunk failed: ' + JSON.stringify(rc))
  const comp = await (await fetch(`${base}/api/upload/chunk/complete?${authQ}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId, filename: name, totalChunks: 1, mime, relativePath }) })).json()
  if (!comp.ok) throw new Error('complete failed: ' + JSON.stringify(comp))
  return comp.url
}

async function main() {
  const s = await connect()
  const reg = await emit(s, 'auth:register', { username: `fd_${ts}`, password: 'secret123', nick: 'f', device: 'T' })
  if (!reg?.ok) throw new Error('register failed')
  const tok = reg.token
  const c = await emit(s, 'company:create', { name: `fold_${ts}` })
  if (!c?.ok) throw new Error('company failed: ' + JSON.stringify(c))
  const cid = c.company.id
  console.log('注册 ok, companyId=', cid)

  // 造两个测试文件，模拟发送文件夹 p20260921_merge（根 + 子目录）
  const tmpdir = process.env.TMPDIR || (await import('node:os')).tmpdir()
  const f1 = path.join(tmpdir, `tmp-f1-${ts}.txt`)
  const f2 = path.join(tmpdir, `tmp-f2-${ts}.txt`)
  await writeFile(f1, 'folder-root-content')
  await writeFile(f2, 'folder-sub-content')

  const u1 = await chunkUpload(tok, f1, `p20260921_merge`, cid)
  const u2 = await chunkUpload(tok, f2, `p20260921_merge/子目录`, cid)
  expect(u1.includes(`/files/${cid}/p20260921_merge/`), `根文件落盘: ${u1}`)
  expect(u2.includes(`/files/${cid}/p20260921_merge/子目录/`), `子目录文件落盘: ${u2}`)

  // 发一条 folder 消息（content=文件夹相对路径）
  const folderPath = `${cid}/p20260921_merge`
  const g = await emit(s, 'group:create', { companyId: 0, name: `fg_${ts}` })
  if (!g?.ok) throw new Error('group failed')
  const send = await emit(s, 'chat:send', { groupId: g.group.id, kind: 'folder', content: folderPath })
  expect(send?.ok === true, `folder 消息发送成功: ${JSON.stringify(send)}`)
  expect(send?.id != null, 'folder 消息有 id')

  // 文件夹下载清单（递归含子目录）
  const listRes = await (await fetch(`${URL}/api/folder/files?path=${encodeURIComponent(folderPath)}&token=${tok}`)).json()
  expect(listRes.ok === true, 'folder/files 端点 ok')
  const names = listRes.files.map((f) => f.relPath).sort()
  expect(names.some((n) => n.includes('p20260921_merge/tmp-f1-') && !n.includes('子目录')), '清单含根文件')
  expect(names.some((n) => n.includes('p20260921_merge/子目录/tmp-f2-')), '清单含子目录文件')

  // 越权校验：非成员访问其他公司文件夹应 403
  const reg2 = await emit(s, 'auth:register', { username: `fd2_${ts}`, password: 'secret123', nick: 'x', device: 'T' })
  const forbid = await (await fetch(`${URL}/api/folder/files?path=${encodeURIComponent(folderPath)}&token=${reg2.token}`)).json()
  expect(forbid.ok === false, `非成员访问被拒: ok=${forbid.ok} error=${forbid.error}`)

  s.disconnect()
  await Promise.all([rm(f1, { force: true }), rm(f2, { force: true })])
  console.log(`FOLDER TEST PASS (${checks} checks)`)
}
main().catch((e) => { console.error('error:', e.message); process.exit(1) })
