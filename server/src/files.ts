import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import multer from 'multer'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { ServerConfig } from './config'
import type { Store } from './db/store'
import { verifyToken, hashToken } from './token'

interface Saved {
  storage: 'local'
  url: string
}

/** 清洗文件名：只取 basename（防路径穿越），去掉控制/危险字符，保留中文与常用符号 */
function sanitizeName(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_').trim().slice(0, 180)
  return cleaned || 'file'
}

/** 磁盘上避免同名覆盖：已存在则追加 “ (n)” 再回到原文件名优先 */
async function uniqueDiskName(dir: string, name: string): Promise<string> {
  let target = name
  let n = 1
  const m = name.match(/^(.+?)(\.[a-z0-9]+)?$/i)
  const stem = m?.[1] ?? name
  const ext = m?.[2] ?? ''
  for (;;) {
    try {
      await stat(path.join(dir, target))
    } catch {
      return target // 不存在，可用
    }
    n += 1
    target = `${stem} (${n})${ext}`
  }
}

/** 文件夹相对路径校验（如 6/p20260921_merge 或 default/p20260921_merge）：逐段清洗、拒绝穿越/根目录 */
function isSafeFolderPath(v: string): boolean {
  const parts = v.split('/').filter(Boolean)
  if (parts.length < 2) return false
  return parts.every((s) => {
    if (s === '.' || s === '..' || s === '~' || s.includes('\\')) return false
    return /^[\w\u4e00-\u9fa5\-\s.()（）]+$/.test(s)
  })
}

/** 存储到本地磁盘（HTTP 下载）。路径结构：{dir}/{companyKey}/{relativeDir...}/{原始文件名}。
 *  - companyKey：无公司传 'default'，有公司传公司 id 字符串
 *  - relativeDir：发送文件夹时保留的相对子目录（斜杠分段，逐段清洗防穿越），单文件传 ''
 * 物理文件名 = 原始文件名（去重防覆盖，UTF-8 安全）；url 按请求 host 拼，保证与客户端同源可达 */
async function saveLocal(
  config: ServerConfig,
  originalName: string,
  buf: Buffer,
  host: string,
  companyKey = 'default',
  relativeDir = ''
): Promise<Saved> {
  const root = path.resolve(config.file.dir)
  const segments = [
    sanitizeName(companyKey || 'default') || 'default',
    ...(relativeDir
      ? relativeDir.split('/').map((s) => sanitizeName(s)).filter(Boolean)
      : [])
  ]
  const dir = path.join(root, ...segments)
  await mkdir(dir, { recursive: true })
  const diskName = await uniqueDiskName(dir, sanitizeName(originalName))
  await writeFile(path.join(dir, diskName), buf)
  const rel = [...segments, encodeURIComponent(diskName)].join('/')
  return { storage: 'local', url: `http://${host}/files/${rel}` }
}

/** 从请求解析登录用户（JWT 或 会话 token），未登录返回 0 */
async function authedUserId(req: IncomingMessage, store: Store, config: ServerConfig): Promise<number> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const token = url.searchParams.get('token') ?? bearer
  if (!token) return 0
  const payload = verifyToken(token, config.jwtSecret)
  if (payload && Number.isInteger(Number(payload.sub)) && Number(payload.sub) > 0) {
    return Number(payload.sub)
  }
  const session = await store.getSessionByTokenHash(hashToken(token)).catch(() => null)
  if (session && new Date(session.expiresAt).getTime() > Date.now()) return session.userId
  return 0
}

const json = (res: ServerResponse, code: number, body: Record<string, unknown>): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 读取请求体原始字节（原生 http server 不自动解析 body） */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 按扩展名推断 MIME（媒体给 inline 可播，其余 octet-stream） */
const mimeOf = (name: string): string => {
  const e = path.extname(name).toLowerCase()
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.ts': 'video/mp2t',
    '.rmvb': 'application/vnd.rn-realmedia-vbr', '.rm': 'application/vnd.rn-realmedia',
    '.3gp': 'video/3gpp', '.3gpp': 'video/3gpp', '.ogv': 'video/ogg',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac'
  }
  return map[e] ?? 'application/octet-stream'
}

