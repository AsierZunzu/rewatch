// When did an episode actually air?
//
// `episodes.air_date` is a bare calendar date in the show's own country — it has
// no instant, so it can never answer "has this aired yet?". Every such check goes
// through `episodes.airs_at`, an absolute timestamptz resolved once at cache time
// by `resolveAirsAtSql` below. Being absolute, it is simultaneously correct for
// every user regardless of where they are; the user's timezone only ever decides
// which *local day* something falls in (calendar headings, "today's releases").
import { Prisma } from '../generated/prisma/client.js'

// ——— Providers ———

/**
 * Sources that hand us a real per-episode instant, best first.
 *
 * The order *is* the precedence: when both providers time the same air date, the
 * earlier entry wins, and the later one only fills what the earlier one has no
 * answer for. Trakt leads because its `first_aired` is a genuine per-episode
 * field — TVmaze's `airstamp` is largely the weekly slot projected onto each
 * episode's date, so it is a better schedule than it is a record of the past.
 * Flip this array to change the policy; nothing else encodes an ordering.
 */
export const EXACT_SOURCES = ['TRAKT', 'TVMAZE'] as const
export type ExactAirsAtSource = (typeof EXACT_SOURCES)[number]

/** What one provider knows about a show. */
export type ShowAirTimes = {
  /** The show's weekly slot, local to `timezone`. Null when the provider has none. */
  airs: { time: string; timezone: string } | null
  /**
   * The show's *local calendar date* ("YYYY-MM-DD") → the exact UTC instant
   * episodes air on that date. Dates the provider cannot time are absent.
   *
   * Keyed on the date rather than on season/number on purpose — see
   * `recordInstant()` below for why.
   */
  instantsByDate: Map<string, Date>
}

/**
 * Files one provider instant under its local air date, keeping the *latest*
 * when a date carries several episodes.
 *
 * Why the date is the key at all: season and episode numbers are not a shared
 * identity, they are one catalogue's coordinates. TMDB, TheTVDB and Trakt
 * regroup the same episodes into different seasons all the time — Futurama's
 * revival is TMDB season 8 onwards and TVmaze season 11 onwards, a fixed
 * three-season offset — so matching on "11:6" hands one show's episode the
 * air time of a completely different one, years apart. The air date does not
 * drift that way: whatever a catalogue calls the episode, everyone agrees on
 * the day it went out. And the date is all we actually need from these
 * providers, because what they add over TMDB is the *time of day*, which is a
 * property of the broadcast slot rather than of any one episode.
 *
 * Collisions (double bills, a special sharing its date, a whole season dropped
 * at once) take the latest instant of the day. Same reasoning as `COUNTRY_TZ`
 * below: marking an episode aired a little late is recoverable, marking it
 * aired before it was is the bug this module exists to prevent.
 */
export function recordInstant(instants: Map<string, Date>, date: string, at: Date) {
  const seen = instants.get(date)
  if (!seen || at > seen) instants.set(date, at)
}

/**
 * A UTC instant as a calendar date in `timezone` — the date the broadcaster
 * would print, which is the one TMDB's `air_date` holds.
 *
 * `en-CA` is the locale whose short date format is already ISO. An unknown zone
 * makes `Intl` throw, so the show's own zone is only trusted after it parses.
 */
