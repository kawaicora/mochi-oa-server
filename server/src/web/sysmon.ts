/**
 * 网页端「已登录电脑控制」页（/view/admin → 电脑控制）：
 *   - 系统信息：主机名/IP(路由器分配)/系统/CPU型号与核数/内存/磁盘/主板/显卡/运行时长
 *   - 实时性能：CPU 使用率 + 内存 + 进程数（canvas 曲线）
 *   - 进程列表（刷新）
 *   - 命令行执行
 *   - 屏幕截图 / 摄像头读取（无显示/设备环境会明确提示）
 * 数据层：服务端 sysmon.ts handler（仅 SERVER_ADMIN）
 */

export function buildSysmonHtml(): string {
  return `
  <div id="sysmon-wrap">
    <div class="page-head"><span class="ph-title">已登录电脑控制</span><button class="mini-btn" id="sys-refresh">刷新系统信息</button></div>

    <!-- 系统信息 -->
    <div class="sys-cards" id="sys-cards">
      <div class="sys-card"><div class="sc-k">主机名</div><div class="sc-v" id="s-host">—</div></div>
      <div class="sys-card"><div class="sc-k">IP 地址</div><div class="sc-v" id="s-ip">—</div></div>
      <div class="sys-card"><div class="sc-k">操作系统</div><div class="sc-v" id="s-os">—</div></div>
      <div class="sys-card"><div class="sc-k">CPU</div><div class="sc-v" id="s-cpu">—</div></div>
      <div class="sys-card"><div class="sc-k">内存总量</div><div class="sc-v" id="s-mem">—</div></div>
      <div class="sys-card"><div class="sc-k">主板</div><div class="sc-v" id="s-board">—</div></div>
      <div class="sys-card"><div class="sc-k">显卡</div><div class="sc-v" id="s-gpu">—</div></div>
      <div class="sys-card"><div class="sc-k">运行时长</div><div class="sc-v" id="s-uptime">—</div></div>
    </div>
    <div class="sys-disk"><div class="sc-k">磁盘</div><pre id="s-disk" class="disk-pre">—</pre></div>

    <!-- 实时性能 -->
    <div class="perf-row">
      <div class="perf-box">
        <div class="perf-title">CPU 使用率 <span id="perf-cpu-v" class="perf-num">0%</span></div>
        <canvas id="perf-cpu" width="600" height="160"></canvas>
      </div>
      <div class="perf-box">
        <div class="perf-title">内存 <span id="perf-mem-v" class="perf-num">0%</span></div>
        <canvas id="perf-mem" width="600" height="160"></canvas>
      </div>
      <div class="perf-box">
        <div class="perf-title">进程数 <span id="perf-proc-v" class="perf-num">0</span></div>
        <button class="mini-btn" id="proc-refresh">刷新进程列表</button>
      </div>
    </div>

    <!-- 进程列表 -->
    <div class="panel-box">
      <div class="panel-title">进程列表</div>
      <div class="proc-table" id="proc-table"><div class="empty">点击「刷新进程列表」查看</div></div>
    </div>

    <!-- 命令行 -->
    <div class="panel-box">
      <div class="panel-title">执行命令行（仅 SERVER_ADMIN，15s 超时）</div>
      <div class="exec-row">
        <input id="exec-input" placeholder="例如：ls -la /  |  dir  |  df -h  |  free -m">
        <button class="mini-btn primary" id="exec-run">执行</button>
      </div>
      <pre id="exec-out" class="exec-out"></pre>
    </div>

    <!-- 屏幕 / 摄像头 -->
    <div class="panel-box">
      <div class="panel-title">远程查看</div>
      <div class="media-row">
        <div class="media-item">
          <button class="mini-btn primary" id="shot-btn">截取屏幕</button>
          <div id="shot-box" class="media-box"><span class="empty">点击截取屏幕</span></div>
        </div>
        <div class="media-item">
          <button class="mini-btn primary" id="cam-btn">读取摄像头</button>
          <div id="cam-box" class="media-box"><span class="empty">点击读取摄像头（服务器本机设备）</span></div>
        </div>
      </div>
    </div>
  </div>
  `
}

