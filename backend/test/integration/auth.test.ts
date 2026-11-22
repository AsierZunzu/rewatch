import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../../src/lib/prisma.js'
import { call, createUser, daysFromNow, installFakeFetch, resetDb, startApp } from './helpers.js'

// Capture outgoing emails instead of sending them: the raw tokens they carry are
// the only way to drive the verify and reset flows end to end.
const mail = vi.hoisted(() => ({
  verify: [] as { to: string; token: string }[],
  reset: [] as { to: string; token: string }[],
}))
vi.mock('../../src/lib/mailer.js', () => ({
  sendVerificationEmail: vi.fn(async (to: string, _u: string, token: string) => void mail.verify.push({ to, token })),
  sendVerifyReminderEmail: vi.fn(async () => {}),
  sendResetEmail: vi.fn(async (to: string, _u: string, token: string) => void mail.reset.push({ to, token })),
  sendTestEmail: vi.fn(async () => {}),
}))

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
  mail.verify.length = 0
  mail.reset.length = 0
  vi.unstubAllEnvs()
})

const sessionCookie = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie']
  const header = Array.isArray(raw) ? raw[0] : String(raw)
  return header.split(';')[0]!
}

const register = (body: Record<string, unknown>) =>
  call(app, 'POST', '/api/auth/register', {
    body: { username: 'alice', password: 'correct-horse', email: 'Alice@Example.test', ...body },
  })

describe('POST /api/auth/register', () => {
  it('creates the account, opens a session and sends a verification email', async () => {
    const res = await register({ language: 'fr', timezone: 'Europe/Paris' })

    expect(res.statusCode).toBe(201)
    expect(res.data).toMatchObject({
      username: 'alice',
      email: 'alice@example.test', // lower-cased
      emailVerified: false,
      language: 'fr',
      timezone: 'Europe/Paris',
      blocked: false,
    })
    expect(res.data.verifyDeadline).toBeTruthy()
    expect(mail.verify).toEqual([{ to: 'alice@example.test', token: expect.any(String) }])

    const me = await call(app, 'GET', '/api/auth/me', { cookie: sessionCookie(res) })
    expect(me.statusCode).toBe(200)
    expect(me.data.username).toBe('alice')
  })

  it('makes the first account an admin and nobody after it', async () => {
    const first = await register({})
    const second = await register({ username: 'bob', email: 'bob@example.test' })
    expect(first.data.isAdmin).toBe(true)
    expect(second.data.isAdmin).toBe(false)
  })

  it('stores the password hashed', async () => {
    await register({})
    const row = await prisma.user.findUniqueOrThrow({ where: { username: 'alice' } })
    expect(row.passwordHash).not.toContain('correct-horse')
    expect(row.passwordHash).toMatch(/^\$argon2/)
  })

  it.each([
    ['a too-short username', { username: 'ab' }],
    ['a username with spaces', { username: 'al ice' }],
    ['a short password', { password: 'short' }],
    ['an invalid email', { email: 'not-an-email' }],
    ['an unknown language', { language: 'xx' }],
    ['an unknown timezone', { timezone: 'Mars/Olympus' }],
  ])('rejects %s', async (_label, body) => {
    const res = await register(body)
    expect(res.statusCode).toBe(400)
    expect(res.data.error).toBe('invalid_input')
  })

  it('refuses a taken username or email', async () => {
    await register({})
    expect((await register({ email: 'other@example.test' })).data.error).toBe('username_taken')
    expect((await register({ username: 'other' })).data.error).toBe('email_taken')
  })

  it('is closed when the operator disables registration', async () => {
    vi.stubEnv('REGISTRATION_ENABLED', 'false')
    const res = await register({})
    expect(res.statusCode).toBe(403)
    expect(res.data.error).toBe('registration_closed')
  })

  it('is rate limited per IP', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await call(app, 'POST', '/api/auth/register', {
        ip: '192.0.2.1',
        body: { username: `u${i}x`, password: 'password123', email: `u${i}@example.test` },
      })
      statuses.push(res.statusCode)
    }
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201])
    expect(statuses[5]).toBe(429)
  })
})

describe('POST /api/auth/login and /logout', () => {
  it('logs in with the right password and returns the public user', async () => {
    const { user, password } = await createUser({ username: 'carol' })
    const res = await call(app, 'POST', '/api/auth/login', { body: { username: 'carol', password } })
    expect(res.statusCode).toBe(200)
    expect(res.data).toMatchObject({ id: user.id, username: 'carol', emailVerified: true })
    expect(res.data).not.toHaveProperty('passwordHash')
    expect(String(res.headers['set-cookie'])).toMatch(/rewatch_session=.+HttpOnly/i)
  })

  it('gives the same answer for a wrong password and an unknown user', async () => {
    await createUser({ username: 'carol' })
    const wrong = await call(app, 'POST', '/api/auth/login', { body: { username: 'carol', password: 'nopenopenope' } })
    const unknown = await call(app, 'POST', '/api/auth/login', { body: { username: 'nobody', password: 'nopenopenope' } })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.data).toEqual(unknown.data)
  })

  it('logout destroys the session', async () => {
    const { cookie } = await createUser()
    expect((await call(app, 'POST', '/api/auth/logout', { cookie })).statusCode).toBe(200)
    expect((await call(app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401)
  })

  it('rejects an expired session and deletes it', async () => {
    const { user, cookie } = await createUser()
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: daysFromNow(-1) } })
    expect((await call(app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401)
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0)
  })
})

