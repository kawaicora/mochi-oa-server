# mochioa-server

基于 Socket.IO + MySQL 的服务端：**注册登录 + 多公司(company)组织管理**，数据存储用 **Sequelize ORM**（声明式模型，无手写 SQL），可编译成 Linux / Windows / macOS 原生可执行文件。

组织结构**完全照搬钉钉**：

```
公司(company)        —— 每个用户都能创建，创建人即 owner；可添加子管理员(admin)
 └─ 部门(department) —— 属于公司，由公司管理员(owner/admin)创建，可嵌套
群(group)            —— 属于公司（可挂部门下）；无公司(companyId=0)也能建群
私信(dm)             —— 与公司无关，一对一；无公司也能私聊/加好友
```

## 特性

- 全部走 Socket.IO（握手 `auth.token` 自动登录），无其它发现协议；scrypt 密码 + JWT
- 初始管理员：`ADMIN_USER/ADMIN_PASSWORD` 首次启动播种到数据库
- 多公司：人人可建公司（钉钉），创建人=owner，可加子管理员(admin)；凭码加入/退出/角色/踢人
- 部门：管理员(owner/admin)创建，可嵌套，分配/移出成员
- 群：成员创建（有公司挂公司下，**无公司 companyId=0 也能建**），凭码加入、退出、群主踢人
- **对话列表**：群聊+私信统一，按 **置顶优先、最新消息倒序**，含未读数/预览/对方昵称
- **一对一私信** + **好友**（与公司无关）
- **历史存储**：每群/每私信都有历史，分页 `beforeTs`
- **删除**：客户端删除/清空只打 `deletedAt` 标记（软删）；真正删除仅公司管理员，私信仅发送者本人
- **文件上传**：`POST /api/upload` → **本地磁盘存储**（含分块上传 + 断点续传 + 文件夹结构）；文件表 `files(uuid, filename, mime, size, storage, url)`；消息内容存**地址(URL)**；表情存字串/图片地址
  - 路径按公司隔离：`{FILE_DIR}/{company_id}/`（无公司用 `default/`），保留**原始文件名**；发送文件夹按原目录结构创建子目录
- 多部署：HTTP/HTTPS、`TRANSPORTS` 可配 polling（适配 Cloudflare）、TRUST_PROXY

## 目录

```
server/              服务端全部代码（Node.js）
  src/db/models.ts     Sequelize ORM 模型 + 关联 + 建表(sync)
  src/db/mysql-store.ts MySQL 存储实现（ORM，无裸 SQL）
  src/db/memory-store.ts 内存存储（开发/测试）
  src/handlers/       auth / company(部门) / group / conversation(群+私信) / friends
  src/files.ts        上传（本地磁盘，按公司/文件夹结构）
  ...
Dockerfile           安装 Node 环境并编译服务端
docker-compose.yaml  一键启动：MySQL + 服务端
```

## 快速开始

```bash
# 本地（无 MySQL）试跑
cd server
npm install
npm run build
STORAGE=memory PORT=3000 node dist/index.js

# 基础冒烟（内存，spawn 真实服务）
npm test

# 全面模拟（连真实服务端）：SIM_URL=http://127.0.0.1:3000 node scripts/simulate.mjs
```

### Docker 一键启动（MySQL + 服务端）

```bash
cp .env.example .env        # 按需改 MYSQL_ROOT_PASSWORD / JWT_SECRET
docker compose up -d        # 启动 MySQL + 服务端
```

服务端启动时自动建库建表（`sequelize.sync()`）。容器间用桥接子网、按服务名通信（mysql）。访问 `http://<host>:3000/socket.io`。

## 配置（环境变量，见 server/.env.example）

