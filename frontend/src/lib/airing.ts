// Mirror of the backend's aired gate (backend/src/lib/airing.ts).
//
// `airDate` is a bare calendar date in the show's own country and serialises as
// UTC midnight, so comparing it to `new Date()` marks an episode aired up to a
// day before it was. `airsAt` is an absolute instant — the only field that can
// answer this. Null means the air time is unknown, which counts as not aired.
import type { Episode } from '../api/types'

export const hasAired = (e: Pick<Episode, 'airsAt'>, now = Date.now()) =>
  e.airsAt !== null && new Date(e.airsAt).getTime() <= now

/**
 * The instant to *display*, or null when there is none worth showing.
 *
 * `airsAt` is set for every episode with an `airDate`, but only TRAKT, TVMAZE
 * and SCHEDULE resolve it from a real broadcast time. FALLBACK is the end of
 * `airDate` in the origin country — a bound chosen so `hasAired()` errs late,
 * not an air time — so rendering its clock would invent one (and land on the
 * following day). Those episodes keep a date-only label.
 */
const TIMED_SOURCES: Episode['airsAtSource'][] = ['TRAKT', 'TVMAZE', 'SCHEDULE']

export const knownAirInstant = (e: Pick<Episode, 'airsAt' | 'airsAtSource'>) =>
  e.airsAt !== null && TIMED_SOURCES.includes(e.airsAtSource) ? new Date(e.airsAt) : null
