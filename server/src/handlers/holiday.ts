import type { Socket } from 'socket.io'
import { ok, fail } from '../util'
import type { Ctx } from './auth'
import type { Store } from '../db/store'
import type { HolidayType } from '../types'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): { id: number } | null {
  return socket.data.auth ? (socket.data.auth as { id: number }) : null
}

/** 内置法定假期种子（当前年主要法定放假日期，type=legal；用户可在客户端增删改，多端同步） */
export async function seedHolidays(store: Store): Promise<void> {
  const seed: { date: string; name: string; type: HolidayType }[] = [
    { date: '2026-01-01', name: '元旦', type: 'legal' },
    { date: '2026-01-02', name: '元旦', type: 'legal' },
    { date: '2026-02-16', name: '春节', type: 'legal' },
    { date: '2026-02-17', name: '春节', type: 'legal' },
    { date: '2026-02-18', name: '春节', type: 'legal' },
    { date: '2026-02-19', name: '春节', type: 'legal' },
    { date: '2026-02-20', name: '春节', type: 'legal' },
    { date: '2026-04-05', name: '清明节', type: 'legal' },
    { date: '2026-04-06', name: '清明节', type: 'legal' },
    { date: '2026-05-01', name: '劳动节', type: 'legal' },
    { date: '2026-05-02', name: '劳动节', type: 'legal' },
    { date: '2026-06-19', name: '端午节', type: 'legal' },
    { date: '2026-06-20', name: '端午节', type: 'legal' },
    { date: '2026-09-25', name: '中秋节', type: 'legal' },
    { date: '2026-10-01', name: '国庆节', type: 'legal' },
    { date: '2026-10-02', name: '国庆节', type: 'legal' },
    { date: '2026-10-03', name: '国庆节', type: 'legal' },
    { date: '2026-10-04', name: '国庆节', type: 'legal' },
    { date: '2026-10-05', name: '国庆节', type: 'legal' }
  ]
  for (const s of seed) {
    try {
      await store.saveHoliday(s)
    } catch {
      // 忽略单条失败（已存在/并发）
    }
  }
}

export function registerHolidayHandlers(ctx: Ctx): void {
  const { io, store } = ctx

  io.on('connection', (socket) => {
    // ---- 假期列表（year 省略/0=全部） ----
    socket.on('holiday:list', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const year = Number((data as { year?: unknown } | null)?.year) || 0
      const holidays = await store.listHolidays(year || undefined)
      ack(ok({ holidays }))
    })

    // ---- 新增/修改假期（date 唯一） ----
    socket.on('holiday:add', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const d = (data ?? {}) as { date?: unknown; name?: unknown; type?: unknown }
      const date = typeof d.date === 'string' ? d.date.trim() : ''
      const name = typeof d.name === 'string' ? d.name.trim().slice(0, 32) : ''
      const type = typeof d.type === 'string' ? (d.type as HolidayType) : 'legal'
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ack(fail('日期格式不合法'))
      if (!name) return ack(fail('名称不能为空'))
      if (!['legal', 'workday', 'custom'].includes(type)) return ack(fail('类型不合法'))
      const holiday = await store.saveHoliday({ date, name, type })
      io.emit('holiday:updated', {})
      ack(ok({ holiday }))
    })

    // ---- 删除假期 ----
    socket.on('holiday:remove', async (data: unknown, cb?: Ack) => {
      const ack = cb ?? (() => {})
      const auth = authed(socket)
      if (!auth) return ack(fail('未登录'))
      const date = typeof (data as { date?: unknown } | null)?.date === 'string' ? (data as { date: string }).date : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ack(fail('日期格式不合法'))
      await store.deleteHoliday(date)
      io.emit('holiday:updated', {})
      ack(ok())
    })
  })
}
