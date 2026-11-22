import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { resetTmdb } from './fake-tmdb.js'
import { ALPHA, INCEPTION, OMEGA, PARASITE, seedCatalog } from './fixtures.js'
import { call, createUser, installFakeFetch, resetDb, startApp } from './helpers.js'

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
  // Cached, not followed: episodes exist to be watched by id.
  for (const id of [ALPHA, OMEGA]) await call(app, 'GET', `/api/shows/${id}`, { cookie })
})

const episodeId = async (show: number, season: number, number: number) =>
  (await prisma.episode.findUniqueOrThrow({ where: { showTmdbId_season_number: { showTmdbId: show, season, number } } })).id

const watch = async (show: number, season: number, number: number, watchedAt = '2025-01-01T20:00:00Z') =>
  call(app, 'POST', `/api/episodes/${await episodeId(show, season, number)}/watch`, { cookie, body: { watchedAt } })

describe('GET /api/watchlist (Up Next)', () => {
  it('points at the first aired unwatched episode, with what is left', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    await watch(ALPHA, 1, 1)

    const res = await call(app, 'GET', '/api/watchlist', { cookie })
    expect(res.statusCode).toBe(200)
    expect(res.data.shows).toHaveLength(1)
    const [entry] = res.data.shows
    expect(entry.show.name).toBe('Alpha')
    expect(entry.nextEpisode).toMatchObject({ season: 1, number: 2, name: 'Second', airsAtSource: 'FALLBACK' })
    // Aired and unwatched: S1E2, S1E3, S2E1, S2E2. The special and S2E3+ don't count.
    expect(entry.seasonRemaining).toBe(2)
    expect(entry.totalRemaining).toBe(4)
    // S1E2 has no runtime of its own and inherits the show's 45 minutes.
    expect(entry.seasonRemainingMinutes).toBe(45 + 50)
    expect(entry.totalRemainingMinutes).toBe(45 + 50 + 40 + 40)
    expect(entry.isSeasonFinale).toBe(false)
  })

  it('does not call a caught-up week the season finale when more episodes are announced', async () => {
    await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 1 } } })
    const [entry] = (await call(app, 'GET', '/api/watchlist', { cookie })).data.shows
    expect(entry.nextEpisode).toMatchObject({ season: 2, number: 2 })
    expect(entry.seasonRemaining).toBe(1)
    expect(entry.isSeasonFinale).toBe(false)
  })

  it('flags a real season finale', async () => {
    await call(app, 'PUT', `/api/shows/${OMEGA}/follow`, { cookie })
    await watch(OMEGA, 1, 1)
    const [entry] = (await call(app, 'GET', '/api/watchlist', { cookie })).data.shows
    expect(entry.nextEpisode).toMatchObject({ season: 1, number: 2 })
    expect(entry.isSeasonFinale).toBe(true)
  })

  it('drops shows that are caught up, archived or for later', async () => {
    await call(app, 'PUT', `/api/shows/${OMEGA}/follow`, { cookie })
    await call(app, 'POST', `/api/shows/${OMEGA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 1 } } })
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie, body: { state: 'FOR_LATER' } })
    expect((await call(app, 'GET', '/api/watchlist', { cookie })).data.shows).toEqual([])
  })

  it('orders shows by most recent activity', async () => {
    await watch(OMEGA, 1, 1, '2025-01-01T20:00:00Z')
    await watch(ALPHA, 1, 1, '2025-03-01T20:00:00Z')
    const names = (await call(app, 'GET', '/api/watchlist', { cookie })).data.shows.map((s: any) => s.show.name)
    expect(names).toEqual(['Alpha', 'Omega'])
  })

  it('splits the movie watchlist into for-later and archived', async () => {
    await call(app, 'PUT', `/api/movies/${INCEPTION}/watchlist`, { cookie })
    await call(app, 'PUT', `/api/movies/${PARASITE}/watchlist`, { cookie, body: { state: 'ARCHIVED' } })
    const { movies, archivedMovies } = (await call(app, 'GET', '/api/watchlist', { cookie })).data
    expect(movies.map((m: any) => m.title)).toEqual(['Inception'])
    expect(archivedMovies.map((m: any) => m.title)).toEqual(['Parasite'])
  })

  it('speaks the user language', async () => {
    const fr = await createUser({ language: 'fr' })
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie: fr.cookie })
    const [entry] = (await call(app, 'GET', '/api/watchlist', { cookie: fr.cookie })).data.shows
    expect(entry.show.name).toBe('Alpha (FR)')
    expect(entry.show.overview).toBe('Résumé')
    expect(entry.nextEpisode.name).toBe('Pilot [fr-FR]')
  })
})

describe('library views', () => {
  it('lists followed shows with watched / aired progress and favorites', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    await call(app, 'PUT', `/api/shows/${ALPHA}/favorite`, { cookie })
    await watch(ALPHA, 1, 1)
    await watch(ALPHA, 1, 1, '2025-02-01T20:00:00Z') // a rewatch counts once

    const [row] = (await call(app, 'GET', '/api/library/shows', { cookie })).data
    expect(row).toMatchObject({ state: 'WATCHING', isFavorite: true, watched: 1, aired: 5 })
    expect(row.show.tmdbId).toBe(ALPHA)
  })

  it('lists ended shows that are fully watched, and watched movies', async () => {
    await call(app, 'POST', `/api/shows/${OMEGA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 1 } } })
    await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 2 } } }) // returning: not finished
    await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie })

    const { finishedShows, movies } = (await call(app, 'GET', '/api/library/watched', { cookie })).data
    expect(finishedShows.map((s: any) => s.name)).toEqual(['Omega'])
    expect(movies.map((m: any) => m.title)).toEqual(['Inception'])
  })

  it('collects favorites and top ratings into highlights', async () => {
    await call(app, 'PUT', `/api/movies/${INCEPTION}/favorite`, { cookie })
    await call(app, 'GET', `/api/shows/${OMEGA}`, { cookie })
    await call(app, 'PUT', '/api/ratings', { cookie, body: { target: 'SHOW', targetRef: OMEGA, value: 8 } })
    await call(app, 'PUT', '/api/ratings', { cookie, body: { target: 'MOVIE', targetRef: INCEPTION, value: 10 } })

    const res = (await call(app, 'GET', '/api/library/highlights', { cookie })).data
    expect(res.favorites).toEqual([expect.objectContaining({ kind: 'movie', tmdbId: INCEPTION, title: 'Inception' })])
    expect(res.topRated.map((r: any) => [r.title, r.rating])).toEqual([
      ['Inception', 10],
      ['Omega', 8],
    ])
  })
})

