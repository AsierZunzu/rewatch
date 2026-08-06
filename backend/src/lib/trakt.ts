// Trakt.tv API client: OAuth device flow + sync endpoints.
// The instance operator registers one Trakt app (client id/secret in the
// admin settings); each user then connects their own account.
import { prisma } from './prisma.js'
import { getSetting } from './settings.js'
import type { ShowAirTimes } from './airing.js'

// Overridable for the e2e stub server — leave unset in production.
const BASE = process.env.TRAKT_API_URL || 'https://api.trakt.tv'

export const traktConfigured = () =>
  getSetting('TRAKT_CLIENT_ID') !== undefined && getSetting('TRAKT_CLIENT_SECRET') !== undefined

function headers(accessToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': getSetting('TRAKT_CLIENT_ID') ?? '',
    // Trakt sits behind Cloudflare, which 403s UA-less requests — and
    // Node's fetch sends no User-Agent by default.
    'User-Agent': 'Rewatch (github.com/gulian/rewatch)',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }
}

// ——— Device flow ———

export type DeviceCode = {
  device_code: string
  user_code: string
  verification_url: string
  expires_in: number
  interval: number
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  const res = await fetch(`${BASE}/oauth/device/code`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ client_id: getSetting('TRAKT_CLIENT_ID') }),
  })
  if (!res.ok) throw new Error(`trakt device/code: ${res.status}`)
  return (await res.json()) as DeviceCode
}

/** One poll tick. 'pending' → keep polling; 'denied'/'expired' → stop. */
export async function pollDeviceToken(
  deviceCode: string,
): Promise<{ status: 'ok'; tokens: TokenResponse } | { status: 'pending' | 'denied' | 'expired' }> {
  const res = await fetch(`${BASE}/oauth/device/token`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      code: deviceCode,
      client_id: getSetting('TRAKT_CLIENT_ID'),
      client_secret: getSetting('TRAKT_CLIENT_SECRET'),
    }),
  })
  if (res.ok) return { status: 'ok', tokens: (await res.json()) as TokenResponse }
  if (res.status === 400 || res.status === 429) return { status: 'pending' }
  if (res.status === 410 || res.status === 404) return { status: 'expired' }
  return { status: 'denied' } // 409/418
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; created_at: number }

export async function saveTokens(userId: number, tokens: TokenResponse) {
  const expiresAt = new Date((tokens.created_at + tokens.expires_in) * 1000)
  await prisma.traktAccount.upsert({
    where: { userId },
    create: { userId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt },
    update: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt },
  })
  // Best effort: display name for the UI.
  try {
    const settings = await apiGet<{ user: { username: string } }>(userId, '/users/settings')
    await prisma.traktAccount.update({ where: { userId }, data: { username: settings.user.username } })
  } catch {
    /* not fatal */
  }
}

async function refreshTokens(userId: number, refreshToken: string): Promise<string> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: getSetting('TRAKT_CLIENT_ID'),
      client_secret: getSetting('TRAKT_CLIENT_SECRET'),
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    // Refresh token dead (revoked on Trakt's side): drop the connection so
    // the UI shows "connect" again instead of failing forever.
    await prisma.traktAccount.delete({ where: { userId } }).catch(() => {})
    throw new Error('trakt_disconnected')
  }
  const tokens = (await res.json()) as TokenResponse
  await saveTokens(userId, tokens)
  return tokens.access_token
}

async function accessTokenFor(userId: number): Promise<string> {
  const account = await prisma.traktAccount.findUnique({ where: { userId } })
  if (!account) throw new Error('trakt_not_connected')
  if (account.expiresAt.getTime() - Date.now() > 60_000) return account.accessToken
  return refreshTokens(userId, account.refreshToken)
}

// ——— Authenticated API helpers ———

async function apiGet<T>(userId: number, path: string): Promise<T> {
  const token = await accessTokenFor(userId)
  const res = await fetch(`${BASE}${path}`, { headers: headers(token) })
  if (!res.ok) throw new Error(`trakt GET ${path}: ${res.status}`)
  return (await res.json()) as T
}

export async function apiPost<T>(userId: number, path: string, body: unknown): Promise<T> {
  const token = await accessTokenFor(userId)
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`trakt POST ${path}: ${res.status}`)
  return (await res.json()) as T
}

