import { describe, expect, it } from 'vitest'
import { applyExactInstantsSql, mergeAirTimes, type ProviderAirTimes } from '../../src/lib/airing.js'

const at = (iso: string) => new Date(iso)
const provider = (
  source: 'TRAKT' | 'TVMAZE',
  firstAired: Record<string, string>,
  airs: { time: string; timezone: string } | null = null,
): ProviderAirTimes => ({
  source,
  airs,
  firstAired: new Map(Object.entries(firstAired).map(([key, iso]) => [key, at(iso)])),
})

describe('mergeAirTimes', () => {
  it('ranks Trakt over TVmaze per episode, and fills gaps from TVmaze', () => {
    const merged = mergeAirTimes([
      provider('TVMAZE', { '1:1': '2025-01-02T02:00:00Z', '1:2': '2025-01-09T02:00:00Z' }),
      provider('TRAKT', { '1:1': '2025-01-02T01:00:00Z' }),
    ])
    expect(merged.instants.get('1:1')).toEqual({ at: at('2025-01-02T01:00:00Z'), source: 'TRAKT' })
    expect(merged.instants.get('1:2')).toEqual({ at: at('2025-01-09T02:00:00Z'), source: 'TVMAZE' })
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

  it('passes each instant with its season and number', () => {
    const sql = applyExactInstantsSql(1, new Map([['2:5', { at: at('2025-01-01T00:00:00Z'), source: 'TRAKT' as const }]]), ['TRAKT'])!
    expect(sql.values).toEqual(expect.arrayContaining([2, 5, at('2025-01-01T00:00:00Z')]))
  })
})
