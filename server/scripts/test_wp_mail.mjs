// 用 WP 实际配置重测：admin@kawaimoe.org / DTV92zn8iNkqGPBH / mail.kawaimoe.org:25
import nodemailer from 'nodemailer'

const USER = 'admin@kawaimoe.org'
const PASS = 'DTV92zn8iNkqGPBH'

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT(' + ms + 'ms)')), ms)) }

async function attempt(name, opts) {
  try {
    const t = nodemailer.createTransport({
      host: 'mail.kawaimoe.org',
      port: 25,
      ...opts,
      auth: { user: USER, pass: PASS },
      connectionTimeout: 12000,
      greetingTimeout: 12000,
      socketTimeout: 12000
    })
    const r = await Promise.race([
      t.sendMail({
        from: '"零食大礼包" <admin@kawaimoe.org>',
        to: 'admin@kawaimoe.org',
        subject: '[mochi-oa] SMTP 连通测试',
        text: '测试邮件，验证 kawaimoe SMTP 可用。'
      }),
      timeout(16000)
    ])
    console.log(name, '=> OK', r.messageId || '')
  } catch (e) {
    console.log(name, '=> FAIL:', e.message)
  }
}

await attempt('明文 (secure:false)', { secure: false })
await attempt('STARTTLS (requireTLS)', { secure: false, requireTLS: true })
await attempt('opportunisticTLS (587-style)', { secure: false, opportunisticTLS: true, port: 25 })
