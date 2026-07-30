// Mirror of the backend's aired gate (backend/src/lib/airing.ts).
//
// `airDate` is a bare calendar date in the show's own country and serialises as
// UTC midnight, so comparing it to `new Date()` marks an episode aired up to a
// day before it was. `airsAt` is an absolute instant — the only field that can
// answer this. Null means the air time is unknown, which counts as not aired.
import type { Episode } from '../api/types'

export const hasAired = (e: Pick<Episode, 'airsAt'>, now = Date.now()) =>
  e.airsAt !== null && new Date(e.airsAt).getTime() <= now
