// 一次性验证脚本：验证 MySqlStore 邮件配置 CRUD + 默认账号选择 + 作用域隔离。
// 运行：node scripts/verify-mail-store.mjs
import { MySqlStore } from '../dist/db/mysql-store.js'

const store = new MySqlStore({
  host: '127.0.0.1', port: 3306, user: 'root', password: 'mochioa_root_pw', database: 'mochioa'
})
await store.init()

// 主配置（全局）：两个邮箱，一个默认
const a = await store.saveMailConfig({
  companyId: null, email: 'admin@example.com', displayName: '测试OA',
  host: 'smtp.example.com', port: 465, secure: true,
  user: 'admin@example.com', password: 'pw-a', isDefault: true, priority: 10
})
const b = await store.saveMailConfig({
  companyId: null, email: 'wang@example.com', displayName: '测试OA备用',
  host: 'smtp.example.com', port: 465, secure: true,
  user: 'wang@example.com', password: 'pw-b', isDefault: false, priority: 20
})

// 公司级配置：用真实存在的公司 id（测试 company_id=null 主配置外键不受限；公司配置须引用真实公司）
const company = (await store.listCompanies()).filter((x) => x.id != null)[0]
const companyId = Number(company.id)
const c = await store.saveMailConfig({
  companyId, email: `hr-${companyId}@corp.com`, displayName: '公司HR',
  host: 'smtp.corp.com', port: 587, secure: false,
  user: `hr-${companyId}@corp.com`, password: 'pw-c'
})

const main = await store.listMailConfigs({ companyId: null })
console.log('[OK] 主配置数:', main.length)
console.log('[OK] 主默认账号:', (await store.getDefaultMailConfig({ companyId: null }))?.email)
const companyList = await store.listMailConfigs({ companyId })
console.log('[OK] 公司(' + companyId + ')配置数:', companyList.length)
console.log('[OK] 公司默认账号:', (await store.getDefaultMailConfig({ companyId }))?.email)
// 作用域隔离：公司配置不应出现在主配置
console.log('[OK] 隔离:公司配置出现在主配置?', main.some((m) => m.id === c.id))

// 更新测试：改公司配置默认标记
const c2 = await store.saveMailConfig({ id: c.id, email: c.email, host: c.host, isDefault: true })
console.log('[OK] 更新后公司默认:', (await store.getDefaultMailConfig({ companyId }))?.email)

// 清理测试数据
await store.deleteMailConfig(a.id)
await store.deleteMailConfig(b.id)
await store.deleteMailConfig(c2.id)
console.log('[OK] 清理后主配置数:', (await store.listMailConfigs({ companyId: null })).length)
console.log('[OK] 清理后公司配置数:', (await store.listMailConfigs({ companyId })).length)
await store.close()
