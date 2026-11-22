import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runDailyJob = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../src/jobs/daily.js', () => ({ runDailyJob }))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))

const sendMail = vi.hoisted(() => vi.fn(async () => ({})))
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })))
vi.mock('nodemailer', () => ({ default: { createTransport } }))

const { startDailySchedule } = await import('../../src/lib/scheduler.js')
const mailer = await import('../../src/lib/mailer.js')

const fakeApp = () => {
  const log = { info: vi.fn(), error: vi.fn() }
  return { app: { log } as unknown as FastifyInstance, log }
}

beforeEach(() => {
  vi.unstubAllEnvs()
  runDailyJob.mockClear()
  sendMail.mockClear()
  createTransport.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('startDailySchedule', () => {
  it('does nothing when DAILY_JOB_AT is unset', () => {
    const { app, log } = fakeApp()
    vi.useFakeTimers()
    startDailySchedule(app)
    expect(vi.getTimerCount()).toBe(0)
    expect(log.info).not.toHaveBeenCalled()
  })

  it.each(['25:00', '8h30', '12:60'])('refuses an invalid time (%s)', (value) => {
    vi.stubEnv('DAILY_JOB_AT', value)
    const { app, log } = fakeApp()
    startDailySchedule(app)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not a valid HH:MM'))
  })

  it('runs once a day, at the first tick past the slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1, 8, 0, 0)) // local time, like the scheduler
    vi.stubEnv('DAILY_JOB_AT', '08:30')
    const { app } = fakeApp()
    startDailySchedule(app)

    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(runDailyJob).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(runDailyJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(runDailyJob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(runDailyJob).toHaveBeenCalledTimes(2)
  })

  it('does not catch up when started after the slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1, 9, 0, 0))
    vi.stubEnv('DAILY_JOB_AT', '08:30')
    startDailySchedule(fakeApp().app)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(runDailyJob).not.toHaveBeenCalled()
  })

  it('logs a failed run instead of crashing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1, 8, 29, 50))
    vi.stubEnv('DAILY_JOB_AT', '08:30')
    runDailyJob.mockRejectedValueOnce(new Error('boom'))
    const { app, log } = fakeApp()
    startDailySchedule(app)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(log.error).toHaveBeenCalledWith('daily job failed: boom')
  })
})

describe('mailer', () => {
  it('logs instead of sending when SMTP is not configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await mailer.sendVerificationEmail('a@example.test', 'alice', 'tok')
    expect(createTransport).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[mailer disabled] To: a@example.test'))
  })

  it('sends through SMTP with a localized body and a link to APP_URL', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.test')
    vi.stubEnv('SMTP_USER', 'user')
    vi.stubEnv('SMTP_PASS', 'pass')
    vi.stubEnv('APP_URL', 'https://tv.example.test/')
    await mailer.sendResetEmail('a@example.test', 'alice', 'tok123', 'fr')

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.test', port: 587, secure: false, auth: { user: 'user', pass: 'pass' } }),
    )
    const [message] = sendMail.mock.calls[0]! as unknown as [{ to: string; subject: string; text: string }]
    expect(message.to).toBe('a@example.test')
    expect(message.subject).toMatch(/réinitialisation/)
    expect(message.text).toContain('https://tv.example.test/reset?token=tok123')
  })

  it('has every template in every language', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.test')
    const { LANGS } = await import('../../src/lib/langs.js')
    for (const lang of LANGS) {
      await mailer.sendVerificationEmail('a@x.test', 'u', 't', lang)
      await mailer.sendVerifyReminderEmail('a@x.test', 'u', 't', lang)
      await mailer.sendResetEmail('a@x.test', 'u', 't', lang)
    }
    expect(sendMail).toHaveBeenCalledTimes(LANGS.length * 3)
  })
})
