// 用阿里云企业邮 SMTP 实测发信
import nodemailer from 'nodemailer'

const USER = 'admin@kawaimoe.org'

async function tryPass(label, pass) {
  try {
    const t = nodemailer.createTransport({
      host: 'smtp.aliyun.com',
      port: 465,
      secure: true,
      auth: { user: USER, pass },
      connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 12000
    })
    const info = await Promise.race([
      t.sendMail({
        from: `"OA 通知" <${USER}>`,
        to: USER,
        subject: '[mochi-oa] 阿里云 SMTP 测试',
        text: '测试邮件，验证阿里云企业邮 SMTP 可用。'
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 16000))
    ])
    console.log(`[${label}] => OK`, info.messageId || '', '|', (info.response || '').slice(0, 60))
    return true
  } catch (e) {
    console.log(`[${label}] => FAIL:`, e.message)
    return false
  }
}

await tryPass('DTV92zn8iNkqGPBH (WP密码)', 'DTV92zn8iNkqGPBH')
await tryPass('SacS5VfD2Ef54S1V5ac0 (首给密码)', 'SacS5VfD2Ef54S1V5ac0')
