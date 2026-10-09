/**
 * 远程终端独立窗口 —— 交互式 shell（会话保持，cwd/变量持久）。
 * 输入命令 → dev:termIn 写到被控端常驻 shell stdin；stdout/stderr 经 dev:termOut 实时回显。
 */
;(function () {
  const CONFIG = window.__ADMIN_CONFIG__ || { path: '/socket.io', transports: ['websocket', 'polling'] }
  const q = new URLSearchParams(location.search)
  const deviceId = q.get('deviceId') || ''
  const shell = q.get('shell') || 'auto'
  const out = document.getElementById('term-out')
  const input = document.getElementById('term-input')
  const stateEl = document.getElementById('term-state')
  const devEl = document.getElementById('term-dev')
  devEl.textContent = '目标：' + deviceId + ' · shell=' + shell
  const token = q.get('token') || localStorage.getItem('vr_token') || ''

  function append(text, cls) {
    if (!text) return
    const d = document.createElement('div')
    d.className = 'term-line' + (cls ? ' ' + cls : '')
    d.textContent = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    out.appendChild(d)
    out.scrollTop = out.scrollHeight
  }
  function setState(t, cls) { stateEl.textContent = t; stateEl.className = 'term-state' + (cls ? ' ' + cls : '') }

  let sock = null
  function connect() {
    sock = io(location.origin, {
      path: CONFIG.path,
      transports: CONFIG.transports,
      auth: token ? { token, device: 'web-admin-terminal' } : { device: 'web-admin-terminal' }
    })
    sock.on('connect', () => {
      setState('已连接')
      sock.emit('dev:termOpen', { deviceId, shell }, (res) => {
        if (!res || !res.ok) {
          setState('打开失败', 'err')
          append('打开终端失败：' + ((res && res.error) || '无响应'), 'err')
        } else {
          setState('会话已建立')
          append('\r\n[远程终端已建立 · 目标 ' + deviceId + ' · ' + shell + ']（会话保持，可连续输入命令）\r\n', 'sys')
        }
      })
    })
    sock.on('connect_error', (e) => { setState('连接失败', 'err'); append('连接失败：' + ((e && e.message) || '未知错误'), 'err') })
    sock.on('disconnect', () => { setState('已断开', 'err'); append('\r\n[连接已断开]', 'err') })
    sock.on('dev:termOut', (d) => { if (!d || d.deviceId !== deviceId) return; append(d.data || '', d.isErr ? 'err' : '') })
    sock.on('dev:termClose', (d) => {
      if (!d || d.deviceId !== deviceId) return
      setState('会话已结束', 'err')
      append('\r\n[会话已结束 exit=' + (d.code ?? 0) + ']', 'err')
    })
  }
  connect()

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = input.value
      if (cmd.trim() !== '') { if (sock) sock.emit('dev:termIn', { deviceId, data: cmd + '\n' }) }
      input.value = ''
    } else if (e.key === 'Escape') {
      input.value = ''
    }
  })
  document.getElementById('term-close').onclick = () => {
    if (sock) sock.emit('dev:termClose', { deviceId })
    window.close()
  }
  window.addEventListener('beforeunload', () => { if (sock) { try { sock.emit('dev:termClose', { deviceId }) } catch {} } })
  input.focus()
})()