/** 安全地流式发送文件：支持 Range(206)、正确 MIME/inline、错误时不写重复响应头（避免进程崩溃） */
function streamFile(
  res: ServerResponse,
  full: string,
  rangeHeader: string | undefined,
  dispositionName: string
): void {
  stat(full)
    .then((st) => {
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 404 })
      const total = st.size
      let start = 0
      let end = total - 1
      let status = 200
      const m = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      if (m && (m[1] || m[2])) {
        start = m[1] ? Number(m[1]) : 0
        end = m[2] ? Number(m[2]) : total - 1
        if (start > end || start >= total || end < 0) {
          if (!res.headersSent) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` })
            res.end()
          }
          return
        }
        if (end >= total) end = total - 1
        status = 206
      }
      const headers: Record<string, string> = {
        'Content-Type': mimeOf(full),
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(dispositionName)}`
      }
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
      res.writeHead(status, headers)
      const stream = createReadStream(full, { start, end })
      stream.on('error', () => {
        // 客户端提前断开等：响应可能已发出，绝不能再 writeHead
        if (!res.headersSent) res.destroy()
        else res.destroy()
      })
      stream.pipe(res)
    })
    .catch(() => {
      if (!res.headersSent) {
        res.writeHead(404)
        res.end()
      }
    })
}
/** 注册 HTTP 上传/下载路由（不走 socket）：
 *  POST /api/upload              单文件（保留原文件名）
 *  POST /api/upload/chunk        分块上传（multipart: file+uploadId+chunkIndex）
 *  POST /api/upload/chunk/complete  合并分块（JSON: uploadId,filename,totalChunks,mime）
 *  GET  /api/upload/chunk/status?uploadId=  断点续传查询已收到分块
 *  GET  /files/*                 下载（支持 Range/正确 MIME/inline，供 <video> 流播）
 *  GET  /api/transcode?src=       ffmpeg 转码后 mp4 下载/流播 */
