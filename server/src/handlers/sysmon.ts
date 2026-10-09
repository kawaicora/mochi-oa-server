/**
 * 系统监控 handler —— 已登录电脑控制（/view/admin → 电脑控制 页的数据层）。
 * 全部要求 SERVER_ADMIN（服务端兜底校验，登录时已判）。
 * 事件：
 *   sys:info       → 系统信息（主机名/平台/CPU/内存/磁盘/网络IP/主板/显卡/运行时长）
 *   sys:perf       → 实时 CPU 使用率 + 内存 + 进程数
 *   sys:processes  → 进程列表（Windows tasklist / Linux ps）
 *   sys:exec       → 执行命令行（超时/长度限制）
 *   sys:screenshot → 尝试截取服务器屏幕（无显示环境则明确报不可用）
 *   sys:camera     → 尝试读取服务器摄像头一帧（无设备则明确报不可用）
 */
import type { Server, Socket } from 'socket.io'
import type { ServerConfig } from '../config'
import { fail, ok } from '../util'
import { isServerAdmin } from './mail'
import type { AuthUser } from './auth'

type Ack = (res: Record<string, unknown>) => void

/** 执行一条命令，返回 stdout/stderr/exitCode；超时或异常时以 error 返回。绝不让进程崩溃。 */
function execCmd(cmd: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    if (!cmd || cmd.length > 2000) return resolve({ stdout: '', stderr: '', exitCode: null, error: '命令为空或过长' })
    const cp = require('node:child_process') as typeof import('node:child_process')
    let timer: NodeJS.Timeout | null = null
    try {
      const child = cp.exec(cmd, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (timer) clearTimeout(timer)
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0,
          error: err ? String(err.message ?? err) : undefined
        })
      })
      timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }, timeoutMs + 500)
    } catch (e) {
      if (timer) clearTimeout(timer)
      resolve({ stdout: '', stderr: '', exitCode: null, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

/** 收集非内部 IPv4 地址（去掉 loopback、docker/虚拟网段等明显内网容器地址可选保留） */
function networkIps(): Array<{ name: string; address: string; family: string; internal: boolean }> {
  const os = require('node:os') as typeof import('node:os')
  const out: Array<{ name: string; address: string; family: string; internal: boolean }> = []
  const nis = os.networkInterfaces()
  for (const name of Object.keys(nis)) {
    for (const it of nis[name] ?? []) {
      if (it.family === 'IPv4') {
        out.push({ name, address: it.address, family: it.family, internal: it.internal })
      }
    }
  }
  return out
}

/** 进程列表快照 */
async function processes(): Promise<Array<{ pid: number; name: string; cpu?: string; mem?: string; args?: string }>> {
  const os = require('node:os') as typeof import('node:os')
  if (os.platform() === 'win32') {
    const r = await execCmd('tasklist /FO CSV /NH', 12000)
    if (r.error || r.exitCode !== 0) return []
    const out: Array<{ pid: number; name: string }> = []
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line)
      if (m) out.push({ pid: Number(m[2]), name: m[1] })
    }
    return out
  }
  const r = await execCmd('ps -eo pid,comm,%cpu,%mem,args --sort=-%cpu 2>/dev/null || ps -eo pid,comm,%cpu,%mem,args', 12000)
  if (r.error || r.exitCode !== 0) return []
  const out: Array<{ pid: number; name: string; cpu?: string; mem?: string; args?: string }> = []
  const lines = r.stdout.split(/\r?\n/).slice(1)
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(/\s+/)
    if (parts.length >= 4) {
      out.push({ pid: Number(parts[0]) || 0, name: parts[1], cpu: parts[2], mem: parts[3], args: parts.slice(4).join(' ') })
    }
  }
  return out
}

/** 计算 CPU 使用率：采样两次 os.cpus() 差值 */
function cpuUsage(): Promise<{ percent: number; perCore: number[] }> {
  return new Promise((resolve) => {
    const os = require('node:os') as typeof import('node:os')
    const a = os.cpus().map((c) => ({ idle: c.times.idle, total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }))
    setTimeout(() => {
      const b = os.cpus().map((c) => ({ idle: c.times.idle, total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }))
      const perCore = a.map((x, i) => {
        const t = b[i].total - x.total
        const idl = b[i].idle - x.idle
        return t <= 0 ? 0 : Math.max(0, Math.min(100, Math.round(((t - idl) / t) * 1000) / 10))
      })
      const avg = perCore.length ? perCore.reduce((s, v) => s + v, 0) / perCore.length : 0
      resolve({ percent: Math.round(avg * 10) / 10, perCore })
    }, 500)
  })
}

