// HTTP clients for TMDB, TVmaze and Trakt, with fetch stubbed out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))

const tmdb = await import('../../src/lib/tmdb.js')
const tvmaze = await import('../../src/lib/tvmaze.js')
const trakt = await import('../../src/lib/trakt.js')

type Route = (url: URL, init?: RequestInit) => Response | undefined
let routes: Route[] = []
const requests: { url: URL; init?: RequestInit }[] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  routes = []
  requests.length = 0
  vi.unstubAllEnvs()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, init })
    for (const route of routes) {
      const res = route(url, init)
      if (res) return res
    }
    return new Response('not found', { status: 404 })
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('tmdb client', () => {
  it('refuses to call TMDB without a key', async () => {
    await expect(tmdb.getShow(1)).rejects.toThrow(/not configured/)
  })

  it('sends a v4 token as a Bearer header', async () => {
    vi.stubEnv('TMDB_API_TOKEN', 'eyJ.v4.token')
    routes.push((url) => (url.pathname === '/3/tv/1' ? json({ id: 1 }) : undefined))
    await tmdb.getShow(1, 'fr-FR')
    const { url, init } = requests[0]!
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer eyJ.v4.token')
    expect(url.searchParams.get('language')).toBe('fr-FR')
    expect(url.searchParams.has('api_key')).toBe(false)
  })

  it('sends a v3 key as a query parameter, with the instance language by default', async () => {
    vi.stubEnv('TMDB_API_TOKEN', '0123456789abcdef0123456789abcdef')
    vi.stubEnv('TMDB_LANGUAGE', 'fr-FR')
    routes.push(() => json({ results: [] }))
    await tmdb.searchMovie('heat')
    const { url } = requests[0]!
    expect(url.searchParams.get('api_key')).toBe('0123456789abcdef0123456789abcdef')
    expect(url.searchParams.get('language')).toBe('fr-FR')
    expect(url.searchParams.get('query')).toBe('heat')
  })

  it('throws a TmdbError carrying the status', async () => {
    vi.stubEnv('TMDB_API_TOKEN', 'x.y')
    await expect(tmdb.getMovie(42)).rejects.toMatchObject({ status: 404 })
  })

  it('resolves a TheTVDB id, or null', async () => {
    vi.stubEnv('TMDB_API_TOKEN', 'x.y')
    routes.push((url) =>
      url.pathname === '/3/find/111' ? json({ tv_results: [{ id: 5, name: 'Found' }] }) : url.pathname.startsWith('/3/find/') ? json({ tv_results: [] }) : undefined,
    )
    expect(await tmdb.findShowByTvdbId(111)).toEqual({ id: 5, name: 'Found' })
    expect(await tmdb.findShowByTvdbId(222)).toBeNull()
  })
})

/** TMDB external ids for show 1, so TVmaze has something to look up by. */
function externalIds(ids: { tvdb_id: number | null; imdb_id: string | null }) {
  vi.stubEnv('TMDB_API_TOKEN', 'x.y')
  routes.push((url) => (url.pathname === '/3/tv/1/external_ids' ? json(ids) : undefined))
}

describe('tvmaze.getShowAirTimes', () => {
  const show = { id: 9, schedule: { time: '20:00' }, network: { country: { timezone: 'Europe/London' } } }

  it('collects instants by local air date, skipping unusable episodes', async () => {
    externalIds({ tvdb_id: 100, imdb_id: null })
    routes.push((url) => {
      if (url.pathname === '/lookup/shows') return json(show)
      if (url.pathname === '/shows/9/episodes')
        return json([
          { season: 1, number: 1, airdate: '2025-01-05', airstamp: '2025-01-05T20:00:00+00:00' },
          { season: 1, number: 2, airdate: '2025-01-12', airstamp: 'garbage' },
          // Unnumbered, but dated — the date is all the match needs now.
          { season: 0, number: null, airdate: '2025-01-19', airstamp: '2025-01-19T20:00:00+00:00' },
          { season: 1, number: 3, airdate: '2025-01-26', airstamp: null },
          { season: 1, number: 4, airdate: null, airstamp: '2025-02-02T20:00:00+00:00' },
        ])
      return undefined
    })
    expect(await tvmaze.getShowAirTimes(1)).toEqual({
      airs: { time: '20:00', timezone: 'Europe/London' },
      instantsByDate: new Map([
        ['2025-01-05', new Date('2025-01-05T20:00:00Z')],
        ['2025-01-19', new Date('2025-01-19T20:00:00Z')],
      ]),
    })
    expect(requests.some((r) => r.url.searchParams.get('specials') === '1')).toBe(true)
  })

  it("files an instant under TVmaze's airdate, not the UTC day of its airstamp", async () => {
    externalIds({ tvdb_id: 100, imdb_id: null })
    routes.push((url) => {
      if (url.pathname === '/lookup/shows') return json(show)
      // A late-evening broadcast west of UTC: the airstamp is already the next UTC day.
      if (url.pathname === '/shows/9/episodes')
        return json([{ season: 1, number: 1, airdate: '2025-01-05', airstamp: '2025-01-06T02:00:00+00:00' }])
      return undefined
    })
    expect((await tvmaze.getShowAirTimes(1))!.instantsByDate).toEqual(new Map([['2025-01-05', new Date('2025-01-06T02:00:00Z')]]))
  })

  it('falls back to the IMDb id when TheTVDB lookup misses', async () => {
    externalIds({ tvdb_id: 100, imdb_id: 'tt123' })
    routes.push((url) => (url.pathname === '/lookup/shows' && url.searchParams.get('imdb') === 'tt123' ? json({ ...show, network: null, webChannel: null }) : undefined))
    routes.push((url) => (url.pathname === '/shows/9/episodes' ? json([]) : undefined))
    // A global streamer has no country, hence no slot.
    expect(await tvmaze.getShowAirTimes(1)).toEqual({ airs: null, instantsByDate: new Map() })
  })

  it('is null when TMDB has no id to look it up by, when TVmaze 404s, or on an outage', async () => {
    externalIds({ tvdb_id: null, imdb_id: null })
    expect(await tvmaze.getShowAirTimes(1)).toBeNull()

    routes = []
    externalIds({ tvdb_id: 100, imdb_id: null })
    expect(await tvmaze.getShowAirTimes(1)).toBeNull()

    routes.push((url) => (url.host === 'api.tvmaze.com' ? new Response('', { status: 500 }) : undefined))
    expect(await tvmaze.getShowAirTimes(1)).toBeNull()
  })

  it('retries a 429 once after a pause', async () => {
    vi.useFakeTimers()
    externalIds({ tvdb_id: 100, imdb_id: null })
    let lookups = 0
    routes.push((url) => {
      if (url.pathname === '/lookup/shows') return ++lookups === 1 ? new Response('', { status: 429 }) : json(show)
      if (url.pathname === '/shows/9/episodes') return json([])
      return undefined
    })
    const pending = tvmaze.getShowAirTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).not.toBeNull()
    expect(lookups).toBe(2)
  })
})

