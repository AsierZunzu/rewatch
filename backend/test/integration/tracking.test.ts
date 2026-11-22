import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { resetTmdb } from './fake-tmdb.js'
import { ALPHA, INCEPTION, OMEGA, seedCatalog } from './fixtures.js'
import { call, createUser, fetchCalls, flush, installFakeFetch, resetDb, startApp } from './helpers.js'

vi.mock('../../src/lib/tmdb.js', () => import('./fake-tmdb.js'))

let app: FastifyInstance
let cookie: string
let userId: number

beforeAll(async () => {
  app = await startApp()
})
afterAll(async () => {
  await app.close()
})
beforeEach(async () => {
  await resetDb()
  installFakeFetch()
  resetTmdb()
  seedCatalog()
  ;({ cookie, user: { id: userId } } = await createUser())
})

const episodeId = async (show: number, season: number, number: number) =>
  (await prisma.episode.findUniqueOrThrow({ where: { showTmdbId_season_number: { showTmdbId: show, season, number } } })).id

const watchedCodes = async () =>
  (
    await prisma.watchEvent.findMany({
      where: { userId, episodeId: { not: null } },
      include: { episode: true },
      orderBy: [{ episode: { season: 'asc' } }, { episode: { number: 'asc' } }],
    })
  ).map((w) => `S${w.episode!.season}E${w.episode!.number}`)

describe('following a show', () => {
  it('caches the show from TMDB and follows it as WATCHING', async () => {
    const res = await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    expect(res.statusCode).toBe(200)
    expect(res.data).toMatchObject({ userId, showTmdbId: ALPHA, state: 'WATCHING' })

    const show = await prisma.show.findUniqueOrThrow({ where: { tmdbId: ALPHA }, include: { episodes: true } })
    expect(show.name).toBe('Alpha')
    expect(show.episodes).toHaveLength(8)
    // Every dated episode leaves caching with an air instant.
    expect(show.episodes.filter((e) => e.airDate && !e.airsAt)).toEqual([])
  })

  it('changes state, then unfollows', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    const archived = await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie, body: { state: 'ARCHIVED' } })
    expect(archived.data.state).toBe('ARCHIVED')
    expect((await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie, body: { state: 'BOGUS' } })).statusCode).toBe(400)

    await call(app, 'DELETE', `/api/shows/${ALPHA}/follow`, { cookie })
    expect(await prisma.follow.count({ where: { userId } })).toBe(0)
  })

  it('surfaces an unknown TMDB id as an error, not a follow', async () => {
    const res = await call(app, 'PUT', '/api/shows/999999/follow', { cookie })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(await prisma.follow.count()).toBe(0)
  })

  it('rejects a non-numeric id', async () => {
    expect((await call(app, 'PUT', '/api/shows/abc/follow', { cookie })).statusCode).toBe(400)
  })
})

describe('episodes', () => {
  beforeEach(async () => {
    await call(app, 'GET', `/api/shows/${ALPHA}`, { cookie }) // caches without following
  })

  it('marking an episode watched follows the show, without overriding an existing state', async () => {
    const id = await episodeId(ALPHA, 1, 1)
    expect((await call(app, 'POST', `/api/episodes/${id}/watch`, { cookie })).statusCode).toBe(200)
    expect((await prisma.follow.findFirstOrThrow({ where: { userId } })).state).toBe('WATCHING')

    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie, body: { state: 'ARCHIVED' } })
    await call(app, 'POST', `/api/episodes/${await episodeId(ALPHA, 1, 2)}/watch`, { cookie })
    expect((await prisma.follow.findFirstOrThrow({ where: { userId } })).state).toBe('ARCHIVED')
  })

  it('keeps every rewatch, and unwatching removes them all', async () => {
    const id = await episodeId(ALPHA, 1, 1)
    await call(app, 'POST', `/api/episodes/${id}/watch`, { cookie, body: { watchedAt: '2024-01-01T20:00:00Z' } })
    await call(app, 'POST', `/api/episodes/${id}/watch`, { cookie, body: { watchedAt: '2024-06-01T20:00:00Z' } })
    expect(await prisma.watchEvent.count({ where: { userId, episodeId: id } })).toBe(2)

    await call(app, 'DELETE', `/api/episodes/${id}/watch`, { cookie })
    expect(await prisma.watchEvent.count({ where: { userId, episodeId: id } })).toBe(0)
  })

  it('404s an unknown episode', async () => {
    expect((await call(app, 'POST', '/api/episodes/987654/watch', { cookie })).statusCode).toBe(404)
  })

  it('marks a whole season, skipping unaired episodes', async () => {
    const res = await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { season: 2 } })
    expect(res.data).toEqual({ marked: 2 })
    expect(await watchedCodes()).toEqual(['S2E1', 'S2E2'])
  })

  it('"caught up to here" marks everything up to the episode, specials excluded', async () => {
    const res = await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 1 } } })
    expect(res.data).toEqual({ marked: 4 })
    expect(await watchedCodes()).toEqual(['S1E1', 'S1E2', 'S1E3', 'S2E1'])
  })

  it('never duplicates an episode already watched', async () => {
    await call(app, 'POST', `/api/episodes/${await episodeId(ALPHA, 1, 2)}/watch`, { cookie })
    const res = await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { season: 1 } })
    expect(res.data).toEqual({ marked: 2 })
    expect(await prisma.watchEvent.count({ where: { userId } })).toBe(3)
  })

  it('requires exactly one of season / upTo', async () => {
    for (const body of [{}, { season: 1, upTo: { season: 1, number: 1 } }]) {
      expect((await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body })).statusCode).toBe(400)
    }
  })

  it('unmarks a whole season', async () => {
    await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 2 } } })
    const res = await call(app, 'POST', `/api/shows/${ALPHA}/unwatch-bulk`, { cookie, body: { season: 1 } })
    expect(res.data).toEqual({ unmarked: 3 })
    expect(await watchedCodes()).toEqual(['S2E1', 'S2E2'])
  })

  it("never touches another user's history", async () => {
    const other = await createUser()
    const id = await episodeId(ALPHA, 1, 1)
    await call(app, 'POST', `/api/episodes/${id}/watch`, { cookie: other.cookie })
    await call(app, 'DELETE', `/api/episodes/${id}/watch`, { cookie })
    expect(await prisma.watchEvent.count({ where: { userId: other.user.id } })).toBe(1)
  })

  it('does not call Trakt for a user without a mirrored account', async () => {
    await call(app, 'POST', `/api/episodes/${await episodeId(ALPHA, 1, 1)}/watch`, { cookie })
    await flush()
    expect(fetchCalls.filter((u) => u.includes('trakt'))).toEqual([])
  })
})