describe('authentication gates', () => {
  it('401s a protected route without a session', async () => {
    expect((await call(app, 'GET', '/api/watchlist')).statusCode).toBe(401)
    expect((await call(app, 'GET', '/api/watchlist', { cookie: 'rewatch_session=forged' })).statusCode).toBe(401)
  })

  it('blocks an unverified account past its grace period, except from the routes that unblock it', async () => {
    const { cookie } = await createUser({ verified: false, createdAt: daysFromNow(-8) })

    const blocked = await call(app, 'GET', '/api/watchlist', { cookie })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.data.error).toBe('email_verification_required')

    const me = await call(app, 'GET', '/api/auth/me', { cookie })
    expect(me.statusCode).toBe(200)
    expect(me.data.blocked).toBe(true)

    expect((await call(app, 'POST', '/api/auth/resend-verification', { cookie })).statusCode).toBe(200)
    expect(mail.verify).toHaveLength(1)
  })

  it('lets an unverified account in while still within its grace period', async () => {
    const { cookie } = await createUser({ verified: false, createdAt: daysFromNow(-6) })
    expect((await call(app, 'GET', '/api/watchlist', { cookie })).statusCode).toBe(200)
  })
})

describe('email verification', () => {
  it('verifies with the emailed token, exactly once', async () => {
    const res = await register({})
    const { token } = mail.verify[0]!

    expect((await call(app, 'POST', '/api/auth/verify', { body: { token } })).statusCode).toBe(200)
    const me = await call(app, 'GET', '/api/auth/me', { cookie: sessionCookie(res) })
    expect(me.data.emailVerified).toBe(true)

    const again = await call(app, 'POST', '/api/auth/verify', { body: { token } })
    expect(again.statusCode).toBe(400)
    expect(again.data.error).toBe('invalid_or_expired_token')
  })

  it('only keeps the latest token alive', async () => {
    const { cookie } = await createUser({ verified: false })
    await call(app, 'POST', '/api/auth/resend-verification', { cookie })
    await call(app, 'POST', '/api/auth/resend-verification', { cookie })
    const [first, second] = mail.verify
    expect((await call(app, 'POST', '/api/auth/verify', { body: { token: first!.token } })).statusCode).toBe(400)
    expect((await call(app, 'POST', '/api/auth/verify', { body: { token: second!.token } })).statusCode).toBe(200)
  })

  it('changing the email resets verification and refuses an address in use', async () => {
    await createUser({ email: 'taken@example.test' })
    const { cookie } = await createUser()

    const taken = await call(app, 'PATCH', '/api/auth/email', { cookie, body: { email: 'TAKEN@example.test' } })
    expect(taken.statusCode).toBe(409)

    const res = await call(app, 'PATCH', '/api/auth/email', { cookie, body: { email: 'new@example.test' } })
    expect(res.statusCode).toBe(200)
    expect(res.data).toMatchObject({ email: 'new@example.test', emailVerified: false })
    expect(mail.verify.at(-1)?.to).toBe('new@example.test')
  })
})

describe('password reset', () => {
  it('sends a link to a verified address only, and always answers 200', async () => {
    await createUser({ email: 'verified@example.test' })
    await createUser({ email: 'unverified@example.test', verified: false })

    for (const email of ['verified@example.test', 'unverified@example.test', 'unknown@example.test', 'garbage']) {
      expect((await call(app, 'POST', '/api/auth/forgot', { body: { email } })).statusCode).toBe(200)
    }
    expect(mail.reset.map((m) => m.to)).toEqual(['verified@example.test'])
  })

  it('resets the password and logs out every device', async () => {
    const { user, cookie } = await createUser({ email: 'r@example.test' })
    await call(app, 'POST', '/api/auth/forgot', { body: { email: 'r@example.test' } })
    const { token } = mail.reset[0]!

    const res = await call(app, 'POST', '/api/auth/reset', { body: { token, password: 'brand-new-pass' } })
    expect(res.statusCode).toBe(200)
    expect((await call(app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401)

    const login = await call(app, 'POST', '/api/auth/login', {
      body: { username: user.username, password: 'brand-new-pass' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('rejects an expired reset token', async () => {
    await createUser({ email: 'r@example.test' })
    await call(app, 'POST', '/api/auth/forgot', { body: { email: 'r@example.test' } })
    await prisma.authToken.updateMany({ data: { expiresAt: daysFromNow(-1) } })
    const res = await call(app, 'POST', '/api/auth/reset', {
      body: { token: mail.reset[0]!.token, password: 'brand-new-pass' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('changes the password when the current one is right', async () => {
    const { cookie, password } = await createUser()
    const wrong = await call(app, 'PATCH', '/api/auth/password', { cookie, body: { current: 'nope', next: 'another-pass' } })
    expect(wrong.statusCode).toBe(401)
    const ok = await call(app, 'PATCH', '/api/auth/password', { cookie, body: { current: password, next: 'another-pass' } })
    expect(ok.statusCode).toBe(200)
  })
})

describe('profile preferences', () => {
  it('updates the language and the timezone, validating both', async () => {
    const { cookie } = await createUser()
    expect((await call(app, 'PATCH', '/api/auth/language', { cookie, body: { language: 'de' } })).data.language).toBe('de')
    expect((await call(app, 'PATCH', '/api/auth/language', { cookie, body: { language: 'klingon' } })).statusCode).toBe(400)
    expect(
      (await call(app, 'PATCH', '/api/auth/timezone', { cookie, body: { timezone: 'America/New_York' } })).data.timezone,
    ).toBe('America/New_York')
    expect((await call(app, 'PATCH', '/api/auth/timezone', { cookie, body: { timezone: 'Nowhere/City' } })).statusCode).toBe(400)
  })
})

describe('GET /api/health', () => {
  it('answers without a session', async () => {
    const res = await call(app, 'GET', '/api/health')
    expect(res.data).toEqual({ status: 'ok' })
  })
})
