# mochioa-server 客户端对接说明（Socket.IO + HTTP 上传）

本文档是给客户端（mochioa 桌面端）接入本服务端的完整事件清单。服务端地址：`http://<host>:3000`（Socket.IO 路径 `/socket.io`）。

---

## 0. 通用约定

- **传输**：`websocket` + `polling` 两种都启用；握手可用任一种。Cloudflare 只放行 HTTP 时服务端配 `TRANSPORTS=polling`。
- **Ack（回调）统一信封**：
  - 成功：`{ ok: true, ...业务字段 }`
  - 失败：`{ ok: false, error: "原因文案" }`
  - 所有「客户端→服务端」事件都可带回调 `cb(ack)`；不传也无妨。
- **鉴权**：大部分事件要求已登录；未登录回调 `{ ok:false, error:"未登录" }`。
- **在线自动加入房间**：登录后服务端自动把该 socket 加入「本人私信房间 `user:{id}`」和「所属全部群房间 `group:{id}`」，客户端**无需**手动 join/leave 群房间。发消息、收广播都直接按事件名来。

---

## 1. 连接与账号

### 连接

```js
import { io } from 'socket.io-client'
const socket = io('http://<host>:3000', {
  auth: { token },      // 有 token 就带上，服务端握手自动登录
  transports: ['websocket', 'polling']
})
```

### 注册 `auth:register`
```js
socket.emit('auth:register', { username, password, nick?, email? }, cb)
```
- `username`：3–32 位字母数字 `_-.`；`password`：6–128；`nick`≤32；`email`≤128。
- 成功：`{ ok:true, token, user:{id,username,nick,avatar,email}, companies:[{company,role}] }`

### 登录 `auth:login`
```js
socket.emit('auth:login', { username, password }, cb)
```
- 成功回包同注册：`{ ok:true, token, user, companies }`。
- 拿到 `token` 后即可用它做后续握手自动登录（`socket.auth.token = token` 或重连时传入）。

### 登出 `auth:logout`
```js
socket.emit('auth:logout', {}, cb)   // → { ok:true }
```

### 初始管理员
静态配置 `ADMIN_USER/ADMIN_PASSWORD`（.env）在服务端**首次启动时播种**到数据库，之后可正常登录。

---

## 2. 公司与部门（钉钉组织）

> 角色：`owner`(创建人) > `admin`(子管理员) > `member`。**每个用户都能创建公司**，创建人即 owner。

### 创建公司 `company:create`
```js
socket.emit('company:create', { name, code? }, cb)
// → { ok:true, company:{id,name,code,ownerId,createdAt} }
```
`code` 不传则自动生成 8 位加入码。

### 我的公司 `company:list`
```js
socket.emit('company:list', {}, cb)
// → { ok:true, companies:[{ company:{id,name,code,ownerId,createdAt}, role }] }
```
（一人可持多个公司；客户端「切换公司」时用它）

### 搜索公司 `company:search`
```js
socket.emit('company:search', { keyword? }, cb)
// → { ok:true, companies:[Company] }   // keyword 模糊匹配公司名
```

### 凭码加入 `company:join`
```js
socket.emit('company:join', { code }, cb)
// → { ok:true, company }
```

### 退出公司 `company:leave`
```js
socket.emit('company:leave', { companyId }, cb)  // 创建人不能退出
```

### 公司成员 `company:members`
```js
socket.emit('company:members', { companyId }, cb)
// → { ok:true, members:[{ companyId,userId,role,joinedAt,username,nick,online }] }
```

### 设置角色（加子管理员）`company:setRole`
```js
socket.emit('company:setRole', { companyId, userId, role }, cb)  // role: owner|admin|member
// 仅 owner/admin 可；授予 admin=添加子管理员；admin 不能改 owner
```

### 移除成员 `company:kick`
```js
socket.emit('company:kick', { companyId, userId }, cb)  // 仅 owner/admin；不可移除 owner
```

### 创建部门 `company:createDepartment`
```js
socket.emit('company:createDepartment', { companyId, name, parentId? }, cb)
// → { ok:true, department:{id,companyId,name,parentId,createdAt} }
// 仅公司 owner/admin；parentId 可选（嵌套部门）
```

### 部门列表 `company:listDepartments`
```js
socket.emit('company:listDepartments', { companyId }, cb)
// → { ok:true, departments:[Department] }
```

