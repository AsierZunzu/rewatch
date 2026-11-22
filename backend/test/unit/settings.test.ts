import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ rows: [] as { key: string; value: string }[] }))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    setting: {
      findMany: vi.fn(async () => db.rows),
      upsert: vi.fn((args: unknown) => args),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}))

const settings = await import('../../src/lib/settings.js')

beforeEach(async () => {
  vi.unstubAllEnvs()
  db.rows = []
  await settings.loadSettings()
})

describe('settings', () => {
  it('reads DB values loaded at boot', async () => {
    db.rows = [{ key: 'APP_URL', value: 'https://db.example' }]
    await settings.loadSettings()
    expect(settings.getSetting('APP_URL')).toBe('https://db.example')
  })

  it('lets a non-empty environment variable win, and locks it', async () => {
    db.rows = [{ key: 'APP_URL', value: 'https://db.example' }]
    await settings.loadSettings()
    vi.stubEnv('APP_URL', 'https://env.example')
    expect(settings.getSetting('APP_URL')).toBe('https://env.example')
    expect(settings.isEnvLocked('APP_URL')).toBe(true)

    vi.stubEnv('APP_URL', '')
    expect(settings.getSetting('APP_URL')).toBe('https://db.example')
    expect(settings.isEnvLocked('APP_URL')).toBe(false)
  })

  it('treats an empty value as unset', async () => {
    db.rows = [{ key: 'LEGAL_HOST', value: '' }]
    await settings.loadSettings()
    expect(settings.getSetting('LEGAL_HOST')).toBeUndefined()
  })

  it('updates the cache on save and notifies listeners', async () => {
    const listener = vi.fn()
    settings.onSettingsChange(listener)
    await settings.saveSettings({ LEGAL_CONTACT: 'ops@example.test' })
    expect(settings.getSetting('LEGAL_CONTACT')).toBe('ops@example.test')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('needs setup until a TMDB token exists', async () => {
    expect(settings.needsSetup()).toBe(true)
    await settings.saveSettings({ TMDB_API_TOKEN: 'token' })
    expect(settings.needsSetup()).toBe(false)
  })

  it('declares every secret as a known key', () => {
    for (const key of settings.SECRET_KEYS) expect(settings.SETTING_KEYS).toContain(key)
  })
})