| 变量 | 默认 | 说明 |
|---|---|---|
| HOST / PORT | 0.0.0.0 / 3000 | 监听地址 / 端口 |
| TRANSPORTS | websocket,polling | 传输方式。**Cloudflare 等只放行 HTTP/HTTPS 时设 `polling`** |
| TRUST_PROXY | false | 反向代理后置 true |
| STORAGE | mysql | mysql（生产）\| memory（本地/测试） |
| MYSQL_HOST/PORT/USER/PASSWORD/DATABASE | 127.0.0.1/3306/root//mochioa | MySQL |
| JWT_SECRET / JWT_EXPIRES_IN | change-me-in-production / 30d | 令牌 |
| ADMIN_USER / ADMIN_PASSWORD | - | 初始管理员（播种） |
| FILE_DIR / FILE_BASE_URL / FILE_MAX_BYTES | ./data / … /files / 20MB | 本地文件存储（`./data/{公司id|default}/{文件名/文件夹结构}`，docker 挂载宿主机 `./data`） |
| ICE_SERVERS / ICE_USE_CLOUDFLARE / CLOUDFLARE_TURN_TOKEN / CLOUDFLARE_TURN_KEY_ID / ICE_SERVERS_TOKEN_SECOND | - / false / - / - / 86400 | WebRTC ICE（静态或 Cloudflare TURN API 动态获取） |

## Socket.IO 事件（客户端→服务端，带 ack）

- 账号：`auth:register` / `auth:login` / `auth:logout`
- 公司：`company:create`（人人可建）/ `company:list` / `company:search` / `company:join`（凭码）/ `company:leave` / `company:members` / `company:setRole`（加子管理员）/ `company:kick` / `company:createDepartment` / `company:listDepartments`
- 部门：`department:assign` / `department:removeMember` / `department:members`
- 群：`group:create`（companyId=0 可无公司）/ `group:list` / `group:search` / `group:join` / `group:leave` / `group:members` / `group:kick`
- 消息：`chat:send` {groupId, kind?, content|text} → 群内广播 `chat:message`；`chat:history` {groupId, beforeTs?, limit?}
- 私信：`dm:send` {toUserId, kind?, content|text} → `dm:message`；`dm:history` {withUserId, beforeTs?, limit?}
- 对话：`conversation:list` {type?} / `conversation:pin` {conversationId,pinned} / `conversation:read` {conversationId}
- 删除：`message:delete`（软删）/ `message:hardDelete`（管理员）→ 广播 `message:deleted`
- 好友：`friend:add` / `friend:remove` / `friend:list`
- 在线：上下线广播 `presence:update`（{userId,nick,online}）
- 文件：HTTP `POST /api/upload?token=&company=`（multipart `file`）→ `{uuid, filename, mime, size, url}`；本地文件 `GET /files/{company|default}/{子目录…}/{文件名}`；分块 `POST /api/upload/chunk` + `POST /api/upload/chunk/complete`（断点续传 `GET /api/upload/chunk/status`）

kind：`text`（含表情字串）/ `image` / `file`（视频、音频等通用文件，mime 区分）。消息结构：`{id, conversationId, type(group|dm), fromId, nick, kind, content, ts}`。

## 编译三端

```bash
cd server
npm run pkg:win     # dist/bin/mochioa-server-win-x64(.exe)
npm run pkg:linux   # dist/bin/mochioa-server-linux-x64
npm run pkg:mac     # dist/bin/mochioa-server-macos
npm run pkg:all     # 一次打好
```

> pkg 跨平台编译需从 GitHub 下载 Node 运行时基座；内网无法下载时在各自标平台分别执行对应脚本。

## 客户端接入

去掉 UDP 发现逻辑 → 启动即连 `http://<server>:<port>/socket.io` → `auth:login`/`auth:register` 拿 token → 握手 `auth.token` 自动登录 → 服务端自动加入所属群/用户房间 → `chat:send`/`dm:send` 发消息、`conversation:list` 拉对话列表。上传用 `POST /api/upload`（带 token，`company` 参数对应当前切换的公司）。