### 部门成员/分配/移出
```js
socket.emit('department:members', { departmentId }, cb)       // → { ok:true, members:[...online] }
socket.emit('department:assign', { departmentId, userId }, cb)  // 仅 owner/admin
socket.emit('department:removeMember', { departmentId, userId }, cb)
```

---

## 3. 群

> 钉钉：**无公司(companyId=0)也能建群**（上级 company 为 0）；有公司则须为公司成员。

### 创建群 `group:create`
```js
socket.emit('group:create', { companyId, departmentId?, name }, cb)
// companyId: 0 表示无公司群；>0 须为公司成员；departmentId 可选，须属于该公司
// → { ok:true, group:{id,companyId,departmentId,name,code,ownerId,createdAt} }
```

### 我的群 `group:list`
```js
socket.emit('group:list', {}, cb)  // → { ok:true, groups:[Group] }
```

### 某公司下的群 `group:search`
```js
socket.emit('group:search', { companyId?, keyword? }, cb)
```

### 凭码加入 `group:join`
```js
socket.emit('group:join', { code }, cb)
// 无公司群任何用户可加；有公司群须先加入该公司
```

### 退出群 `group:leave` / 群成员 `group:members` / 群主踢人 `group:kick`
```js
socket.emit('group:leave', { groupId }, cb)   // 群主不能退群
socket.emit('group:members', { groupId }, cb)  // → { ok:true, members:[{...,online}] }
socket.emit('group:kick', { groupId, userId }, cb)  // 仅群主(owner)
```

---

## 4. 消息：群聊 / 私信

### 消息结构 `ChatMessage`
```json
{ "id": "1", "conversationId": 3, "type": "group|dm",
  "fromId": 1, "nick": "甲",
  "kind": "text|image|file",
  "content": "…", "ts": 1690000000000 }
```
- `kind=text`：`content` 存**文本或表情字串**（客户端表情只需存字串，图片表情走 image）。
- `kind=image` / `file`：`content` 存**文件地址 URL**（可先传 UUID，服务端自动解析成 URL；图片/视频/音频都走这两种，用 mime 区分）。
- `nick`：服务端按 fromId 回填发送者昵称。

### 群聊发送 `chat:send`
```js
socket.emit('chat:send', { groupId, kind?, content|text? }, cb)
// 文本：{ groupId, content: "你好" }；图片/文件：{ groupId, kind:'image'|'file', content: uuid 或 url }
// → { ok:true, id:"消息id" }
// 广播：群内所有成员收到 chat:message（ChatMessage）
```

### 群聊历史 `chat:history`
```js
socket.emit('chat:history', { groupId, beforeTs?, limit? }, cb)
// → { ok:true, messages:[ChatMessage] }   // 按时间倒序（最新在前）；翻页用最后一条的 ts 作 beforeTs
```

### 私信发送 `dm:send`
```js
socket.emit('dm:send', { toUserId, kind?, content|text? }, cb)
// → { ok:true, id } ；对方在线时收到 dm:message（ChatMessage）
```

### 私信历史 `dm:history`
```js
socket.emit('dm:history', { withUserId, beforeTs?, limit? }, cb)
// → { ok:true, messages:[ChatMessage] }   // 无需好友也能私聊
```

---

## 5. 对话列表 / 置顶 / 已读

### 对话列表 `conversation:list`
```js
socket.emit('conversation:list', { type? }, cb)  // type: 'group'|'dm'|省略=全部
// → { ok:true, conversations:[{ conversationId, type, groupId, dmUserId,
//       pinned, lastMessageAt, lastPreview, unread, name, avatar }] }
```
- **排序：置顶(pinned=true)排最前，其余按 lastMessageAt 倒序**。
- `dmUserId` 私信对方 id（用它拉昵称/头像）；`name/avatar` 服务端已填好。
- `lastPreview`：`[图片]`/`[文件]` 或文本预览；`unread` 未读数。

### 置顶 `conversation:pin`
```js
socket.emit('conversation:pin', { conversationId, pinned:true|false }, cb)
// → { ok:true, pinned }
```

### 标记已读 `conversation:read`
```js
socket.emit('conversation:read', { conversationId }, cb)  // 清零 unread
```

---

## 6. 删除：软删 vs 真删

