import type { IceServer, ServerConfig } from './config'

/** 从 Cloudflare TURN API 动态获取 ICE 服务器（替代静态 ICE_SERVERS 配置）。
 * 端点：POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers
 * 返回 { iceServers: [{ urls, username, credential }] }，凭证有效期 ttl 秒。 */
export async function fetchCloudflareIce(config: ServerConfig): Promise<IceServer[] | null> {
  const cf = config.iceCloudflare
  if (!cf?.enabled) return null
  try {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cf.keyId)}/credentials/generate-ice-servers`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cf.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: cf.ttl })
    })
    if (res.status !== 200 && res.status !== 201) {
      console.error(`[mochioa-server] Cloudflare ICE 获取失败：${res.status} - ${await res.text().catch(() => '')}`)
      return null
    }
    const data = (await res.json()) as { iceServers?: IceServer[] }
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      console.error('[mochioa-server] Cloudflare ICE 返回空 iceServers')
      return null
    }
    return data.iceServers
  } catch (err) {
    console.error('[mochioa-server] Cloudflare ICE 请求异常：', err instanceof Error ? err.message : err)
    return null
  }
}

/** Cloudflare ICE 缓存（凭证 ttl 秒内复用，避免每次通话都打 CF API；提前 1 分钟过期） */
let cfCache: { servers: IceServer[]; expiresAt: number } | null = null

/** 获取用于下发客户端的 ICE servers：CF 开启时动态取 CF TURN；失败/未开启回退静态配置 */
export async function getIceServers(config: ServerConfig): Promise<IceServer[]> {
  const cf = config.iceCloudflare
  if (cf?.enabled) {
    const now = Date.now()
    if (cfCache && cfCache.expiresAt > now) return cfCache.servers
    const servers = await fetchCloudflareIce(config)
    if (servers && servers.length > 0) {
      cfCache = { servers, expiresAt: now + cf.ttl * 1000 - 60_000 }
      console.log(`[mochioa-server] Cloudflare ICE 已下发 ${servers.length} 个 server，ttl=${cf.ttl}s`)
      return servers
    }
    console.warn('[mochioa-server] Cloudflare ICE 不可用，回退静态 ICE_SERVERS')
  }
  return config.iceServers
}