export function registerUploadRoutes(http: HttpServer, store: Store, config: ServerConfig): void {
  const upload = multer({ limits: { fileSize: config.file.maxBytes } }).single('file')
  // 分块：单块上限取总上限的 1/4（最小 4MB，方便大文件），合并时再校验总量
  const chunkUpload = multer({ limits: { fileSize: Math.max(4 * 1024 * 1024, Math.floor(config.file.maxBytes / 4)) } }).single('file')

  http.on('request', async (req, res) => {
    // 允许跨域读取文件（头像 canvas 绘制、视频流播、fetch 转 blob 需要 CORS 头）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 本地文件下载；支持 {companyKey}/{子目录...}/{文件名} 结构
    if (url.pathname.startsWith('/files/')) {
      const root = path.resolve(config.file.dir)
      const decoded = decodeURIComponent(url.pathname.slice('/files/'.length))
      if (!decoded || decoded.includes('\0')) {
        res.writeHead(403)
        res.end()
        return
      }
      const full = path.resolve(root, decoded)
      if (full !== root && !full.startsWith(root + path.sep)) {
        res.writeHead(403)
        res.end()
        return
      }
      const name = path.basename(full)
      streamFile(res, full, req.headers.range, name)
      return
    }

    // ffmpeg 转码流播：GET /api/transcode?src={companyKey}/{相对路径...}/{文件名}&token=
    // 把 rm/avi/mkv/3gp/3gpp/rmvb 等浏览器不原生支持的格式转成 h264+aac mp4（结果缓存到 .transcode/）
    if (url.pathname === '/api/transcode' && req.method === 'GET') {
      const userId = await authedUserId(req, store, config)
      if (userId <= 0) return json(res, 401, { ok: false, error: '未登录' })
      const src = url.searchParams.get('src') ?? ''
      if (!src || src.includes('\0') || src.split('/').some((s) => s === '.' || s === '..' || s === '~' || s.includes('\\'))) {
        return json(res, 400, { ok: false, error: '路径不合法' })
      }
      const root = path.resolve(config.file.dir)
      const full = path.resolve(root, src)
      if (full !== root && !full.startsWith(root + path.sep)) return json(res, 400, { ok: false, error: '路径越界' })
      let st
      try {
        st = await stat(full)
      } catch {
        return json(res, 404, { ok: false, error: '文件不存在' })
      }
      if (!st.isFile()) return json(res, 400, { ok: false, error: '非文件' })
      const outDir = path.join(root, '.transcode')
      await mkdir(outDir, { recursive: true })
      const out = path.join(outDir, `${createHash('sha1').update(`${src}:${st.size}`).digest('hex')}.mp4`)
      try {
        await stat(out)
      } catch {
        // 转码（源文件不可变缓存；失败则 500）
        try {
          await new Promise<void>((resolveP, rejectP) => {
            execFile(
              'ffmpeg',
              ['-y', '-i', full, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out],
              { timeout: 10 * 60 * 1000 },
              (err) => (err ? rejectP(err) : resolveP())
            )
          })
        } catch (e) {
          return json(res, 500, { ok: false, error: e instanceof Error ? `转码失败: ${e.message}` : '转码失败' })
        }
      }
      streamFile(res, out, req.headers.range, path.basename(full).replace(/\.[^.]+$/, '') + '.mp4')
      return
    }

    // 分块上传
    if (url.pathname === '/api/upload/chunk' && req.method === 'POST') {
      const userId = await authedUserId(req, store, config)
      if (userId <= 0) return json(res, 401, { ok: false, error: '未登录' })
      chunkUpload(req as never, res as never, async (err: unknown) => {
        if (err) return json(res, 400, { ok: false, error: err instanceof Error ? err.message : '上传失败' })
        const file = (req as { file?: { buffer: Buffer } }).file
        const body = (req as { body?: Record<string, unknown> }).body ?? {}
        const uploadId = String(body.uploadId ?? '')
        const chunkIndex = Number(body.chunkIndex)
        const totalChunks = Number(body.totalChunks)
        if (!file || !uploadId || !Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isInteger(totalChunks) || totalChunks <= 0 || chunkIndex >= totalChunks) {
          return json(res, 400, { ok: false, error: '参数不合法（需要 file/uploadId/chunkIndex/totalChunks）' })
        }
        const chunkDir = path.join(config.file.dir, '.chunks', uploadId)
        await mkdir(chunkDir, { recursive: true })
        await writeFile(path.join(chunkDir, String(chunkIndex)), file.buffer)
        json(res, 200, { ok: true, uploadId, chunkIndex, received: chunkIndex + 1, totalChunks })
      })
      return
    }

    // 断点续传查询
    if (url.pathname === '/api/upload/chunk/status' && req.method === 'GET') {
      const userId = await authedUserId(req, store, config)
      if (userId <= 0) return json(res, 401, { ok: false, error: '未登录' })
      const uploadId = url.searchParams.get('uploadId') ?? ''
      if (!uploadId) return json(res, 400, { ok: false, error: '缺少 uploadId' })
      const chunkDir = path.join(config.file.dir, '.chunks', uploadId)
      let received: number[] = []
      try {
        const files = await readdir(chunkDir)
        received = files.map((f) => Number(f)).filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
      } catch {
        received = []
      }
      json(res, 200, { ok: true, uploadId, received })
      return
    }

    // 分块合并
    if (url.pathname === '/api/upload/chunk/complete' && req.method === 'POST') {
      const userId = await authedUserId(req, store, config)
      if (userId <= 0) return json(res, 401, { ok: false, error: '未登录' })
      let d: { uploadId?: unknown; filename?: unknown; totalChunks?: unknown; mime?: unknown; relativePath?: unknown }
      try {
        const raw = await readBody(req)
        d = JSON.parse(raw.toString('utf8') || '{}') as typeof d
      } catch {
        return json(res, 400, { ok: false, error: 'JSON 解析失败' })
      }
      const uploadId = String(d.uploadId ?? '')
      const originalName = String(d.filename ?? '')
      const totalChunks = Number(d.totalChunks)
      const relativePath = String(d.relativePath ?? '')
      const companyParam = url.searchParams.get('company') ?? ''
      const cId = Number(companyParam)
      const companyKey = Number.isInteger(cId) && cId > 0 ? String(cId) : 'default'
      if (!uploadId || !Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 10000) {
        return json(res, 400, { ok: false, error: '参数不合法' })
      }
      const chunkDir = path.join(config.file.dir, '.chunks', uploadId)
      const buf: Buffer[] = []
      let totalSize = 0
      try {
        for (let i = 0; i < totalChunks; i++) {
          const b = await readFile(path.join(chunkDir, String(i)))
          buf.push(b)
          totalSize += b.length
        }
      } catch {
        return json(res, 400, { ok: false, error: `分块不完整，请先补传（${totalChunks}）` })
      }
      if (totalSize <= 0) return json(res, 400, { ok: false, error: '文件为空' })
      const merged = Buffer.concat(buf, totalSize)
      try {
        const saved = await saveLocal(config, originalName, merged, req.headers.host || `127.0.0.1:${config.port}`, companyKey, relativePath)
        const rec = await store.saveFile({
          uuid: randomUUID(),
          filename: sanitizeName(originalName),
          mime: String(d.mime ?? 'application/octet-stream'),
          size: merged.length,
          storage: saved.storage,
          url: saved.url
        })
        await rm(chunkDir, { recursive: true, force: true }).catch(() => {})
        json(res, 200, { ok: true, uuid: rec.uuid, filename: rec.filename, mime: rec.mime, size: rec.size, url: rec.url })
      } catch (e) {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : '存储失败' })
      }
      return
    }

    // 文件夹文件清单（下载用）：GET /api/folder/files?path={companyKey}/{folderName}&token=
    if (url.pathname === '/api/folder/files' && req.method === 'GET') {
      const userId = await authedUserId(req, store, config)
      if (userId <= 0) return json(res, 401, { ok: false, error: '未登录' })
      const p = url.searchParams.get('path') ?? ''
      if (!isSafeFolderPath(p)) return json(res, 400, { ok: false, error: '文件夹路径不合法' })
      // 公司校验：path 首段为数字公司 id 时须为公司成员；default 放行
      const first = p.split('/')[0]
      if (/^\d+$/.test(first)) {
        const role = await store.getMemberRole(Number(first), userId).catch(() => null)
        if (role === null) return json(res, 403, { ok: false, error: '非该公司成员' })
      }
      const root = path.resolve(config.file.dir)
      const rel = p.split('/').map((s) => sanitizeName(s)).filter(Boolean).join('/')
      const dir = path.resolve(root, rel)
      if (dir !== root && !dir.startsWith(root + path.sep)) return json(res, 400, { ok: false, error: '路径越界' })
      const files: { name: string; relPath: string; url: string }[] = []
      const walk = async (curDir: string, curRel: string): Promise<void> => {
        let entries: { name: string; isFile: boolean }[] = []
        try {
          const es = await readdir(curDir, { withFileTypes: true })
          entries = es.map((e) => ({ name: e.name, isFile: e.isFile() }))
        } catch {
          return
        }
        for (const e of entries) {
          if (e.isFile) {
            const relPath = `${curRel}/${e.name}`
            const url = `http://${req.headers.host || `127.0.0.1:${config.port}`}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`
            files.push({ name: e.name, relPath, url })
          } else {
            await walk(path.join(curDir, e.name), `${curRel}/${e.name}`)
          }
        }
      }
      await walk(dir, rel)
      json(res, 200, { ok: true, path: rel, files })
      return
    }

    // 单文件上传（保留原文件名）
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const userId = await authedUserId(req, store, config)
      if (userId <= 0) return json(res, 401, { ok: false, error: '未登录' })
      const companyParam = url.searchParams.get('company') ?? ''
      const companyId = Number(companyParam)
      const company = Number.isInteger(companyId) && companyId > 0 ? String(companyId) : 'default'

      upload(req as never, res as never, async (err: unknown) => {
        if (err) {
          json(res, 400, { ok: false, error: err instanceof Error ? err.message : '上传失败' })
          return
        }
        const file = (req as { file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } }).file
        if (!file) {
          json(res, 400, { ok: false, error: '缺少文件字段 file' })
          return
        }
        const uuid = randomUUID()
        try {
          const saved = await saveLocal(config, file.originalname, file.buffer, req.headers.host || `127.0.0.1:${config.port}`, company)
          const rec = await store.saveFile({
            uuid,
            filename: sanitizeName(file.originalname),
            mime: file.mimetype,
            size: file.size,
            storage: saved.storage,
            url: saved.url
          })
          json(res, 200, { ok: true, uuid: rec.uuid, filename: rec.filename, mime: rec.mime, size: rec.size, url: rec.url })
        } catch (e) {
          json(res, 500, { ok: false, error: e instanceof Error ? e.message : '存储失败' })
        }
      })
      return
    }
  })
}
