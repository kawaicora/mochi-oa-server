import type { Store } from './db/store'
import type { MailConfig } from './types'
import type { ServerMailConfig } from './config'
import nodemailer, { type Transporter } from 'nodemailer'

/**
 * SMTP 邮件客户端。
 *
 * 作用域：
 * - 主/全局配置（companyId=null）：用户注册、登录验证、验证码等系统级邮件，公司未配置时也用。支持多个邮箱（每行一条，按默认/优先级顺序尝试）。
 * - 公司级配置（companyId!=null）：默认为空，在公司设置里配置；配置后该公司相关邮件用公司邮箱发送。
 *
 * 账号选择顺序：显式 mailConfigId > 公司配置（companyId 传且存在）> 主配置。
 */

/** 未配置可用邮件账号时抛出（区分 主配置/公司配置） */
export class MailNotConfiguredError extends Error {
  constructor(scope: 'global' | 'company') {
    super(scope === 'company' ? '该公司未配置邮件发送账号' : '服务器未配置邮件发送账号（主邮件配置为空）')
    this.name = 'MailNotConfiguredError'
  }
}

export interface SendMailOptions {
  to: string | string[]
  subject: string
  text?: string
  html?: string
  /** 发送作用域：传 companyId 且该公司有配置时用公司邮箱；否则回退主配置 */
  companyId?: number | null
  /** 明确指定发件账号（跳过自动选择） */
  mailConfigId?: number
}

export interface SendMailResult {
  ok: boolean
  messageId?: string
  /** 实际使用的发件账号 */
  used: MailConfig | null
  error?: string
  /** 多账号回退时记录的各账号失败原因 */
  attempts?: { email: string; error: string }[]
}

export class Mailer {
  /** 环境级主邮件（来自 .env/Docker，第一优先级）；null 表示未配置 */
  private readonly envCfg: ServerMailConfig | null
  constructor(
    private readonly store: Store,
    envMail?: ServerMailConfig | null
  ) {
    this.envCfg = envMail && envMail.enabled ? envMail : null
  }

  // ---- 配置管理（透传 store，供公司设置 / 管理界面使用） ----
  async listConfigs(companyId?: number | null): Promise<MailConfig[]> {
    return this.store.listMailConfigs({ companyId: companyId ?? null })
  }
  async getConfig(id: number): Promise<MailConfig | null> {
    return this.store.getMailConfig(id)
  }
  async saveConfig(input: Parameters<Store['saveMailConfig']>[0]): Promise<MailConfig> {
    return this.store.saveMailConfig(input)
  }
  async deleteConfig(id: number): Promise<void> {
    return this.store.deleteMailConfig(id)
  }

  /**
   * 发送邮件。所选作用域多账号时，按默认/优先级顺序尝试，一个成功即返回；全部失败则返回失败详情。
   */
  async sendMail(opts: SendMailOptions): Promise<SendMailResult> {
    const to = Array.isArray(opts.to) ? opts.to : [opts.to]
    if (to.length === 0 || to.some((t) => !t)) {
      return { ok: false, used: null, error: '收件人地址为空' }
    }

    // 1) 确定候选账号列表
    let candidates: MailConfig[] = []
    if (opts.mailConfigId) {
      const c = await this.store.getMailConfig(opts.mailConfigId)
      if (c) candidates = [c]
    }
    if (candidates.length === 0 && opts.companyId) {
      candidates = (await this.store.listMailConfigs({ companyId: opts.companyId })).filter((c) => c.enabled)
    }
    // 环境级主邮件（.env/Docker 配置，第一优先级）
    if (candidates.length === 0 && this.envCfg) {
      candidates = [this.envConfigToMail(this.envCfg)]
    }
    // 数据库主配置（客户端 SERVER_ADMIN 在设置里写入）
    if (candidates.length === 0) {
      candidates = (await this.store.listMailConfigs({ companyId: null })).filter((c) => c.enabled)
    }
    if (candidates.length === 0) {
      throw new MailNotConfiguredError(opts.companyId ? 'company' : 'global')
    }

    // 2) 逐个尝试（默认/优先级已由 store 排序，如 isDefault 靠前、priority 升序）
    const attempts: { email: string; error: string }[] = []
    for (const cfg of candidates) {
      try {
        const messageId = await this.sendVia(cfg, { to, subject: opts.subject, text: opts.text, html: opts.html })
        return { ok: true, messageId, used: cfg, attempts }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        attempts.push({ email: cfg.email, error: msg })
      }
    }
    return {
      ok: false,
      used: null,
      error: `所有邮件账号发送均失败：${attempts.map((a) => `${a.email}: ${a.error}`).join('；')}`,
      attempts
    }
  }

  private async sendVia(cfg: MailConfig, msg: { to: string[]; subject: string; text?: string; html?: string }): Promise<string | undefined> {
    const transporter: Transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password }
    })
    const info = await transporter.sendMail({
      from: `"${cfg.displayName || cfg.email}" <${cfg.email}>`,
      to: msg.to.join(', '),
      subject: msg.subject,
      text: msg.text,
      html: msg.html
    })
    return info.messageId
  }

  /** 把环境级配置映射为 MailConfig（id=0 仅用于发送） */
  private envConfigToMail(c: ServerMailConfig): MailConfig {
    return {
      id: 0,
      companyId: null,
      email: c.fromEmail || c.user,
      displayName: c.fromName,
      host: c.host,
      port: c.port,
      secure: c.secure,
      user: c.user,
      password: c.password,
      isDefault: true,
      enabled: true,
      priority: 0,
      createdAt: ''
    }
  }

  /**
   * 当前生效的主邮件配置：优先环境级（.env/Docker），否则数据库（客户端 SERVER_ADMIN 设置）。
   * source 标记来源，供设置界面判断是否可改。
   */
  async getMainMail(): Promise<{ source: 'env' | 'db'; config: MailConfig | null }> {
    if (this.envCfg) return { source: 'env', config: this.envConfigToMail(this.envCfg) }
    const db = await this.store.getDefaultMailConfig({ companyId: null })
    return { source: 'db', config: db }
  }
}

/** 创建邮件服务（业务模块可直接用，也可 new Mailer(store)） */
export function createMailer(store: Store, envMail?: ServerMailConfig | null): Mailer {
  return new Mailer(store, envMail)
}
