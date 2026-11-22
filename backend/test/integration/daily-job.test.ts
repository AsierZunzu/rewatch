import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDailyJob } from '../../src/jobs/daily.js'
import { cacheShow } from '../../src/lib/catalog.js'
import { prisma } from '../../src/lib/prisma.js'
import { saveSettings } from '../../src/lib/settings.js'
import { resetTmdb } from './fake-tmdb.js'
import { ALPHA, OMEGA, seedCatalog } from './fixtures.js'
import { createUser, daysFromNow, installFakeFetch, resetDb } from './helpers.js'

vi.mock('../../src/lib/tmdb.js', () => import('./fake-tmdb.js'))

const sent = vi.hoisted(() => ({ reminders: [] as string[], pushes: [] as { endpoint: string; payload: any }[] }))
vi.mock('../../src/lib/mailer.js', () => ({
  sendVerificationEmail: vi.fn(async () => {}),
  sendVerifyReminderEmail: vi.fn(async (to: string) => void sent.reminders.push(to)),
  sendResetEmail: vi.fn(async () => {}),
  sendTestEmail: vi.fn(async () => {}),
}))
// web-push is imported as a namespace (import * as webpush).
const webpushFake = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
    sent.pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) })
  }),
}))
vi.mock('web-push', () => ({ ...webpushFake, default: webpushFake }))

const log = { info: vi.fn(), error: vi.fn() }

beforeEach(async () => {
  await resetDb()
  installFakeFetch()
  resetTmdb()
  seedCatalog()
  sent.reminders.length = 0
  sent.pushes.length = 0
  log.info.mockClear()
  log.error.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('verification reminders', () => {
  it('reminds an account the day before lockout, once', async () => {
    await createUser({ email: 'due@example.test', verified: false, createdAt: daysFromNow(-6.5) })
    await createUser({ email: 'early@example.test', verified: false, createdAt: daysFromNow(-2) })
    await createUser({ email: 'locked@example.test', verified: false, createdAt: daysFromNow(-9) })
    await createUser({ email: 'fine@example.test', createdAt: daysFromNow(-6.5) })

    await runDailyJob(log)
    await runDailyJob(log)
    expect(sent.reminders).toEqual(['due@example.test'])
  })
})

describe('housekeeping', () => {
  it('purges expired auth tokens only', async () => {
    const { user } = await createUser()
    await prisma.authToken.createMany({
      data: [
        { id: 'expired', userId: user.id, kind: 'VERIFY_EMAIL', expiresAt: daysFromNow(-1) },
        { id: 'live', userId: user.id, kind: 'RESET_PASSWORD', expiresAt: daysFromNow(1) },
      ],
    })
    await runDailyJob(log)
    expect((await prisma.authToken.findMany()).map((t) => t.id)).toEqual(['live'])
  })
})

describe('new-episode push', () => {
  beforeEach(async () => {
    await saveSettings({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })
  })

  async function subscriber(language = 'en') {
    const u = await createUser({ language })
    await prisma.pushSubscription.create({
      data: { userId: u.user.id, endpoint: `https://push.example.test/${u.user.id}`, p256dh: 'p', auth: 'a' },
    })
    return u
  }

  /** Pretend S{season}E{number} aired `hoursAgo` hours ago. */
  const airedHoursAgo = (show: number, season: number, number: number, hoursAgo: number) =>
    prisma.episode.update({
      where: { showTmdbId_season_number: { showTmdbId: show, season, number } },
      data: { airsAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000), airsAtSource: 'TVMAZE' },
    })

  it("notifies WATCHING followers of the last 24h's episodes, in their language", async () => {
    await cacheShow(ALPHA)
    await cacheShow(OMEGA)
    const en = await subscriber('en')
    const fr = await subscriber('fr')
    const archived = await subscriber()
    const noDevice = await createUser()
    for (const u of [en, fr, noDevice]) await prisma.follow.create({ data: { userId: u.user.id, showTmdbId: ALPHA } })
    await prisma.follow.create({ data: { userId: archived.user.id, showTmdbId: ALPHA, state: 'ARCHIVED' } })
    await prisma.follow.create({ data: { userId: en.user.id, showTmdbId: OMEGA } })

    await airedHoursAgo(ALPHA, 2, 3, 2)
    await airedHoursAgo(OMEGA, 2, 1, 5)
    await airedHoursAgo(ALPHA, 0, 1, 3) // specials don't push
    await airedHoursAgo(ALPHA, 2, 2, 30) // outside the window

    await runDailyJob(log)

    const byEndpoint = Object.fromEntries(sent.pushes.map((p) => [p.endpoint, p.payload]))
    expect(Object.keys(byEndpoint).sort()).toEqual(
      [`https://push.example.test/${en.user.id}`, `https://push.example.test/${fr.user.id}`].sort(),
    )
    expect(byEndpoint[`https://push.example.test/${en.user.id}`]).toEqual({
      title: '2 new episodes available',
      body: expect.stringMatching(/^(Alpha S02E03\nOmega S02E01|Omega S02E01\nAlpha S02E03)$/),
      url: '/calendar',
    })
    expect(byEndpoint[`https://push.example.test/${fr.user.id}`]).toEqual({
      title: 'Nouvel épisode disponible',
      body: 'Alpha S02E03',
      url: '/calendar',
    })
  })

  it('keeps going when push is not configured, and logs it', async () => {
    await saveSettings({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })
    await cacheShow(ALPHA)
    const u = await subscriber()
    await prisma.follow.create({ data: { userId: u.user.id, showTmdbId: ALPHA } })
    await airedHoursAgo(ALPHA, 2, 3, 1)

    await expect(runDailyJob(log)).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('new-episode push failed'))
  })
})

describe('air-time refresh', () => {
  it('re-checks followed, ongoing shows that were never enriched or are stale', async () => {
    await cacheShow(ALPHA)
    await cacheShow(OMEGA)
    const { user } = await createUser()
    await prisma.follow.createMany({ data: [{ userId: user.id, showTmdbId: ALPHA }, { userId: user.id, showTmdbId: OMEGA }] })

    await runDailyJob(log)
    // ALPHA was never enriched; OMEGA has ended and is left alone.
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('1 show(s) air-time refreshed'))
  })

  it('leaves a recently enriched show alone', async () => {
    await cacheShow(ALPHA)
    const { user } = await createUser()
    await prisma.follow.create({ data: { userId: user.id, showTmdbId: ALPHA } })
    await prisma.show.update({ where: { tmdbId: ALPHA }, data: { airsCachedAt: daysFromNow(-1) } })

    await runDailyJob(log)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('0 show(s) air-time refreshed'))
  })
})