describe('trakt.getShowAirTimes', () => {
  beforeEach(() => {
    vi.stubEnv('TRAKT_CLIENT_ID', 'client-id')
    vi.stubEnv('TRAKT_CLIENT_SECRET', 'client-secret')
  })

  it('is null without calling anything when the instance has no Trakt app', async () => {
    vi.stubEnv('TRAKT_CLIENT_ID', '')
    expect(await trakt.getShowAirTimes(1)).toBeNull()
    expect(requests).toEqual([])
  })

  it("collects first_aired by the show's local air date, and sends the API headers", async () => {
    routes.push((url) => {
      if (url.pathname === '/search/tmdb/1') return json([{ show: { ids: { trakt: 7 }, airs: { time: '21:00', timezone: 'America/New_York' } } }])
      if (url.pathname === '/shows/7/seasons')
        return json([
          {
            number: 1,
            episodes: [
              { season: 1, number: 1, first_aired: '2025-01-06T02:00:00.000Z' },
              { season: 1, number: 2, first_aired: null },
            ],
          },
        ])
      return undefined
    })
    expect(await trakt.getShowAirTimes(1)).toEqual({
      airs: { time: '21:00', timezone: 'America/New_York' },
      // 02:00Z on the 6th is 21:00 on the 5th in New York.
      instantsByDate: new Map([['2025-01-05', new Date('2025-01-06T02:00:00Z')]]),
    })
    const headers = requests[0]!.init!.headers as Record<string, string>
    expect(headers['trakt-api-key']).toBe('client-id')
    expect(headers['User-Agent']).toMatch(/Rewatch/)
  })

  it('asks the show summary when the search hit carries no slot', async () => {
    routes.push((url) => {
      if (url.pathname === '/search/tmdb/1') return json([{ show: { ids: { trakt: 7 } } }])
      if (url.pathname === '/shows/7') return json({ airs: { time: '20:00', timezone: 'Europe/Paris' } })
      if (url.pathname === '/shows/7/seasons') return json([])
      return undefined
    })
    expect(await trakt.getShowAirTimes(1)).toMatchObject({ airs: { time: '20:00', timezone: 'Europe/Paris' } })
  })

  it('is null when search finds nothing, or on an outage', async () => {
    routes.push((url) => (url.pathname === '/search/tmdb/1' ? json([]) : undefined))
    expect(await trakt.getShowAirTimes(1)).toBeNull()

    routes = [() => new Response('', { status: 502 })]
    expect(await trakt.getShowAirTimes(1)).toBeNull()
  })
})

describe('trakt device flow', () => {
  it.each([
    [200, 'ok'],
    [400, 'pending'],
    [429, 'pending'],
    [404, 'expired'],
    [410, 'expired'],
    [409, 'denied'],
    [418, 'denied'],
  ])('maps a %i poll reply to %s', async (status, expected) => {
    routes.push(() => (status === 200 ? json({ access_token: 'a', refresh_token: 'r', expires_in: 1, created_at: 1 }) : new Response('', { status })))
    expect((await trakt.pollDeviceToken('code')).status).toBe(expected)
  })
})