- **软删（客户端删除/清空）`message:delete`**：只打 `deletedAt` 标记，历史不再返回，物理数据保留。
  - 权限：本人可删自己的；**公司管理员(owner/admin)** 可删群内任意。
- **真删 `message:hardDelete`**：物理删除。
  - 群聊：仅**公司管理员**；私信：仅**发送者本人**。

```js
socket.emit('message:delete', { conversationId, messageId }, cb)
socket.emit('message:hardDelete', { conversationId, messageId }, cb)
// 成功都会向同对话在线客户端广播 message:deleted
```

### 服务端推送 `message:deleted`
```js
socket.on('message:deleted', ({ conversationId, messageId }) => { /* 从本地列表移除/隐藏该消息 */ })
```

---

## 7. 文件上传（HTTP，不走 socket）

- 上传：`POST /api/upload`
- 鉴权：`?token=<JWT>`（或 `Authorization: Bearer <JWT>`）
- 公司参数：`?company=<companyId>`（钉钉客户端有**切换公司**功能；有公司存到 `{data}/{company_id}/`，无公司/不传用 `default/`）
- 字段名：`file`（multipart），限 `FILE_MAX_BYTES`（默认 20MB）
- 成功：`{ ok:true, uuid, filename, mime, size, url }`
  - `url` 即下载地址（本地存储 `GET /files/{company|default}/{子目录…}/{文件名}`，保留原始文件名与文件夹结构）。
  - 用返回的 `url` 作为消息 `content` 发送；也可传 `uuid` 让服务端自动解析成 url。
- 支持：图片、视频、音频、任意文件（用 mime 区分，kind 统一 image/file）。

```js
const fd = new FormData()
fd.append('file', blob, 'a.mp4')
const res = await fetch(`${base}/api/upload?token=${token}&company=${companyId}`, { method:'POST', body: fd })
const { uuid, url } = await res.json()
```

---

## 8. 好友

```js
socket.emit('friend:add', { userId }, cb)      // 与公司无关，无公司也能加；互加幂等（已是好友也返回 ok）
socket.emit('friend:remove', { userId }, cb)
socket.emit('friend:list', {}, cb)             // → { ok:true, friends:[{userId,username,nick,avatar,addedAt}] }
```

---

## 9. 在线状态（服务端推送）

```js
socket.on('presence:update', ({ userId, nick, online }) => {})
```
- 上下线时向该用户所属的**群房间**广播。私信对象在线与否客户端可结合 `company:members`/`group:members`/`department:members` 返回的 `online` 字段刷新。

---

## 10. 客户端典型接入流程

1. 启动 → `io(url, { auth:{ token? } })` 连接。
2. 无 token：弹注册/登录，`auth:register` / `auth:login` 拿 `token` + `user` + `companies`。
3. 存 token；重连时 `auth.token` 自动登录（服务端自动入房间）。
4. 拉数据：
   - `company:list` → 顶部公司切换器；
   - `company:listDepartments` + `company:members` → 组织树/成员；
   - `group:list` / `group:search` → 群列表；
   - `friend:list` → 好友；
   - `conversation:list` → 主界面对话列表（置顶+时间倒序）。
5. 进会话：`chat:history` / `dm:history` 拉历史；发送走 `chat:send` / `dm:send`；文件先 `POST /api/upload` 再带 url 发送。
6. 实时：`chat:message`、`dm:message`、`presence:update`、`message:deleted` 监听并更新界面。
7. 置顶 `conversation:pin`、已读 `conversation:read`、删除 `message:delete` / `message:hardDelete`。

---

## 11. 数据结构速查

| 结构 | 字段 |
|---|---|
| User | `id,username,nick,avatar,email,createdAt` |
| Company | `id,name,code,ownerId,createdAt` |
| Department | `id,companyId,name,parentId,createdAt` |
| Group | `id,companyId,departmentId,name,code,ownerId,createdAt` |
| Member/GroupMember | `…Id,userId,role,joinedAt,username,nick,online` |
| ConversationItem | `conversationId,type,groupId,dmUserId,pinned,lastMessageAt,lastPreview,unread,name,avatar` |
| ChatMessage | `id,conversationId,type,fromId,nick,kind,content,ts` |
| Friend | `userId,username,nick,avatar,addedAt` |

角色：公司 `owner|admin|member`；群 `owner|member`。消息 `kind`：`text|image|file`。