export function registerSysmonHandlers(ctx: { io: Server; store: unknown; config: ServerConfig }): void {
  const { io, config } = ctx

  io.on('connection', (socket: Socket) => {
    const authedUser = (): AuthUser | null => (socket.data.auth as AuthUser | null) ?? null

    socket.on('sys:info', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const os = require('node:os') as typeof import('node:os')
      const base: Record<string, unknown> = {
        hostname: os.hostname(),
        platform: os.platform(),
        type: os.type(),
        release: os.release(),
        arch: os.arch(),
        uptime: Math.round(os.uptime()),
        cpuModel: (os.cpus()[0]?.model ?? '').trim(),
        cpuCores: os.cpus().length,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        ips: networkIps()
      }
      // 主板 / 显卡 / 磁盘 —— 尽力尝试，失败回退为空
      const [board, gpu, disk] = await Promise.all([
        (async () => {
          if (os.platform() === 'win32') {
            const r = await execCmd('powershell -NoProfile -Command "Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty Manufacturer; Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty Product"', 12000)
            if (r.error || r.exitCode !== 0) return ''
            const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
            return lines.join(' / ')
          }
          const r = await execCmd('dmidecode -t baseboard 2>/dev/null | grep -E "Manufacturer|Product Name" | head -4', 12000)
          if (r.error || r.exitCode !== 0) return ''
          return r.stdout.split(/\r?\n/).map((s) => s.replace(/^\s*\w+:\s*/, '').trim()).filter(Boolean).join(' / ')
        })(),
        (async () => {
          if (os.platform() === 'win32') {
            const r = await execCmd('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"', 12000)
            if (r.error || r.exitCode !== 0) return ''
            return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ')
          }
          const r = await execCmd('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || lspci 2>/dev/null | grep -iE "vga|3d|display" | head -4', 12000)
          if (r.error || r.exitCode !== 0) return ''
          return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ')
        })(),
        (async () => {
          const r = await execCmd(os.platform() === 'win32' ? 'wmic logicaldisk get size,freespace,deviceid 2>nul || powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n=\'GB\';e={[math]::Round($_.Used/1GB,1)}}"' : 'df -h --output=target,size,used,avail,pcent 2>/dev/null || df -h', 12000)
          if (r.error || r.exitCode !== 0) return ''
          return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12).join('\n')
        })()
      ])
      ack(ok({ ...base, board: board || '未知', gpu: gpu || '未知', disk: disk || '' }))
    })

    socket.on('sys:perf', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const os = require('node:os') as typeof import('node:os')
      const cu = await cpuUsage()
      const total = os.totalmem()
      const free = os.freemem()
      ack(
        ok({
          cpu: cu.percent,
          perCore: cu.perCore,
          memTotal: total,
          memUsed: total - free,
          memPercent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
          uptime: Math.round(os.uptime()),
          ts: Date.now()
        })
      )
    })

    socket.on('sys:processes', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const list = await processes()
      ack(ok({ processes: list.slice(0, 300) }))
    })

    socket.on('sys:exec', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { cmd?: unknown }
      const cmd = typeof d.cmd === 'string' ? d.cmd.trim() : ''
      if (!cmd) return ack(fail('命令为空'))
      if (cmd.length > 2000) return ack(fail('命令过长'))
      const timeout = 15000
      const r = await execCmd(cmd, timeout)
      ack(ok({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, error: r.error ?? null }))
    })

    socket.on('sys:screenshot', async (_d: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const os = require('node:os') as typeof import('node:os')
      try {
        if (os.platform() === 'win32') {
          // PowerShell 截取主屏幕到临时 PNG，再读回 base64
          const tmp = require('node:path').join(require('node:os').tmpdir(), `mochi_shot_${Date.now()}.png`)
          const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${tmp}'); $g.Dispose(); $bmp.Dispose()`
          const r = await execCmd(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 20000)
          const fs = require('node:fs')
          if (r.exitCode === 0 && fs.existsSync(tmp)) {
            const data = fs.readFileSync(tmp)
            try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
            return ack(ok({ image: 'data:image/png;base64,' + data.toString('base64'), ts: Date.now() }))
          }
          return ack(fail('截屏失败：' + (r.stderr || r.error || '无显示会话')))
        }
        // Linux：尝试 scrot / import / gnome-screenshot
        const tmp = require('node:path').join(require('node:os').tmpdir(), `mochi_shot_${Date.now()}.png`)
        const r = await execCmd(`(scrot '${tmp}' || import -window root '${tmp}' || gnome-screenshot -f '${tmp}') 2>/dev/null`, 20000)
        const fs = require('node:fs')
        if (r.exitCode === 0 && fs.existsSync(tmp)) {
          const data = fs.readFileSync(tmp)
          try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
          return ack(ok({ image: 'data:image/png;base64,' + data.toString('base64'), ts: Date.now() }))
        }
        return ack(fail('当前服务器无图形桌面/显示会话，无法截屏'))
      } catch (e) {
        ack(fail('截屏失败：' + (e instanceof Error ? e.message : String(e))))
      }
    })

    socket.on('sys:camera', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const u = authedUser()
      if (!u) return ack(fail('未登录'))
      if (!isServerAdmin(u, config)) return ack(fail('需要 SERVER_ADMIN 权限'))
      const d = (data ?? {}) as { device?: unknown }
      const device = typeof d.device === 'string' && d.device ? d.device : undefined
      const os = require('node:os') as typeof import('node:os')
      try {
        const fs = require('node:fs')
        const tmp = require('node:path').join(require('node:os').tmpdir(), `mochi_cam_${Date.now()}.jpg`)
        const devArg = device ? `-i "${device}"` : '-f v4l2 -i /dev/video0'
        // 优先 ffmpeg 抓一帧
        const r = await execCmd(
          os.platform() === 'win32'
            ? `powershell -NoProfile -Command "try{$c=New-Object System.Drawing.Bitmap 640,480;$g=[System.Drawing.Graphics]::FromImage($c);$g.Clear([System.Drawing.Color]::Black);$c.Save('${tmp}')}catch{}" >nul`
            : `ffmpeg -y -loglevel error ${devArg} -frames:v 1 "${tmp}" 2>/dev/null`,
          15000
        )
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 500) {
          const data = fs.readFileSync(tmp)
          try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
          return ack(ok({ image: 'data:image/jpeg;base64,' + data.toString('base64'), ts: Date.now() }))
        }
        return ack(fail('未检测到可用摄像头设备' + (r.stderr ? '：' + r.stderr : '')))
      } catch (e) {
        ack(fail('摄像头读取失败：' + (e instanceof Error ? e.message : String(e))))
      }
    })
  })
}
