import type { Socket } from 'socket.io'
import type { CompanyRole } from '../types'
import { AlreadyExistsError } from '../db/store'
import { hashPassword } from '../password'
import { fail, makeJoinCode, ok } from '../util'
import type { AuthUser, Ctx } from './auth'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): AuthUser | null {
  return socket.data.auth ? (socket.data.auth as AuthUser) : null
}

const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{3,32}$/.test(v)
const isPassword = (v: unknown): v is string => typeof v === 'string' && v.length >= 6 && v.length <= 128

/** 简易 CSV 解析：支持引号包裹、逗号内逗号、BOM、CRLF。返回行数组（每行一个对象，键为表头）。 */
function parseCsv(text: string): Array<Record<string, string>> {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuote) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuote = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      lines.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    lines.push(row)
  }
  // 去掉全空行
  const rows = lines.filter((r) => r.some((c) => c.trim().length > 0))
  if (rows.length === 0) return []
  // 表头归一（兼容常见别名）
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const colIndex: Record<string, number> = {}
  const aliases: Array<[string, string[]]> = [
    ['company', ['company', 'company_name', '公司', '组织', '组织名']],
    ['company_code', ['company_code', 'companycode', 'code', '加入码', '公司码']],
    ['department', ['department', 'dept', '部门', '部门名', 'department_name']],
    ['username', ['username', 'user', '账号', '用户名', '登录名']],
    ['password', ['password', 'pwd', '密码']],
    ['nick', ['nick', 'nickname', 'name', '昵称', '姓名']],
    ['role', ['role', '职位', '角色', '权限']]
  ]
  for (const [key, names] of aliases) {
    for (let i = 0; i < head.length; i++) {
      if (names.includes(head[i]) && colIndex[key] === undefined) colIndex[key] = i
    }
  }
  // 若无有效表头，则按顺序当 company,code,department,username,password,nick,role
  const isHeader = colIndex.company !== undefined || colIndex.username !== undefined
  if (isHeader) {
    return rows.slice(1).map((r) => {
      const o: Record<string, string> = {}
      for (const key of Object.keys(colIndex)) o[key] = r[colIndex[key]] ?? ''
      return o
    })
  }
  return rows.map((r) => ({
    company: r[0] ?? '',
    company_code: r[1] ?? '',
    department: r[2] ?? '',
    username: r[3] ?? '',
    password: r[4] ?? '',
    nick: r[5] ?? '',
    role: r[6] ?? ''
  }))
}

/**
 * org:importCsv —— 从 CSV 导入组织架构（公司 → 部门 → 成员）。
 * 列：company, company_code, department, username, password, nick, role
 * 导入人须已登录；新建公司时导入人自动成为 owner(创建人)。幂等：已存在则跳过。
 */
export function registerOrgHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    socket.on('org:importCsv', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const csv = (data as { csv?: unknown } | null)?.csv
      if (typeof csv !== 'string' || csv.trim().length === 0) return ack(fail('CSV 内容为空'))
      if (csv.length > 2_000_000) return ack(fail('CSV 过大（限 2MB）'))

      const rows = parseCsv(csv)
      const result = {
        ok: true as boolean,
        companies: 0,
        departments: 0,
        users: 0,
        memberships: 0,
        skipped: 0,
        errors: [] as string[]
      }
      const companyCache = new Map<string, number>() // code → companyId
      const deptCache = new Map<string, number>() // `${companyId}:${name}` → deptId

      for (const [idx, r] of rows.entries()) {
        const companyName = (r.company ?? '').trim()
        if (!companyName) continue
        let companyCode = (r.company_code ?? '').trim()
        if (companyCode && !isCode(companyCode)) {
          result.errors.push(`第${idx + 2}行：加入码「${companyCode}」不合法，已忽略该码`)
          companyCode = ''
        }

        // 1) 公司：有码则查码，无码/未命中则新建（导入人为 owner）
        let companyId = companyCode ? companyCache.get(companyCode) : undefined
        if (companyId === undefined) {
          const existing = companyCode ? await store.getCompanyByCode(companyCode) : null
          if (existing) {
            companyId = existing.id
            companyCache.set(companyCode!, companyId)
          }
        }
        if (companyId === undefined) {
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = companyCode || makeJoinCode()
            try {
              const company = await store.createCompany({ name: companyName, code, ownerId: auth.id })
              companyId = company.id
              companyCache.set(code, companyId)
              if (companyCode) companyCode = code
              result.companies++
              break
            } catch (err) {
              if (err instanceof AlreadyExistsError) {
                if (companyCode) {
                  result.errors.push(`第${idx + 2}行：公司加入码「${companyCode}」已被占用，已跳过该公司`)
                  break
                }
                continue
              }
              result.errors.push(`第${idx + 2}行：创建公司失败`)
              break
            }
          }
        }
        if (companyId === undefined) continue

        // 2) 部门：按 公司+部门名 幂等创建（仅管理员可建，导入人作为 owner/admin）
        const deptName = (r.department ?? '').trim()
        if (deptName) {
          const dk = `${companyId}:${deptName}`
          if (!deptCache.has(dk)) {
            const depts = await store.listDepartments(companyId)
            const existing = depts.find((d) => d.name === deptName)
            if (existing) {
              deptCache.set(dk, existing.id)
            } else {
              try {
                const dept = await store.createDepartment({ companyId, name: deptName })
                deptCache.set(dk, dept.id)
                result.departments++
              } catch {
                result.errors.push(`第${idx + 2}行：创建部门「${deptName}」失败`)
              }
            }
          }
        }

        // 3) 成员：按用户名幂等创建，加入公司并分配部门
        const username = (r.username ?? '').trim()
        if (!username) continue
        const password = (r.password ?? '').trim()
        if (password && !isPassword(password)) {
          result.errors.push(`第${idx + 2}行：账号「${username}」密码需 6-128 位，已跳过`)
          continue
        }
        let userId: number | null = null
        const existingUser = await store.getUserByUsername(username)
        if (existingUser) {
          userId = existingUser.id
        } else {
          try {
            const created = await store.createUser({
              username,
              passwordHash: hashPassword(password || 'mochioa123'),
              nick: (r.nick ?? '').trim() || username
            })
            userId = created.id
            result.users++
          } catch {
            result.errors.push(`第${idx + 2}行：创建账号「${username}」失败`)
          }
        }
        if (userId === null) continue

        // 加入公司（owner 仅公司创建人；新建公司导入人是 owner，其余按 role，默认 member）
        const roleRaw = (r.role ?? '').trim().toLowerCase()
        let role: CompanyRole = roleRaw === 'admin' ? 'admin' : roleRaw === 'owner' ? 'admin' : 'member'
        const cur = await store.getMemberRole(companyId, userId)
        if (cur === null) {
          try {
            await store.addMember(companyId, userId, role)
            result.memberships++
          } catch {
            result.errors.push(`第${idx + 2}行：加入公司「${companyName}」失败`)
          }
        } else {
          result.skipped++
        }

        // 分配部门
        if (deptName) {
          const dk = `${companyId}:${deptName}`
          const deptId = deptCache.get(dk)
          if (deptId !== undefined) {
            try {
              await store.assignDepartment(deptId, userId)
            } catch {
              /* 已在部门则忽略 */
            }
          }
        }
      }

      ack(ok(result))
    })
  })
}
