import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LANG, isLang, LANG_TO_TMDB, LANGS, toLang } from '../../src/lib/langs.js'
import { isBlocked, VERIFY_GRACE_MS, verifyDeadline } from '../../src/lib/verification.js'

describe('langs', () => {
  it('narrows unknown values to the default', () => {
    expect(toLang('fr')).toBe('fr')
    expect(toLang('xx')).toBe(DEFAULT_LANG)
    expect(toLang(null)).toBe(DEFAULT_LANG)
    expect(isLang('de')).toBe(true)
    expect(isLang('DE')).toBe(false)
  })

  it('maps every language to a TMDB locale', () => {
    for (const lang of LANGS) expect(LANG_TO_TMDB[lang]).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
  })
})

describe('verification policy', () => {
  const created = new Date('2025-01-01T00:00:00Z')

  afterEach(() => vi.useRealTimers())

  it('has no deadline once verified', () => {
    expect(verifyDeadline({ emailVerifiedAt: new Date(), createdAt: created })).toBeNull()
    expect(isBlocked({ emailVerifiedAt: new Date(), createdAt: created })).toBe(false)
  })

  it('blocks only after the grace period', () => {
    const user = { emailVerifiedAt: null, createdAt: created }
    expect(verifyDeadline(user)).toEqual(new Date(created.getTime() + VERIFY_GRACE_MS))

    vi.useFakeTimers()
    vi.setSystemTime(created.getTime() + VERIFY_GRACE_MS - 1000)
    expect(isBlocked(user)).toBe(false)
    vi.setSystemTime(created.getTime() + VERIFY_GRACE_MS + 1000)
    expect(isBlocked(user)).toBe(true)
  })
})

describe('metrics', () => {
  beforeEach(() => vi.resetModules())

  it('reports percentiles, error rate and the slowest API routes', async () => {
    const { metricsSnapshot, recordRequest } = await import('../../src/lib/metrics.js')
    for (let ms = 1; ms <= 100; ms++) recordRequest('/api/fast', ms, 200)
    recordRequest('/api/slow', 900, 500)
    recordRequest('/assets/app.js', 5000, 200)

    const snap = metricsSnapshot()
    expect(snap.latency.p50).toBe(51)
    expect(snap.latency.p99).toBe(900)
    expect(snap.throughput).toMatchObject({ requests15m: 102, totalSinceBoot: 102, errors15m: 1 })
    expect(snap.throughput.errorRate15m).toBeCloseTo(1, 0)
    expect(snap.routes.map((r) => r.route)).toEqual(['/api/slow', '/api/fast']) // static assets excluded
    expect(snap.buckets).toHaveLength(30)
  })

  it('is all zeros before any request', async () => {
    const { metricsSnapshot } = await import('../../src/lib/metrics.js')
    const snap = metricsSnapshot()
    expect(snap.latency).toMatchObject({ p50: 0, p95: 0, p99: 0 })
    expect(snap.throughput.errorRate15m).toBe(0)
    expect(snap.routes).toEqual([])
  })
})
