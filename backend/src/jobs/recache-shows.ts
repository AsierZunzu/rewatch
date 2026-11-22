// One-off: force a full re-fetch of every cached show, from every provider.
//
//   npx tsx src/jobs/recache-shows.ts          # dev
//   node dist/jobs/recache-shows.js            # inside the container
//
// Each show goes back through `cacheShow()`, which is the same path a first
// view takes: TMDB for the show, its seasons and every episode, TMDB again for
// each supported language, then Trakt and TVmaze for the air times. Nothing is
// deleted — every write is an upsert — so it is safe to re-run after a failure
// or an interruption.
//
// Run it after a change to how provider data is interpreted: the caches are
// keyed on ids that do not change, so a fix in the parsing or matching logic is
// invisible until the data is pulled again. Shows are visited oldest-cache
// first, and `cacheShow()` stamps `cachedAt`, so a resumed run naturally picks
// up where the last one stopped rather than starting over.
//
//   --limit=N     stop after N shows (spread a large library over several runs)
//   --delay=MS    pause between shows, default 250
//   --ids=a,b,c   re-cache only these TMDB ids. `cacheShow()` stamps `cachedAt`
//                 before the work that can fail, so a show that failed sorts
//                 *last* on the next run, not first — retrying it means naming
//                 it.
import 'dotenv/config'
import { prisma } from '../lib/prisma.js'
import { loadSettings } from '../lib/settings.js'
import { cacheShow } from '../lib/catalog.js'

const flag = (name: string, fallback: number | null) => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number, got "${raw}"`)
  return value
}

const ids = process.argv
  .find((a) => a.startsWith('--ids='))
  ?.slice('--ids='.length)
  .split(',')
  .map((raw) => {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) throw new Error(`--ids must be TMDB ids, got "${raw}"`)
    return id
  })

const limit = flag('limit', null)
// TVmaze allows roughly 20 requests per 10 seconds per IP and a show costs it
// two, so the ceiling is far above one show per 250ms — but a re-cache walks
// every show back to back for a long time, which is exactly when a limiter
// notices. The default is cheap insurance; a small library can set --delay=0.
const delayMs = flag('delay', 250)!

// Settings live in the DB (the setup wizard writes them there), and every
// provider reads its credentials through `getSetting`. Without this the TMDB
// token is missing on any instance that did not also set the env var, and Trakt
// silently reports itself as not configured.
await loadSettings()

const shows = await prisma.show.findMany({
  where: ids ? { tmdbId: { in: ids } } : undefined,
  select: { tmdbId: true, name: true },
  orderBy: { cachedAt: 'asc' },
  ...(limit !== null ? { take: limit } : {}),
})

console.log(`re-caching ${shows.length} show(s), ${delayMs}ms apart`)

const started = Date.now()
let done = 0
let failed = 0

for (const show of shows) {
  try {
    await cacheShow(show.tmdbId)
    done++
  } catch (err) {
    // One unknown id, one TMDB hiccup or one rate limit must not cost the rest
    // of the library the run. The id is logged so it can be retried by hand.
    failed++
    // Not just `.message`: TMDB and the providers can reject with an error whose
    // message is empty, and a bare "failed:" says nothing about what to fix.
    const reason = (err as Error)?.message || String(err)
    console.error(`show ${show.tmdbId} (${show.name}) failed: ${reason}`)
    if (!(err as Error)?.message) console.error(err)
  }

  const seen = done + failed
  if (seen % 10 === 0 || seen === shows.length) {
    const perShow = (Date.now() - started) / seen
    const left = Math.round((perShow * (shows.length - seen)) / 1000)
    console.log(`${seen}/${shows.length} — ${failed} failed — ~${left}s left`)
  }
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
}

console.log(`done: ${done} re-cached, ${failed} failed, ${Math.round((Date.now() - started) / 1000)}s`)
await prisma.$disconnect()
process.exit(failed > 0 ? 1 : 0)
