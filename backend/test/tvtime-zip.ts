// Builds a TV Time GDPR export in memory, shaped like the real thing
// (docs/tvtime-export-format.md). Shared by the parser and import tests.
import AdmZip from 'adm-zip'

const csv = (header: string[], rows: (string | number)[][]) =>
  [header.join(','), ...rows.map((r) => r.map((v) => (String(v).includes(',') ? `"${v}"` : v)).join(','))].join('\n')

export type TvTimeZipInput = {
  v2?: (string | number)[][] // key, s_id, series_name, season_number, episode_number, created_at, is_followed, is_archived, is_for_later
  v1?: (string | number)[][] // entity_type, type, movie_name, created_at
  ratings?: (string | number)[][] // tv_show_id, rating, created_at
  favorites?: (string | number)[][] // tv_show_id, is_favorited
  /** Nest files in a folder, as some exports do. */
  folder?: string
}

export function tvTimeZip(input: TvTimeZipInput) {
  const zip = new AdmZip()
  const prefix = input.folder ? `${input.folder}/` : ''
  const add = (name: string, content: string) => zip.addFile(prefix + name, Buffer.from(content, 'utf8'))

  if (input.v2)
    add(
      'tracking-prod-records-v2.csv',
      csv(
        ['key', 's_id', 'series_name', 'season_number', 'episode_number', 'created_at', 'is_followed', 'is_archived', 'is_for_later'],
        input.v2,
      ),
    )
  if (input.v1) add('tracking-prod-records.csv', csv(['entity_type', 'type', 'movie_name', 'created_at'], input.v1))
  if (input.ratings) add('tv_show_rate.csv', csv(['tv_show_id', 'rating', 'created_at'], input.ratings))
  if (input.favorites) add('user_tv_show_data.csv', csv(['tv_show_id', 'is_favorited'], input.favorites))
  return zip.toBuffer()
}

/** Helpers for the most common v2 rows. */
export const watchRow = (tvdbId: number, name: string, season: number, number: number, at: string) => [
  `watch-episode-${tvdbId}-${season}-${number}`,
  tvdbId,
  name,
  season,
  number,
  at,
  '',
  '',
  '',
]
export const seriesRow = (
  tvdbId: number,
  name: string,
  at: string,
  flags: { followed?: boolean; archived?: boolean; forLater?: boolean } = { followed: true },
) => [
  `user-series-${tvdbId}`,
  tvdbId,
  name,
  '',
  '',
  at,
  String(!!flags.followed),
  String(!!flags.archived),
  String(!!flags.forLater),
]