/** Paginated GET: concatenates all pages (100 items each). */
export async function apiGetAll<T>(userId: number, path: string, onPage?: (page: number, total: number) => void): Promise<T[]> {
  const out: T[] = []
  let page = 1
  let pageCount = 1
  do {
    const token = await accessTokenFor(userId)
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${BASE}${path}${sep}page=${page}&limit=100`, { headers: headers(token) })
    if (!res.ok) throw new Error(`trakt GET ${path}: ${res.status}`)
    pageCount = Number(res.headers.get('x-pagination-page-count') ?? 1)
    out.push(...((await res.json()) as T[]))
    onPage?.(page, pageCount)
    page++
  } while (page <= pageCount)
  return out
}

// ——— Typed sync payloads ———

export type TraktIds = { trakt?: number; tmdb?: number; imdb?: string; tvdb?: number }
export type TraktHistoryItem = {
  watched_at: string
  type: 'episode' | 'movie'
  episode?: { season: number; number: number; ids: TraktIds }
  show?: { title: string; ids: TraktIds }
  movie?: { title: string; year?: number; ids: TraktIds }
}
export type TraktRatingItem = {
  rated_at: string
  rating: number // 1-10
  type: 'show' | 'movie' | 'episode' | 'season'
  show?: { ids: TraktIds }
  movie?: { ids: TraktIds }
}
export type TraktWatchlistItem = {
  type: 'show' | 'movie' | 'episode' | 'season'
  show?: { ids: TraktIds }
  movie?: { ids: TraktIds }
}

export const getHistory = (userId: number, onPage?: (p: number, t: number) => void) =>
  apiGetAll<TraktHistoryItem>(userId, '/sync/history', onPage)
export const getHistorySince = (userId: number, since: Date) =>
  apiGetAll<TraktHistoryItem>(userId, `/sync/history?start_at=${encodeURIComponent(since.toISOString())}`)
export const getLastActivities = (userId: number) =>
  apiGet<{ episodes?: { watched_at?: string }; movies?: { watched_at?: string } }>(userId, '/sync/last_activities')
export const getRatings = (userId: number) => apiGetAll<TraktRatingItem>(userId, '/sync/ratings')
export const getWatchlist = (userId: number) => apiGetAll<TraktWatchlistItem>(userId, '/sync/watchlist')

// ——— Public catalog: air times ———
//
// Show metadata is public on Trakt — these endpoints need the instance api key
// and no user token, so air times work even for users who never connected an
// account. TMDB has no air time at all (only `air_date`), which is why this
// exists: Trakt computes `first_aired` in UTC from the episode's air date and
// the show's country and slot.

/** Unauthenticated GET. Returns null on 404 so a missing show is not an error. */
async function apiGetPublic<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, { headers: headers() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`trakt GET ${path}: ${res.status}`)
  return (await res.json()) as T
}

type TraktAirs = { day?: string | null; time?: string | null; timezone?: string | null }
type TraktSeasonWithEpisodes = {
  number: number
  episodes?: { season: number; number: number; first_aired?: string | null }[]
}

/**
 * Air times for one show, looked up by TMDB id.
 *
 * Returns null — never throws — when Trakt is not configured on this instance,
 * does not know the show, or is unreachable. Callers fall back to resolving the
 * air date against the show's origin country, so this is pure enrichment.
 */
export async function getShowAirTimes(tmdbId: number): Promise<ShowAirTimes | null> {
  if (!traktConfigured()) return null

  try {
    // `extended=full` on search already carries `airs`, saving a summary call.
    const results = await apiGetPublic<{ show?: { ids: TraktIds; airs?: TraktAirs } }[]>(
      `/search/tmdb/${tmdbId}?type=show&extended=full`,
    )
    const match = results?.[0]?.show
    const traktId = match?.ids.trakt
    if (!traktId) return null

    // Older Trakt responses omit `airs` from search hits — ask directly.
    let airs = match.airs
    if (!airs?.time || !airs.timezone) {
      airs = (await apiGetPublic<{ airs?: TraktAirs }>(`/shows/${traktId}?extended=full`))?.airs
    }

    const seasons =
      (await apiGetPublic<TraktSeasonWithEpisodes[]>(`/shows/${traktId}/seasons?extended=episodes,full`)) ?? []

    const firstAired = new Map<string, Date>()
    for (const season of seasons) {
      for (const ep of season.episodes ?? []) {
        if (!ep.first_aired) continue
        const at = new Date(ep.first_aired)
        if (!Number.isNaN(at.getTime())) firstAired.set(`${ep.season}:${ep.number}`, at)
      }
    }

    return {
      airs: airs?.time && airs.timezone ? { time: airs.time, timezone: airs.timezone } : null,
      firstAired,
    }
  } catch (err) {
    // Rate limits, outages, schema drift: none of these should break caching a show.
    console.warn(`trakt air times unavailable for tmdb:${tmdbId}: ${(err as Error).message}`)
    return null
  }
}
