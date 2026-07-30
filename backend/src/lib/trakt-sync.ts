// Trakt import/export jobs + the live mirror (V2).
// Same job machinery as the TV Time import: fire-and-forget, progress in
// import_jobs, idempotent DB writes.
import { prisma } from './prisma.js'
import { cacheMovie, cacheShow } from './catalog.js'
import { TmdbError } from './tmdb.js'
import { apiPost, getHistory, getHistorySince, getLastActivities, getRatings, getWatchlist } from './trakt.js'
import { FollowState, Prisma } from '../generated/prisma/client.js'

// An entry Trakt knows about but TMDB doesn't (deleted or merged entry).
type SkippedItem = { kind: 'show' | 'movie'; tmdbId: number; title?: string }
// The report is stored as JSON in import_jobs: list enough to act on, count the rest.
const SKIPPED_REPORT_CAP = 50

/**
 * Whether a caching failure concerns this item alone. A 404 means TMDB has no
 * such entry and no retry will change that, so the item is skipped and named in
 * the report. Everything else (missing API key, rate limit, network) hits every
 * other item just as hard: it stays fatal, so the job fails loudly instead of
 * quietly dropping half the library.
 */
function missingOnTmdb(err: unknown): boolean {
  return err instanceof TmdbError && err.status === 404
}

async function setProgress(jobId: number, phase: string, done: number, total: number) {
  await prisma.importJob.update({ where: { id: jobId }, data: { progress: { phase, done, total } } })
}

async function finishJob(jobId: number, fn: () => Promise<unknown>) {
  try {
    const report = await fn()
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'DONE', report: report as Prisma.InputJsonValue, progress: Prisma.DbNull },
    })
  } catch (err) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
    })
  }
}

// ——— Import: Trakt → Rewatch ———

