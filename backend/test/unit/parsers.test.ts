import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { parseRewatchExport, SUPPORTED_EXPORT_VERSION } from '../../src/lib/rewatch-export.js'
import { parseTvTimeExport } from '../../src/lib/tvtime.js'
import { seriesRow, tvTimeZip, watchRow } from '../tvtime-zip.js'

describe('parseTvTimeExport', () => {
  const zip = tvTimeZip({
    folder: 'export',
    v2: [
      seriesRow(1, 'Show One', '2024-01-01 10:00:00'),
      seriesRow(2, 'Show Two', '2024-01-01 10:00:00', { archived: true }),
      watchRow(1, 'Show One', 1, 1, '2024-01-02 21:00:00'),
      ['rewatch-episode-1-1-1', 1, 'Show One', 1, 1, '2024-02-02 21:00:00', '', '', ''],
      ['watch-episode-bad', 'nope', 'Broken', 1, 1, '2024-01-02 21:00:00', '', '', ''], // no show id
      ['watch-episode-bad', 3, 'No date', 1, 1, '', '', '', ''],
      ['something-else', 4, 'Ignored', 1, 1, '2024-01-02 21:00:00', '', '', ''],
    ],
    v1: [
      ['movie', 'watch', 'Heat', '2020-01-01 20:00:00'],
      ['movie', 'watch', 'Heat', '2021-01-01 20:00:00'],
      ['movie', 'towatch', 'Heat', '2019-01-01 20:00:00'], // watched since: not on the watchlist
      ['movie', 'towatch', 'Ronin', '2019-01-01 20:00:00'],
      ['episode', 'watch', 'Not a movie', '2019-01-01 20:00:00'],
    ],
    ratings: [
      [1, 4, '2024-03-01 10:00:00'],
      [2, 9, '2024-03-01 10:00:00'], // out of range
    ],
    favorites: [
      [1, '1'],
      [2, '0'],
    ],
  })

  const data = parseTvTimeExport(zip)

  it('reads watches and rewatches, skipping unusable rows', () => {
    expect(data.episodeEvents).toEqual([
      { tvdbShowId: 1, seriesName: 'Show One', season: 1, number: 1, watchedAt: new Date('2024-01-02T21:00:00Z') },
      { tvdbShowId: 1, seriesName: 'Show One', season: 1, number: 1, watchedAt: new Date('2024-02-02T21:00:00Z') },
    ])
  })

  it('reads the series list with its flags', () => {
    expect(data.series.map((s) => [s.tvdbShowId, s.isFollowed, s.isArchived, s.isForLater])).toEqual([
      [1, true, false, false],
      [2, false, true, false],
    ])
  })

  it('groups movie watches and keeps the watchlist to unwatched titles', () => {
    expect(data.watchedMovies).toEqual([
      { title: 'Heat', watchedAts: [new Date('2020-01-01T20:00:00Z'), new Date('2021-01-01T20:00:00Z')] },
    ])
    expect(data.watchlistMovies).toEqual([{ title: 'Ronin', watchedAts: [] }])
  })

  it('keeps valid ratings and favorites', () => {
    expect(data.showRatings).toEqual([{ tvdbShowId: 1, rating: 4, ratedAt: new Date('2024-03-01T10:00:00Z') }])
    expect(data.favoriteTvdbIds).toEqual([1])
  })

  it('refuses a zip without the v2 tracking file', () => {
    expect(() => parseTvTimeExport(tvTimeZip({ v1: [] }))).toThrow(/tracking-prod-records-v2\.csv missing/)
  })

  it('refuses something that is not a zip at all', () => {
    expect(() => parseTvTimeExport(Buffer.from('hello'))).toThrow()
  })

  it('refuses a zip bomb by declared size', () => {
    const bomb = new AdmZip()
    bomb.addFile('tracking-prod-records-v2.csv', Buffer.alloc(301 * 1024 * 1024, 0x20))
    expect(() => parseTvTimeExport(bomb.toBuffer())).toThrow(/300MB/)
  })
})

describe('parseRewatchExport', () => {
  const json = (v: unknown) => Buffer.from(JSON.stringify(v))
  const minimal = { format: 'rewatch-export', version: 1 }

  it('fills defaults for a minimal export', () => {
    expect(parseRewatchExport(json(minimal))).toMatchObject({ shows: [], episodeWatches: [], movies: [], movieWatchlist: [] })
  })

  it('coerces dates and defaults optional fields', () => {
    const parsed = parseRewatchExport(
      json({
        ...minimal,
        shows: [{ tmdbId: 1, state: 'WATCHING', followedAt: '2024-01-01T00:00:00Z' }],
        movies: [{ tmdbId: 2, watchedAts: ['2024-02-01T00:00:00Z'] }],
      }),
    )
    expect(parsed.shows[0]).toEqual({ tmdbId: 1, name: '', state: 'WATCHING', isFavorite: false, followedAt: new Date('2024-01-01T00:00:00Z'), rating: null })
    expect(parsed.movies[0]!.watchedAts).toEqual([new Date('2024-02-01T00:00:00Z')])
  })

  it.each([
    ['not_json', Buffer.from('{oops')],
    ['not_a_rewatch_export', json({ format: 'tvtime', version: 1 })],
    ['malformed_export', json({ ...minimal, shows: [{ tmdbId: -1, state: 'WATCHING', followedAt: '2024-01-01' }] })],
    ['malformed_export', json({ ...minimal, shows: [{ tmdbId: 1, state: 'DROPPED', followedAt: '2024-01-01' }] })],
    ['malformed_export', json({ ...minimal, movies: [{ tmdbId: 1, rating: 11 }] })],
    ['unsupported_version', json({ format: 'rewatch-export', version: SUPPORTED_EXPORT_VERSION + 1 })],
  ])('throws %s', (message, buffer) => {
    expect(() => parseRewatchExport(buffer)).toThrow(message)
  })
})
