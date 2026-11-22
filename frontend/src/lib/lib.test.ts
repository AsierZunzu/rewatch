import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { hasAired, knownAirInstant } from './airing'
import {
  airTimeLabel,
  calendarDayLabel,
  epCode,
  frDate,
  initial,
  minutesToDaysHours,
  posterColor,
  runtimeLabel,
  tmdbImage,
} from './format'

describe('hasAired', () => {
  const now = Date.parse('2025-06-01T12:00:00Z')

  it('compares the absolute instant, not the air date', () => {
    expect(hasAired({ airsAt: '2025-06-01T11:59:59Z' }, now)).toBe(true)
    expect(hasAired({ airsAt: '2025-06-01T12:00:00Z' }, now)).toBe(true)
    expect(hasAired({ airsAt: '2025-06-01T12:00:01Z' }, now)).toBe(false)
  })

  it('treats an unknown instant as not aired', () => {
    expect(hasAired({ airsAt: null }, now)).toBe(false)
  })
})

describe('knownAirInstant', () => {
  it.each(['TRAKT', 'TVMAZE', 'SCHEDULE'] as const)('shows a %s instant', (source) => {
    expect(knownAirInstant({ airsAt: '2025-06-01T20:00:00Z', airsAtSource: source })).toEqual(new Date('2025-06-01T20:00:00Z'))
  })

  it('hides the FALLBACK bound, which is not a real air time', () => {
    expect(knownAirInstant({ airsAt: '2025-06-02T07:00:00Z', airsAtSource: 'FALLBACK' })).toBeNull()
    expect(knownAirInstant({ airsAt: null, airsAtSource: null })).toBeNull()
  })
})

describe('format helpers', () => {
  it('formats episode codes', () => {
    expect(epCode(1, 2)).toBe('S01E02')
    expect(epCode(12, 105)).toBe('S12E105')
  })

  it('builds TMDB image URLs', () => {
    expect(tmdbImage('/abc.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg')
    expect(tmdbImage('/abc.jpg', 'w780')).toBe('https://image.tmdb.org/t/p/w780/abc.jpg')
    expect(tmdbImage(null)).toBeNull()
  })

  it('skips leading articles for the poster initial', () => {
    expect(initial('The Office')).toBe('O')
    expect(initial("L'Arnacoeur")).toBe('A')
    expect(initial('les revenants')).toBe('R')
    expect(initial('Theodore')).toBe('T')
    expect(initial('Legion')).toBe('L')
    expect(initial('Lady Bird')).toBe('L')
  })

  it('picks a stable poster color per title', () => {
    expect(posterColor('Dark')).toBe(posterColor('Dark'))
    expect(posterColor('Dark')).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('formats durations', () => {
    expect(minutesToDaysHours(90)).toBe('1 h 30 min')
    expect(minutesToDaysHours(60 * 24 * 2 + 60 * 5)).toBe('2 d 5 h')
    expect(runtimeLabel(45)).toBe('45 min')
    expect(runtimeLabel(125)).toBe('2 h 05')
    expect(runtimeLabel(null)).toBeNull()
    expect(runtimeLabel(0)).toBeNull()
  })

  it('follows the UI language for dates', async () => {
    const d = '2025-07-14T12:00:00Z'
    expect(frDate(d)).toBe('14 Jul 2025')
    await i18n.changeLanguage('fr')
    expect(frDate(d)).toBe('14 juil. 2025')
    await i18n.changeLanguage('de')
    expect(frDate(d)).toBe('14. Juli 2025')
  })
})

describe('relative day labels', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-11T10:00:00Z')) // a Wednesday; TZ is pinned to UTC
  })
  afterEach(() => vi.useRealTimers())

  it('hangs the clock time on the day it belongs to', () => {
    expect(airTimeLabel(new Date('2025-06-11T21:00:00Z'))).toBe('Today · 21:00')
    expect(airTimeLabel(new Date('2025-06-12T21:00:00Z'))).toBe('Tomorrow · 21:00')
    expect(airTimeLabel(new Date('2025-06-13T21:00:00Z'))).toBe('Fri · 21:00')
    expect(airTimeLabel(new Date('2025-06-30T21:00:00Z'))).toBe('30 Jun · 21:00')
    expect(airTimeLabel(new Date('2025-06-01T21:00:00Z'))).toBe('1 Jun · 21:00')
    expect(airTimeLabel(new Date('2026-01-05T21:00:00Z'))).toBe('5 Jan 2026 · 21:00')
  })

  it('labels calendar days', () => {
    expect(calendarDayLabel(new Date('2025-06-11T00:00:00Z'))).toMatchObject({ label: 'Today', today: true, daysUntil: null })
    expect(calendarDayLabel(new Date('2025-06-12T00:00:00Z'))).toMatchObject({ label: 'Tomorrow', sub: 'Thursday 12 June' })
    expect(calendarDayLabel(new Date('2025-06-15T00:00:00Z'))).toEqual({ label: 'Sunday 15 June', sub: '', today: false, daysUntil: 4 })
    expect(calendarDayLabel(new Date('2026-01-01T00:00:00Z')).label).toMatch(/^Thursday,? 1 January 2026$/)
    expect(calendarDayLabel(new Date('2025-06-01T00:00:00Z')).daysUntil).toBeNull()
  })
})