export function runTraktImport(jobId: number, userId: number): Promise<void> {
  return finishJob(jobId, async () => {
    const history = await getHistory(userId, (page, total) => void setProgress(jobId, 'fetch', page, total))
    const [ratings, watchlist] = [await getRatings(userId), await getWatchlist(userId)]

    // 1. Cache every show involved (episodes come along with each show).
    const showIds = new Set<number>()
    for (const h of history) if (h.type === 'episode' && h.show?.ids.tmdb) showIds.add(h.show.ids.tmdb)
    for (const w of watchlist) if (w.type === 'show' && w.show?.ids.tmdb) showIds.add(w.show.ids.tmdb)
    for (const r of ratings) if (r.type === 'show' && r.show?.ids.tmdb) showIds.add(r.show.ids.tmdb)

    // History carries display titles; watchlist and ratings only carry ids.
    const titles = new Map<string, string>()
    for (const h of history) {
      if (h.show?.ids.tmdb) titles.set(`show:${h.show.ids.tmdb}`, h.show.title)
      if (h.movie?.ids.tmdb) titles.set(`movie:${h.movie.ids.tmdb}`, h.movie.title)
    }
    const skipped: SkippedItem[] = []
    const skippedKeys = new Set<string>()
    const noteSkip = (kind: 'show' | 'movie', tmdbId: number) => {
      const key = `${kind}:${tmdbId}`
      if (skippedKeys.has(key)) return
      skippedKeys.add(key)
      skipped.push({ kind, tmdbId, title: titles.get(key) })
    }

    let done = 0
    for (const tmdbId of showIds) {
      const existing = await prisma.show.findUnique({ where: { tmdbId } })
      if (!existing) {
        try {
          await cacheShow(tmdbId)
        } catch (err) {
          if (!missingOnTmdb(err)) throw err
          noteSkip('show', tmdbId)
        }
      }
      done++
      if (done % 5 === 0 || done === showIds.size) await setProgress(jobId, 'shows', done, showIds.size)
    }

    // What actually landed in the cache. Follows and watch events carry foreign
    // keys to shows/movies, so every write below is filtered against these sets
    // rather than against the ids we merely tried: a show whose season fetch
    // died halfway is still a usable row, and one we never got is not.
    const cachedShowIds = new Set(
      (
        await prisma.show.findMany({ where: { tmdbId: { in: [...showIds] } }, select: { tmdbId: true } })
      ).map((s) => s.tmdbId),
    )

    // 2. Episode watch events (matched by show + season + number).
    const episodes = await prisma.episode.findMany({
      where: { showTmdbId: { in: [...showIds] } },
      select: { id: true, showTmdbId: true, season: true, number: true },
    })
    const epIndex = new Map<string, number>()
    for (const ep of episodes) epIndex.set(`${ep.showTmdbId}:${ep.season}:${ep.number}`, ep.id)

    let unmatched = 0
    const events: { userId: number; episodeId: number; watchedAt: Date }[] = []
    const movieEvents: { movieTmdbId: number; watchedAt: Date }[] = []
    for (const h of history) {
      if (h.type === 'episode') {
        const showTmdb = h.show?.ids.tmdb
        const id = showTmdb ? epIndex.get(`${showTmdb}:${h.episode!.season}:${h.episode!.number}`) : undefined
        if (!id) unmatched++
        else events.push({ userId, episodeId: id, watchedAt: new Date(h.watched_at) })
      } else if (h.movie?.ids.tmdb) {
        movieEvents.push({ movieTmdbId: h.movie.ids.tmdb, watchedAt: new Date(h.watched_at) })
      }
    }
    const inserted = await prisma.watchEvent.createMany({ data: events, skipDuplicates: true })

    // 3. Movies: cache + events.
    const movieIds = [...new Set(movieEvents.map((m) => m.movieTmdbId))]
    const watchlistMovieIds = [
      ...new Set(watchlist.filter((w) => w.type === 'movie' && w.movie?.ids.tmdb).map((w) => w.movie!.ids.tmdb!)),
    ]
    let doneMovies = 0
    const allMovieIds = [...new Set([...movieIds, ...watchlistMovieIds])]
    const cachedMovieIds = new Set<number>()
    for (const tmdbId of allMovieIds) {
      try {
        await cacheMovie(tmdbId)
        cachedMovieIds.add(tmdbId)
      } catch (err) {
        if (!missingOnTmdb(err)) throw err
        noteSkip('movie', tmdbId)
      }
      doneMovies++
      if (doneMovies % 5 === 0 || doneMovies === allMovieIds.length)
        await setProgress(jobId, 'movies', doneMovies, allMovieIds.length)
    }
    const importedWatchlistMovieIds = watchlistMovieIds.filter((id) => cachedMovieIds.has(id))
    const insertedMovies = await prisma.watchEvent.createMany({
      data: movieEvents
        .filter((m) => cachedMovieIds.has(m.movieTmdbId))
        .map((m) => ({ userId, movieId: m.movieTmdbId, watchedAt: m.watchedAt })),
      skipDuplicates: true,
    })

    // 4. Follows: shows with history → WATCHING; watchlist shows → FOR_LATER.
    // upsert with empty update: never clobber a state the user already set.
    let follows = 0
    const watchedShows = new Set(events.length ? episodes.filter((e) => events.some((ev) => ev.episodeId === e.id)).map((e) => e.showTmdbId) : [])
    for (const h of history) if (h.type === 'episode' && h.show?.ids.tmdb) watchedShows.add(h.show.ids.tmdb)
    for (const tmdbId of watchedShows) {
      if (!cachedShowIds.has(tmdbId)) continue
      await prisma.follow.upsert({
        where: { userId_showTmdbId: { userId, showTmdbId: tmdbId } },
        create: { userId, showTmdbId: tmdbId, state: FollowState.WATCHING },
        update: {},
      })
      follows++
    }
    for (const w of watchlist) {
      if (w.type !== 'show' || !w.show?.ids.tmdb) continue
      if (!cachedShowIds.has(w.show.ids.tmdb)) continue
      await prisma.follow.upsert({
        where: { userId_showTmdbId: { userId, showTmdbId: w.show.ids.tmdb } },
        create: { userId, showTmdbId: w.show.ids.tmdb, state: FollowState.FOR_LATER },
        update: {},
      })
    }
    for (const tmdbId of importedWatchlistMovieIds) {
      await prisma.movieWatchlistEntry.upsert({
        where: { userId_movieTmdbId: { userId, movieTmdbId: tmdbId } },
        create: { userId, movieTmdbId: tmdbId },
        update: {},
      })
    }

    // 5. Ratings (Trakt is 1-10 like ours).
    let ratingCount = 0
    for (const r of ratings) {
      const target = r.type === 'show' ? ('SHOW' as const) : r.type === 'movie' ? ('MOVIE' as const) : null
      const ref = r.type === 'show' ? r.show?.ids.tmdb : r.movie?.ids.tmdb
      if (!target || !ref) continue
      if (target === 'SHOW') {
        if (!cachedShowIds.has(ref)) continue
      } else if (!cachedMovieIds.has(ref)) {
        // Rated but never watched or watchlisted: not cached by the loops above.
        try {
          await cacheMovie(ref)
          cachedMovieIds.add(ref)
        } catch (err) {
          if (!missingOnTmdb(err)) throw err
          noteSkip('movie', ref)
          continue
        }
      }
      await prisma.rating.upsert({
        where: { userId_target_targetRef: { userId, target, targetRef: ref } },
        create: { userId, target, targetRef: ref, value: r.rating, ratedAt: new Date(r.rated_at) },
        update: { value: r.rating },
      })
      ratingCount++
    }

    return {
      episodes: { imported: inserted.count, unmatched },
      movies: { imported: insertedMovies.count, watchlist: importedWatchlistMovieIds.length },
      follows,
      ratings: ratingCount,
      skipped: { total: skipped.length, items: skipped.slice(0, SKIPPED_REPORT_CAP) },
    }
  })
}

