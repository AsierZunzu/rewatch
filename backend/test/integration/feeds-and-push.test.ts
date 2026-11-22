import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { saveSettings } from '../../src/lib/settings.js'
import { resetTmdb } from './fake-tmdb.js'
import { ALPHA, seedCatalog } from './fixtures.js'
import { call, createUser, installFakeFetch, resetDb, startApp } from './helpers.js'

vi.mock('../../src/lib/tmdb.js', () => import('./fake-tmdb.js'))

const push = vi.hoisted(() => ({
  sent: [] as { endpoint: string; payload: string }[],
  failWith: new Map<string, number>(),
}))
// web-push is imported as a namespace (import * as webpush).
const webpushFake = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  generateVAPIDKeys: () => ({ publicKey: 'generated-public', privateKey: 'generated-private' }),
  sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
    const status = push.failWith.get(sub.endpoint)
    if (status) throw Object.assign(new Error('push failed'), { statusCode: status })
    push.sent.push({ endpoint: sub.endpoint, payload })
  }),
}))
vi.mock('web-push', () => ({ ...webpushFake, default: webpushFake }))

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
  push.sent.length = 0
  push.failWith.clear()
  ;({ cookie, user: { id: userId } } = await createUser())
})

describe('calendar feed (.ics)', () => {
  it('creates, rotates and revokes the feed token', async () => {
    expect((await call(app, 'GET', '/api/calendar-feed', { cookie })).data).toEqual({ token: null })

    const first = (await call(app, 'POST', '/api/calendar-feed', { cookie })).data.token
    expect(first).toMatch(/^[\w-]{20,}$/)
    const second = (await call(app, 'POST', '/api/calendar-feed', { cookie })).data.token
    expect(second).not.toBe(first)
    expect((await call(app, 'GET', `/api/calendar/${first}.ics`)).statusCode).toBe(404)
    expect((await call(app, 'GET', `/api/calendar/${second}.ics`)).statusCode).toBe(200)

    await call(app, 'DELETE', '/api/calendar-feed', { cookie })
    expect((await call(app, 'GET', `/api/calendar/${second}.ics`)).statusCode).toBe(404)
  })

  it('serves followed episodes from the past two weeks onward, without auth', async () => {
    await saveSettings({ APP_URL: 'https://tv.example.test' })
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie })
    const { token } = (await call(app, 'POST', '/api/calendar-feed', { cookie })).data

    const res = await call(app, 'GET', `/api/calendar/${token}.ics`)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    expect(res.headers['cache-control']).toBe('private, max-age=900')
    expect(res.body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)

    const summaries = [...res.body.matchAll(/^SUMMARY:(.*)\r$/gm)].map((m) => m[1])
    // S2E1 (-9d), S2E2 (-3d), S2E3 (+5d). Old season 1, the special and the undated S2E4 are out.
    expect(summaries).toEqual(['Alpha S02E01', 'Alpha S02E02', 'Alpha S02E03'])
    expect(res.body).toContain(`URL:https://tv.example.test/show/${ALPHA}`)
    expect(res.body).toMatch(/UID:rewatch-episode-\d+@tv\.example\.test/)
  })

  it('leaves archived shows out', async () => {
    await call(app, 'PUT', `/api/shows/${ALPHA}/follow`, { cookie, body: { state: 'ARCHIVED' } })
    const { token } = (await call(app, 'POST', '/api/calendar-feed', { cookie })).data
    expect((await call(app, 'GET', `/api/calendar/${token}.ics`)).body).not.toContain('BEGIN:VEVENT')
  })
})

describe('web push', () => {
  const subscription = (endpoint = 'https://push.example.test/abc') => ({
    endpoint,
    keys: { p256dh: 'p256', auth: 'auth' },
  })

  it('answers 503 for the public key until VAPID is configured', async () => {
    expect((await call(app, 'GET', '/api/push/vapid-key', { cookie })).statusCode).toBe(503)
  })

  it('serves the VAPID key generated from the admin console', async () => {
    await saveSettings({ VAPID_PUBLIC_KEY: 'console-public', VAPID_PRIVATE_KEY: 'console-private' })
    const res = await call(app, 'GET', '/api/push/vapid-key', { cookie })
    expect(res.statusCode).toBe(200)
    expect(res.data).toEqual({ key: 'console-public' })
  })

  it('subscribes, moves an endpoint to whoever is logged in, and unsubscribes', async () => {
    await call(app, 'PUT', '/api/push/subscription', { cookie, body: subscription() })
    const other = await createUser()
    await call(app, 'PUT', '/api/push/subscription', { cookie: other.cookie, body: subscription() })
    expect(await prisma.pushSubscription.findMany({ select: { userId: true } })).toEqual([{ userId: other.user.id }])

    expect((await call(app, 'PUT', '/api/push/subscription', { cookie, body: { endpoint: 'nope' } })).statusCode).toBe(400)

    await call(app, 'DELETE', '/api/push/subscription', { cookie: other.cookie, body: { endpoint: subscription().endpoint } })
    expect(await prisma.pushSubscription.count()).toBe(0)
  })

  it('sends a test push to every device and prunes dead subscriptions', async () => {
    await saveSettings({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })
    await call(app, 'PUT', '/api/push/subscription', { cookie, body: subscription('https://push.example.test/live') })
    await call(app, 'PUT', '/api/push/subscription', { cookie, body: subscription('https://push.example.test/gone') })
    push.failWith.set('https://push.example.test/gone', 410)

    const res = await call(app, 'POST', '/api/push/test', { cookie })
    expect(res.data).toEqual({ delivered: 1 })
    expect(push.sent.map((p) => p.endpoint)).toEqual(['https://push.example.test/live'])
    expect(await prisma.pushSubscription.findMany({ where: { userId }, select: { endpoint: true } })).toEqual([
      { endpoint: 'https://push.example.test/live' },
    ])
  })
})
