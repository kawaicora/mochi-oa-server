// 阿里云邮件推送 SMTP (smtpdm.aliyun.com:465) 实测发到 mengyou81219@163.com
import nodemailer from 'nodemailer'

const t = nodemailer.createTransport({
  host: 'smtpdm.aliyun.com',
  port: 465,
  secure: true,
  auth: { user: 'admin@kawaimoe.org', pass: 'DTV92zn8iNkqGPBH' },
  connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000
})
try {
  const info = await Promise.race([
    t.sendMail({
      from: '"OA 通知" <admin@kawaimoe.org>',
      to: 'mengyou81219@163.com',
      subject: '[mochi-oa] 邮件测试',
      text: '这是一封由 mochi-oa 服务端 SMTP 客户端发出的测试邮件，验证阿里云邮件推送（smtpdm）通道可用。'
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT(22s)')), 22000))
  ])
  console.log('OK messageId=', info.messageId || '')
  console.log('response=', (info.response || '').slice(0, 150))
} catch (e) {
  console.log('FAIL:', e.message)
}