// ——— Export: Rewatch → Trakt ———

const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

export function runTraktExport(jobId: number, userId: number): Promise<void> {
  return finishJob(jobId, async () => {
    await setProgress(jobId, 'fetch', 0, 1)
    const theirs = await getHistory(userId, (page, total) => void setProgress(jobId, 'fetch', page, total))
    const seen = new Set<string>()
    for (const h of theirs) {
      if (h.type === 'episode' && h.show?.ids.tmdb)
        seen.add(`e:${h.show.ids.tmdb}:${h.episode!.season}:${h.episode!.number}:${dayKey(h.watched_at)}`)
      if (h.type === 'movie' && h.movie?.ids.tmdb) seen.add(`m:${h.movie.ids.tmdb}:${dayKey(h.watched_at)}`)
    }

    const ours = await prisma.watchEvent.findMany({
      where: { userId },
      include: { episode: { select: { showTmdbId: true, season: true, number: true } } },
    })

    // Same-day plays already on Trakt are skipped: close enough to avoid
    // duplicates without chasing exact-timestamp equality.
    type ShowAcc = Map<number, Map<number, { number: number; watched_at: string }[]>>
    const shows: ShowAcc = new Map()
    const movies: { ids: { tmdb: number }; watched_at: string }[] = []
    let skipped = 0
    let pushCount = 0
    for (const ev of ours) {
      if (ev.episode) {
        const key = `e:${ev.episode.showTmdbId}:${ev.episode.season}:${ev.episode.number}:${dayKey(ev.watchedAt)}`
        if (seen.has(key)) {
          skipped++
          continue
        }
        const seasons = shows.get(ev.episode.showTmdbId) ?? new Map()
        const eps = seasons.get(ev.episode.season) ?? []
        eps.push({ number: ev.episode.number, watched_at: ev.watchedAt.toISOString() })
        seasons.set(ev.episode.season, eps)
        shows.set(ev.episode.showTmdbId, seasons)
        pushCount++
      } else if (ev.movieId) {
        const key = `m:${ev.movieId}:${dayKey(ev.watchedAt)}`
        if (seen.has(key)) {
          skipped++
          continue
        }
        movies.push({ ids: { tmdb: ev.movieId }, watched_at: ev.watchedAt.toISOString() })
        pushCount++
      }
    }

    // POST rate limit is 1/s: chunk large pushes and pace them.
    const showPayload = [...shows.entries()].map(([tmdb, seasons]) => ({
      ids: { tmdb },
      seasons: [...seasons.entries()].map(([number, eps]) => ({ number, episodes: eps })),
    }))
    const chunks: { shows?: typeof showPayload; movies?: typeof movies }[] = []
    for (let i = 0; i < showPayload.length; i += 100) chunks.push({ shows: showPayload.slice(i, i + 100) })
    for (let i = 0; i < movies.length; i += 500) chunks.push({ movies: movies.slice(i, i + 500) })

    let added = { episodes: 0, movies: 0 }
    for (let i = 0; i < chunks.length; i++) {
      const res = await apiPost<{ added: { episodes: number; movies: number } }>(userId, '/sync/history', chunks[i])
      added = { episodes: added.episodes + (res.added?.episodes ?? 0), movies: added.movies + (res.added?.movies ?? 0) }
      await setProgress(jobId, 'push', i + 1, chunks.length)
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 1100))
    }

    return { pushed: added, skipped, candidates: pushCount }
  })
}

