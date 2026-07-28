// When did an episode actually air?
//
// `episodes.air_date` is a bare calendar date in the show's own country — it has
// no instant, so it can never answer "has this aired yet?". Every such check goes
// through `episodes.airs_at`, an absolute timestamptz resolved once at cache time
// by `resolveAirsAtSql` below. Being absolute, it is simultaneously correct for
// every user regardless of where they are; the user's timezone only ever decides
// which *local day* something falls in (calendar headings, "today's releases").
import { Prisma } from '../generated/prisma/client.js'

/**
 * Origin country → the IANA zone whose end-of-day we treat as the latest moment
 * an episode dated D could still have aired.
 *
 * For countries spanning several zones this is deliberately the *westernmost*
 * mainstream one: the lower the UTC offset, the later that date ends, and the
 * fallback must never mark an episode aired before it did. Erring late is
 * recoverable (the episode shows up a few hours on), erring early is the bug
 * this whole module exists to fix.
 */
const COUNTRY_TZ: Record<string, string> = {
  US: 'America/Los_Angeles',
  CA: 'America/Vancouver',
  MX: 'America/Tijuana',
  BR: 'America/Rio_Branco',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  PT: 'Atlantic/Azores',
  ES: 'Atlantic/Canary',
  FR: 'Europe/Paris',
  BE: 'Europe/Brussels',
  NL: 'Europe/Amsterdam',
  DE: 'Europe/Berlin',
  AT: 'Europe/Vienna',
  CH: 'Europe/Zurich',
  IT: 'Europe/Rome',
  DK: 'Europe/Copenhagen',
  NO: 'Europe/Oslo',
  SE: 'Europe/Stockholm',
  FI: 'Europe/Helsinki',
  IS: 'Atlantic/Reykjavik',
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest',
  GR: 'Europe/Athens',
  RU: 'Europe/Kaliningrad',
  UA: 'Europe/Kyiv',
  TR: 'Europe/Istanbul',
  IL: 'Asia/Jerusalem',
  ZA: 'Africa/Johannesburg',
  NG: 'Africa/Lagos',
  IN: 'Asia/Kolkata',
  CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  TH: 'Asia/Bangkok',
  PH: 'Asia/Manila',
  ID: 'Asia/Jakarta',
  AU: 'Australia/Perth',
  NZ: 'Pacific/Auckland',
}

/**
 * Zone of last resort: UTC-12, where any given date ends later than anywhere
 * else on Earth. Used when the origin country is unknown or unmapped, so an
 * unrecognised show is late rather than early.
 */
const UNKNOWN_COUNTRY_TZ = 'Etc/GMT+12'

/** `COUNTRY_TZ` as a SQL relation, joined against `shows.origin_country`. */
const countryTzTable = Prisma.sql`
  (VALUES ${Prisma.join(
    Object.entries(COUNTRY_TZ).map(([country, zone]) => Prisma.sql`(${country}, ${zone})`),
  )}) AS tz(country, zone)
`

/**
 * Recomputes `airs_at` for one show's episodes, best source first:
 *
 *   1. TRAKT    — a per-episode `first_aired`, already UTC and already accounting
 *                 for the show's country and the DST in force on that date. Rows
 *                 carrying it are left untouched; nothing here improves on it.
 *   2. SCHEDULE — `air_date` + the show's broadcast slot, read in the show's own
 *                 timezone. Resolved per episode, so a January and a July episode
 *                 correctly land on different UTC offsets.
 *   3. FALLBACK — end of `air_date` in the origin country, i.e. midnight opening
 *                 the following day. No air time is known, so this is the first
 *                 instant at which the episode has certainly aired.
 *
 * All three conversions are done by Postgres, which owns a full IANA database —
 * no date library, and DST is handled per date rather than by a frozen offset.
 */
export function resolveAirsAtSql(showTmdbId: number) {
  return Prisma.sql`
    UPDATE episodes e
    SET
      airs_at = CASE
        WHEN e.airs_at_source = 'TRAKT' THEN e.airs_at
        WHEN s.airs_time IS NOT NULL AND s.airs_timezone IS NOT NULL
          THEN (e.air_date + s.airs_time::time) AT TIME ZONE s.airs_timezone
        ELSE (e.air_date + interval '1 day') AT TIME ZONE COALESCE(tz.zone, ${UNKNOWN_COUNTRY_TZ})
      END,
      airs_at_source = CASE
        WHEN e.airs_at_source = 'TRAKT' THEN 'TRAKT'::"AirsAtSource"
        WHEN s.airs_time IS NOT NULL AND s.airs_timezone IS NOT NULL THEN 'SCHEDULE'::"AirsAtSource"
        ELSE 'FALLBACK'::"AirsAtSource"
      END
    FROM shows s
    LEFT JOIN ${countryTzTable} ON tz.country = s.origin_country
    WHERE s.tmdb_id = e.show_tmdb_id
      AND e.show_tmdb_id = ${showTmdbId}
      AND e.air_date IS NOT NULL
  `
}

/**
 * Writes Trakt's exact per-episode instants in one statement, and clears the
 * TRAKT marking everywhere else for this show so `resolveAirsAtSql` recomputes
 * those rows — an episode Trakt has dropped or rescheduled must not keep an
 * instant derived from its old air date.
 */
export function applyTraktInstantsSql(showTmdbId: number, firstAired: Map<string, Date>) {
  const rows = [...firstAired].map(([key, at]) => {
    const [season, number] = key.split(':').map(Number)
    return Prisma.sql`(${season}::int, ${number}::int, ${at}::timestamptz)`
  })
  if (rows.length === 0) {
    return Prisma.sql`
      UPDATE episodes SET airs_at_source = NULL
      WHERE show_tmdb_id = ${showTmdbId} AND airs_at_source = 'TRAKT'
    `
  }
  return Prisma.sql`
    WITH incoming(season, number, airs_at) AS (VALUES ${Prisma.join(rows)}),
    cleared AS (
      UPDATE episodes e SET airs_at_source = NULL
      WHERE e.show_tmdb_id = ${showTmdbId} AND e.airs_at_source = 'TRAKT'
        AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.season = e.season AND i.number = e.number)
    )
    UPDATE episodes e
    SET airs_at = i.airs_at, airs_at_source = 'TRAKT'
    FROM incoming i
    WHERE e.show_tmdb_id = ${showTmdbId} AND e.season = i.season AND e.number = i.number
  `
}

/**
 * The aired predicate, shared by every read path so they cannot drift apart
 * again. `<= now()` already excludes NULL, so episodes with no known air date
 * stay hidden — same as the behaviour this replaced.
 *
 * `alias` is the table alias the caller gave `episodes`.
 */
export const airedSql = (alias: string) => Prisma.raw(`${alias}.airs_at <= now()`)

/**
 * The user's current local calendar date, as UTC midnight — the shape Prisma
 * compares `@db.Date` columns against.
 *
 * For scheduling views ("what is on from today onwards") this is the right
 * boundary: both sides are then calendar dates in the same frame, with no
 * instant-versus-date mixing. Postgres resolves the zone, and the date is read
 * back as a string so no driver has a chance to reinterpret it.
 */
export async function userToday(
  db: { $queryRaw: <T>(q: Prisma.Sql) => Promise<T> },
  timezone: string,
): Promise<Date> {
  const rows = await db.$queryRaw<{ today: string }[]>(
    Prisma.sql`SELECT to_char((now() AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS today`,
  )
  return new Date(`${rows[0]!.today}T00:00:00Z`)
}
