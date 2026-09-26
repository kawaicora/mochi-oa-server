// 更新主邮件配置为阿里云邮件推送，并用 mailer（读 DB 配置）端到端实测发信
import { MySqlStore } from '../dist/db/mysql-store.js'
import { Mailer } from '../dist/mailer.js'

const store = new MySqlStore({
  host: '127.0.0.1', port: 3306, user: 'root', password: 'mochioa_root_pw', database: 'mochioa'
})
await store.init()
const mailer = new Mailer(store)

const EMAIL = 'admin@kawaimoe.org'

// 1) 更新/确保主配置为阿里云邮件推送
const existing = (await store.listMailConfigs({ companyId: null })).find((c) => c.email === EMAIL)
const cfg = await store.saveMailConfig({
  id: existing?.id,
  companyId: null,
  email: EMAIL,
  displayName: 'OA 通知',
  host: 'smtpdm.aliyun.com',
  port: 465,
  secure: true,
  user: EMAIL,
  password: 'DTV92zn8iNkqGPBH',
  isDefault: true,
  enabled: true,
  priority: 10
})
console.log('[配置] 主邮件配置 id=', cfg.id, cfg.email, '→', cfg.host + ':' + cfg.port, 'secure=', cfg.secure)

// 2) 端到端：mailer 读 DB 配置发信
const r = await mailer.sendMail({
  to: 'mengyou81219@163.com',
  subject: '[mochi-oa] 端到端验证（读配置表）',
  text: '本邮件由 mochi-oa 服务端 mailer 读取数据库主邮件配置后发送，链路已通。',
  companyId: null
})
console.log('[端到端] ok=', r.ok, 'used=', r.used?.email, 'messageId=', r.messageId ?? '')
if (!r.ok) console.log('error:', r.error)

await store.close()
