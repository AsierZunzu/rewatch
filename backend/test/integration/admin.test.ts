import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { getSetting } from '../../src/lib/settings.js'
import { call, createUser, daysFromNow, installFakeFetch, json, onFetch, resetDb, startApp } from './helpers.js'

const mail = vi.hoisted(() => ({ sent: [] as string[] }))
vi.mock('../../src/lib/mailer.js', () => ({
  sendVerificationEmail: vi.fn(async (to: string) => void mail.sent.push(`verify:${to}`)),
  sendVerifyReminderEmail: vi.fn(async () => {}),
  sendResetEmail: vi.fn(async (to: string) => void mail.sent.push(`reset:${to}`)),
  sendTestEmail: vi.fn(async (to: string) => void mail.sent.push(`test:${to}`)),
}))

let app: FastifyInstance
let admin: Awaited<ReturnType<typeof createUser>>

beforeAll(async () => {
  app = await startApp()
})
afterAll(async () => {
  await app.close()
})
beforeEach(async () => {
  await resetDb()
  installFakeFetch()
  mail.sent.length = 0
  vi.unstubAllEnvs()
  admin = await createUser({ username: 'admin', isAdmin: true })
})

describe('admin surface', () => {
  it('is invisible (404) to regular users and anonymous visitors', async () => {
    const { cookie } = await createUser()
    for (const url of ['/api/admin/overview', '/api/admin/users', '/api/admin/metrics', '/api/admin/settings']) {
      expect((await call(app, 'GET', url, { cookie })).statusCode).toBe(404)
      expect((await call(app, 'GET', url)).statusCode).toBe(404)
    }
  })

  it('serves the overview and live metrics', async () => {
    await createUser({ verified: false })
    const overview = (await call(app, 'GET', '/api/admin/overview', { cookie: admin.cookie })).data
    expect(overview.users).toMatchObject({ total: 2, verified: 1 })
    expect(overview.cache).toEqual({ shows: 0, episodes: 0, movies: 0 })

    const metrics = (await call(app, 'GET', '/api/admin/metrics', { cookie: admin.cookie })).data
    expect(metrics.latency).toHaveProperty('p95')
    expect(metrics.db.pingMs).toBeGreaterThanOrEqual(0)
    expect(metrics.buckets).toHaveLength(30)
  })
})

describe('GET /api/admin/users', () => {
  beforeEach(async () => {
    await createUser({ username: 'zed', email: 'zed@corp.test' })
    await createUser({ username: 'amy', verified: false })
    await createUser({ username: 'bob', verified: false, createdAt: daysFromNow(-10) })
  })

  const list = async (query = '') => (await call(app, 'GET', `/api/admin/users${query}`, { cookie: admin.cookie })).data

  it('paginates', async () => {
    const page = await list('?pageSize=2&page=2&sort=username&dir=asc')
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2, totalPages: 2 })
    expect(page.users.map((u: any) => u.username)).toEqual(['bob', 'zed'])
  })

  it('filters by status, role and search', async () => {
    expect((await list('?status=blocked')).users.map((u: any) => u.username)).toEqual(['bob'])
    expect((await list('?status=unverified')).users.map((u: any) => u.username)).toEqual(['amy'])
    expect((await list('?role=admin')).users.map((u: any) => u.username)).toEqual(['admin'])
    expect((await list('?search=CORP')).users.map((u: any) => u.username)).toEqual(['zed'])
  })

  it('rejects a sort column outside the whitelist', async () => {
    const res = await call(app, 'GET', '/api/admin/users?sort=password_hash', { cookie: admin.cookie })
    expect(res.statusCode).toBe(400)
  })
})

describe('account management', () => {
  it('verifies a user by hand', async () => {
    const { user } = await createUser({ verified: false })
    await call(app, 'POST', `/api/admin/users/${user.id}/verify`, { cookie: admin.cookie })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull()
  })

  it('resends verification and sends a reset link', async () => {
    const { user } = await createUser({ email: 'u@example.test', verified: false })
    await call(app, 'POST', `/api/admin/users/${user.id}/resend-verification`, { cookie: admin.cookie })
    await call(app, 'POST', `/api/admin/users/${user.id}/send-reset`, { cookie: admin.cookie })
    expect(mail.sent).toEqual(['verify:u@example.test', 'reset:u@example.test'])
    expect((await call(app, 'POST', '/api/admin/users/9999/send-reset', { cookie: admin.cookie })).statusCode).toBe(404)
  })

  it('deletes a user but never itself or another admin', async () => {
    const { user } = await createUser()
    const other = await createUser({ isAdmin: true })
    expect((await call(app, 'DELETE', `/api/admin/users/${admin.user.id}`, { cookie: admin.cookie })).data.error).toBe('cannot_delete_self')
    expect((await call(app, 'DELETE', `/api/admin/users/${other.user.id}`, { cookie: admin.cookie })).data.error).toBe('cannot_delete_admin')
    expect((await call(app, 'DELETE', `/api/admin/users/${user.id}`, { cookie: admin.cookie })).statusCode).toBe(200)
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0)
  })
})

