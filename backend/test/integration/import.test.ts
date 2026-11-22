import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { tvTimeZip, seriesRow, watchRow } from '../tvtime-zip.js'
import { addMovie, resetTmdb } from './fake-tmdb.js'
import { ALPHA, INCEPTION, OMEGA, PARASITE, seedCatalog } from './fixtures.js'
import { call, createUser, installFakeFetch, multipartFile, resetDb, startApp, waitForJob } from './helpers.js'

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
  addMovie({ id: 438631, title: 'Dune' })
  addMovie({ id: 693134, title: 'Dune: Part Two' })
  ;({ cookie, user: { id: userId } } = await createUser())
})

const upload = (url: string, file: Buffer, name = 'tvtime.zip') => {
  const { payload, headers } = multipartFile(name, file)
  return call(app, 'POST', url, { cookie, headers, body: payload })
}

const exportZip = () =>
  tvTimeZip({
    v2: [
      seriesRow(5001, 'Alpha', '2024-01-01 10:00:00'),
      seriesRow(5002, 'Omega', '2023-01-01 10:00:00', { archived: true }),
      seriesRow(9999, 'Ghost Show', '2023-01-01 10:00:00'),
      watchRow(5001, 'Alpha', 1, 1, '2024-01-02 21:00:00'),
      watchRow(5001, 'Alpha', 1, 2, '2024-01-03 21:00:00'),
      watchRow(5001, 'Alpha', 9, 9, '2024-01-04 21:00:00'), // not on TMDB
      watchRow(5002, 'Omega', 1, 1, '2023-02-01 21:00:00'),
    ],
    v1: [
      ['movie', 'watch', 'Inception', '2022-05-05 20:00:00'],
      ['movie', 'towatch', 'Parasite', '2022-05-06 20:00:00'],
      ['movie', 'watch', 'Dun', '2022-05-07 20:00:00'], // ambiguous: two candidates
      ['movie', 'watch', 'Some Obscure Film', '2022-05-08 20:00:00'], // no candidates
    ],
    ratings: [[5001, 4, '2024-02-01 10:00:00']],
    favorites: [[5001, '1']],
  })