describe('movies', () => {
  it('watching a movie caches it and drops it off the watchlist', async () => {
    await call(app, 'PUT', `/api/movies/${INCEPTION}/watchlist`, { cookie })
    expect(await prisma.movieWatchlistEntry.count({ where: { userId } })).toBe(1)

    expect((await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie })).statusCode).toBe(200)
    expect(await prisma.movieWatchlistEntry.count({ where: { userId } })).toBe(0)
    expect(await prisma.watchEvent.count({ where: { userId, movieId: INCEPTION } })).toBe(1)

    await call(app, 'DELETE', `/api/movies/${INCEPTION}/watch`, { cookie })
    expect(await prisma.watchEvent.count({ where: { userId } })).toBe(0)
  })

  it('moves a watchlist entry between FOR_LATER and ARCHIVED, and rejects other states', async () => {
    await call(app, 'PUT', `/api/movies/${INCEPTION}/watchlist`, { cookie, body: { state: 'ARCHIVED' } })
    expect((await prisma.movieWatchlistEntry.findFirstOrThrow({ where: { userId } })).state).toBe('ARCHIVED')
    expect((await call(app, 'PUT', `/api/movies/${INCEPTION}/watchlist`, { cookie, body: { state: 'WATCHING' } })).statusCode).toBe(400)
    await call(app, 'DELETE', `/api/movies/${INCEPTION}/watchlist`, { cookie })
    expect(await prisma.movieWatchlistEntry.count()).toBe(0)
  })
})

describe('ratings and favorites', () => {
  it('upserts and deletes a rating, validating the 1-10 range', async () => {
    const put = (value: number) => call(app, 'PUT', '/api/ratings', { cookie, body: { target: 'SHOW', targetRef: OMEGA, value } })
    expect((await put(7)).data).toMatchObject({ value: 7 })
    expect((await put(9)).data).toMatchObject({ value: 9 })
    expect(await prisma.rating.count()).toBe(1)
    expect((await put(0)).statusCode).toBe(400)
    expect((await put(11)).statusCode).toBe(400)

    await call(app, 'DELETE', '/api/ratings', { cookie, body: { target: 'SHOW', targetRef: OMEGA } })
    expect(await prisma.rating.count()).toBe(0)
  })

  it('favorites shows and movies idempotently', async () => {
    await call(app, 'PUT', `/api/shows/${OMEGA}/favorite`, { cookie })
    await call(app, 'PUT', `/api/shows/${OMEGA}/favorite`, { cookie })
    await call(app, 'PUT', `/api/movies/${INCEPTION}/favorite`, { cookie })
    expect(await prisma.favorite.findMany({ select: { target: true, targetRef: true }, orderBy: { target: 'asc' } })).toEqual([
      { target: 'SHOW', targetRef: OMEGA },
      { target: 'MOVIE', targetRef: INCEPTION },
    ])
    await call(app, 'DELETE', `/api/shows/${OMEGA}/favorite`, { cookie })
    expect(await prisma.favorite.count()).toBe(1)
  })
})
