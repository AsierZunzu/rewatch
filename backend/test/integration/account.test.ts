import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { resetTmdb } from './fake-tmdb.js'
import { ALPHA, INCEPTION, OMEGA, seedCatalog } from './fixtures.js'
import { call, createUser, installFakeFetch, multipartFile, resetDb, startApp, waitForJob } from './helpers.js'

vi.mock('../../src/lib/tmdb.js', () => import('./fake-tmdb.js'))

let app: FastifyInstance

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
})

/** A user with a bit of everything: follows, watches, ratings, favorites, a watchlist. */
async function seedHistory(cookie: string) {
  await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
  await call(app, 'PUT', `/api/shows/${OMEGA}/follow`, { cookie, body: { state: 'ARCHIVED' } })
  await call(app, 'POST', `/api/shows/${ALPHA}/watch-bulk`, { cookie, body: { season: 1 } })
  await call(app, 'PUT', `/api/shows/${ALPHA}/favorite`, { cookie })
  await call(app, 'PUT', '/api/ratings', { cookie, body: { target: 'SHOW', targetRef: ALPHA, value: 8 } })
  await call(app, 'POST', `/api/movies/${INCEPTION}/watch`, { cookie, body: { watchedAt: '2024-03-01T20:00:00Z' } })
  await call(app, 'PUT', '/api/ratings', { cookie, body: { target: 'MOVIE', targetRef: INCEPTION, value: 10 } })
  await call(app, 'PUT', `/api/movies/27205/favorite`, { cookie })
}

describe('GET /api/account/export', () => {
  it('exports every kind of tracking data as a downloadable file', async () => {
    const { cookie } = await createUser({ username: 'exporter' })
    await seedHistory(cookie)

    const res = await call(app, 'GET', '/api/account/export', { cookie })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="rewatch-export-exporter-\d{4}-\d{2}-\d{2}\.json"/)

    const data = res.data
    expect(data).toMatchObject({ format: 'rewatch-export', version: 1, user: { username: 'exporter', language: 'en' } })
    expect(data.shows).toHaveLength(2)
    expect(data.shows.find((s: any) => s.tmdbId === ALPHA)).toMatchObject({ state: 'WATCHING', isFavorite: true, rating: 8 })
    expect(data.shows.find((s: any) => s.tmdbId === OMEGA)).toMatchObject({ state: 'ARCHIVED', isFavorite: false, rating: null })
    expect(data.episodeWatches.map((e: any) => `${e.showTmdbId}:${e.season}:${e.number}`).sort()).toEqual([
      `${ALPHA}:1:1`,
      `${ALPHA}:1:2`,
      `${ALPHA}:1:3`,
    ])
    expect(data.movies).toEqual([
      { tmdbId: INCEPTION, title: 'Inception', watchedAts: ['2024-03-01T20:00:00.000Z'], isFavorite: true, rating: 10 },
    ])
  })

  it('round-trips through the Rewatch import into another account', async () => {
    const source = await createUser()
    await seedHistory(source.cookie)
    const exported = (await call(app, 'GET', '/api/account/export', { cookie: source.cookie })).body

    const target = await createUser()
    const upload = multipartFile('export.json', Buffer.from(exported), 'application/json')
    const res = await call(app, 'POST', '/api/import/rewatch', { cookie: target.cookie, ...upload, body: upload.payload })
    expect(res.statusCode).toBe(202)

    const job = await waitForJob(res.data.jobId)
    expect(job.status).toBe('DONE')

    const reexported = (await call(app, 'GET', '/api/account/export', { cookie: target.cookie })).data
    const original = JSON.parse(exported)
    const strip = (d: any) => ({
      shows: d.shows.map(({ tmdbId, state, isFavorite, rating }: any) => ({ tmdbId, state, isFavorite, rating })).sort((a: any, b: any) => a.tmdbId - b.tmdbId),
      episodes: d.episodeWatches.map((e: any) => `${e.showTmdbId}:${e.season}:${e.number}:${e.watchedAt}`).sort(),
      movies: d.movies,
    })
    expect(strip(reexported)).toEqual(strip(original))
  })

  it('is idempotent: importing the same file twice creates no duplicates', async () => {
    const source = await createUser()
    await seedHistory(source.cookie)
    const exported = Buffer.from((await call(app, 'GET', '/api/account/export', { cookie: source.cookie })).body)

    const target = await createUser()
    for (let i = 0; i < 2; i++) {
      const upload = multipartFile('export.json', exported)
      const res = await call(app, 'POST', '/api/import/rewatch', { cookie: target.cookie, ...upload, body: upload.payload })
      await waitForJob(res.data.jobId)
    }
    expect(await prisma.watchEvent.count({ where: { userId: target.user.id } })).toBe(4)
  })
})

describe('DELETE /api/account/history', () => {
  it('wipes tracking data, keeps the account, and reports accurate counts', async () => {
    const { cookie, password, user } = await createUser()
    await seedHistory(cookie)
    await call(app, 'PUT', `/api/movies/${INCEPTION}/watchlist`, { cookie })

    expect((await call(app, 'DELETE', '/api/account/history', { cookie, body: { password: 'wrong' } })).statusCode).toBe(401)

    const res = await call(app, 'DELETE', '/api/account/history', { cookie, body: { password } })
    expect(res.statusCode).toBe(200)
    expect(res.data.deleted).toEqual({
      watchEvents: 4,
      follows: 2,
      ratings: 2,
      favorites: 2,
      movieWatchlist: 1,
      pendingMovies: 0,
      importJobs: 0,
    })
    expect(await prisma.watchEvent.count()).toBe(0)
    expect(await prisma.favorite.count()).toBe(0)
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1)
  })
})

describe('DELETE /api/account', () => {
  it('deletes the account and everything it owns', async () => {
    const { cookie, password, user } = await createUser()
    await seedHistory(cookie)
    const res = await call(app, 'DELETE', '/api/account', { cookie, body: { password } })
    expect(res.statusCode).toBe(200)
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0)
    expect(await prisma.watchEvent.count()).toBe(0)
    expect((await call(app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401)
  })

  it('refuses the wrong password and refuses admins', async () => {
    const user = await createUser()
    expect((await call(app, 'DELETE', '/api/account', { cookie: user.cookie, body: { password: 'nope' } })).statusCode).toBe(401)
    const admin = await createUser({ isAdmin: true })
    const res = await call(app, 'DELETE', '/api/account', { cookie: admin.cookie, body: { password: admin.password } })
    expect(res.data.error).toBe('cannot_delete_admin')
  })
})
