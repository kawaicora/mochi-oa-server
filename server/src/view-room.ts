/**
 * /view/room —— 服务端网页端「会议大厅 + 通话」，作为客户端的前端替代。
 *
 * 功能：
 *   1. 网页端登录（账号+密码 → auth:login 明文；或 URL ?token= 直接进入）
 *      · 登录时即判定 SERVER_ADMIN：非服务器管理员不允许进入会议大厅
 *   2. 展示所有进行中的会议/通话（conf 会议、group 群通话、dm 私聊通话）——rtc:listRooms + rtc:roomsChanged 实时刷新
 *   3. 加入：可选 仅语音 / 摄像头(音视频) / 共享屏幕(音视频+屏幕)
 *   4. 通话界面照抄客户端 RtcCallRoom：顶部栏(会议号/计时/会议信息) + 中央九宫格(本地/远端 tiles、点击放大、全屏)
 *      底部控制栏(静音/摄像头/共享/聊天/参会者/会议信息/录制/设备面板) + 聊天/参会者面板 + 会议信息浮层
 *      右键切换设备(麦克风/摄像头菜单) + 语音画面样式(头像+频谱 / 滚动频谱) + 录制(MediaRecorder 下载)
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
input,select,button{outline:none;font-family:inherit}
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
.pick-pass{display:flex;gap:8px}
.pick-pass input{flex:1}
.modal-btns{display:flex;gap:10px;margin-top:18px}
.modal-btns .btn{margin-top:0;flex:1}

/* ═══ 通话界面（照抄客户端 RtcCallRoom） ═══ */
.call-root{height:100vh;display:flex;flex-direction:column;background:#0d1117;overflow:hidden;position:relative}
.top-bar{height:44px;flex-shrink:0;display:flex;align-items:center;padding:0 12px;background:#0d1117;gap:8px}
.top-btn{background:transparent;border:none;color:#cfd3dc;font-size:15px;cursor:pointer;width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center}
.top-btn:hover{background:rgba(255,255,255,.08)}
.close-btn:hover{background:#e81123;color:#fff}
.timer{display:flex;align-items:baseline;gap:6px;color:#cfd3dc}
.timer-time{font-size:14px;font-variant-numeric:tabular-nums}
.timer-sub{font-size:12px;color:#8a8f99}
.meeting-no{margin-left:12px;color:#cfd3dc;font-size:13px;cursor:pointer;user-select:none;padding:4px 10px;border:1px solid #2d2d44;border-radius:6px;background:rgba(255,255,255,.04)}
.meeting-no:hover{border-color:#1677ff;color:#fff}
.top-right{margin-left:auto;display:flex;align-items:center;gap:4px}
.meeting-info{position:absolute;top:48px;left:12px;background:#1a1a2e;border:1px solid #2d2d44;border-radius:8px;padding:12px 14px;color:#e6e6e6;font-size:13px;z-index:20;min-width:220px}
.info-title{font-weight:600;margin-bottom:8px}
.info-row{margin:4px 0;color:#b8bcc6}
.center-area{flex:1;min-height:0;position:relative;background:#0d1117;display:flex;flex-direction:column}
.video-grid{flex:1;min-height:0;overflow:auto;display:grid;gap:12px;padding:16px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));align-content:center}
.tile{position:relative;aspect-ratio:16/9;background:#1a1a2e;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer}
.tile video{width:100%;height:100%;object-fit:cover}
.tile.focused{outline:2px solid #1677ff}
.tile-avatar{display:flex;align-items:center;justify-content:center}
.avatar-face{position:relative;width:96px;height:96px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#23304f;color:#a9c0ff;font-size:38px;font-weight:600}
.avatar-face img{width:100%;height:100%;object-fit:cover}
.tile-name{position:absolute;left:8px;bottom:6px;color:#fff;font-size:12px;background:rgba(0,0,0,.45);padding:2px 8px;border-radius:4px;z-index:5}
.tile-fs{position:absolute;right:8px;top:8px;width:28px;height:28px;border:none;border-radius:6px;background:rgba(0,0,0,.5);color:#fff;font-size:13px;cursor:pointer;z-index:5}
.tile-fs:hover{background:#1677ff}
.who-am-i{padding:4px 16px;color:#8a8f99;font-size:12px;flex-shrink:0}
.focus-overlay{position:absolute;inset:0;z-index:30;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center}
.focus-overlay video{width:100%;height:100%;object-fit:contain}
.focus-avatar{display:flex;align-items:center;justify-content:center}
.focus-name{position:absolute;left:16px;bottom:16px;color:#fff;font-size:14px}
.focus-btns{position:absolute;top:14px;right:14px;display:flex;gap:8px}
.focus-btn{width:34px;height:34px;border:none;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font-size:15px;cursor:pointer}
.focus-btn:hover{background:#1677ff}
.side-panel{position:absolute;top:52px;right:12px;width:280px;max-height:calc(100% - 130px);background:#1a1a2e;border:1px solid #2d2d44;border-radius:8px;z-index:25;display:flex;flex-direction:column;overflow:hidden}
.panel-title{font-weight:600;font-size:14px;padding:12px 14px 8px;color:#e6e6e6}
.chat-list{flex:1;overflow-y:auto;padding:8px 14px;min-height:80px}
.chat-msg{margin-bottom:10px}
.chat-head{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.chat-nick{font-size:11px;color:#8a8f99}
.chat-bubble{background:#2d2d44;color:#e6e6e6;padding:6px 10px;border-radius:8px;font-size:13px;word-break:break-word;display:inline-block}
.chat-msg.mine{text-align:right}
.chat-msg.mine .chat-head{justify-content:flex-end}
.chat-msg.mine .chat-bubble{background:#1677ff;color:#fff}
.chat-input-row{display:flex;gap:6px;padding:8px 14px 12px;border-top:1px solid #2d2d44}
.chat-input-row input{flex:1;background:#0d1117;border:1px solid #2d2d44;border-radius:6px;padding:7px 10px;color:#e6e6e6;font-size:13px}
.chat-send{background:#1677ff;border:none;color:#fff;width:36px;border-radius:6px;cursor:pointer}
.participant-row{display:flex;align-items:center;gap:10px;padding:8px 14px}
.participant-name{flex:1;font-size:13px}
.participant-status{font-size:11px;color:#8a8f99}
.dev-panel-wrap{position:absolute;top:48px;right:12px;z-index:20}
.device-panel{width:300px;background:#1a1a2e;border:1px solid #2d2d44;border-radius:8px;padding:12px 14px;color:#e6e6e6;font-size:13px;z-index:20}
.dev-row{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.dev-row label{color:#8a8f99;font-size:12px}
.dev-row select{background:#0d1117;border:1px solid #2d2d44;border-radius:6px;color:#e6e6e6;font-size:13px;padding:6px 8px}
.dev-hint{color:#6b7280;font-size:11px;margin-bottom:10px}
.dev-actions{display:flex;justify-content:flex-end}
.dev-apply{background:#1677ff;border:none;color:#fff;padding:7px 20px;border-radius:6px;font-size:13px;cursor:pointer}
.dev-apply:hover{background:#3a8aff}
.control-bar{height:64px;flex-shrink:0;display:flex;align-items:center;justify-content:center;gap:10px;background:rgba(13,17,23,.92);padding:0 16px;position:relative;z-index:10}
.ctrl{background:#2d2d44;border:none;color:#e6e6e6;width:42px;height:42px;border-radius:50%;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative}
.ctrl:hover{background:#3a3a55}
.ctrl.danger{background:#e81123}
.ctrl.on{background:#1677ff}
.ctrl.sharing{background:#1677ff}
.ctrl.rec.on{color:#e81123}
.ctrl.hangup{width:auto;border-radius:22px;padding:0 18px;gap:6px}
.ctrl.hangup{background:#ff7d00}
.ctrl.hangup:hover{background:#ff9033}
.ctrl .hangup-text{font-size:14px}
.dev-pop{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);min-width:220px;max-width:320px;background:#1a1a2e;border:1px solid #2d2d44;border-radius:8px;padding:6px;color:#e6e6e6;font-size:13px;z-index:50;max-height:320px;overflow-y:auto}
.dev-pop-title{font-size:12px;color:#8a8f99;padding:4px 8px 6px}
.dev-pop-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 10px;border-radius:6px;border:none;background:transparent;color:#e6e6e6;font-size:13px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dev-pop-item:hover{background:rgba(255,255,255,.08)}
.dev-pop-item.cur{color:#1677ff}
.dev-pop-empty{padding:8px;color:#6b7280;font-size:12px;border:none;background:transparent}
.rec-toast{position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:rgba(22,27,34,.95);color:#e6e6e6;font-size:13px;padding:8px 16px;border-radius:8px;border:1px solid #2d2d44;z-index:80;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.spec-menu-trigger{position:absolute;inset:0;z-index:6}
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

<!-- ═══ 通话界面（照抄客户端 RtcCallRoom） ═══ -->
<div id="view-call" class="call-root" style="display:none">
  <!-- 顶部栏 -->
  <div class="top-bar">
    <button class="top-btn" id="btn-info" title="会议信息">ℹ</button>
    <div class="timer"><span class="timer-time" id="call-timer">00:00</span><span class="timer-sub">(60分钟)</span></div>
    <span class="meeting-no" id="call-no" title="点击复制会议号"></span>
    <div class="top-right">
      <button class="top-btn" id="btn-view" title="视图">▦</button>
      <button class="top-btn" id="btn-min" title="最小化">−</button>
      <button class="top-btn" id="btn-max" title="最大化">□</button>
      <button class="top-btn close-btn" id="btn-close" title="关闭">✕</button>
    </div>
  </div>

  <!-- 会议信息浮层 -->
  <div id="meeting-info" class="meeting-info" style="display:none">
    <div class="info-title">会议信息</div>
    <div class="info-row">会议号：<span id="mi-no"></span></div>
    <div class="info-row">主题：<span id="mi-title"></span></div>
    <div class="info-row">状态：<span id="mi-status"></span></div>
  </div>

  <!-- 设备面板（更多菜单） -->
  <div id="dev-panel" class="dev-panel-wrap" style="display:none">
    <div class="device-panel">
      <div class="dev-hint">选择音视频设备，点击「应用」生效</div>
      <div class="dev-row"><label>麦克风</label><select id="dev-mic"></select></div>
      <div class="dev-row"><label>扬声器</label><select id="dev-out"></select></div>
      <div class="dev-row"><label>摄像头</label><select id="dev-cam"></select></div>
      <div class="dev-actions"><button class="dev-apply" id="dev-apply">应用</button></div>
    </div>
  </div>

  <!-- 中央视频区 -->
  <div class="center-area">
    <div class="video-grid" id="call-grid"></div>
    <div class="who-am-i" id="who-am-i">我：—</div>

    <!-- 点击放大视图 -->
    <div id="focus-overlay" class="focus-overlay" style="display:none">
      <div id="focus-body"></div>
      <div class="focus-name" id="focus-name"></div>
      <div class="focus-btns">
        <button class="focus-btn" id="focus-close" title="关闭">✕</button>
        <button class="focus-btn" id="focus-fs" title="全屏">⛶</button>
      </div>
    </div>
  </div>

  <!-- 聊天面板 -->
  <div id="chat-panel" class="side-panel" style="display:none">
    <div class="panel-title">聊天</div>
    <div class="chat-list" id="chat-list"></div>
    <div class="chat-input-row">
      <input id="chat-input" placeholder="发送消息">
      <button class="chat-send" id="chat-send">➤</button>
    </div>
  </div>

  <!-- 参会者面板 -->
  <div id="participants-panel" class="side-panel" style="display:none">
    <div class="panel-title">参会者（<span id="participant-count">1</span>）</div>
    <div id="participant-list"></div>
  </div>

  <!-- 底部控制栏 -->
  <div class="control-bar">
    <button class="ctrl" id="ctrl-mute" title="左键静音/解除静音，右键切换麦克风">🎤</button>
    <button class="ctrl" id="ctrl-cam" title="左键开关摄像头，右键切换摄像头">📷</button>
    <button class="ctrl" id="ctrl-shield" title="安全">🛡</button>
    <button class="ctrl" id="ctrl-invite" title="邀请/复制会议号">👥</button>
    <button class="ctrl" id="ctrl-users" title="参会者">👤</button>
    <button class="ctrl" id="ctrl-screen" title="共享屏幕">🖥</button>
    <button class="ctrl" id="ctrl-chat" title="聊天">💬</button>
    <button class="ctrl rec" id="ctrl-rec" title="录制">●</button>
    <button class="ctrl" id="ctrl-ai" title="AI听记">🤖</button>
    <button class="ctrl" id="ctrl-more" title="更多（音视频设备）">⋯</button>
    <button class="ctrl hangup" id="ctrl-hangup" title="结束"><span>📞</span><span class="hangup-text">结束</span></button>
  </div>

  <!-- 语音画面样式菜单 -->
  <div id="spec-menu" class="dev-pop" style="display:none">
    <div class="dev-pop-title">语音画面样式</div>
    <button class="dev-pop-item" id="spec-avatar">👤 头像 + 频谱</button>
    <button class="dev-pop-item" id="spec-scroll">〰 滚动频谱</button>
  </div>

  <!-- 麦克风设备菜单 -->
  <div id="mic-menu" class="dev-pop" style="display:none">
    <div class="dev-pop-title">麦克风</div>
    <div id="mic-menu-items"></div>
  </div>

  <!-- 摄像头设备菜单 -->
  <div id="cam-menu" class="dev-pop" style="display:none">
    <div class="dev-pop-title">摄像头</div>
    <div id="cam-menu-items"></div>
  </div>

  <!-- 轻提示 -->
  <div id="rec-toast" class="rec-toast" style="display:none"></div>
</div>

<script>
// ═══ 服务器配置 ═══
const SERVER_PATH = ${JSON.stringify(serverPath)};
const CONFIG_TRANSPORTS = ${JSON.stringify(transports)};

// ═══ 全局状态 ═══
const $ = (id) => document.getElementById(id);
let sock = null;
let token = localStorage.getItem('vr_token') || '';
let myUser = null;
let myNick = '我';
let myAvatar = '';
let rooms = [];
let currentRoom = null;
let peers = [];
let remoteStreams = {};
let engine = null;
let localStream = null;        // 当前本端媒体流（音频 + 当前视频轨）
let callTimer = null;
let callSeconds = 0;
let isMuted = false;
let isCameraOff = true;        // 默认摄像头关闭（视频轨=频谱占位）
let isScreenSharing = false;
let isRecording = false;
let spectrumStyle = 'avatar';  // avatar | scroll
let focusedKey = null;         // 放大的 tile key
let micDevices = [], camDevices = [], outDevices = [];
let currentMic = 'default', currentCam = 'default';
let connectionState = 'connecting';
let showChat = false, showParticipants = false, showMeetingInfo = false, showDevices = false;
const joinMode = { val: 'mic' };
let chatMessages = [];
let recorder = null;
let recChunks = [];
let toastTimer = null;
let myUserId = 0;

// ═══ socket.io ═══
function connect() {
  if (sock) { sock.disconnect(); sock = null; }
  sock = io(location.origin, { path: SERVER_PATH, transports: CONFIG_TRANSPORTS, auth: token ? { token, device: 'web-room' } : { device: 'web-room' } });
  sock.on('connect_error', (e) => { console.warn('[view/room] connect_error', e && e.message); });
  sock.on('disconnect', (r) => { console.warn('[view/room] disconnect', r); if (!token) showLogin(); });
  sock.on('auth:sessionRevoked', () => { token = ''; localStorage.removeItem('vr_token'); showLogin(); });
  sock.on('rtc:roomsChanged', () => { if (viewNow() === 'list') loadRooms(); });
  sock.on('rtc:peerJoined', (d) => { if (currentRoom && d.room === currentRoom.id) { upsertPeer(d.peer); engine && engine.addPeer(d.peer.userId); } });
  sock.on('rtc:peerLeft', (d) => { if (currentRoom && d.room === currentRoom.id) { const p = peers.find((x) => x.socketId === d.peerId); if (p) { engine && engine.closePeer(p.userId); delete remoteStreams[p.userId]; peers = peers.filter((x) => x.socketId !== d.peerId); renderGrid(); } } });
  sock.on('rtc:signal', (d) => { if (currentRoom && d.room === currentRoom.id) engine && engine.handleSignal(d.from.userId, d.signal); });
  sock.on('rtc:ended', (d) => { if (currentRoom && d.room === currentRoom.id) { alert('会议已结束'); leaveCall(true); } });
  sock.on('rtc:chatMessage', (d) => { if (currentRoom && d.room === currentRoom.id && d.from.userId !== myUserId) { pushChat(d.from.nick || '用户', d.content, false, d.from.avatar); } });
}
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
    if (!ack.serverAdmin) { token = ''; localStorage.removeItem('vr_token'); showNoPerm(); return; }
    token = ack.token; localStorage.setItem('vr_token', token);
    myUser = ack.user; myNick = ack.user.nick || ack.user.username; myAvatar = ack.user.avatar || ''; myUserId = ack.user.id;
    enterList();
  } catch (e) { showErr(e instanceof Error ? e.message : '登录失败'); }
}
function showErr(m) { $('login-err').textContent = m; $('login-err').style.display = ''; }
async function enterList() {
  $('who').textContent = myNick;
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
document.querySelectorAll('.pick').forEach((p) => { p.onclick = async () => { setPick(p.dataset.mode); await updatePreview(); }; });
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
  } catch (e) { localStream = null; box.textContent = '未检测到该设备（仍可加入，进入后可用其它设备或共享屏幕）'; }
}
function stopPreview() {
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  $('join-preview').innerHTML = '';
}
async function acquireStream(mode) {
  if (mode === 'mic') return navigator.mediaDevices.getUserMedia({ audio: true });
  if (mode === 'cam') return navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } });
  try { return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { return navigator.mediaDevices.getDisplayMedia({ video: true }); }
}
$('join-cancel').onclick = () => { $('view-join').style.display = 'none'; stopPreview(); localStream = null; };
$('join-go').onclick = () => { if (joinTarget) doJoin(joinTarget); };
async function doJoin(r) {
  const password = $('join-pass').value || undefined;
  try {
    if (!localStream) {
      try { localStream = await acquireStream(joinMode.val); }
      catch { localStream = null; }
    }
    const ack = await emitAck('rtc:join', { roomId: r.id, password, kind: r.kind });
    if (!ack.ok) { alert(ack.error || '加入失败'); return; }
    enterCall(ack.room, ack.peers || [], ack.iceServers || [], ack.kind);
  } catch (e) { alert(e instanceof Error ? e.message : '加入失败'); }
}

// ═══ 频谱：头像+频谱（1024 FFT 左右声道半圆环） ═══
function avatarSpecCanvas(mic, size) {
  size = size || 160;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  let ctx = null, src = null, split = null, aL = null, aR = null;
  let dL = new Uint8Array(0), dR = new Uint8Array(0), raf = 0;
  const track = mic.getAudioTracks()[0];
  if (!track) return canvas;
  try {
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(new MediaStream([track]));
    split = ctx.createChannelSplitter(2);
    src.connect(split);
    aL = ctx.createAnalyser(); aL.fftSize = 1024; aL.smoothingTimeConstant = 0.8;
    aR = ctx.createAnalyser(); aR.fftSize = 1024; aR.smoothingTimeConstant = 0.8;
    split.connect(aL, 0); split.connect(aR, 1);
    dL = new Uint8Array(aL.frequencyBinCount); dR = new Uint8Array(aR.frequencyBinCount);
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { return canvas; }
  function half(data, sa, ea, inner, outer, color) {
    const n = Math.min(data.length, 64);
    for (let i = 0; i < n; i++) {
      const v = data[i] / 255;
      const len = inner + v * (outer - inner);
      const a = sa + (i / n) * (ea - sa);
      g.strokeStyle = color.replace('A', (0.35 + v * 0.65).toFixed(2));
      g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(size / 2 + Math.cos(a) * inner, size / 2 + Math.sin(a) * inner); g.lineTo(size / 2 + Math.cos(a) * len, size / 2 + Math.sin(a) * len); g.stroke();
    }
  }
  function draw() {
    if (!aL || !aR) return;
    aL.getByteFrequencyData(dL); aR.getByteFrequencyData(dR);
    g.clearRect(0, 0, size, size);
    const inner = size / 2 - 13, outer = size / 2 - 3;
    half(dL, Math.PI / 2, (Math.PI * 3) / 2, inner, outer, 'rgba(56,132,255,A)');
    half(dR, -Math.PI / 2, Math.PI / 2, inner, outer, 'rgba(0,200,180,A)');
  }
  function loop() { draw(); raf = requestAnimationFrame(loop); }
  loop();
  canvas.__teardown = () => { cancelAnimationFrame(raf); if (src) src.disconnect(); if (split) split.disconnect(); if (aL) aL.disconnect(); if (aR) aR.disconnect(); if (ctx) ctx.close(); };
  return canvas;
}

// ═══ 频谱：滚动频谱 ═══
function scrollSpecCanvas(mic, w, h) {
  w = w || 640; h = h || 360;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  let ctx = null, src = null, an = null, raf = 0;
  const track = mic.getAudioTracks()[0];
  const trail = [];
  if (!track) return canvas;
  try {
    ctx = new AudioContext();
    src = ctx.createMediaStreamSource(new MediaStream([track]));
    an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.6;
    src.connect(an);
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { return canvas; }
  const data = new Uint8Array(an.frequencyBinCount);
  function draw() {
    an.getByteFrequencyData(data);
    trail.unshift(data.slice());
    if (trail.length > 96) trail.pop();
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < trail.length; x++) {
      const frame = trail[x];
      const xp = w - x * (w / 96);
      for (let y = 0; y < frame.length; y += 4) {
        const v = frame[y] / 255;
        if (v > 0.02) {
          const yp = h - (y / frame.length) * h;
          g.fillStyle = 'hsla(' + (260 - v * 260) + ',100%,' + (30 + v * 50) + '%,' + (0.15 + v * 0.7) + ')';
          g.fillRect(xp - 2, yp, 3, h / frame.length * 3 + 1);
        }
      }
    }
  }
  function loop() { draw(); raf = requestAnimationFrame(loop); }
  loop();
  canvas.__teardown = () => { cancelAnimationFrame(raf); if (src) src.disconnect(); if (an) an.disconnect(); if (ctx) ctx.close(); };
  return canvas;
}
function canvasStream(canvas, fps) {
  try { return canvas.captureStream(fps || 30); } catch (e) { return null; }
}

// ═══ 本地媒体流管理（等价 VideoStream） ═══
function spectrumVideoTrack() {
  if (!localStream) return null;
  const micOnly = new MediaStream((localStream.getAudioTracks().length ? [localStream.getAudioTracks()[0]] : []));
  let canvas;
  if (spectrumStyle === 'scroll') canvas = scrollSpecCanvas(micOnly, 640, 360);
  else canvas = avatarSpecCanvas(micOnly, 160);
  const s = canvasStream(canvas);
  const t = s && s.getVideoTracks()[0] ? s.getVideoTracks()[0] : null;
  if (t) t.__specCanvas = canvas;
  return t;
}
async function getAudioStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({ audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true });
}
async function getCameraStream(deviceId) {
  const opts = { video: { width: 1280, height: 720 } };
  if (deviceId && deviceId !== 'default') opts.video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia(opts);
}
async function getScreenStream() {
  try { return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { return navigator.mediaDevices.getDisplayMedia({ video: true }); }
}
function updateLocalVideo(track) {
  const audio = localStream.getAudioTracks();
  const arr = audio.slice();
  if (track) arr.push(track);
  localStream = new MediaStream(arr);
  renderGrid();
  engine && engine.replaceTrack(track, 'video');
}
function updateLocalAudio(track) {
  const video = localStream.getVideoTracks();
  const arr = video.slice();
  if (track) arr.push(track);
  localStream = new MediaStream(arr);
  engine && engine.replaceTrack(track, 'audio');
}

// ═══ RtcEngine（照抄客户端） ═══
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
  startRecording() { this.recorder = null; this.recChunks = []; }
  stopRecording() { return Promise.resolve(null); }
}
function toIce(ices) { return (ices || []).map((i) => ({ urls: i.urls, username: i.username, credential: i.credential })); }
function stereo(sdp) { return (sdp || '').replace(/(a=fmtp:111 .*)/g, (line) => (/stereo=1/.test(line) ? line : line + ';stereo=1;sprop-stereo=1')); }

// ═══ 进入房间 ═══
function enterCall(room, roomPeers, iceServers, _kind) {
  currentRoom = room; peers = roomPeers || []; remoteStreams = {};
  $('view-join').style.display = 'none';
  $('view-login').style.display = 'none'; $('view-list').style.display = 'none'; $('view-noperm').style.display = 'none';
  $('view-call').style.display = '';
  const no = room.meetingNo || room.id;
  $('call-no').textContent = '会议号：' + no;
  $('mi-no').textContent = no;
  $('mi-title').textContent = room.title || '视频会议';
  $('mi-status').textContent = '已连接';
  connectionState = 'connected';
  $('who-am-i').textContent = '我：' + myNick;

  // 本地流：麦克风 + 频谱占位视频轨
  const audioStream = localStream && localStream.getAudioTracks().length ? localStream : null;
  if (audioStream) {
    // 保留加入时选的麦克风轨；摄像头/共享的轨迹替换为频谱占位
    const mic = new MediaStream(audioStream.getAudioTracks());
    let vtrack = null;
    if (joinMode.val === 'cam') { vtrack = localStream.getVideoTracks()[0] || null; isCameraOff = false; }
    else if (joinMode.val === 'screen') { vtrack = localStream.getVideoTracks()[0] || null; isScreenSharing = true; }
    if (!vtrack) { vtrack = spectrumVideoTrack(); isCameraOff = true; }
    localStream = new MediaStream([...(vtrack ? [vtrack] : []), ...mic.getTracks()]);
  } else {
    localStream = new MediaStream();
    const mic = navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => new MediaStream());
    mic.then((m) => {
      m.getAudioTracks().forEach((t) => localStream.addTrack(t));
      engine && engine.replaceTrack(localStream.getAudioTracks()[0], 'audio');
    });
    const vtrack = spectrumVideoTrack();
    if (vtrack) localStream.addTrack(vtrack);
    isCameraOff = true;
  }

  renderGrid();
  engine = new RtcEngine({
    roomId: room.id, iceServers, localStream,
    onSignal: (sig) => { sock.emit('rtc:signal', { roomId: room.id, signal: sig }); },
    onRemote: (userId, s) => { remoteStreams[userId] = s; renderGrid(); },
    onDisconnect: (userId) => { delete remoteStreams[userId]; peers = peers.filter((p) => p.userId !== userId); renderGrid(); }
  });
  roomPeers.forEach((p) => engine.addPeer(p.userId));

  callSeconds = 0; $('call-timer').textContent = '00:00';
  if (callTimer) clearInterval(callTimer);
  callTimer = setInterval(() => { callSeconds++; $('call-timer').textContent = fmt(callSeconds); }, 1000);
  isMuted = false;
  refreshBar();
  closeAllPanels();
}

// ═══ 九宫格渲染 ═══
function hasVideo(s) { const t = s && s.getVideoTracks()[0]; return !!t && t.readyState !== 'ended'; }
function makeFace(nick, avatar, size, cls) {
  const d = document.createElement('div'); d.className = cls || 'tile-avatar';
  const f = document.createElement('div'); f.className = 'avatar-face'; f.style.width = size + 'px'; f.style.height = size + 'px';
  if (avatar) { const im = document.createElement('img'); im.src = avatar; im.onerror = () => { f.innerHTML = ''; f.textContent = (nick || '?').charAt(0); }; f.appendChild(im); }
  else f.textContent = (nick || '?').charAt(0);
  d.appendChild(f);
  return d;
}
function renderGrid() {
  const grid = $('call-grid');
  grid.innerHTML = '';
  // 本地 "我"
  const me = document.createElement('div'); me.className = 'tile' + (focusedKey === 'me' ? ' focused' : '');
  if (hasVideo(localStream)) { const v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = localStream; me.appendChild(v); }
  else me.appendChild(makeFace(myNick, myAvatar, 96));
  const mn = document.createElement('div'); mn.className = 'tile-name'; mn.textContent = '我：' + myNick; me.appendChild(mn);
  const mfs = document.createElement('button'); mfs.className = 'tile-fs'; mfs.title = '全屏'; mfs.textContent = '⛶'; mfs.onclick = (ev) => { ev.stopPropagation(); fullscreenEl(me); }; me.appendChild(mfs);
  me.onclick = () => { focusedKey = 'me'; renderGrid(); showFocus('me'); };
  me.oncontextmenu = (ev) => { ev.preventDefault(); toggleSpecMenu(); };
  grid.appendChild(me);
  // 远端
  peers.forEach((p) => {
    const t = document.createElement('div'); t.className = 'tile' + (focusedKey === p.socketId ? ' focused' : '');
    const rs = remoteStreams[p.userId];
    if (hasVideo(rs)) { const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.srcObject = rs; t.appendChild(v); }
    else t.appendChild(makeFace(p.nick, p.avatar, 96));
    const n = document.createElement('div'); n.className = 'tile-name'; n.textContent = p.nick; t.appendChild(n);
    const fs = document.createElement('button'); fs.className = 'tile-fs'; fs.title = '全屏'; fs.textContent = '⛶'; fs.onclick = (ev) => { ev.stopPropagation(); fullscreenEl(t); }; t.appendChild(fs);
    t.onclick = () => { focusedKey = p.socketId; renderGrid(); showFocus(p.socketId); };
    grid.appendChild(t);
  });
  renderParticipants();
}
function upsertPeer(p) {
  const idx = peers.findIndex((x) => x.userId === p.userId);
  if (idx >= 0) peers[idx] = p; else peers.push(p);
  renderGrid();
}
function focusedPeer() { return focusedKey ? peers.find((p) => p.socketId === focusedKey) || null : null; }
function showFocus(key) {
  const ov = $('focus-overlay'); const body = $('focus-body'); const name = $('focus-name');
  body.innerHTML = '';
  if (key === 'me') {
    if (hasVideo(localStream)) { const v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = localStream; body.appendChild(v); }
    else body.appendChild(makeFace(myNick, myAvatar, 180, 'focus-avatar'));
    name.textContent = '我：' + myNick;
  } else {
    const p = focusedPeer();
    if (p) {
      if (hasVideo(remoteStreams[p.userId])) { const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.srcObject = remoteStreams[p.userId]; body.appendChild(v); }
      else body.appendChild(makeFace(p.nick, p.avatar, 180, 'focus-avatar'));
      name.textContent = p.nick;
    }
  }
  ov.style.display = '';
}
function closeFocus() { focusedKey = null; $('focus-overlay').style.display = 'none'; renderGrid(); }
function fullscreenEl(el) {
  if (document.fullscreenElement === el) { document.exitFullscreen().catch(() => {}); return; }
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}
function fmt(s) { const mm = String(Math.floor(s / 60)).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0'); return mm + ':' + ss; }

// ═══ 通话控制 ═══
function refreshBar() {
  $('ctrl-mute').classList.toggle('danger', isMuted);
  $('ctrl-mute').innerHTML = isMuted ? '🔇' : '🎤';
  $('ctrl-cam').classList.toggle('danger', isCameraOff);
  $('ctrl-cam').innerHTML = isCameraOff ? '🚫' : '📷';
  $('ctrl-screen').classList.toggle('sharing', isScreenSharing);
  $('ctrl-rec').classList.toggle('on', isRecording);
}
function toggleMute() {
  isMuted = !isMuted;
  const t = localStream && localStream.getAudioTracks()[0];
  if (t) t.enabled = !isMuted;
  refreshBar();
}
async function toggleCamera() {
  try {
    if (isCameraOff) {
      const camStream = await getCameraStream();
      const track = camStream.getVideoTracks()[0] || null;
      updateLocalVideo(track); isCameraOff = false; isScreenSharing = false;
    } else {
      const track = spectrumVideoTrack();
      updateLocalVideo(track); isCameraOff = true; isScreenSharing = false;
    }
    refreshBar(); renderGrid();
  } catch (e) { toast('切换摄像头失败'); }
}
async function toggleScreenShare() {
  if (!engine) return;
  try {
    if (isScreenSharing) {
      let track = null;
      if (!isCameraOff) { const c = await getCameraStream().catch(() => null); track = c ? c.getVideoTracks()[0] || null : null; }
      if (!track) track = spectrumVideoTrack();
      updateLocalVideo(track); isScreenSharing = false;
    } else {
      const ss = await getScreenStream();
      const track = ss.getVideoTracks()[0] || null;
      if (!track) throw new Error('未获取到屏幕画面');
      updateLocalVideo(track); isScreenSharing = true;
      track.onended = () => { isScreenSharing = false; refreshBar(); };
    }
    refreshBar(); renderGrid();
  } catch (e) { toast('屏幕共享切换失败'); }
}
async function toggleRecording() {
  if (!engine) return;
  if (isRecording) { await stopRecording(); return; }
  try {
    const micT = localStream && localStream.getAudioTracks()[0];
    const videoT = localStream && localStream.getVideoTracks()[0];
    if (!micT && !videoT) { toast('录制启动失败（未获取到音视频流）'); return; }
    const ms = new MediaStream([...(micT ? [micT] : []), ...(videoT ? [videoT] : [])]);
    recorder = new MediaRecorder(ms);
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.start();
    isRecording = true; refreshBar(); toast('正在录制…');
  } catch (e) { toast('录制启动失败'); }
}
async function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
    await new Promise((res) => { recorder.onstop = res; });
  }
  isRecording = false; refreshBar();
  if (recChunks.length) {
    const blob = new Blob(recChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = '通话录制-' + (currentRoom && (currentRoom.meetingNo || currentRoom.id)) + '-' + Date.now() + '.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('录制已保存（webm），已在下载');
  }
  recorder = null; recChunks = [];
}
async function leaveCall(_ended) {
  if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
  if (callTimer) { clearInterval(callTimer); callTimer = null; }
  if (engine) { if (currentRoom && !_ended) sock.emit('rtc:leave', { roomId: currentRoom.id }); engine.closeAll(); engine = null; }
  if (localStream) { localStream.getTracks().forEach((t) => { if (t.__specCanvas) { try { t.__specCanvas.__teardown && t.__specCanvas.__teardown(); } catch {} } t.stop(); }); localStream = null; }
  currentRoom = null; peers = []; remoteStreams = {}; isRecording = false; isScreenSharing = false;
  closeAllPanels(); $('focus-overlay').style.display = 'none';
  $('view-call').style.display = 'none';
  $('view-login').style.display = 'none'; $('view-list').style.display = ''; $('view-noperm').style.display = 'none';
  loadRooms();
}
function closeAllPanels() {
  $('chat-panel').style.display = 'none'; $('participants-panel').style.display = 'none'; $('meeting-info').style.display = 'none'; $('dev-panel').style.display = 'none';
  $('spec-menu').style.display = 'none'; $('mic-menu').style.display = 'none'; $('cam-menu').style.display = 'none';
  showChat = false; showParticipants = false; showMeetingInfo = false; showDevices = false;
}

// ═══ 面板：会议信息 / 参会者 / 聊天 / 设备 ═══
$('btn-info').onclick = () => { showMeetingInfo = !showMeetingInfo; $('meeting-info').style.display = showMeetingInfo ? '' : 'none'; if (showMeetingInfo) { closeSideOther(); } };
function closeSideOther() { $('chat-panel').style.display = 'none'; showChat = false; $('participants-panel').style.display = 'none'; showParticipants = false; }
$('ctrl-users').onclick = () => { showParticipants = !showParticipants; $('participants-panel').style.display = showParticipants ? '' : 'none'; if (showParticipants) { closeSideOther(); $('meeting-info').style.display = 'none'; showMeetingInfo = false; renderParticipants(); } };
function renderParticipants() {
  $('participant-count').textContent = peers.length + 1;
  const list = $('participant-list');
  list.innerHTML = '';
  const me = document.createElement('div'); me.className = 'participant-row';
  me.innerHTML = '<div class="avatar-face" style="width:32px;height:32px;font-size:13px">' + (myAvatar ? '<img src="' + esc(myAvatar) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">' : esc((myNick || '我').charAt(0))) + '</div><span class="participant-name">我：' + esc(myNick) + '</span><span class="participant-status">主持人</span>';
  list.appendChild(me);
  peers.forEach((p) => {
    const r = document.createElement('div'); r.className = 'participant-row';
    r.innerHTML = '<div class="avatar-face" style="width:32px;height:32px;font-size:13px">' + (p.avatar ? '<img src="' + esc(p.avatar) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">' : esc((p.nick || '?').charAt(0))) + '</div><span class="participant-name">' + esc(p.nick) + '</span><span class="participant-status">在线</span>';
    list.appendChild(r);
  });
}
$('ctrl-chat').onclick = () => { showChat = !showChat; $('chat-panel').style.display = showChat ? '' : 'none'; if (showChat) { closeSideOther(); $('meeting-info').style.display = 'none'; showMeetingInfo = false; scrollChat(); } };
function pushChat(nick, content, mine, avatar) {
  chatMessages.push({ nick, content, mine, avatar });
  renderChat(); scrollChat();
}
function renderChat() {
  const list = $('chat-list');
  list.innerHTML = '';
  chatMessages.forEach((m) => {
    const d = document.createElement('div'); d.className = 'chat-msg' + (m.mine ? ' mine' : '');
    const av = m.avatar ? '<img src="' + esc(m.avatar) + '" style="width:22px;height:22px;border-radius:50%;object-fit:cover">' : '<span>' + esc((m.nick || '?').charAt(0)) + '</span>';
    d.innerHTML = '<div class="chat-head"><div class="avatar-face" style="width:22px;height:22px;font-size:11px">' + av + '</div><div class="chat-nick">' + esc(m.nick) + '</div></div><div class="chat-bubble">' + esc(m.content) + '</div>';
    list.appendChild(d);
  });
}
function scrollChat() { const l = $('chat-list'); l.scrollTop = l.scrollHeight; }
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text || !currentRoom) return;
  $('chat-input').value = '';
  const ack = await emitAck('rtc:chatMessage', { roomId: currentRoom.id, content: text }).catch(() => ({ ok: false }));
  if (ack.ok) pushChat(myNick, text, true, myAvatar);
}
$('ctrl-more').onclick = async () => {
  showDevices = !showDevices; $('dev-panel').style.display = showDevices ? '' : 'none';
  if (showDevices) { closeSideOther(); $('meeting-info').style.display = 'none'; showMeetingInfo = false; await refreshDeviceSelects(); }
};
async function refreshDeviceSelects() {
  try { await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {}); } catch (e) {}
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  micDevices = all.filter((d) => d.kind === 'audioinput');
  outDevices = all.filter((d) => d.kind === 'audiooutput');
  camDevices = all.filter((d) => d.kind === 'videoinput');
  const selMic = $('dev-mic'), selOut = $('dev-out'), selCam = $('dev-cam');
  fillSel(selMic, micDevices, currentMic, '默认麦克风');
  fillSel(selOut, outDevices, '', '默认扬声器');
  fillSel(selCam, camDevices, currentCam, '默认摄像头');
}
function fillSel(sel, devices, cur, defLabel) {
  sel.innerHTML = '';
  const o = document.createElement('option'); o.value = 'default'; o.textContent = defLabel; sel.appendChild(o);
  devices.forEach((d) => { const op = document.createElement('option'); op.value = d.deviceId; op.textContent = d.label || d.deviceId; sel.appendChild(op); });
  sel.value = cur;
}
$('dev-apply').onclick = async () => {
  try {
    const audioIn = $('dev-mic').value;
    const audioOut = $('dev-out').value;
    const cam = $('dev-cam').value;
    if (audioIn && audioIn !== 'default') {
      const s = await getAudioStream(audioIn); const t = s.getAudioTracks()[0] || null;
      updateLocalAudio(t); currentMic = audioIn;
    }
    if (cam && cam !== 'default') {
      const s = await getCameraStream(cam); const t = s.getVideoTracks()[0] || null;
      updateLocalVideo(t); isCameraOff = false; isScreenSharing = false;
    } else if (cam === 'default') {
      const t = spectrumVideoTrack(); updateLocalVideo(t); isCameraOff = true; isScreenSharing = false;
    }
    if (audioOut && audioOut !== 'default' && typeof HTMLVideoElement.prototype.setSinkId === 'function') {
      document.querySelectorAll('video').forEach((el) => { el.setSinkId(audioOut).catch(() => {}); });
    }
    refreshBar(); renderGrid(); $('dev-panel').style.display = 'none'; showDevices = false;
  } catch (e) { toast('设备切换失败'); }
};

// ═══ 右键设备菜单（麦克风/摄像头） ═══
$('ctrl-mute').addEventListener('contextmenu', async (ev) => { ev.preventDefault(); await openMicMenu(); });
$('ctrl-cam').addEventListener('contextmenu', async (ev) => { ev.preventDefault(); await openCamMenu(); });
async function openMicMenu() {
  try { await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {}); } catch (e) {}
  micDevices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput');
  const items = $('mic-menu-items');
  items.innerHTML = '';
  items.appendChild(devItem('default', '🎤 系统默认', currentMic === 'default', () => switchMic('default')));
  if (micDevices.length === 0) { const e = document.createElement('button'); e.className = 'dev-pop-empty'; e.disabled = true; e.textContent = '未检测到麦克风'; items.appendChild(e); }
  micDevices.forEach((d) => items.appendChild(devItem(d.deviceId, '🎤 ' + (d.label || d.deviceId), currentMic === d.deviceId, () => switchMic(d.deviceId))));
  $('mic-menu').style.display = '';
}
async function openCamMenu() {
  try { await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {}); } catch (e) {}
  camDevices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
  const items = $('cam-menu-items');
  items.innerHTML = '';
  items.appendChild(devItem('default', '📷 系统默认', currentCam === 'default', () => switchCamera('default')));
  if (camDevices.length === 0) { const e = document.createElement('button'); e.className = 'dev-pop-empty'; e.disabled = true; e.textContent = '未检测到摄像头'; items.appendChild(e); }
  camDevices.forEach((d) => items.appendChild(devItem(d.deviceId, '📷 ' + (d.label || d.deviceId), currentCam === d.deviceId, () => switchCamera(d.deviceId))));
  $('cam-menu').style.display = '';
}
function devItem(id, label, cur, fn) {
  const b = document.createElement('button'); b.className = 'dev-pop-item' + (cur ? ' cur' : ''); b.textContent = label;
  b.onclick = fn; return b;
}
async function switchMic(deviceId) {
  $('mic-menu').style.display = 'none';
  try {
    const s = await getAudioStream(deviceId); const t = s.getAudioTracks()[0] || null;
    updateLocalAudio(t); currentMic = deviceId;
  } catch (e) { toast('麦克风切换失败'); }
}
async function switchCamera(deviceId) {
  $('cam-menu').style.display = 'none';
  try {
    let track;
    if (deviceId === 'default') { track = spectrumVideoTrack(); isCameraOff = true; isScreenSharing = false; }
    else { const s = await getCameraStream(deviceId); track = s.getVideoTracks()[0] || null; isCameraOff = false; isScreenSharing = false; }
    updateLocalVideo(track); currentCam = deviceId;
    refreshBar(); renderGrid();
  } catch (e) { toast('摄像头切换失败'); }
}

// ═══ 语音画面样式菜单 ═══
let specMenuShown = false;
function toggleSpecMenu() { specMenuShown = !specMenuShown; $('spec-menu').style.display = specMenuShown ? '' : 'none'; }
$('spec-avatar').onclick = () => { applySpec('avatar'); };
$('spec-scroll').onclick = () => { applySpec('scroll'); };
async function applySpec(style) {
  $('spec-menu').style.display = 'none'; specMenuShown = false;
  if (spectrumStyle === style) return;
  spectrumStyle = style;
  if (!isCameraOff || isScreenSharing) return; // 开着摄像头/共享时忽略
  const t = spectrumVideoTrack();
  updateLocalVideo(t);
  renderGrid();
}

// ═══ 其它控制栏 ═══
$('ctrl-hangup').onclick = () => { if (confirm('确定结束通话？')) leaveCall(false); };
$('btn-close').onclick = () => { leaveCall(false); };
$('btn-min').onclick = () => toast('浏览器环境不支持窗口最小化');
$('btn-max').onclick = () => { if (document.fullscreenEnabled) { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen().catch(() => {}); } else toast('浏览器环境不支持最大化'); };
$('btn-view').onclick = () => toast('视图布局：网格');
$('ctrl-shield').onclick = () => toast('会议安全：已加密');
$('ctrl-ai').onclick = () => toast('AI 听记：浏览器环境暂未启用');
$('ctrl-invite').onclick = copyMeetingNo;
$('call-no').onclick = copyMeetingNo;
function copyMeetingNo() {
  const no = currentRoom && (currentRoom.meetingNo || currentRoom.id);
  if (no && navigator.clipboard) { navigator.clipboard.writeText(no).catch(() => {}); toast('会议号已复制：' + no); }
}
$('focus-close').onclick = closeFocus;
$('focus-fs').onclick = () => fullscreenEl($('focus-overlay'));
$('focus-overlay').onclick = (ev) => { if (ev.target === ev.currentTarget) closeFocus(); };
document.addEventListener('click', (ev) => {
  const inMenu = ev.target.closest('.dev-pop');
  if (!inMenu) { $('spec-menu').style.display = 'none'; specMenuShown = false; $('mic-menu').style.display = 'none'; $('cam-menu').style.display = 'none'; }
});

// ═══ 轻提示 ═══
function toast(msg) {
  const t = $('rec-toast');
  t.textContent = msg; t.style.display = '';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3000);
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
  const q = new URLSearchParams(location.search);
  const urlToken = q.get('token') || '';
  if (urlToken) { token = urlToken; localStorage.setItem('vr_token', urlToken); }
  if (token) {
    try {
      connect();
      await new Promise((res, rej) => { sock.once('connect', res); sock.once('connect_error', rej); setTimeout(() => rej(new Error('连接超时')), 8000); });
      const ack = await emitAck('auth:me', {});
      if (ack.ok) {
        if (!ack.serverAdmin) { token = ''; localStorage.removeItem('vr_token'); showNoPerm(); return; }
        myUser = ack.user; myNick = ack.user.nick || ack.user.username; myAvatar = ack.user.avatar || ''; myUserId = ack.user.id;
        enterList(); return;
      }
      token = ''; localStorage.removeItem('vr_token'); showLogin();
    } catch { showLogin(); }
  } else { showLogin(); }
})();
</script>
</body>
</html>`
}

/** 从服务端 node_modules 提供 socket.io 客户端脚本 */
function ioClientJs(): Buffer | null {
  const candidates = [
    join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'),
    join(process.cwd(), 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js')
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p) } catch { /* 继续 */ }
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

    if (url.pathname !== ROOM_PAGE) return
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('仅支持 GET')
      return
    }
    sendHtml(res, 200, pageHtml(serverPath, transports))
  })
}
