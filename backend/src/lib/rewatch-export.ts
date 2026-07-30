// Parses Rewatch's own export (the JSON produced by GET /api/account/export).
// Everything is keyed by TMDB id, so unlike the TV Time export there is no
// id mapping or title guessing to do — the payload is already canonical.
import { z } from 'zod'

const showState = z.enum(['WATCHING', 'ARCHIVED', 'FOR_LATER'])
const rating = z.number().int().min(1).max(10).nullable().default(null)
const tmdbId = z.number().int().positive()

// Dates come back as ISO strings through JSON; be liberal about what we accept.
const date = z.coerce.date()

const schema = z.object({
  format: z.literal('rewatch-export'),
  version: z.number().int().positive(),
  exportedAt: date.optional(),
  user: z.object({ username: z.string(), language: z.string() }).partial().optional(),
  shows: z
    .array(
      z.object({
        tmdbId,
        name: z.string().default(''),
        state: showState,
        isFavorite: z.boolean().default(false),
        followedAt: date,
        rating,
      }),
    )
    .default([]),
  episodeWatches: z
    .array(
      z.object({
        showTmdbId: tmdbId,
        showName: z.string().default(''),
        season: z.number().int().min(0),
        number: z.number().int().min(0),
        watchedAt: date,
      }),
    )
    .default([]),
  movies: z
    .array(
      z.object({
        tmdbId,
        title: z.string().default(''),
        watchedAts: z.array(date).default([]),
        isFavorite: z.boolean().default(false),
        rating,
      }),
    )
    .default([]),
  movieWatchlist: z
    .array(z.object({ tmdbId, title: z.string().default(''), addedAt: date }))
    .default([]),
})

export type RewatchExport = z.infer<typeof schema>

/** The highest `version` this importer knows how to read. */
export const SUPPORTED_EXPORT_VERSION = 1

export function parseRewatchExport(buffer: Buffer): RewatchExport {
  let json: unknown
  try {
    json = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error('not_json')
  }

  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    // A wrong-but-plausible file (a TV Time zip renamed, someone else's export
    // format) is the common case — say which check failed rather than dumping zod.
    const wrongFormat = parsed.error.issues.some((i) => i.path[0] === 'format')
    throw new Error(wrongFormat ? 'not_a_rewatch_export' : 'malformed_export')
  }
  if (parsed.data.version > SUPPORTED_EXPORT_VERSION) throw new Error('unsupported_version')

  return parsed.data
}