describe('per-user overlays', () => {
  it('show overlay: follow, rating, favorite, watched episode ids', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    await call(app, 'PUT', '/api/ratings', { cookie, body: { target: 'SHOW', targetRef: ALPHA, value: 6 } })
    await watch(ALPHA, 1, 1)
    const res = (await call(app, 'GET', `/api/shows/${ALPHA}/user`, { cookie })).data
    expect(res).toMatchObject({ rating: 6, isFavorite: false, watchedEpisodeIds: [await episodeId(ALPHA, 1, 1)] })
    expect(res.follow.state).toBe('WATCHING')
  })

  it('movie overlay: viewings in order, watchlist state, rating', async () => {
    await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie, body: { watchedAt: '2025-05-01T00:00:00Z' } })
    await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie, body: { watchedAt: '2024-05-01T00:00:00Z' } })
    const res = (await call(app, 'GET', `/api/movies/${INCEPTION}/user`, { cookie })).data
    expect(res.watchedAts).toEqual(['2024-05-01T00:00:00.000Z', '2025-05-01T00:00:00.000Z'])
    expect(res).toMatchObject({ watchlistState: null, rating: null, isFavorite: false })
  })

  it('is empty for an untouched show', async () => {
    const res = (await call(app, 'GET', `/api/shows/${ALPHA}/user`, { cookie })).data
    expect(res).toEqual({ follow: null, rating: null, isFavorite: false, watchedEpisodeIds: [] })
  })
})

describe('GET /api/calendar', () => {
  it('lists upcoming episodes of followed, non-archived shows', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    const res = await call(app, 'GET', '/api/calendar?days=30', { cookie })
    expect(res.statusCode).toBe(200)
    expect(res.data.map((e: any) => [e.season, e.number, e.show.name])).toEqual([[2, 3, 'Alpha']])

    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie, body: { state: 'ARCHIVED' } })
    expect((await call(app, 'GET', '/api/calendar', { cookie })).data).toEqual([])
  })

  it('respects the window and validates it', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    expect((await call(app, 'GET', '/api/calendar?days=2', { cookie })).data).toEqual([])
    expect((await call(app, 'GET', '/api/calendar?days=500', { cookie })).statusCode).toBeGreaterThanOrEqual(400)
  })
})

