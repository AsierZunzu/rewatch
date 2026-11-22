// Air-time resolution end to end: provider replies (faked at the fetch level) →
// mergeAirTimes → applyExactInstantsSql / resolveAirsAtSql run by real Postgres.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userToday } from '../../src/lib/airing.js'
import { cacheShow, syncShowAirTimes } from '../../src/lib/catalog.js'
import { prisma } from '../../src/lib/prisma.js'
import { addShow, resetTmdb } from './fake-tmdb.js'
import { ALPHA, seedAlpha } from './fixtures.js'
import { installFakeFetch, isoDay, json, onFetch, resetDb } from './helpers.js'

vi.mock('../../src/lib/tmdb.js', () => import('./fake-tmdb.js'))

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

beforeEach(async () => {
  await resetDb()
  installFakeFetch()
  resetTmdb()
  seedAlpha()
  vi.unstubAllEnvs()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const episode = (season: number, number: number) =>
  prisma.episode.findUniqueOrThrow({ where: { showTmdbId_season_number: { showTmdbId: ALPHA, season, number } } })
const show = () => prisma.show.findUniqueOrThrow({ where: { tmdbId: ALPHA } })

/** Wall-clock "HH:MM" and "YYYY-MM-DD" of an instant in a zone. */
const clockIn = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
const dateIn = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

/** The day after `date`, "YYYY-MM-DD". */
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10)

/** 21:00 in `timeZone` on `date`, as a UTC instant (whatever the DST offset). */
function nineInTheEvening(date: string, timeZone: string) {
  for (let offset = 0; offset <= 12; offset++) {
    const at = new Date(Date.parse(`${date}T21:00:00Z`) + offset * HOUR)
    if (clockIn(at, timeZone) === '21:00' && dateIn(at, timeZone) === date) return at
  }
  throw new Error('unreachable')
}

/** TVmaze's own season/number, which need not be TMDB's — the match is on `airdate`. */
type TvmazeEpisode = { season: number; number: number; airdate: string; airstamp: string }

/** A TVmaze episode going out at 21:00 New York time on `airdate`. */
const tvmazeAt = (season: number, number: number, airdate: string): TvmazeEpisode => ({
  season,
  number,
  airdate,
  airstamp: nineInTheEvening(airdate, 'America/New_York').toISOString(),
})

/** TVmaze carries ALPHA (TheTVDB 5001) with a 21:00 New York slot. */
function tvmaze(episodes: TvmazeEpisode[], { status = 200 } = {}) {
  onFetch((url) => {
    if (url.host !== 'api.tvmaze.com') return undefined
    if (status !== 200) return new Response('', { status })
    if (url.pathname === '/lookup/shows' && url.searchParams.get('thetvdb') === '5001')
      return json({ id: 77, schedule: { time: '21:00', days: ['Sunday'] }, network: { country: { timezone: 'America/New_York' } } })
    if (url.pathname === '/shows/77/episodes') return json(episodes)
    return undefined
  })
}

/** S2E1 aired 9 days ago at 21:00 New York time, per TVmaze. */
const s2e1 = () => tvmazeAt(2, 1, isoDay(-9))

describe('without any provider', () => {
  it('falls back to the end of the air date in the origin country', async () => {
    await cacheShow(ALPHA)
    const ep = await episode(1, 1)
    expect(ep.airsAtSource).toBe('FALLBACK')
    // US → America/Los_Angeles: midnight opening the next day, local.
    expect(clockIn(ep.airsAt!, 'America/Los_Angeles')).toBe('00:00')
    expect(dateIn(ep.airsAt!, 'America/Los_Angeles')).toBe(nextDay(isoDay(-60)))
  })

  it('leaves undated episodes without an instant', async () => {
    await cacheShow(ALPHA)
    expect((await episode(2, 4)).airsAt).toBeNull()
  })

  it('does not mark the show as enriched', async () => {
    await cacheShow(ALPHA)
    expect((await show()).airsCachedAt).toBeNull()
  })
})

describe('with TVmaze', () => {
  it('takes exact instants per episode and resolves the rest from the slot', async () => {
    tvmaze([s2e1()])
    await cacheShow(ALPHA)

    const exact = await episode(2, 1)
    expect(exact.airsAtSource).toBe('TVMAZE')
    expect(exact.airsAt!.toISOString()).toBe(s2e1().airstamp)

    // No instant of its own, but the show now has a slot: 21:00 New York on its date.
    const scheduled = await episode(1, 1)
    expect(scheduled.airsAtSource).toBe('SCHEDULE')
    expect(clockIn(scheduled.airsAt!, 'America/New_York')).toBe('21:00')
    expect(dateIn(scheduled.airsAt!, 'America/New_York')).toBe(isoDay(-60))

    const s = await show()
    expect(s).toMatchObject({ airsTime: '21:00', airsTimezone: 'America/New_York' })
    expect(s.airsCachedAt).not.toBeNull()
  })

  it('demotes an episode the provider stops timing', async () => {
    tvmaze([s2e1()])
    await cacheShow(ALPHA)
    expect((await episode(2, 1)).airsAtSource).toBe('TVMAZE')

    installFakeFetch()
    tvmaze([]) // still carries the show, no longer times S2E1
    await syncShowAirTimes(ALPHA)
    expect((await episode(2, 1)).airsAtSource).toBe('SCHEDULE')
  })

  it('keeps instants and slot when the provider is down', async () => {
    tvmaze([s2e1()])
    await cacheShow(ALPHA)

    installFakeFetch()
    tvmaze([], { status: 503 })
    await syncShowAirTimes(ALPHA)

    expect((await episode(2, 1)).airsAtSource).toBe('TVMAZE')
    expect(await show()).toMatchObject({ airsTime: '21:00', airsTimezone: 'America/New_York' })
  })
})

describe('matching provider instants to episodes', () => {
  it('matches on the air date when the provider numbers seasons differently (Futurama)', async () => {
    // TheTVDB groups the show into more seasons than TMDB, so TVmaze's S5E1 is
    // TMDB's S2E1 — and TVmaze's own "S2E3" is an episode from over a year ago.
    // Keyed on season/number, TMDB's upcoming S2E3 inherited that old instant
    // and was shown as long aired.
    const old = tvmazeAt(2, 3, isoDay(-400))
    tvmaze([old, tvmazeAt(5, 1, isoDay(-9))])
    await cacheShow(ALPHA)

    const matched = await episode(2, 1)
    expect(matched.airsAtSource).toBe('TVMAZE')
    expect(matched.airsAt!.toISOString()).toBe(tvmazeAt(5, 1, isoDay(-9)).airstamp)

    const upcoming = await episode(2, 3)
    expect(upcoming.airsAtSource).toBe('SCHEDULE')
    expect(upcoming.airsAt!.getTime()).toBeGreaterThan(Date.now())
    expect(upcoming.airsAt!.toISOString()).not.toBe(old.airstamp)
  })

  it('refuses an instant that lands far from the date it is filed under', async () => {
    // The provider claims the date of TMDB's upcoming S2E3 but times it years
    // ago: two catalogues describing different episodes, not a timezone.
    tvmaze([{ ...tvmazeAt(2, 3, isoDay(5)), airstamp: nineInTheEvening(isoDay(-1000), 'America/New_York').toISOString() }])
    await cacheShow(ALPHA)

    const ep = await episode(2, 3)
    expect(ep.airsAtSource).toBe('SCHEDULE')
    expect(ep.airsAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('takes an instant filed a day after the TMDB date (Apple TV+ drops)', async () => {
    // TVmaze files a global streaming drop on the network's listed day, TMDB on
    // the day before. An exact match left whole seasons with no time at all.
    const drop = tvmazeAt(1, 2, nextDay(isoDay(-3)))
    tvmaze([drop])
    await cacheShow(ALPHA)

    const ep = await episode(2, 2)
    expect(ep.airsAtSource).toBe('TVMAZE')
    expect(ep.airsAt!.toISOString()).toBe(drop.airstamp)
  })

  it('prefers the exact date over a neighbouring one', async () => {
    tvmaze([tvmazeAt(2, 1, isoDay(-9)), tvmazeAt(2, 99, isoDay(-8))])
    await cacheShow(ALPHA)
    expect((await episode(2, 1)).airsAt!.toISOString()).toBe(tvmazeAt(2, 1, isoDay(-9)).airstamp)
  })

  it("never takes a neighbouring date another episode claims exactly", async () => {
    // Two TMDB episodes a day apart, and the provider only times the second.
    addShow({
      id: ALPHA,
      name: 'Alpha',
      tvdbId: 5001,
      seasons: [
        {
          number: 1,
          episodes: [
            { number: 1, airDate: isoDay(-9) },
            { number: 2, airDate: isoDay(-8) },
          ],
        },
      ],
    })
    tvmaze([tvmazeAt(1, 2, isoDay(-8))])
    await cacheShow(ALPHA)

    expect((await episode(1, 2)).airsAtSource).toBe('TVMAZE')
    const first = await episode(1, 1)
    expect(first.airsAtSource).toBe('SCHEDULE')
    expect(dateIn(first.airsAt!, 'America/New_York')).toBe(isoDay(-9))
  })

  it('wipes a provider instant left on an episode TMDB no longer dates', async () => {
    tvmaze([s2e1()])
    await cacheShow(ALPHA)
    // What the season-keyed match used to leave behind: a past instant on the
    // undated S2E4, read everywhere as "already aired".
    await prisma.episode.update({
      where: { showTmdbId_season_number: { showTmdbId: ALPHA, season: 2, number: 4 } },
      data: { airsAt: new Date(Date.now() - 30 * DAY), airsAtSource: 'TVMAZE' },
    })

    await syncShowAirTimes(ALPHA)
    expect(await episode(2, 4)).toMatchObject({ airsAt: null, airsAtSource: null })
  })
})

describe('with Trakt and TVmaze together', () => {
  it('prefers Trakt on an episode both providers time, and its slot', async () => {
    vi.stubEnv('TRAKT_CLIENT_ID', 'id')
    vi.stubEnv('TRAKT_CLIENT_SECRET', 'secret')
    const traktAt = nineInTheEvening(isoDay(-9), 'America/Chicago')

    onFetch((url) => {
      if (url.host !== 'api.trakt.tv') return undefined
      if (url.pathname === `/search/tmdb/${ALPHA}`)
        return json([{ show: { ids: { trakt: 1 }, airs: { day: 'Sunday', time: '21:00', timezone: 'America/Chicago' } } }])
      if (url.pathname === '/shows/1/seasons')
        return json([{ number: 2, episodes: [{ season: 2, number: 1, first_aired: traktAt.toISOString() }] }])
      return undefined
    })
    tvmaze([s2e1(), tvmazeAt(2, 2, isoDay(-3))])

    await cacheShow(ALPHA)

    const both = await episode(2, 1)
    expect(both.airsAtSource).toBe('TRAKT')
    expect(both.airsAt!.toISOString()).toBe(traktAt.toISOString())
    // Trakt has nothing for S2E2, so TVmaze fills it.
    expect((await episode(2, 2)).airsAtSource).toBe('TVMAZE')
    expect(await show()).toMatchObject({ airsTime: '21:00', airsTimezone: 'America/Chicago' })
  })
})

describe('userToday', () => {
  it("is the viewer's local date, as UTC midnight", async () => {
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const today = await userToday(prisma, tz)
      expect(today.toISOString()).toBe(`${dateIn(new Date(), tz)}T00:00:00.000Z`)
    }
  })
})