export function localDate(at: Date, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

export type ProviderAirTimes = ShowAirTimes & { source: ExactAirsAtSource }
export type ExactInstant = { at: Date; source: ExactAirsAtSource }

/** `EXACT_SOURCES` as SQL literals, for `airs_at_source IN (…)`. */
const exactSourcesSql = Prisma.join(EXACT_SOURCES.map((s) => Prisma.sql`${s}::"AirsAtSource"`))

/**
 * Folds every provider's answer into the one we store, by `EXACT_SOURCES` order.
 *
 * Merging per date rather than picking a single winning provider matters: Trakt
 * tends to know the back catalogue and TVmaze the upcoming schedule, so a show
 * often needs both to be fully dated. The slot is *not* merged field by field —
 * `time` and `timezone` only mean something together, so they travel as a pair
 * from the best provider that has one.
 */
export function mergeAirTimes(providers: readonly ProviderAirTimes[]) {
  const ranked = [...providers].sort((a, b) => EXACT_SOURCES.indexOf(a.source) - EXACT_SOURCES.indexOf(b.source))
  const instants = new Map<string, ExactInstant>()
  let airs: ShowAirTimes['airs'] = null
  for (const provider of ranked) {
    airs ??= provider.airs
    for (const [date, at] of provider.instantsByDate) {
      if (!instants.has(date)) instants.set(date, { at, source: provider.source })
    }
  }
  return { airs, instants, answered: ranked.map((p) => p.source) }
}

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
 *   1. EXACT    — a per-episode instant from a provider (Trakt's `first_aired`,
 *                 TVmaze's `airstamp`), already UTC and already accounting for
 *                 the show's country and the DST in force on that date. Rows
 *                 carrying one are left untouched; nothing here improves on it.
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
        WHEN e.airs_at_source IN (${exactSourcesSql}) THEN e.airs_at
        WHEN s.airs_time IS NOT NULL AND s.airs_timezone IS NOT NULL
          THEN (e.air_date + s.airs_time::time) AT TIME ZONE s.airs_timezone
        ELSE (e.air_date + interval '1 day') AT TIME ZONE COALESCE(tz.zone, ${UNKNOWN_COUNTRY_TZ})
      END,
      airs_at_source = CASE
        WHEN e.airs_at_source IN (${exactSourcesSql}) THEN e.airs_at_source
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
 * Writes the merged instants in one statement, matching them to episodes by air
 * date, and clears the marking on every row the answering providers no longer
 * back so `resolveAirsAtSql` recomputes it.
 *
 * Two things are checked before an instant is accepted, and both are the reason
 * this function exists rather than a plain update:
 *
 *   - The episode must have a TMDB `air_date` to match against. A row TMDB will
 *     not date takes no instant: a provider that dates it is, by definition,
 *     talking about an episode TMDB does not agree exists on that day, and
 *     `airs_at` is what the whole app reads as "has this aired?". Those rows
 *     have their stale `airs_at` wiped too — `resolveAirsAtSql` skips undated
 *     episodes, so nothing else would ever clear it.
 *   - The instant must land within two days either side of that date. `air_date`
 *     is a bare local date and the instant is absolute, so a legitimate pair can
 *     straddle a UTC boundary — just past midnight in UTC+14 falls on the
 *     previous UTC day, late evening in UTC-12 on the next — and the match below
 *     tolerates a further day of its own. Anything outside that is not a
 *     timezone, it is two catalogues describing different episodes, and it is
 *     dropped rather than shown. This is the guard that keeps the instant the UI
 *     prints (`airTimeLabel` renders the day of `airs_at`, never `air_date`)
 *     from silently contradicting the date TMDB gave us.
 *
 * The dates are matched within a day of each other rather than exactly, because
 * catalogues date a global streaming drop by different conventions: TVmaze files
 * Apple TV+ releases on the network's listed day and TMDB on the day before, so
 * whole seasons of Ted Lasso and Silo matched nothing at all and fell back to a
 * date with no clock. An exact match always wins; a neighbouring date is only
 * taken when *no* episode claims it exactly, so a show whose dates line up day
 * for day can never have an episode's instant stolen by the one next to it. Two
 * episodes a day apart on either side of a lone provider date can still both
 * take it — bounded by a day, and better than showing nothing.
 *
 * `answered` lists the providers that actually replied. Only their rows are
 * cleared: a provider that is rate-limited or down says nothing about the
 * episodes it enriched last time, and wiping those would silently demote a show
 * to the coarse fallback until the next sync.
 */
export function applyExactInstantsSql(
  showTmdbId: number,
  instants: Map<string, ExactInstant>,
  answered: readonly ExactAirsAtSource[],
) {
  if (answered.length === 0) return null
  const sources = Prisma.join(answered.map((s) => Prisma.sql`${s}::"AirsAtSource"`))
  const rows = [...instants].map(
    ([date, { at, source }]) => Prisma.sql`(${date}::date, ${at}::timestamptz, ${source}::"AirsAtSource")`,
  )
  if (rows.length === 0) {
    return Prisma.sql`
      UPDATE episodes SET airs_at_source = NULL
      WHERE show_tmdb_id = ${showTmdbId} AND airs_at_source IN (${sources})
    `
  }
  return Prisma.sql`
    WITH incoming(air_date, airs_at, source) AS (VALUES ${Prisma.join(rows)}),
    accepted AS (
      SELECT DISTINCT ON (e.id) e.id, i.airs_at, i.source
      FROM episodes e
      JOIN incoming i ON i.air_date BETWEEN e.air_date - 1 AND e.air_date + 1
      WHERE e.show_tmdb_id = ${showTmdbId}
        AND i.airs_at >= (e.air_date - interval '2 days') AT TIME ZONE 'UTC'
        AND i.airs_at < (e.air_date + interval '3 days') AT TIME ZONE 'UTC'
        AND (
          i.air_date = e.air_date
          OR NOT EXISTS (
            SELECT 1 FROM episodes claimant
            WHERE claimant.show_tmdb_id = e.show_tmdb_id AND claimant.air_date = i.air_date
          )
        )
      -- Nearest date wins, and a tie goes to the later one: same reasoning as
      -- COUNTRY_TZ, marking an episode aired early is the failure that matters.
      ORDER BY e.id, abs(i.air_date - e.air_date), i.air_date DESC
    ),
    cleared AS (
      UPDATE episodes e
      SET airs_at_source = NULL,
          airs_at = CASE WHEN e.air_date IS NULL THEN NULL ELSE e.airs_at END
      WHERE e.show_tmdb_id = ${showTmdbId} AND e.airs_at_source IN (${sources})
        AND NOT EXISTS (SELECT 1 FROM accepted a WHERE a.id = e.id)
    )
    UPDATE episodes e
    SET airs_at = a.airs_at, airs_at_source = a.source
    FROM accepted a
    WHERE e.id = a.id
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