describe('instance settings', () => {
  it('reports setup status publicly, until a TMDB key is saved', async () => {
    expect((await call(app, 'GET', '/api/setup-status')).data).toEqual({ needsSetup: true })
    await call(app, 'PUT', '/api/admin/settings', { cookie: admin.cookie, body: { TMDB_API_TOKEN: 'a'.repeat(32) } })
    expect((await call(app, 'GET', '/api/setup-status')).data).toEqual({ needsSetup: false })
  })

  it('stores values and never returns a secret', async () => {
    const res = await call(app, 'PUT', '/api/admin/settings', {
      cookie: admin.cookie,
      body: { APP_URL: 'https://rewatch.example/', SMTP_PASS: 'hunter2', LEGAL_HOST: 'Jane' },
    })
    expect(res.statusCode).toBe(200)
    expect(getSetting('APP_URL')).toBe('https://rewatch.example') // trailing slash trimmed

    const settings = (await call(app, 'GET', '/api/admin/settings', { cookie: admin.cookie })).data
    const byKey = Object.fromEntries(settings.map((s: any) => [s.key, s]))
    expect(byKey.APP_URL).toMatchObject({ set: true, value: 'https://rewatch.example' })
    expect(byKey.SMTP_PASS).toMatchObject({ set: true, value: null })
    expect(JSON.stringify(settings)).not.toContain('hunter2')

    expect((await call(app, 'GET', '/api/legal-info')).data).toEqual({ host: 'Jane', contact: null })
  })

  it('validates keys and values, and refuses to override the environment', async () => {
    const put = (body: unknown) => call(app, 'PUT', '/api/admin/settings', { cookie: admin.cookie, body })
    expect((await put({ NOT_A_KEY: 'x' })).data).toEqual({ error: 'unknown_setting', key: 'NOT_A_KEY' })
    expect((await put({ SMTP_PORT: 'abc' })).data).toEqual({ error: 'invalid_value', key: 'SMTP_PORT' })
    expect((await put({ APP_URL: 'not a url' })).data).toEqual({ error: 'invalid_value', key: 'APP_URL' })

    vi.stubEnv('LEGAL_HOST', 'From env')
    expect((await put({ LEGAL_HOST: 'From UI' })).data).toEqual({ error: 'env_locked', key: 'LEGAL_HOST' })
    const settings = (await call(app, 'GET', '/api/admin/settings', { cookie: admin.cookie })).data
    expect(settings.find((s: any) => s.key === 'LEGAL_HOST')).toMatchObject({ envLocked: true, value: 'From env' })
  })

  it('generates VAPID keys once', async () => {
    const first = await call(app, 'POST', '/api/admin/settings/generate-vapid', { cookie: admin.cookie })
    expect(first.statusCode).toBe(200)
    expect(getSetting('VAPID_PUBLIC_KEY')).toBe(first.data.publicKey)
    expect((await call(app, 'POST', '/api/admin/settings/generate-vapid', { cookie: admin.cookie })).statusCode).toBe(409)
  })

  it('tests a TMDB token against the API', async () => {
    onFetch((url, init) => {
      if (url.host !== 'api.themoviedb.org') return undefined
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      return json({}, auth === 'Bearer good.token' ? 200 : 401)
    })
    const test = (token: string) => call(app, 'POST', '/api/admin/settings/test-tmdb', { cookie: admin.cookie, body: { token } })
    expect((await test('good.token')).data).toEqual({ ok: true })
    expect((await test('bad.token')).data).toEqual({ ok: false })
    expect((await call(app, 'POST', '/api/admin/settings/test-tmdb', { cookie: admin.cookie })).data.error).toBe('no_token')
  })

  it('only sends a test email once SMTP is configured', async () => {
    const send = () => call(app, 'POST', '/api/admin/settings/test-email', { cookie: admin.cookie, body: { to: 'ops@example.test' } })
    expect((await send()).data.error).toBe('smtp_not_configured')
    vi.stubEnv('SMTP_HOST', 'smtp.example.test')
    expect((await send()).data).toEqual({ ok: true })
    expect(mail.sent).toEqual(['test:ops@example.test'])
  })
})
