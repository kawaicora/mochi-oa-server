// 一次性脚本：连接 Docker MySQL，按当前模型 sync 建出 mail_configs 表并验证字段。
// 运行：node scripts/sync-mail-config.mjs
// 说明：只新增空表，不触碰现有表/数据，不影响运行中的服务端。
import { Sequelize } from 'sequelize'
import { initModels } from '../dist/db/models.js'

const sequelize = new Sequelize({
  database: 'mochioa',
  username: 'root',
  password: 'mochioa_root_pw',
  host: '127.0.0.1',
  port: 3306,
  dialect: 'mysql',
  logging: false
})

initModels(sequelize)
await sequelize.sync()

const [rows] = await sequelize.query("SHOW TABLES LIKE 'mail_configs';")
console.log('mail_configs table exists:', rows.length > 0)

const cols = await sequelize.getQueryInterface().describeTable('mail_configs')
console.log('columns:', Object.keys(cols).join(', '))

await sequelize.close()