describe('TV Time import', () => {
  it('maps shows, episodes, follows, ratings, favorites and movies', async () => {
    const res = await upload('/api/import/tvtime', exportZip())
    expect(res.statusCode).toBe(202)
    const job = await waitForJob(res.data.jobId)
    expect(job.error).toBeNull()
    expect(job.status).toBe('DONE')
    expect(job.report).toEqual({
      shows: { mapped: 2, unmapped: [{ tvdbId: 9999, name: 'Ghost Show' }] },
      episodes: { imported: 3, unmatched: 1 },
      follows: 2,
      ratings: 1,
      movies: { autoMatched: 1, pending: 2, watchlist: 1 },
    })

    const follows = await prisma.follow.findMany({ where: { userId }, orderBy: { showTmdbId: 'asc' } })
    expect(follows.map((f) => [f.showTmdbId, f.state])).toEqual([
      [ALPHA, 'WATCHING'],
      [OMEGA, 'ARCHIVED'],
    ])
    // TV Time rates out of 5, Rewatch out of 10.
    expect(await prisma.rating.findFirst({ where: { userId }, select: { targetRef: true, value: true } })).toEqual({
      targetRef: ALPHA,
      value: 8,
    })
    expect(await prisma.favorite.findMany({ where: { userId }, select: { targetRef: true } })).toEqual([{ targetRef: ALPHA }])
    expect(await prisma.watchEvent.count({ where: { userId, movieId: INCEPTION } })).toBe(1)
    expect(await prisma.movieWatchlistEntry.count({ where: { userId, movieTmdbId: PARASITE } })).toBe(1)
    expect((await prisma.show.findUniqueOrThrow({ where: { tmdbId: ALPHA } })).tvdbId).toBe(5001)
  })

  it('is replayable without duplicating anything', async () => {
    for (let i = 0; i < 2; i++) await waitForJob((await upload('/api/import/tvtime', exportZip())).data.jobId)
    expect(await prisma.watchEvent.count({ where: { userId } })).toBe(4)
    expect(await prisma.importPendingMovie.count({ where: { userId } })).toBe(2)
  })

  it('queues unmatched movies for manual resolution', async () => {
    await waitForJob((await upload('/api/import/tvtime', exportZip())).data.jobId)

    const pending = (await call(app, 'GET', '/api/import/pending', { cookie })).data
    expect(pending.map((p: any) => [p.title, p.candidates.length])).toEqual([
      ['Dun', 2],
      ['Some Obscure Film', 0],
    ])

    const dune = pending[0]
    expect((await call(app, 'POST', `/api/import/pending/${dune.id}/resolve`, { cookie, body: { tmdbId: 438631 } })).statusCode).toBe(200)
    expect(await prisma.watchEvent.findMany({ where: { userId, movieId: 438631 }, select: { watchedAt: true } })).toEqual([
      { watchedAt: new Date('2022-05-07T20:00:00Z') },
    ])

    const obscure = pending[1]
    expect((await call(app, 'DELETE', `/api/import/pending/${obscure.id}`, { cookie })).statusCode).toBe(200)
    expect((await call(app, 'GET', '/api/import/pending', { cookie })).data).toEqual([])
    expect((await call(app, 'DELETE', `/api/import/pending/${obscure.id}`, { cookie })).statusCode).toBe(404)
  })

  it("can't touch another user's pending movies or jobs", async () => {
    const jobId = (await upload('/api/import/tvtime', exportZip())).data.jobId
    await waitForJob(jobId)
    const [pending] = (await call(app, 'GET', '/api/import/pending', { cookie })).data

    const other = await createUser()
    expect((await call(app, 'GET', `/api/import/jobs/${jobId}`, { cookie: other.cookie })).statusCode).toBe(404)
    expect((await call(app, 'DELETE', `/api/import/pending/${pending.id}`, { cookie: other.cookie })).statusCode).toBe(404)
    expect((await call(app, 'GET', '/api/import/jobs/latest', { cookie: other.cookie })).data).toEqual({ job: null })
  })

  it('fails the job, not the request, on a file that is not a TV Time export', async () => {
    const res = await upload('/api/import/tvtime', Buffer.from('definitely not a zip'))
    expect(res.statusCode).toBe(202)
    const job = await waitForJob(res.data.jobId)
    expect(job.status).toBe('FAILED')
    expect(job.error).toBeTruthy()

    const latest = (await call(app, 'GET', '/api/import/jobs/latest', { cookie })).data.job
    expect(latest).toMatchObject({ id: res.data.jobId, status: 'FAILED' })
  })

  it('allows one running import per user', async () => {
    const running = await prisma.importJob.create({ data: { userId } })
    const res = await upload('/api/import/tvtime', exportZip())
    expect(res.statusCode).toBe(409)
    expect(res.data).toEqual({ error: 'import_already_running', jobId: running.id })
  })

  it('requires a file', async () => {
    const res = await call(app, 'POST', '/api/import/tvtime', {
      cookie,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: '--x--\r\n',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('Rewatch import validation', () => {
  it.each([
    ['not JSON', 'nope{', 'not_json'],
    ['another format', JSON.stringify({ format: 'something-else', version: 1 }), 'not_a_rewatch_export'],
    ['a newer version', JSON.stringify({ format: 'rewatch-export', version: 99 }), 'unsupported_version'],
    ['a malformed body', JSON.stringify({ format: 'rewatch-export', version: 1, shows: [{ tmdbId: 'x' }] }), 'malformed_export'],
  ])('rejects %s synchronously', async (_label, content, error) => {
    const res = await upload('/api/import/rewatch', Buffer.from(content), 'export.json')
    expect(res.statusCode).toBe(400)
    expect(res.data.error).toBe(error)
    expect(await prisma.importJob.count()).toBe(0)
  })
})
