// 入职流程端到端验证：跑在已启动的 Docker 服务上（mysql 模式, http://127.0.0.1:3000）
// 链路：A 注册→建公司(owner) → A 邀请 B → B 收到 company:inviteReceived + myInvites → B acceptInvite
//       → B 加入公司+部门+全员群 → A 收到 company:inviteResolved → B 填写 member:updateProfile / 读取 getProfile
import { io } from 'socket.io-client'

const URL = process.env.URL || 'http://127.0.0.1:3000'
const transports = ['websocket']

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  ok - ${msg}`)
  else {
    failures++
    console.error(`  FAIL - ${msg}`)
  }
}
const once = (s, ev) => new Promise((r) => s.once(ev, r))
const emitAck = (s, ev, d) => new Promise((r) => s.emit(ev, d, r))

async function connect() {
  const s = io(URL, { transports, reconnection: false })
  await new Promise((res, rej) => {
    s.once('connect', res)
    s.once('connect_error', rej)
  })
  return s
}

const ts = Date.now()
const userA = `inviter_${ts}`
const userB = `joiner_${ts}`

async function main() {
  const A = await connect()
  const B = await connect()

  const regA = await emitAck(A, 'auth:register', { username: userA, password: 'secret123', nick: '邀请人甲' })
  assert(regA.ok && regA.token, `A 注册成功 (${userA})`)
  const regB = await emitAck(B, 'auth:register', { username: userB, password: 'secret456', nick: '入职者乙' })
  assert(regB.ok && regB.token, `B 注册成功 (${userB})`)

  // A 建公司（owner）
  const create = await emitAck(A, 'company:create', { name: '入职验证公司' })
  assert(create.ok && create.company, 'A 创建公司成功')
  const company = create.company

  // A 建部门
  const dept = await emitAck(A, 'company:createDepartment', { companyId: company.id, name: '人事部' })
  assert(dept.ok && dept.department, 'A 创建部门成功')
  const department = dept.department

  // B 收到实时邀请推送
  const recvP = once(B, 'company:inviteReceived')

  // A 邀请 B 加入公司（指定部门）
  const invite = await emitAck(A, 'company:invite', { companyId: company.id, username: userB, departmentId: department.id })
  assert(invite.ok && invite.invitation, 'A 邀请 B 成功')
  const invitation = invite.invitation
  assert(invitation.status === 'pending' && invitation.companyName === '入职验证公司', '邀请状态 pending，含公司名')
  assert(invitation.departmentName === '人事部', '邀请含部门名')

  const recv = await recvP
  assert(recv.invitation && recv.invitation.id === invitation.id, 'B 实时收到邀请推送')

  // B 查待处理邀请
  const myInvites = await emitAck(B, 'company:myInvites', {})
  assert(myInvites.ok && myInvites.invites.some((i) => i.id === invitation.id), 'B myInvites 含该邀请')

  // 普通成员（此时 B 尚未入司，无角色）——A 是 owner 可发；重复邀请被拒
  const dup = await emitAck(A, 'company:invite', { companyId: company.id, username: userB })
  assert(dup.ok === false, '重复邀请被拒绝')

  // B 同意邀请
  const acceptP = once(A, 'company:inviteResolved')
  const accept = await emitAck(B, 'company:acceptInvite', { invitationId: invitation.id })
  assert(accept.ok && accept.company, 'B 同意邀请成功')
  const resolved = await acceptP
  assert(resolved.invitation.status === 'accepted', 'A 收到 inviteResolved，状态已 accepted')

  // B 现在在公司中，且是 member（非 owner）
  const bCompany = await emitAck(B, 'company:list', {})
  assert(bCompany.ok && bCompany.companies.some((c) => c.company.id === company.id), 'B 的公司列表含该公司')
  const role = bCompany.companies.find((c) => c.company.id === company.id)?.role
  assert(role === 'member', 'B 在公司中角色为 member')

  // B 已加入全员群（总群）
  const gList = await emitAck(B, 'group:list', {})
  const mainG = gList.groups.find((g) => g.companyId === company.id)
  assert(mainG && /总群/.test(mainG.name), 'B 已自动加入全员群')

  // B 填写人事档案
  const up = await emitAck(B, 'member:updateProfile', {
    companyId: company.id,
    realName: '张入职',
    idCard: '440000199001011234',
    bankCard: '6222020000000000',
    resumeUrl: '/files/resume.pdf',
    portfolioUrl: '/files/portfolio.pdf'
  })
  assert(up.ok && up.profile.realName === '张入职', 'B 填写人事档案成功')

  const gp = await emitAck(B, 'member:getProfile', { companyId: company.id })
  assert(gp.ok && gp.profile.bankCard === '6222020000000000', 'B 读取人事档案正确')

  // A 作为 admin 能列出公司发出的邀请
  const listInv = await emitAck(A, 'company:listInvitations', { companyId: company.id })
  assert(listInv.ok && listInv.invites.length >= 1, 'A 列出公司邀请')

  // C 注册 → 被 A 邀请 → C 拒绝（验证 decline 分支）
  const userC = `decliner_${ts}`
  const C = await connect()
  const regC = await emitAck(C, 'auth:register', { username: userC, password: 'secret789', nick: '拒绝者丙' })
  assert(regC.ok, `C 注册成功 (${userC})`)
  const invite2 = await emitAck(A, 'company:invite', { companyId: company.id, username: userC, departmentId: department.id })
  assert(invite2.ok, 'A 邀请 C 成功')
  const decline = await emitAck(C, 'company:declineInvite', { invitationId: invite2.invitation.id })
  assert(decline.ok, 'C 拒绝邀请成功')
  const statusAfter = await emitAck(A, 'company:listInvitations', { companyId: company.id })
  const declined = statusAfter.invites.find((i) => i.id === invite2.invitation.id)
  assert(declined && declined.status === 'declined', '邀请状态已更新为 declined')
  C.disconnect()

  A.disconnect()
  B.disconnect()
  console.log(failures === 0 ? '\nONBOARDING TEST PASS' : `\nONBOARDING TEST FAIL (${failures})`)
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error('onboarding test error:', err)
    process.exit(1)
  })
