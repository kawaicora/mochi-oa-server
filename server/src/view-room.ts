/**
 * /view/room —— 服务端网页端「会议大厅 + 通话」，作为客户端的前端替代。
 *
 * 功能：
 *   1. 网页端登录（账号+密码 → auth:login 明文；或 URL ?token= 直接进入）
 *   2. 展示所有进行中的会议/通话（conf 会议、group 群通话、dm 私聊通话）——rtc:listRooms + rtc:roomsChanged 实时刷新
 *   3. 加入：可选 麦克风(仅语音) / 摄像头(音视频) / 共享屏幕(音视频+屏幕)，WebRTC 信令与客户端完全一致
 *   4. 通话界面照抄客户端 RtcCallRoom：视频网格 + 底部控制栏（静音/摄像头/共享屏幕/聊天/结束）
 *
 * 资源：
 *   GET /view/room            → 单页 HTML（内联 CSS/JS）
 *   GET /view/room/socket.io.js → 本地提供 socket.io 客户端（serveClient=false，不依赖外网 CDN）
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'socket.io'
import type { ServerConfig } from './config'

const ROOM_PAGE = '/view/room'
const IO_JS = '/view/room/socket.io.js'

function pageHtml(serverPath: string, transports: string[]): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>会议大厅 · Mochi OA</title>
<script src="${ROOM_PAGE}/socket.io.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#0d1117;color:#e6e6e6;min-height:100vh}
input,button{outline:none;font-family:inherit}
.card{background:#1a1e28;border:1px solid #2a2f3d;border-radius:14px;padding:32px;width:360px;max-width:92vw;margin:12vh auto 0;box-shadow:0 12px 40px rgba(0,0,0,.4)}
h1{font-size:20px;font-weight:600;margin-bottom:6px}
.sub{color:#9aa0ae;font-size:13px;margin-bottom:22px}
label{display:block;font-size:13px;color:#c3c8d2;margin:14px 0 6px}
input[type=text],input[type=password]{width:100%;height:42px;border:1px solid #333a49;border-radius:8px;background:#141822;color:#e6e6e6;padding:0 12px;font-size:14px}
input:focus{border-color:#4a6cf7}
.btn{width:100%;height:44px;border:none;border-radius:8px;background:#4a6cf7;color:#fff;font-size:15px;font-weight:600;margin-top:22px;cursor:pointer}
.btn:hover{background:#5b79ff}
.btn.ghost{background:#2d2d44}
.btn.ghost:hover{background:#3a3a55}
.err{background:#3a1f24;border:1px solid #7c2836;color:#ffb3bc;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:8px}
.tip{color:#9aa0ae;font-size:12px;text-align:center;margin-top:16px}

/* ── 会议大厅列表 ── */
.header{height:56px;display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid #22262f;background:#0d1117}
.header .brand{font-size:16px;font-weight:700}
.header .who{margin-left:auto;color:#9aa0ae;font-size:13px}
.header .logout{cursor:pointer;color:#9aa0ae;font-size:13px;border:none;background:transparent}
.header .logout:hover{color:#ff7d00}
.list-wrap{max-width:1080px;margin:24px auto;padding:0 20px}
.list-title{font-size:15px;font-weight:600;margin-bottom:14px;color:#cfd3dc}
.empty{padding:40px;text-align:center;color:#6b7280;font-size:14px;border:1px dashed #2a2f3d;border-radius:12px}
.room-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.room-card{background:#1a1e28;border:1px solid #2a2f3d;border-radius:12px;padding:16px;cursor:pointer;transition:border-color .15s}
.room-card:hover{border-color:#4a6cf7}
.room-type{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;margin-bottom:8px}
.rt-conf{background:#16331f;color:#a9e0b8}
.rt-group{background:#23304f;color:#a9c0ff}
.rt-dm{background:#3a1f2e;color:#ffb3d1}
.room-title{font-size:15px;font-weight:600;margin-bottom:6px;word-break:break-all}
.room-meta{font-size:12px;color:#9aa0ae;line-height:1.8}
.room-join{margin-top:12px;text-align:center;font-size:13px;color:#7b96ff}

/* ── 加入对话框 ── */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:40}
.modal-inner{background:#1a1e28;border:1px solid #2a2f3d;border-radius:14px;padding:26px 28px;width:520px;max-width:94vw}
.modal-title{font-size:16px;font-weight:600;margin-bottom:4px;word-break:break-all}
.modal-sub{font-size:12px;color:#9aa0ae;margin-bottom:16px}
.pick-row{display:flex;gap:10px;margin-bottom:16px}
.pick{flex:1;border:1px solid #333a49;border-radius:10px;background:#141822;padding:14px 8px;text-align:center;cursor:pointer;color:#e6e6e6}
.pick:hover,.pick.on{border-color:#4a6cf7;background:#1c2440}
.pick .pi{font-size:22px;margin-bottom:6px;display:block}
.pick .pt{font-size:13px}
.preview{width:100%;background:#000;border-radius:8px;min-height:160px;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:13px;margin-bottom:14px;overflow:hidden}
.preview video{width:100%;max-height:260px}
.pwd-row{display:flex;gap:8px}
.pwd-row input{flex:1}
.modal-btns{display:flex;gap:10px;margin-top:18px}
.modal-btns .btn{margin-top:0;flex:1}
.pick-pass{display:flex;gap:8px}
.pick-pass input{flex:1}

/* ── 通话界面（照抄客户端 RtcCallRoom） ── */
.call-root{height:100vh;display:flex;flex-direction:column;background:#0d1117;overflow:hidden}
.call-top{height:44px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 14px;background:#0d1117;border-bottom:1px solid #1c2029}
.call-top .back{cursor:pointer;border:none;background:transparent;color:#cfd3dc;font-size:14px}
.call-top .back:hover{color:#ff7d00}
.call-no{margin-left:12px;color:#cfd3dc;font-size:13px;padding:4px 10px;border:1px solid #2d2d44;border-radius:6px;background:rgba(255,255,255,.04)}
.call-timer{margin-left:auto;color:#8a8f99;font-size:13px}
.call-center{flex:1;min-height:0;overflow:auto;background:#0d1117;padding:16px;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));align-content:center}
.tile{position:relative;aspect-ratio:16/9;background:#1a1a2e;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.tile video{width:100%;height:100%;object-fit:cover}
.tile .tname{position:absolute;left:8px;bottom:6px;color:#fff;font-size:12px;background:rgba(0,0,0,.45);padding:2px 8px;border-radius:4px}
.tile .tavatar{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:#23304f;color:#a9c0ff;font-size:24px;font-weight:600}
.call-bar{height:64px;flex-shrink:0;display:flex;align-items:center;justify-content:center;gap:10px;background:rgba(13,17,23,.92);padding:0 16px}
.ctrl{background:#2d2d44;border:none;color:#e6e6e6;width:44px;height:44px;border-radius:50%;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.ctrl:hover{background:#3a3a55}
.ctrl.danger{background:#e81123}
.ctrl.on{background:#1677ff}
.ctrl.sharing{background:#1677ff}
.hangup{width:auto;border-radius:22px;padding:0 20px;background:#ff7d00}
.hangup:hover{background:#ff9033}
.call-chat{position:absolute;right:14px;bottom:76px;width:280px;background:#1a1a2e;border:1px solid #2d2d44;border-radius:8px;z-index:30;display:flex;flex-direction:column;max-height:60vh}
.call-chat .cc-list{flex:1;overflow-y:auto;padding:10px;min-height:80px}
.cc-msg{margin-bottom:8px}
.cc-head{font-size:11px;color:#8a8f99;margin-bottom:2px}
.cc-bubble{background:#2d2d44;color:#e6e6e6;padding:5px 9px;border-radius:8px;font-size:13px;word-break:break-word}
.cc-msg.mine .cc-bubble{background:#1677ff;color:#fff}
.cc-input{display:flex;gap:6px;padding:8px;border-top:1px solid #2d2d44}
.cc-input input{flex:1;background:#0d1117;border:1px solid #2d2d44;border-radius:6px;padding:7px 10px;color:#e6e6e6;font-size:13px}
.cc-input button{background:#1677ff;border:none;color:#fff;width:36px;border-radius:6px;cursor:pointer}
</style>
</head>
<body>
<!-- 登录视图 -->
<div id="view-login" class="card">
  <h1>会议大厅</h1>
  <div class="sub">登录后可查看并加入进行中的会议 / 群通话 / 私聊通话</div>
  <div id="login-err" class="err" style="display:none"></div>
  <label>用户名 / 邮箱</label>
  <input id="login-account" type="text" autocomplete="username">
  <label>密码</label>
  <input id="login-pwd" type="password" autocomplete="current-password">
  <button class="btn" id="login-btn">登录</button>
  <div class="tip">也可通过客户端设置页复制会话 Token，以 ?token=… 访问本页免登录</div>
</div>

<!-- 无权限视图 -->
<div id="view-noperm" class="card" style="display:none">
  <h1>会议大厅</h1>
  <div class="sub" style="color:#ffb3bc">需要 SERVER_ADMIN 权限</div>
  <div class="tip">仅服务器管理员（SERVER_ADMIN）可访问本页面。请联系管理员开通账号，或使用客户端「设置」中复制管理员会话 Token，以 ?token=… 访问。</div>
  <button class="btn ghost" id="noperm-back">返回登录</button>
</div>

<!-- 会议大厅列表 -->
<div id="view-list" style="display:none">
  <div class="header">
    <span class="brand">📡 会议大厅</span>
    <span class="who" id="who">—</span>
    <button class="logout" id="logout-btn">退出登录</button>
  </div>
  <div class="list-wrap">
    <div class="list-title" id="list-title">进行中的会议 / 通话</div>
    <div id="room-empty" class="empty">暂无进行中的会议或通话</div>
    <div id="room-grid" class="room-grid"></div>
  </div>
</div>

<!-- 加入对话框 -->
<div id="view-join" class="modal" style="display:none">
  <div class="modal-inner">
    <div class="modal-title" id="join-title">加入会议</div>
    <div class="modal-sub" id="join-sub"></div>
    <div class="pick-row">
      <div class="pick" data-mode="mic"><span class="pi">🎤</span><span class="pt">仅语音<br>（麦克风）</span></div>
      <div class="pick" data-mode="cam"><span class="pi">📷</span><span class="pt">摄像头<br>（音视频）</span></div>
      <div class="pick" data-mode="screen"><span class="pi">🖥️</span><span class="pt">共享屏幕<br>（音视频+屏幕）</span></div>
    </div>
    <div id="join-preview" class="preview">选择设备后显示预览</div>
    <div class="pick-pass" id="join-pass-wrap" style="display:none">
      <input id="join-pass" type="password" placeholder="会议密码">
    </div>
    <div class="modal-btns">
      <button class="btn ghost" id="join-cancel">取消</button>
      <button class="btn" id="join-go">加入</button>
    </div>
  </div>
</div>

<!-- 通话界面 -->
<div id="view-call" class="call-root" style="display:none">
  <div class="call-top">
    <button class="back" id="call-back">← 返回</button>
    <span class="call-no" id="call-no">会议中</span>
    <span class="call-timer" id="call-timer">00:00</span>
  </div>
  <div class="call-center" id="call-grid"></div>
  <div id="call-chat" class="call-chat" style="display:none">
    <div id="cc-list" class="cc-list"></div>
    <div class="cc-input"><input id="cc-input" placeholder="发送消息"><button id="cc-send">➤</button></div>
  </div>
  <div class="call-bar">
    <button class="ctrl" id="btn-mute" title="静音"><span>🎤</span></button>
    <button class="ctrl" id="btn-cam" title="摄像头"><span>📷</span></button>
    <button class="ctrl" id="btn-screen" title="共享屏幕"><span>🖥️</span></button>
    <button class="ctrl" id="btn-chat" title="聊天"><span>💬</span></button>
    <button class="ctrl hangup" id="btn-leave"><span>结束</span></button>
  </div>
</div>

<script>
// ═══ 服务器配置（由服务端注入） ═══
const SERVER_PATH = ${JSON.stringify(serverPath)};
const CONFIG_TRANSPORTS = ${JSON.stringify(transports)};

// ═══ 全局状态 ═══
const $ = (id) => document.getElementById(id);
let sock = null;
let token = localStorage.getItem('vr_token') || '';
let myUser = null;
let rooms = [];
let currentRoom = null;   // 当前通话房间
let peers = [];           // 当前通话成员
let remoteStreams = {};   // userId -> MediaStream
let engine = null;        // RtcEngine 实例
let localStream = null;   // 本端媒体流
let callTimer = null;
let callSeconds = 0;
let isMuted = false;
let isCameraOn = false;
let isSharing = false;
const joinMode = { val: 'mic' };

// ═══ socket.io 连接 ═══
function connect() {
  if (sock) { sock.disconnect(); sock = null; }
  sock = io(location.origin, {
    path: SERVER_PATH,
    transports: CONFIG_TRANSPORTS,
    auth: token ? { token, device: 'web-room' } : { device: 'web-room' }
  });
  sock.on('connect_error', (e) => { console.warn('[view/room] connect_error', e && e.message); });
  sock.on('disconnect', (r) => { console.warn('[view/room] disconnect', r); if (!token) showLogin(); });
  sock.on('auth:sessionRevoked', () => { token = ''; localStorage.removeItem('vr_token'); showLogin(); });
  sock.on('rtc:roomsChanged', () => { if (viewNow() === 'list') loadRooms(); });
  // 通话信令（照抄客户端订阅）
  sock.on('rtc:peerJoined', (d) => { if (currentRoom && d.room === currentRoom.id) { upsertPeer(d.peer); engine && engine.addPeer(d.peer.userId); } });
  sock.on('rtc:peerLeft', (d) => { if (currentRoom && d.room === currentRoom.id) { const p = peers.find((x) => x.socketId === d.peerId); if (p) { engine && engine.closePeer(p.userId); delete remoteStreams[p.userId]; peers = peers.filter((x) => x.socketId !== d.peerId); renderGrid(); } } });
  sock.on('rtc:signal', (d) => { if (currentRoom && d.room === currentRoom.id) engine && engine.handleSignal(d.from.userId, d.signal); });
  sock.on('rtc:ended', (d) => { if (currentRoom && d.room === currentRoom.id) { alert('会议已结束'); leaveCall(true); } });
  sock.on('rtc:chatMessage', (d) => { if (currentRoom && d.room === currentRoom.id && d.from.userId !== (myUser && myUser.id)) { addChat(d.from.nick || '用户', d.content, false); } });
}

// ═══ 视图切换 ═══
function viewNow() { return $('view-list').style.display !== 'none' ? 'list' : $('view-call').style.display !== 'none' ? 'call' : 'login'; }
function showLogin() { $('view-login').style.display = ''; $('view-list').style.display = 'none'; $('view-call').style.display = 'none'; $('view-noperm').style.display = 'none'; }
function showNoPerm() { $('view-login').style.display = 'none'; $('view-list').style.display = 'none'; $('view-call').style.display = 'none'; $('view-noperm').style.display = ''; }
function showList() { $('view-login').style.display = 'none'; $('view-list').style.display = ''; $('view-call').style.display = 'none'; $('view-noperm').style.display = 'none'; $('join-title').textContent = '加入会议'; $('join-title').closest('.modal').style.display = 'none'; }

// ═══ 登录 ═══
async function doLogin() {
  const account = $('login-account').value.trim();
  const password = $('login-pwd').value;
  $('login-err').style.display = 'none';
  if (!account || !password) { showErr('请输入用户名和密码'); return; }
  try {
    connect();
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('connect_error', rej); setTimeout(() => rej(new Error('连接超时')), 8000); });
    const ack = await emitAck('auth:login', { account, password, device: 'web-room' });
    if (!ack.ok) { showErr(ack.error || '登录失败'); return; }
    // 登录时判定 SERVER_ADMIN：非管理员不允许进入会议大厅
    if (!ack.serverAdmin) { token = ''; localStorage.removeItem('vr_token'); showNoPerm(); return; }
    token = ack.token; localStorage.setItem('vr_token', token);
    myUser = ack.user;
    enterList();
  } catch (e) { showErr(e instanceof Error ? e.message : '登录失败'); }
}
function showErr(m) { $('login-err').textContent = m; $('login-err').style.display = ''; }
async function enterList() {
  const who = myUser ? (myUser.nick || myUser.username) : '—';
  $('who').textContent = who;
  showList();
  await loadRooms();
}
async function loadRooms() {
  try {
    const ack = await emitAck('rtc:listRooms', {});
    if (ack.ok) { rooms = ack.rooms || []; renderRooms(); }
  } catch (e) { console.warn('[view/room] listRooms fail', e); }
}
function renderRooms() {
  $('room-empty').style.display = rooms.length ? 'none' : '';
  const grid = $('room-grid');
  grid.innerHTML = '';
  $('list-title').textContent = '进行中的会议 / 通话（' + rooms.length + '）';
  const typeMap = { conf: ['会议', 'rt-conf'], group: ['群通话', 'rt-group'], dm: ['私聊通话', 'rt-dm'] };
  for (const r of rooms) {
    const [tn, tc] = typeMap[r.type] || [r.type, 'rt-conf'];
    const el = document.createElement('div');
    el.className = 'room-card';
    const title = r.title || (r.type === 'group' ? '群通话' : r.type === 'dm' ? '私聊通话' : '视频会议');
    const no = r.meetingNo ? ('会议号 ' + r.meetingNo) : (r.type === 'group' ? ('群 #' + r.groupId) : r.id);
    const started = new Date(r.startedAt).toLocaleTimeString();
    el.innerHTML = '<span class="room-type ' + tc + '">' + tn + '</span>' +
      '<div class="room-title">' + esc(title) + '</div>' +
      '<div class="room-meta">' + esc(no) + (r.hasPassword ? ' · 🔒' : '') + ' · 👥 ' + r.peerCount + ' · 始于 ' + started + '</div>' +
      '<div class="room-join">点击加入 →</div>';
    el.onclick = () => openJoin(r);
    grid.appendChild(el);
  }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ═══ 加入对话框 ═══
let joinTarget = null;
function openJoin(r) {
  joinTarget = r;
  $('join-title').textContent = r.title || (r.type === 'group' ? '群通话' : r.type === 'dm' ? '私聊通话' : '视频会议');
  $('join-sub').textContent = (r.meetingNo ? ('会议号 ' + r.meetingNo) : r.id) + ' · 参与者 ' + r.peerCount;
  $('join-pass-wrap').style.display = r.hasPassword ? '' : 'none';
  $('join-pass').value = '';
  stopPreview();
  joinMode.val = 'mic';
  setPick('mic');
  $('view-join').style.display = '';
}
function setPick(mode) {
  joinMode.val = mode;
  document.querySelectorAll('.pick').forEach((p) => p.classList.toggle('on', p.dataset.mode === mode));
}
document.querySelectorAll('.pick').forEach((p) => {
  p.onclick = async () => { setPick(p.dataset.mode); await updatePreview(); };
});
async function updatePreview() {
  stopPreview();
  const box = $('join-preview');
  box.textContent = '正在获取设备…';
  try {
    const stream = await acquireStream(joinMode.val);
    localStream = stream;
    box.innerHTML = '';
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = stream;
    box.appendChild(v);
  } catch (e) {
    box.textContent = '设备获取失败：' + (e instanceof Error ? e.message : String(e));
  }
}
function stopPreview() {
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  $('join-preview').innerHTML = '';
}
async function acquireStream(mode) {
  if (mode === 'mic') return navigator.mediaDevices.getUserMedia({ audio: true });
  if (mode === 'cam') return navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } });
  // 共享屏幕：音频捕获可选（部分浏览器不支持，catch 后仅视频）
  try { return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { return navigator.mediaDevices.getDisplayMedia({ video: true }); }
}
$('join-cancel').onclick = () => { $('view-join').style.display = 'none'; stopPreview(); localStream = null; };
$('join-go').onclick = () => { if (joinTarget) doJoin(joinTarget); };
async function doJoin(r) {
  const password = $('join-pass').value || undefined;
  try {
    if (!localStream) { localStream = await acquireStream(joinMode.val); }
    const ack = await emitAck('rtc:join', { roomId: r.id, password, kind: r.kind });
    if (!ack.ok) { alert(ack.error || '加入失败'); return; }
    enterCall(ack.room, ack.peers || [], ack.iceServers || [], localStream, ack.kind);
  } catch (e) {
    alert(e instanceof Error ? e.message : '加入失败');
  }
}

// ═══ 通话：RtcEngine（照抄客户端） ═══
class RtcEngine {
  constructor(opts) { this.roomId = opts.roomId; this.ice = toIce(opts.iceServers); this.localStream = opts.localStream; this.onSignal = opts.onSignal; this.onRemote = opts.onRemote; this.onDisconnect = opts.onDisconnect; this.peers = new Map(); this._pendingIce = new Map(); }
  addPeer(userId) {
    const ex = this.peers.get(userId);
    if (ex) { if (ex.signalingState !== 'stable') { ex.close(); this.peers.delete(userId); } else return; }
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    this.peers.set(userId, pc);
    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    this._bind(pc, userId);
    this._offer(pc, userId);
  }
  handleSignal(from, sig) {
    let pc = this.peers.get(from);
    if (!pc && sig.type === 'offer') { pc = new RTCPeerConnection({ iceServers: this.ice }); this.peers.set(from, pc); this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream)); this._bind(pc, from); }
    if (!pc) return;
    if (sig.type === 'offer') this._handleOffer(pc, from, sig.sdp);
    else if (sig.type === 'answer') this._handleAnswer(pc, from, sig.sdp);
    else if (sig.type === 'ice') this._handleIce(pc, from, sig);
  }
  replaceTrack(track, kind) {
    this.peers.forEach((pc) => {
      pc.getSenders().forEach((s) => { if (s.track && s.track.kind === kind) s.replaceTrack(track); });
      this._renegotiate(pc);
    });
  }
  closePeer(userId) { const pc = this.peers.get(userId); if (pc) { pc.close(); this.peers.delete(userId); } }
  closeAll() { this.peers.forEach((pc) => pc.close()); this.peers.clear(); }
  _bind(pc, userId) {
    pc.ontrack = (e) => { if (e.streams.length) this.onRemote(userId, e.streams[0]); };
    pc.onicecandidate = (e) => { if (e.candidate) this.onSignal({ type: 'ice', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') { this.closePeer(userId); this.onDisconnect(userId); } };
  }
  async _offer(pc, userId) {
    try { const o = await pc.createOffer(); o.sdp = stereo(o.sdp); await pc.setLocalDescription(o); this.onSignal({ type: 'offer', sdp: o.sdp || '' }); } catch (e) { console.warn('offer fail', e); }
  }
  async _handleOffer(pc, userId, sdp) {
    try {
      if (pc.signalingState === 'have-remote-offer') { try { await pc.setRemoteDescription({ type: 'rollback' }); } catch {} }
      await pc.setRemoteDescription({ type: 'offer', sdp }); await this._flushIce(userId, pc);
      const a = await pc.createAnswer(); a.sdp = stereo(a.sdp); await pc.setLocalDescription(a); this.onSignal({ type: 'answer', sdp: a.sdp || '' });
    } catch (e) { console.warn('handleOffer fail', e); }
  }
  async _handleAnswer(pc, userId, sdp) {
    try { if (pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription({ type: 'answer', sdp }); await this._flushIce(userId, pc); } } catch (e) { console.warn('handleAnswer fail', e); }
  }
  _handleIce(pc, userId, sig) {
    if (!pc.remoteDescription) { const arr = this._pendingIce.get(userId) || (this._pendingIce.set(userId, []), this._pendingIce.get(userId)); arr.push({ candidate: sig.candidate, sdpMid: sig.sdpMid || undefined, sdpMLineIndex: sig.sdpMLineIndex != null ? sig.sdpMLineIndex : undefined }); return; }
    pc.addIceCandidate(new RTCIceCandidate({ candidate: sig.candidate, sdpMid: sig.sdpMid || undefined, sdpMLineIndex: sig.sdpMLineIndex != null ? sig.sdpMLineIndex : undefined })).catch(() => {});
  }
  async _flushIce(userId, pc) { const arr = this._pendingIce.get(userId); if (!arr || !arr.length) return; this._pendingIce.delete(userId); for (const c of arr) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} } }
  async _renegotiate(pc) { if (pc.signalingState !== 'stable') return; try { const o = await pc.createOffer(); o.sdp = stereo(o.sdp); await pc.setLocalDescription(o); this.onSignal({ type: 'offer', sdp: o.sdp || '' }); } catch (e) { console.warn('renegotiate fail', e); } }
}
function toIce(ices) { return (ices || []).map((i) => ({ urls: i.urls, username: i.username, credential: i.credential })); }
function stereo(sdp) { return (sdp || '').replace(/(a=fmtp:111 .*)/g, (line) => (/stereo=1/.test(line) ? line : line + ';stereo=1;sprop-stereo=1')); }

function enterCall(room, roomPeers, iceServers, stream, _kind) {
  currentRoom = room; peers = roomPeers || []; remoteStreams = {};
  localStream = stream;
  $('view-join').style.display = 'none';
  $('view-login').style.display = 'none';
  $('view-list').style.display = 'none';
  $('view-call').style.display = '';
  $('call-no').textContent = room.meetingNo ? ('会议号 ' + room.meetingNo) : room.id;
  $('call-grid').innerHTML = '';
  // 本地块
  renderGrid();
  engine = new RtcEngine({
    roomId: room.id, iceServers, localStream: stream,
    onSignal: (sig) => { sock.emit('rtc:signal', { roomId: room.id, signal: sig }); },
    onRemote: (userId, s) => { remoteStreams[userId] = s; renderGrid(); },
    onDisconnect: (userId) => { delete remoteStreams[userId]; peers = peers.filter((p) => p.userId !== userId); renderGrid(); }
  });
  roomPeers.forEach((p) => engine.addPeer(p.userId));
  callSeconds = 0; $('call-timer').textContent = '00:00';
  if (callTimer) clearInterval(callTimer);
  callTimer = setInterval(() => { callSeconds++; $('call-timer').textContent = fmt(callSeconds); }, 1000);
  // 底部状态
  isMuted = false; isCameraOn = (joinMode.val === 'cam'); isSharing = (joinMode.val === 'screen');
  refreshBar();
}
function renderGrid() {
  const grid = $('call-grid');
  grid.innerHTML = '';
  // 本地
  const lt = localStream.getVideoTracks()[0];
  const me = document.createElement('div'); me.className = 'tile';
  if (lt && lt.readyState !== 'ended') { const v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = localStream; me.appendChild(v); }
  else { const a = document.createElement('div'); a.className = 'tavatar'; a.textContent = (myUser && (myUser.nick || myUser.username) || '我').charAt(0); me.appendChild(a); }
  const n = document.createElement('div'); n.className = 'tname'; n.textContent = '我' + (myUser ? (myUser.nick || myUser.username) : ''); me.appendChild(n);
  grid.appendChild(me);
  // 远端
  peers.forEach((p) => {
    const t = document.createElement('div'); t.className = 'tile';
    const rs = remoteStreams[p.userId];
    const vt = rs && rs.getVideoTracks()[0];
    if (vt && vt.readyState !== 'ended') { const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.srcObject = rs; t.appendChild(v); }
    else { const a = document.createElement('div'); a.className = 'tavatar'; a.textContent = (p.nick || '?').charAt(0); t.appendChild(a); }
    const n = document.createElement('div'); n.className = 'tname'; n.textContent = p.nick; t.appendChild(n);
    grid.appendChild(t);
  });
}
function fmt(s) { const mm = String(Math.floor(s / 60)).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0'); return mm + ':' + ss; }

// ═══ 通话控制 ═══
function refreshBar() {
  $('btn-mute').classList.toggle('danger', isMuted);
  $('btn-mute').innerHTML = isMuted ? '<span>🔇</span>' : '<span>🎤</span>';
  $('btn-cam').classList.toggle('on', isCameraOn);
  $('btn-cam').innerHTML = isCameraOn ? '<span>📷</span>' : '<span>🚫</span>';
  $('btn-screen').classList.toggle('sharing', isSharing);
}
$('btn-mute').onclick = () => { isMuted = !isMuted; const t = localStream.getAudioTracks()[0]; if (t) t.enabled = !isMuted; refreshBar(); };
$('btn-cam').onclick = async () => {
  try {
    if (isCameraOn) { engine.replaceTrack(null, 'video'); isCameraOn = false; }
    else { const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } }); const t = s.getVideoTracks()[0]; engine.replaceTrack(t, 'video'); isCameraOn = true; }
    refreshBar(); renderGrid();
  } catch (e) { alert('摄像头切换失败'); }
};
$('btn-screen').onclick = async () => {
  try {
    if (isSharing) { engine.replaceTrack(null, 'video'); isSharing = false; refreshBar(); return; }
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(() => navigator.mediaDevices.getDisplayMedia({ video: true }));
    const t = s.getVideoTracks()[0]; engine.replaceTrack(t, 'video'); isSharing = true; refreshBar();
    t.onended = () => { isSharing = false; refreshBar(); };
  } catch (e) { /* 用户取消共享 */ }
};
$('btn-chat').onclick = () => { const c = $('call-chat'); c.style.display = c.style.display === 'none' ? '' : 'none'; };
$('btn-leave').onclick = () => { if (confirm('确定离开当前会议？')) leaveCall(false); };
$('call-back').onclick = () => { if (confirm('确定离开当前会议？')) leaveCall(false); };
$('cc-send').onclick = sendChat;
$('cc-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
  const v = $('cc-input').value.trim();
  if (!v || !currentRoom) return;
  $('cc-input').value = '';
  const ack = await emitAck('rtc:chatMessage', { roomId: currentRoom.id, content: v }).catch(() => ({ ok: false }));
  if (ack.ok) addChat((myUser && (myUser.nick || myUser.username)) || '我', v, true);
}
function addChat(nick, content, mine) {
  const list = $('cc-list');
  const m = document.createElement('div'); m.className = 'cc-msg' + (mine ? ' mine' : '');
  m.innerHTML = '<div class="cc-head">' + esc(nick) + '</div><div class="cc-bubble">' + esc(content) + '</div>';
  list.appendChild(m); list.scrollTop = list.scrollHeight;
}
async function leaveCall(_ended) {
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
  if (engine) { if (currentRoom && !_ended) sock.emit('rtc:leave', { roomId: currentRoom.id }); engine.closeAll(); engine = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  currentRoom = null; peers = []; remoteStreams = {};
  $('view-call').style.display = 'none';
  $('view-login').style.display = 'none';
  $('view-list').style.display = '';
  loadRooms();
}

// ═══ 工具 ═══
function emitAck(evt, payload) {
  return new Promise((resolve) => {
    sock.emit(evt, payload, (res) => resolve(res || { ok: false, error: '无响应' }));
    setTimeout(() => resolve({ ok: false, error: '请求超时' }), 12000);
  });
}

// ═══ 初始化 ═══
$('login-btn').onclick = doLogin;
$('login-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('login-account').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-pwd').focus(); });
$('logout-btn').onclick = () => { token = ''; localStorage.removeItem('vr_token'); sock.disconnect(); showLogin(); };
$('noperm-back').onclick = () => { showLogin(); };

(async function init() {
  // URL ?token= 直接进入
  const q = new URLSearchParams(location.search);
  const urlToken = q.get('token') || '';
  if (urlToken) { token = urlToken; localStorage.setItem('vr_token', urlToken); }
  if (token) {
    try {
      connect();
      await new Promise((res, rej) => { sock.once('connect', res); sock.once('connect_error', rej); setTimeout(() => rej(new Error('连接超时')), 8000); });
      const ack = await emitAck('auth:me', {});
      if (ack.ok) {
        // token 进入同样判 SERVER_ADMIN
        if (!ack.serverAdmin) { token = ''; localStorage.removeItem('vr_token'); showNoPerm(); return; }
        myUser = ack.user; enterList(); return;
      }
      token = ''; localStorage.removeItem('vr_token'); showLogin();
    } catch { showLogin(); }
  } else { showLogin(); }
})();
</script>
</body>
</html>`
}

/** 从服务端 node_modules 提供 socket.io 客户端脚本（serveClient=false，网页端需本地加载） */
function ioClientJs(): Buffer | null {
  const candidates = [
    join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'),
    join(process.cwd(), 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js')
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return readFileSync(p)
      } catch {
        /* 继续 */
      }
    }
  }
  return null
}

function sendHtml(res: ServerResponse, code: number, html: string): void {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

/**
 * 注册 /view/room 网页端路由。
 * GET /view/room            → 单页 HTML
 * GET /view/room/socket.io.js → socket.io 客户端脚本（缓存 1 天）
 */
export function registerViewRoomRoutes(http: HttpServer, _store: unknown, _io: Server, config: ServerConfig): void {
  const serverPath = config.path || '/socket.io'
  const transports = config.transports && config.transports.length ? config.transports : (['websocket', 'polling'] as string[])
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // socket.io 客户端脚本
    if (url.pathname === IO_JS) {
      const js = ioClientJs()
      if (!js) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('socket.io client not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' })
      res.end(js)
      return
    }

    if (url.pathname !== ROOM_PAGE) return // 其它路径交由其它路由处理
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('仅支持 GET')
      return
    }
    sendHtml(res, 200, pageHtml(serverPath, transports))
  })
}