export function buildSysmonJs(): string {
  return `
;(function () {
  const A = window.__admin
  if (!A) return
  const $ = (id) => document.getElementById(id)
  const S = (A.sysmon = A.sysmon || {})
  S.cpuHist = []
  S.memHist = []
  S._poll = null

  function gb(n) { return n == null ? '—' : (n / 1073741824).toFixed(2) + ' GB' }
  function mb(n) { return n == null ? '—' : (n / 1048576).toFixed(0) + ' MB' }
  function uptime(s) { if (!s) return '—'; const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d + '天 ' + h + '时 ' + m + '分' }

  S.loadInfo = async function () {
    const ack = await A.emit('sys:info', {}).catch(() => ({ ok: false }))
    if (!ack.ok) { A.toast(ack.error || '获取系统信息失败'); return }
    $('s-host').textContent = ack.hostname || '—'
    const ips = (ack.ips || []).filter((i) => !i.internal).map((i) => i.address + ' (' + i.name + ')')
    $('s-ip').textContent = ips.length ? ips.join('，') : ((ack.ips || []).map((i) => i.address).join('，') || '—')
    $('s-os').textContent = (ack.type || '') + ' ' + (ack.release || '') + ' ' + (ack.arch || '')
    $('s-cpu').textContent = (ack.cpuModel || '—') + ' · ' + (ack.cpuCores || 0) + ' 核'
    $('s-mem').textContent = gb(ack.totalMem)
    $('s-board').textContent = ack.board || '—'
    $('s-gpu').textContent = ack.gpu || '—'
    $('s-uptime').textContent = uptime(ack.uptime)
    $('s-disk').textContent = ack.disk || '—'
  }

  function drawLine(canvas, hist, color, max) {
    const g = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    g.clearRect(0, 0, w, h)
    g.strokeStyle = '#1f2430'; g.lineWidth = 1
    g.strokeRect(0, 0, w - 1, h - 1)
    const n = hist.length
    if (n < 2) return
    g.strokeStyle = color; g.lineWidth = 2
    g.beginPath()
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (w - 2) + 1
      const y = h - 1 - (hist[i] / max) * (h - 4)
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
    }
    g.stroke()
  }

  S.pollPerf = async function () {
    const ack = await A.emit('sys:perf', {}).catch(() => ({ ok: false }))
    if (!ack.ok) return
    S.cpuHist.push(ack.cpu); if (S.cpuHist.length > 80) S.cpuHist.shift()
    S.memHist.push(ack.memPercent); if (S.memHist.length > 80) S.memHist.shift()
    $('perf-cpu-v').textContent = ack.cpu + '%'
    $('perf-mem-v').textContent = ack.memPercent + '%（' + mb(ack.memUsed) + ' / ' + gb(ack.memTotal) + '）'
    drawLine($('perf-cpu'), S.cpuHist, '#4a6cf7', 100)
    drawLine($('perf-mem'), S.memHist, '#00c88a', 100)
  }

  S.loadProcesses = async function () {
    const ack = await A.emit('sys:processes', {}).catch(() => ({ ok: false }))
    if (!ack.ok) { A.toast(ack.error || '获取进程失败'); return }
    const list = ack.processes || []
    $('perf-proc-v').textContent = list.length
    const box = $('proc-table')
    if (!list.length) { box.innerHTML = '<div class="empty">无进程数据</div>'; return }
    const head = '<div class="pt-head"><span>PID</span><span>名称</span><span>CPU%</span><span>内存%</span><span>命令行</span></div>'
    const rows = list.map((p) => '<div class="pt-row"><span>' + p.pid + '</span><span>' + A.esc(p.name) + '</span><span>' + (p.cpu != null ? p.cpu : '') + '</span><span>' + (p.mem != null ? p.mem : '') + '</span><span class="pt-args">' + A.esc(p.args || '') + '</span></div>')
    box.innerHTML = head + rows.join('')
  }

  S.exec = async function () {
    const cmd = $('exec-input').value.trim()
    if (!cmd) { A.toast('请输入命令'); return }
    $('exec-out').textContent = '正在执行…'
    const ack = await A.emit('sys:exec', { cmd }).catch(() => ({ ok: false }))
    if (!ack.ok) { $('exec-out').textContent = '执行失败：' + (ack.error || ''); return }
    $('exec-out').textContent = 'exit=' + ack.exitCode + '\n\n' + (ack.stdout || '') + (ack.stderr ? ('\n[stderr]\n' + ack.stderr) : '')
  }

  S.shot = async function () {
    $('shot-box').innerHTML = '<span class="empty">截取中…</span>'
    const ack = await A.emit('sys:screenshot', {}).catch(() => ({ ok: false }))
    if (!ack.ok || !ack.image) { $('shot-box').innerHTML = '<span class="empty">' + A.esc(ack.error || '截屏失败') + '</span>'; return }
    $('shot-box').innerHTML = '<img src="' + ack.image + '" style="max-width:100%;max-height:280px;border-radius:6px">'
  }

  S.cam = async function () {
    $('cam-box').innerHTML = '<span class="empty">读取中…</span>'
    const ack = await A.emit('sys:camera', {}).catch(() => ({ ok: false }))
    if (!ack.ok || !ack.image) { $('cam-box').innerHTML = '<span class="empty">' + A.esc(ack.error || '摄像头不可用') + '</span>'; return }
    $('cam-box').innerHTML = '<img src="' + ack.image + '" style="max-width:100%;max-height:280px;border-radius:6px">'
  }

  S.init = function () {
    if (S._inited) return
    S._inited = true
    S.loadInfo()
    S.loadProcesses()
    S.pollPerf()
    if (S._poll) clearInterval(S._poll)
    S._poll = setInterval(() => S.pollPerf(), 2500)
    $('sys-refresh').onclick = S.loadInfo
    $('proc-refresh').onclick = S.loadProcesses
    $('exec-run').onclick = S.exec
    $('exec-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') S.exec() })
    $('shot-btn').onclick = S.shot
    $('cam-btn').onclick = S.cam
  }
})()
`
}
