// 用 nodemailer 测试 STARTTLS (requireTLS) 连 mail.kawaimoe.org:25
import nodemailer from 'nodemailer'

const t = nodemailer.createTransport({
  host: 'mail.kawaimoe.org',
  port: 25,
  secure: false,
  requireTLS: true,
  auth: { user: 'admin@kawaimoe.org', pass: 'SacS5VfD2Ef54S1V5ac0' }
})
try {
  const info = await t.sendMail({
    from: '"OA 通知" <admin@kawaimoe.org>',
    to: 'admin@kawaimoe.org',
    subject: '[mochi-oa] SMTP STARTTLS 测试',
    text: '这是一封测试邮件，验证 kawaimoe STARTTLS 可用。'
  })
  console.log('OK messageId=', info.messageId, info.response)
} catch (e) {
  console.log('FAIL:', e.message)
}
