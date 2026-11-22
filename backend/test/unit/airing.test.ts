import { describe, expect, it } from 'vitest'
import { applyExactInstantsSql, localDate, mergeAirTimes, recordInstant, type ProviderAirTimes } from '../../src/lib/airing.js'

const at = (iso: string) => new Date(iso)
const provider = (
  source: 'TRAKT' | 'TVMAZE',
  instantsByDate: Record<string, string>,
  airs: { time: string; timezone: string } | null = null,
): ProviderAirTimes => ({
  source,
  airs,
  instantsByDate: new Map(Object.entries(instantsByDate).map(([date, iso]) => [date, at(iso)])),
})

describe('recordInstant', () => {
  it('keeps the latest instant when a date carries several episodes', () => {
    const instants = new Map<string, Date>()
    recordInstant(instants, '2025-01-01', at('2025-01-02T02:00:00Z'))
    recordInstant(instants, '2025-01-01', at('2025-01-02T02:30:00Z')) // the second half of a double bill
    recordInstant(instants, '2025-01-01', at('2025-01-02T01:00:00Z'))
    expect(instants).toEqual(new Map([['2025-01-01', at('2025-01-02T02:30:00Z')]]))
  })
})

describe('localDate', () => {
  it("is the instant's calendar date in the show's zone, not in UTC", () => {
    // 21:00 New York on the 1st is already the 2nd in UTC.
    expect(localDate(at('2025-01-02T02:00:00Z'), 'America/New_York')).toBe('2025-01-01')
    expect(localDate(at('2025-01-02T02:00:00Z'), null)).toBe('2025-01-02')
  })

  it('falls back to the UTC date on a zone Intl does not know', () => {
    expect(localDate(at('2025-01-02T02:00:00Z'), 'Not/AZone')).toBe('2025-01-02')
  })
})

describe('mergeAirTimes', () => {
  it('ranks Trakt over TVmaze per date, and fills gaps from TVmaze', () => {
    const merged = mergeAirTimes([
      provider('TVMAZE', { '2025-01-01': '2025-01-02T02:00:00Z', '2025-01-08': '2025-01-09T02:00:00Z' }),
      provider('TRAKT', { '2025-01-01': '2025-01-02T01:00:00Z' }),
    ])
    expect(merged.instants.get('2025-01-01')).toEqual({ at: at('2025-01-02T01:00:00Z'), source: 'TRAKT' })
    expect(merged.instants.get('2025-01-08')).toEqual({ at: at('2025-01-09T02:00:00Z'), source: 'TVMAZE' })
  })

  it('takes the slot as a pair from the best provider that has one', () => {
    const tvmazeSlot = { time: '21:00', timezone: 'America/New_York' }
    expect(mergeAirTimes([provider('TRAKT', {}, null), provider('TVMAZE', {}, tvmazeSlot)]).airs).toEqual(tvmazeSlot)
    const traktSlot = { time: '20:00', timezone: 'Europe/London' }
    expect(mergeAirTimes([provider('TVMAZE', {}, tvmazeSlot), provider('TRAKT', {}, traktSlot)]).airs).toEqual(traktSlot)
  })

  it('lists the providers that answered, best first', () => {
    expect(mergeAirTimes([provider('TVMAZE', {}), provider('TRAKT', {})]).answered).toEqual(['TRAKT', 'TVMAZE'])
    expect(mergeAirTimes([]).answered).toEqual([])
    expect(mergeAirTimes([]).airs).toBeNull()
  })
})

describe('applyExactInstantsSql', () => {
  it('does nothing when no provider answered', () => {
    expect(applyExactInstantsSql(1, new Map(), [])).toBeNull()
  })

  it('only clears markings when the answering providers have no instants', () => {
    const sql = applyExactInstantsSql(1, new Map(), ['TVMAZE'])!
    expect(sql.sql).toMatch(/^\s*UPDATE episodes SET airs_at_source = NULL/)
    expect(sql.values).toEqual([1, 'TVMAZE'])
  })

  it('passes each instant with its air date, and matches on the date rather than the numbering', () => {
    const sql = applyExactInstantsSql(1, new Map([['2025-01-01', { at: at('2025-01-02T02:00:00Z'), source: 'TRAKT' as const }]]), ['TRAKT'])!
    expect(sql.values).toEqual(expect.arrayContaining(['2025-01-01', at('2025-01-02T02:00:00Z'), 'TRAKT']))
    expect(sql.sql).not.toMatch(/season/)
  })
})
