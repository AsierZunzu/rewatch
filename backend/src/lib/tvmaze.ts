// TVmaze air times. Keyless: no app to register, no per-instance setting, so
// unlike Trakt this source is always available.
//
// TVmaze is a schedule database rather than a catalogue — every episode carries
// an `airstamp` (an absolute instant) and every show a `schedule` plus the
// broadcaster's IANA timezone. That is exactly what TMDB does not have and what
// `resolveAirsAtSql` needs.
//
// Docs: https://www.tvmaze.com/api
import * as tmdb from './tmdb.js'
import type { ShowAirTimes } from './airing.js'

// Overridable for the e2e stub server — leave unset in production.
const BASE = process.env.TVMAZE_API_URL || 'https://api.tvmaze.com'

// Anonymous callers get roughly 20 requests per 10 seconds per IP. A single
// show costs at most three, but a bulk re-cache walks hundreds in a row, so a
// 429 is retried once rather than dropped — losing a show's air times to a
// momentary limit would leave it on the coarse fallback for a week.
const RETRY_AFTER_MS = 2_000

// A 429 usually carries `Retry-After`, in seconds. Honour it: retrying sooner
// than the server asked just spends the one retry we have. Cap it all the same,
// because this also runs inside a show-page request, where a caller that never
// returns is worse than a show that stays on the fallback.
const MAX_RETRY_AFTER_MS = 10_000

function retryDelay(res: Response) {
  // Missing, empty, or an HTTP-date rather than a count of seconds: all land on
  // NaN or 0 here, and all mean "we were not told", so fall back to the guess.
  const seconds = Number(res.headers.get('retry-after'))
  if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_AFTER_MS
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

type TvmazeCountry = { timezone?: string | null } | null

type TvmazeShow = {
  id: number
  schedule?: { time?: string | null; days?: string[] } | null
  network?: { country?: TvmazeCountry } | null
  webChannel?: { country?: TvmazeCountry } | null
}

type TvmazeEpisode = {
  season: number | null
  number: number | null
  airstamp?: string | null
}

/** GET returning null on 404 (unknown show) so lookups can just try the next id. */
async function api<T>(path: string, retry = true): Promise<T | null> {
  const res = await fetch(BASE + path, {
    headers: { 'User-Agent': 'Rewatch (github.com/gulian/rewatch)' },
  })
  if (res.status === 404) return null
  if (res.status === 429 && retry) {
    await new Promise((resolve) => setTimeout(resolve, retryDelay(res)))
    return api<T>(path, false)
  }
  if (!res.ok) throw new Error(`TVmaze ${res.status} on ${path}`)
  return res.json() as Promise<T>
}

/**
 * TheTVDB id first: it is what TVmaze itself is keyed on for televised shows,
 * and it is numeric, so there is no formatting to get wrong. IMDb is the
 * fallback, and covers streaming-only shows TheTVDB may not carry.
 *
 * `/lookup/shows` answers with a redirect to `/shows/:id`, which fetch follows,
 * so one call already yields the full show object.
 */
async function lookupShow(ids: { tvdb_id: number | null; imdb_id: string | null }) {
  if (ids.tvdb_id) {
    const byTvdb = await api<TvmazeShow>(`/lookup/shows?thetvdb=${ids.tvdb_id}`)
    if (byTvdb) return byTvdb
  }
  if (ids.imdb_id) return await api<TvmazeShow>(`/lookup/shows?imdb=${encodeURIComponent(ids.imdb_id)}`)
  return null
}

/**
 * The broadcaster's timezone. `network` is the televised channel, `webChannel`
 * the streaming one; a show has one or the other. Global services (Netflix and
 * friends) carry a null country, which is honest — a worldwide drop has no
 * single local slot — and leaves the per-episode `airstamp` to do the work.
 */
const showTimezone = (show: TvmazeShow) =>
  show.network?.country?.timezone ?? show.webChannel?.country?.timezone ?? null

/**
 * Air times for one show, looked up by TMDB id.
 *
 * Returns null — never throws — when TVmaze does not know the show or is
 * unreachable, matching `trakt.getShowAirTimes()`. Callers fall back to the
 * other provider and ultimately to the origin-country bound, so this is pure
 * enrichment.
 */
export async function getShowAirTimes(tmdbId: number): Promise<ShowAirTimes | null> {
  try {
    const ids = await tmdb.getShowExternalIds(tmdbId)
    if (!ids.tvdb_id && !ids.imdb_id) return null

    const show = await lookupShow(ids)
    if (!show) return null

    // `specials=1` so season 0 is dated too — TMDB numbers specials as season 0
    // and the show page lists them like any other episode.
    const episodes = (await api<TvmazeEpisode[]>(`/shows/${show.id}/episodes?specials=1`)) ?? []

    const firstAired = new Map<string, Date>()
    for (const ep of episodes) {
      // Specials TVmaze cannot place in the numbering carry a null number; there
      // is no key to match them on, so they stay on the fallback.
      if (ep.season === null || ep.number === null || !ep.airstamp) continue
      const at = new Date(ep.airstamp)
      if (!Number.isNaN(at.getTime())) firstAired.set(`${ep.season}:${ep.number}`, at)
    }

    const timezone = showTimezone(show)
    return {
      airs: show.schedule?.time && timezone ? { time: show.schedule.time, timezone } : null,
      firstAired,
    }
  } catch (err) {
    // Rate limits, outages, schema drift: none of these should break caching a show.
    console.warn(`tvmaze air times unavailable for tmdb:${tmdbId}: ${(err as Error).message}`)
    return null
  }
}
