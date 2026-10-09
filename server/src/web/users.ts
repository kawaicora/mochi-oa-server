/**
 * 网页端「用户管理」页（/view/admin → 用户管理）：
 *   - 用户表格：id/用户名/昵称/头像/手机/邮箱/所属公司
 *   - 编辑用户：昵称/头像/手机/邮箱（admin:updateUser，邮箱查重）
 * 数据层：服务端 admin-users.ts handler（仅 SERVER_ADMIN）
 */

export function buildUsersHtml(): string {
  return `
  <div id="users-wrap">
    <div class="page-head"><span class="ph-title">用户管理</span><button class="mini-btn" id="users-refresh">刷新</button></div>
    <div class="user-table" id="user-table"><div class="empty">加载中…</div></div>
  </div>

  <!-- 编辑用户弹窗 -->
  <div id="user-edit" class="modal" style="display:none">
    <div class="modal-inner ue-inner">
      <div class="modal-title">编辑用户 <span id="ue-id" class="ue-id"></span></div>
      <div class="modal-sub" id="ue-name">—</div>
      <label>昵称</label><input id="ue-nick" type="text">
      <label>手机</label><input id="ue-phone" type="text">
      <label>邮箱</label><input id="ue-email" type="text">
      <label>头像 URL</label><input id="ue-avatar" type="text">
      <div class="modal-btns">
        <button class="btn ghost" id="ue-cancel">取消</button>
        <button class="btn" id="ue-save">保存</button>
      </div>
    </div>
  </div>
  `
}

export function buildUsersJs(): string {
  return `
;(function () {
  const A = window.__admin
  if (!A) return
  const $ = (id) => document.getElementById(id)
  const U = (A.users = A.users || {})
  U.list = []
  U.editing = null

  U.load = async function () {
    $('user-table').innerHTML = '<div class="empty">加载中…</div>'
    const ack = await A.emit('admin:listUsers', {}).catch(() => ({ ok: false }))
    if (!ack.ok) { $('user-table').innerHTML = '<div class="empty">' + A.esc(ack.error || '获取用户失败') + '</div>'; return }
    U.list = ack.users || []
    U.render()
  }

  U.render = function () {
    const box = $('user-table')
    if (!U.list.length) { box.innerHTML = '<div class="empty">暂无用户</div>'; return }
    const head = '<div class="ut-head"><span>ID</span><span>用户名</span><span>昵称</span><span>头像</span><span>手机</span><span>邮箱</span><span>所属公司</span><span>操作</span></div>'
    const rows = U.list.map((u) => {
      const cs = (u.companies || []).map((c) => c.name + '(' + c.role + ')').join('，') || '—'
      const av = u.avatar ? '<img src="' + A.esc(u.avatar) + '" style="width:28px;height:28px;border-radius:50%;object-fit:cover" onerror="this.style.display=\\'none\\'">' : ''
      return (
        '<div class="ut-row">' +
        '<span>' + u.id + '</span>' +
        '<span>' + A.esc(u.username) + '</span>' +
        '<span>' + A.esc(u.nick || '') + '</span>' +
        '<span>' + av + '</span>' +
        '<span>' + A.esc(u.phone || '') + '</span>' +
        '<span>' + A.esc(u.email || '') + '</span>' +
        '<span>' + A.esc(cs) + '</span>' +
        '<span><button class="mini-btn" data-edit="' + u.id + '">编辑</button></span>' +
        '</div>'
      )
    })
    box.innerHTML = head + rows.join('')
    box.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => U.openEdit(Number(b.getAttribute('data-edit'))) })
  }

  U.openEdit = function (id) {
    const u = U.list.find((x) => x.id === id)
    if (!u) return
    U.editing = u
    $('ue-id').textContent = '#' + u.id
    $('ue-name').textContent = u.username + (u.nick ? '（' + u.nick + '）' : '')
    $('ue-nick').value = u.nick || ''
    $('ue-phone').value = u.phone || ''
    $('ue-email').value = u.email || ''
    $('ue-avatar').value = u.avatar || ''
    $('user-edit').style.display = ''
  }

  U.save = async function () {
    if (!U.editing) return
    const patch = {
      nick: $('ue-nick').value.trim(),
      phone: $('ue-phone').value.trim(),
      email: $('ue-email').value.trim(),
      avatar: $('ue-avatar').value.trim()
    }
    const ack = await A.emit('admin:updateUser', { userId: U.editing.id, patch }).catch(() => ({ ok: false }))
    if (!ack.ok) { A.toast(ack.error || '保存失败'); return }
    $('user-edit').style.display = 'none'
    U.editing = null
    A.toast('已保存')
    U.load()
  }

  U.init = function () {
    if (U._inited) return
    U._inited = true
    U.load()
    $('users-refresh').onclick = U.load
    $('ue-cancel').onclick = () => { $('user-edit').style.display = 'none'; U.editing = null }
    $('ue-save').onclick = U.save
  }
})()
`
}