// ——— Pull: Trakt → Rewatch additions, on app open ———

const dayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

/**
 * Brings new Trakt plays into Rewatch (additions only — removals never
 * propagate). Cheap when idle: one last_activities call against the stored
 * watermark. First call after connecting just sets the baseline: the full
 * backfill is the import's job.
 */
export async function runTraktPull(userId: number): Promise<{ episodes: number; movies: number } | { skipped: string }> {
  const account = await prisma.traktAccount.findUnique({ where: { userId } })
  if (!account?.mirrorEnabled) return { skipped: 'mirror_disabled' }

  const acts = await getLastActivities(userId)
  const latest = Math.max(
    acts.episodes?.watched_at ? new Date(acts.episodes.watched_at).getTime() : 0,
    acts.movies?.watched_at ? new Date(acts.movies.watched_at).getTime() : 0,
  )
  if (!account.lastPullAt) {
    await prisma.traktAccount.update({ where: { userId }, data: { lastPullAt: new Date() } })
    return { skipped: 'baseline_set' }
  }
  // Overlap window: Trakt rounds watched_at to the minute, so a play checked
  // seconds after a pull can carry a timestamp BEFORE our watermark and would
  // otherwise be skipped forever. The same-day dedupe below absorbs the
  // overlap without duplicates.
  const OVERLAP_MS = 10 * 60_000
  const since = new Date(account.lastPullAt.getTime() - OVERLAP_MS)
  if (latest <= since.getTime()) return { skipped: 'up_to_date' }

  const pullStartedAt = new Date()
  const history = await getHistorySince(userId, since)

  // Cache unknown shows/movies, then insert with a same-day dedupe: our own
  // mirrored pushes come back with second-rounded timestamps, and a strict
  // unique constraint would let those through as near-duplicates.
  let episodes = 0
  let movies = 0
  for (const h of history) {
    if (h.type === 'episode' && h.show?.ids.tmdb && h.episode) {
      const showTmdbId = h.show.ids.tmdb
      if (!(await prisma.show.findUnique({ where: { tmdbId: showTmdbId } }))) {
        try {
          await cacheShow(showTmdbId)
        } catch (err) {
          if (!missingOnTmdb(err)) throw err
          continue // gone from TMDB: skip this play, keep pulling the rest
        }
      }
      const ep = await prisma.episode.findFirst({
        where: { showTmdbId, season: h.episode.season, number: h.episode.number },
      })
      if (!ep) continue
      const watchedAt = new Date(h.watched_at)
      const existing = await prisma.watchEvent.findFirst({
        where: {
          userId,
          episodeId: ep.id,
          watchedAt: { gte: new Date(dayOf(watchedAt)), lt: new Date(new Date(dayOf(watchedAt)).getTime() + 86_400_000) },
        },
      })
      if (existing) continue
      await prisma.watchEvent.create({ data: { userId, episodeId: ep.id, watchedAt } })
      await prisma.follow.upsert({
        where: { userId_showTmdbId: { userId, showTmdbId } },
        create: { userId, showTmdbId, state: FollowState.WATCHING },
        update: {},
      })
      episodes++
    } else if (h.type === 'movie' && h.movie?.ids.tmdb) {
      const movieTmdbId = h.movie.ids.tmdb
      try {
        await cacheMovie(movieTmdbId)
      } catch (err) {
        if (!missingOnTmdb(err)) throw err
        continue // gone from TMDB: skip this play, keep pulling the rest
      }
      const watchedAt = new Date(h.watched_at)
      const existing = await prisma.watchEvent.findFirst({
        where: {
          userId,
          movieId: movieTmdbId,
          watchedAt: { gte: new Date(dayOf(watchedAt)), lt: new Date(new Date(dayOf(watchedAt)).getTime() + 86_400_000) },
        },
      })
      if (existing) continue
      await prisma.watchEvent.create({ data: { userId, movieId: movieTmdbId, watchedAt } })
      movies++
    }
  }

  await prisma.traktAccount.update({ where: { userId }, data: { lastPullAt: pullStartedAt } })
  return { episodes, movies }
}