describe('catalog routes', () => {
  it('serves a show with its episodes, from cache on the second read', async () => {
    const first = await call(app, 'GET', `/api/shows/${ALPHA}`, { cookie })
    expect(first.statusCode).toBe(200)
    expect(first.data.episodes).toHaveLength(8)
    expect(first.data.episodes[0]).toMatchObject({ season: 0, number: 1 })

    const { calls } = await import('./fake-tmdb.js')
    const before = calls.length
    await call(app, 'GET', `/api/shows/${ALPHA}`, { cookie })
    expect(calls.length).toBe(before)
  })

  it('re-fetches a stale ongoing show', async () => {
    await call(app, 'GET', `/api/shows/${ALPHA}`, { cookie })
    await prisma.show.update({ where: { tmdbId: ALPHA }, data: { cachedAt: new Date('2020-01-01') } })
    const { calls } = await import('./fake-tmdb.js')
    const before = calls.length
    await call(app, 'GET', `/api/shows/${ALPHA}`, { cookie })
    expect(calls.length).toBeGreaterThan(before)
  })

  it('searches shows and movies only', async () => {
    const res = await call(app, 'GET', '/api/search?q=inc', { cookie })
    expect(res.data).toEqual([{ tmdbId: INCEPTION, kind: 'movie', title: 'Inception', posterPath: null, year: '2010' }])
    expect((await call(app, 'GET', '/api/search?q=', { cookie })).statusCode).toBe(400)
  })

  it('returns the top 12 cast members', async () => {
    const res = await call(app, 'GET', `/api/shows/${ALPHA}/cast`, { cookie })
    expect(res.data.cast).toHaveLength(12)
    expect(res.data.cast[0]).toEqual({ name: 'Actor 0', character: 'Role 0', profilePath: null })
  })

  it('localizes a movie', async () => {
    const fr = await createUser({ language: 'fr' })
    expect((await call(app, 'GET', `/api/movies/${INCEPTION}`, { cookie: fr.cookie })).data.title).toBe('Inception (FR)')
  })
})

describe('GET /api/stats', () => {
  it('adds up watch time with runtime fallbacks', async () => {
    await watch(ALPHA, 1, 1) // 60
    await watch(ALPHA, 1, 2) // no runtime → show default 45
    await watch(OMEGA, 1, 1, '2025-02-01T20:00:00Z') // 30
    await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie }) // 148
    await call(app, 'POST', `/api/movies/${PARASITE}/watch`, { cookie }) // null → 110 fallback

    const res = (await call(app, 'GET', '/api/stats', { cookie })).data
    expect(res).toMatchObject({
      totalMinutes: 60 + 45 + 30 + 148 + 110,
      episodesWatched: 3,
      moviesWatched: 2,
      showsCompleted: 0,
    })
    expect(res.topShows.map((s: any) => [s.name, s.minutes, s.episodes])).toEqual([
      ['Alpha', 105, 2],
      ['Omega', 30, 1],
    ])
    expect(res.byGenre[0]).toEqual({ genre: 'Science Fiction', minutes: 148 })
    expect(res.byMonth.reduce((sum: number, m: any) => sum + m.count, 0)).toBe(5)
  })

  it('counts a fully watched ended show as completed', async () => {
    await call(app, 'POST', `/api/shows/${OMEGA}/watch-bulk`, { cookie, body: { upTo: { season: 2, number: 1 } } })
    expect((await call(app, 'GET', '/api/stats', { cookie })).data.showsCompleted).toBe(1)
  })

  it('is all zeros for a new user', async () => {
    const res = (await call(app, 'GET', '/api/stats', { cookie })).data
    expect(res).toEqual({
      totalMinutes: 0,
      episodesWatched: 0,
      moviesWatched: 0,
      showsCompleted: 0,
      byMonth: [],
      byGenre: [],
      topShows: [],
    })
  })

  it('only counts the current user', async () => {
    const other = await createUser()
    await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie: other.cookie })
    expect((await call(app, 'GET', '/api/stats', { cookie })).data.moviesWatched).toBe(0)
    expect(userId).not.toBe(other.user.id)
  })
})
