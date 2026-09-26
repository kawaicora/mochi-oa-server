import type { Socket } from 'socket.io'
import { ok, fail } from '../util'
import type { Ctx } from './auth'
import type { Store } from '../db/store'
import type { HolidayType } from '../types'

type Ack = (res: Record<string, unknown>) => void

function authed(socket: Socket): { id: number } | null {
  return socket.data.auth ? (socket.data.auth as { id: number }) : null
}

/** 内置法定假期种子（依据《国务院办公厅关于2026年部分节假日安排的通知》国办发明电〔2025〕7号）。
 *  legal=法定放假日期（含假期内穿插的周六/周日），workday=调休补班上班日（周末上班）。 */
export async function seedHolidays(store: Store): Promise<void> {
  const seed: { date: string; name: string; type: HolidayType }[] = [
    // 元旦：1/1(四)-1/3(六)，1/4(日)补班
    { date: '2026-01-01', name: '元旦', type: 'legal' },
    { date: '2026-01-02', name: '元旦', type: 'legal' },
    { date: '2026-01-03', name: '元旦', type: 'legal' },
    { date: '2026-01-04', name: '元旦调休上班', type: 'workday' },
    // 春节：2/15(腊月廿八、日)-2/23(正月初七、一)，2/14(六)、2/28(六)补班
    { date: '2026-02-14', name: '春节调休上班', type: 'workday' },
    { date: '2026-02-15', name: '春节', type: 'legal' },
    { date: '2026-02-16', name: '春节', type: 'legal' },
    { date: '2026-02-17', name: '春节', type: 'legal' },
    { date: '2026-02-18', name: '春节', type: 'legal' },
    { date: '2026-02-19', name: '春节', type: 'legal' },
    { date: '2026-02-20', name: '春节', type: 'legal' },
    { date: '2026-02-21', name: '春节', type: 'legal' },
    { date: '2026-02-22', name: '春节', type: 'legal' },
    { date: '2026-02-23', name: '春节', type: 'legal' },
    { date: '2026-02-28', name: '春节调休上班', type: 'workday' },
    // 清明节：4/4(六)-4/6(一)，无调休
    { date: '2026-04-04', name: '清明节', type: 'legal' },
    { date: '2026-04-05', name: '清明节', type: 'legal' },
    { date: '2026-04-06', name: '清明节', type: 'legal' },
    // 劳动节：5/1(五)-5/5(二)，5/9(六)补班
    { date: '2026-05-01', name: '劳动节', type: 'legal' },
    { date: '2026-05-02', name: '劳动节', type: 'legal' },
    { date: '2026-05-03', name: '劳动节', type: 'legal' },
    { date: '2026-05-04', name: '劳动节', type: 'legal' },
    { date: '2026-05-05', name: '劳动节', type: 'legal' },
    { date: '2026-05-09', name: '劳动节调休上班', type: 'workday' },
    // 端午节：6/19(五)-6/21(日)，无调休
    { date: '2026-06-19', name: '端午节', type: 'legal' },
    { date: '2026-06-20', name: '端午节', type: 'legal' },
    { date: '2026-06-21', name: '端午节', type: 'legal' },
    // 中秋节：9/25(五)-9/27(日)，无调休
    { date: '2026-09-25', name: '中秋节', type: 'legal' },
    { date: '2026-09-26', name: '中秋节', type: 'legal' },
    { date: '2026-09-27', name: '中秋节', type: 'legal' },
    // 国庆节：10/1(四)-10/7(三)，9/20(日)、10/10(六)补班
    { date: '2026-09-20', name: '国庆调休上班', type: 'workday' },
    { date: '2026-10-01', name: '国庆节', type: 'legal' },
    { date: '2026-10-02', name: '国庆节', type: 'legal' },
    { date: '2026-10-03', name: '国庆节', type: 'legal' },
    { date: '2026-10-04', name: '国庆节', type: 'legal' },
    { date: '2026-10-05', name: '国庆节', type: 'legal' },
    { date: '2026-10-06', name: '国庆节', type: 'legal' },
    { date: '2026-10-07', name: '国庆节', type: 'legal' },
    { date: '2026-10-10', name: '国庆调休上班', type: 'workday' }
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