// ——— Live mirror (V2) ———

type MirrorItem =
  | { kind: 'episode'; showTmdbId: number; season: number; number: number; watchedAt?: Date }
  | { kind: 'movie'; movieTmdbId: number; watchedAt?: Date }

/** Bulk variant: one aggregated payload (POSTs are rate-limited to 1/s). */
export function mirrorBulkToTrakt(
  userId: number,
  showTmdbId: number,
  episodes: { season: number; number: number }[],
  action: 'add' | 'remove',
  watchedAt?: Date,
): void {
  void (async () => {
    const account = await prisma.traktAccount.findUnique({ where: { userId } })
    if (!account?.mirrorEnabled || episodes.length === 0) return
    const bySeason = new Map<number, { number: number; watched_at?: string }[]>()
    for (const e of episodes) {
      const list = bySeason.get(e.season) ?? []
      list.push({ number: e.number, ...(watchedAt ? { watched_at: watchedAt.toISOString() } : {}) })
      bySeason.set(e.season, list)
    }
    await apiPost(userId, action === 'add' ? '/sync/history' : '/sync/history/remove', {
      shows: [{ ids: { tmdb: showTmdbId }, seasons: [...bySeason.entries()].map(([number, eps]) => ({ number, episodes: eps })) }],
    })
  })().catch((err) => {
    console.warn(`trakt bulk mirror failed (user ${userId}):`, err instanceof Error ? err.message : err)
  })
}

/**
 * Forwards a watch (or unwatch) to Trakt when the user enabled the mirror.
 * Fire-and-forget by design: a Trakt hiccup must never break a check-in.
 */
export function mirrorToTrakt(userId: number, action: 'add' | 'remove', item: MirrorItem): void {
  void (async () => {
    const account = await prisma.traktAccount.findUnique({ where: { userId } })
    if (!account?.mirrorEnabled) return
    const path = action === 'add' ? '/sync/history' : '/sync/history/remove'
    const watched = item.watchedAt ? { watched_at: item.watchedAt.toISOString() } : {}
    const body =
      item.kind === 'episode'
        ? { shows: [{ ids: { tmdb: item.showTmdbId }, seasons: [{ number: item.season, episodes: [{ number: item.number, ...watched }] }] }] }
        : { movies: [{ ids: { tmdb: item.movieTmdbId }, ...watched }] }
    await apiPost(userId, path, body)
  })().catch((err) => {
    console.warn(`trakt mirror failed (user ${userId}):`, err instanceof Error ? err.message : err)
  })
}
