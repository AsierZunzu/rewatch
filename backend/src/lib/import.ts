// Runs an import (TV Time zip, or Rewatch's own JSON export): TMDB mapping + DB writes.
// Idempotent: replayable without duplicates (unique constraints + upserts).
import { prisma } from './prisma.js'
import * as tmdb from './tmdb.js'
import { cacheMovie, cacheShow } from './catalog.js'
import { parseTvTimeExport } from './tvtime.js'
import { parseRewatchExport } from './rewatch-export.js'
import { FollowState, Prisma } from '../generated/prisma/client.js'

export type ImportReport = {
  // tvdbId is null for sources that are already TMDB-keyed (Rewatch export).
  shows: { mapped: number; unmapped: { tvdbId: number | null; tmdbId?: number; name: string }[] }
  episodes: { imported: number; unmatched: number }
  follows: number
  ratings: number
  // `failed` only occurs on a Rewatch import: a TMDB id in the file that TMDB no longer serves.
  movies: { autoMatched: number; pending: number; watchlist: number; failed?: number }
}

async function setProgress(jobId: number, phase: string, done: number, total: number) {
  await prisma.importJob.update({ where: { id: jobId }, data: { progress: { phase, done, total } } })
}

function normalizeTitle(s: string) {
  return s
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export async function runTvTimeImport(jobId: number, userId: number, zipBuffer: Buffer): Promise<void> {
  try {
    const report = await doImport(jobId, userId, zipBuffer)
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'DONE', report: report as unknown as Prisma.InputJsonValue, progress: Prisma.DbNull },
    })
  } catch (err) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
    })
  }
}

async function doImport(jobId: number, userId: number, zipBuffer: Buffer): Promise<ImportReport> {
  const data = parseTvTimeExport(zipBuffer)

  // ——— 1. Map shows tvdb → tmdb (+ cache show/episode records) ———
  const tvdbIds = [...new Set([...data.series.map((s) => s.tvdbShowId), ...data.episodeEvents.map((e) => e.tvdbShowId)])]
  const tvdbToTmdb = new Map<number, number>()
  const unmapped: { tvdbId: number; name: string }[] = []
  const nameOf = new Map<number, string>()
  for (const s of data.series) nameOf.set(s.tvdbShowId, s.name)
  for (const e of data.episodeEvents) if (!nameOf.has(e.tvdbShowId)) nameOf.set(e.tvdbShowId, e.seriesName)

  let done = 0
  for (const tvdbId of tvdbIds) {
    // Already cached (previous import or another user) → no refetch.
    const existing = await prisma.show.findUnique({ where: { tvdbId } })
    if (existing) {
      tvdbToTmdb.set(tvdbId, existing.tmdbId)
    } else {
      let found = await tmdb.findShowByTvdbId(tvdbId)
      // Fallback: some tvdb_id values in the export are legacy TheTVDB IDs that TMDB
      // doesn't know (e.g. Prison Break 75340 vs 360115) → exact match by name.
      const name = nameOf.get(tvdbId)
      if (!found && name) {
        // Two attempts: raw title, then without the year suffix — "Monster (2022)" → "Monster".
        for (const query of [name, name.replace(/\s*\(\d{4}\)\s*$/, '')]) {
          if (!query) continue
          const { results } = await tmdb.searchTv(query)
          const wanted = normalizeTitle(query)
          found =
            results.find(
              (r) =>
                normalizeTitle(r.name) === wanted || (r.original_name && normalizeTitle(r.original_name) === wanted),
            ) ?? null
          if (found) break
        }
      }
      if (found) {
        await cacheShow(found.id, tvdbId)
        tvdbToTmdb.set(tvdbId, found.id)
      } else {
        unmapped.push({ tvdbId, name: name ?? '?' })
      }
    }
    done++
    if (done % 5 === 0 || done === tvdbIds.length) await setProgress(jobId, 'shows', done, tvdbIds.length)
  }

  // ——— 2. Episode watch events ———
  await setProgress(jobId, 'episodes', 0, data.episodeEvents.length)
  // Index of (tmdbShowId, season, number) → episode.id
  const episodes = await prisma.episode.findMany({
    where: { showTmdbId: { in: [...tvdbToTmdb.values()] } },
    select: { id: true, showTmdbId: true, season: true, number: true },
  })
  const epIndex = new Map<string, number>()
  for (const ep of episodes) epIndex.set(`${ep.showTmdbId}:${ep.season}:${ep.number}`, ep.id)

  let unmatchedEpisodes = 0
  const events: { userId: number; episodeId: number; watchedAt: Date }[] = []
  for (const ev of data.episodeEvents) {
    const tmdbShowId = tvdbToTmdb.get(ev.tvdbShowId)
    const episodeId = tmdbShowId ? epIndex.get(`${tmdbShowId}:${ev.season}:${ev.number}`) : undefined
    if (!episodeId) {
      unmatchedEpisodes++
      continue
    }
    events.push({ userId, episodeId, watchedAt: ev.watchedAt })
  }
  const inserted = await prisma.watchEvent.createMany({ data: events, skipDuplicates: true })
  await setProgress(jobId, 'episodes', data.episodeEvents.length, data.episodeEvents.length)

  // ——— 3. Follows + favorites + ratings ———
  const favorites = new Set(data.favoriteTvdbIds)
  let follows = 0
  for (const s of data.series) {
    const tmdbShowId = tvdbToTmdb.get(s.tvdbShowId)
    if (!tmdbShowId) continue
    if (!s.isFollowed && !s.isArchived && !s.isForLater) continue // show dropped on the TV Time side
    const state = s.isArchived ? FollowState.ARCHIVED : s.isForLater ? FollowState.FOR_LATER : FollowState.WATCHING
    await prisma.follow.upsert({
      where: { userId_showTmdbId: { userId, showTmdbId: tmdbShowId } },
      create: { userId, showTmdbId: tmdbShowId, state, followedAt: s.followedAt },
      update: { state },
    })
    if (favorites.has(s.tvdbShowId)) {
      await prisma.favorite.upsert({
        where: { userId_target_targetRef: { userId, target: 'SHOW', targetRef: tmdbShowId } },
        create: { userId, target: 'SHOW', targetRef: tmdbShowId },
        update: {},
      })
    }
    follows++
  }

  let ratings = 0
  for (const r of data.showRatings) {
    const tmdbShowId = tvdbToTmdb.get(r.tvdbShowId)
    if (!tmdbShowId) continue
    await prisma.rating.upsert({
      where: { userId_target_targetRef: { userId, target: 'SHOW', targetRef: tmdbShowId } },
      create: { userId, target: 'SHOW', targetRef: tmdbShowId, value: r.rating * 2, ratedAt: r.ratedAt },
      update: { value: r.rating * 2 },
    })
    ratings++
  }

  // ——— 4. Movies: match by title, otherwise queue for manual resolution ———
  const allMovies = [
    ...data.watchedMovies.map((m) => ({ ...m, kind: 'WATCHED' as const })),
    ...data.watchlistMovies.map((m) => ({ ...m, kind: 'WATCHLIST' as const })),
  ]
  let autoMatched = 0
  let pending = 0
  let watchlist = 0
  let doneMovies = 0
  for (const movie of allMovies) {
    const { results } = await tmdb.searchMovie(movie.title)
    const wanted = normalizeTitle(movie.title)
    const exact = results.filter(
      (r) => normalizeTitle(r.title) === wanted || (r.original_title && normalizeTitle(r.original_title) === wanted),
    )
    // Auto-match: first exact title (TMDB sorts by relevance), or single result.
    const match = exact[0] ?? (results.length === 1 ? results[0] : null)

    if (match) {
      await applyMovieMatch(userId, match.id, movie.kind, movie.watchedAts)
      // A previous import may have left this title pending manual resolution.
      await prisma.importPendingMovie.deleteMany({ where: { userId, title: movie.title, kind: movie.kind } })
      if (movie.kind === 'WATCHED') autoMatched++
      else watchlist++
    } else {
      await prisma.importPendingMovie.upsert({
        where: { userId_title_kind: { userId, title: movie.title, kind: movie.kind } },
        create: {
          userId,
          title: movie.title,
          kind: movie.kind,
          watchedAts: movie.watchedAts,
          candidates: results.slice(0, 5).map((r) => ({
            tmdbId: r.id,
            title: r.title,
            year: r.release_date?.slice(0, 4) ?? null,
            posterPath: r.poster_path,
          })),
        },
        update: { watchedAts: movie.watchedAts },
      })
      pending++
    }
    doneMovies++
    if (doneMovies % 5 === 0 || doneMovies === allMovies.length)
      await setProgress(jobId, 'movies', doneMovies, allMovies.length)
  }

  return {
    shows: { mapped: tvdbToTmdb.size, unmapped },
    episodes: { imported: inserted.count, unmatched: unmatchedEpisodes },
    follows,
    ratings,
    movies: { autoMatched, pending, watchlist },
  }
}

// ————————————————————————————————————————————————————————————————
// Rewatch's own export (JSON from GET /api/account/export)
// ————————————————————————————————————————————————————————————————

export async function runRewatchImport(jobId: number, userId: number, buffer: Buffer): Promise<void> {
  try {
    const report = await doRewatchImport(jobId, userId, buffer)
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'DONE', report: report as unknown as Prisma.InputJsonValue, progress: Prisma.DbNull },
    })
  } catch (err) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
    })
  }
}

// Conflict policy (decided with the export's "restore my backup" use case in mind):
//   · shows, follow states, ratings, favorites → the FILE WINS, overwriting local values.
//   · watch history & watchlist               → UNION, never deleted; history can only grow.
// Rows absent from the file are left alone: this is a restore/merge, not a mirror,
// so importing an old backup never silently drops shows you added since.
async function doRewatchImport(jobId: number, userId: number, buffer: Buffer): Promise<ImportReport> {
  const data = parseRewatchExport(buffer)

  // ——— 1. Cache every referenced show (ids are already TMDB) ———
  const showIds = [...new Set([...data.shows.map((s) => s.tmdbId), ...data.episodeWatches.map((e) => e.showTmdbId)])]
  const nameOf = new Map<number, string>()
  for (const s of data.shows) nameOf.set(s.tmdbId, s.name)
  for (const e of data.episodeWatches) if (!nameOf.has(e.showTmdbId)) nameOf.set(e.showTmdbId, e.showName)

  const known = new Set(
    (await prisma.show.findMany({ where: { tmdbId: { in: showIds } }, select: { tmdbId: true } })).map((s) => s.tmdbId),
  )
  const unmapped: ImportReport['shows']['unmapped'] = []
  const mapped = new Set<number>()
  let done = 0
  await setProgress(jobId, 'shows', 0, showIds.length)
  for (const tmdbId of showIds) {
    if (known.has(tmdbId)) {
      mapped.add(tmdbId)
    } else {
      // Only reason this fails: the show was deleted/merged on TMDB since the export.
      try {
        await cacheShow(tmdbId)
        mapped.add(tmdbId)
      } catch {
        unmapped.push({ tvdbId: null, tmdbId, name: nameOf.get(tmdbId) ?? '?' })
      }
    }
    done++
    if (done % 5 === 0 || done === showIds.length) await setProgress(jobId, 'shows', done, showIds.length)
  }

  // ——— 2. Episode watch events ———
  await setProgress(jobId, 'episodes', 0, data.episodeWatches.length)
  const episodes = await prisma.episode.findMany({
    where: { showTmdbId: { in: [...mapped] } },
    select: { id: true, showTmdbId: true, season: true, number: true },
  })
  const epIndex = new Map<string, number>()
  for (const ep of episodes) epIndex.set(`${ep.showTmdbId}:${ep.season}:${ep.number}`, ep.id)

  let unmatchedEpisodes = 0
  const events: { userId: number; episodeId: number; watchedAt: Date }[] = []
  for (const ev of data.episodeWatches) {
    const episodeId = epIndex.get(`${ev.showTmdbId}:${ev.season}:${ev.number}`)
    if (!episodeId) {
      unmatchedEpisodes++
      continue
    }
    events.push({ userId, episodeId, watchedAt: ev.watchedAt })
  }
  const inserted = await prisma.watchEvent.createMany({ data: events, skipDuplicates: true })
  await setProgress(jobId, 'episodes', data.episodeWatches.length, data.episodeWatches.length)

  // ——— 3. Follows, favorites, ratings — file wins ———
  let follows = 0
  let ratings = 0
  for (const s of data.shows) {
    if (!mapped.has(s.tmdbId)) continue
    await prisma.follow.upsert({
      where: { userId_showTmdbId: { userId, showTmdbId: s.tmdbId } },
      create: { userId, showTmdbId: s.tmdbId, state: s.state as FollowState, followedAt: s.followedAt },
      update: { state: s.state as FollowState, followedAt: s.followedAt },
    })
    follows++
    await setFavorite(userId, 'SHOW', s.tmdbId, s.isFavorite)
    if (await setRating(userId, 'SHOW', s.tmdbId, s.rating)) ratings++
  }

  // ——— 4. Movies: watches, favorites, ratings, watchlist ———
  const total = data.movies.length + data.movieWatchlist.length
  await setProgress(jobId, 'movies', 0, total)
  let autoMatched = 0
  let watchlist = 0
  let failedMovies = 0
  let doneMovies = 0
  for (const m of data.movies) {
    try {
      await applyMovieMatch(userId, m.tmdbId, 'WATCHED', m.watchedAts)
      await setFavorite(userId, 'MOVIE', m.tmdbId, m.isFavorite)
      if (await setRating(userId, 'MOVIE', m.tmdbId, m.rating)) ratings++
      autoMatched++
    } catch {
      failedMovies++
    }
    doneMovies++
    if (doneMovies % 5 === 0) await setProgress(jobId, 'movies', doneMovies, total)
  }
  for (const w of data.movieWatchlist) {
    try {
      await applyMovieMatch(userId, w.tmdbId, 'WATCHLIST', [])
      watchlist++
    } catch {
      failedMovies++
    }
    doneMovies++
    if (doneMovies % 5 === 0 || doneMovies === total) await setProgress(jobId, 'movies', doneMovies, total)
  }

  return {
    shows: { mapped: mapped.size, unmapped },
    episodes: { imported: inserted.count, unmatched: unmatchedEpisodes },
    follows,
    ratings,
    // Nothing is ever ambiguous here: a TMDB id matches exactly, or the title is gone
    // from TMDB — so there is never anything to resolve by hand.
    movies: { autoMatched, pending: 0, watchlist, failed: failedMovies },
  }
}

/** File-wins favorite: sets or clears, so un-favoriting is restored too. */
async function setFavorite(userId: number, target: 'SHOW' | 'MOVIE', targetRef: number, isFavorite: boolean) {
  if (isFavorite) {
    await prisma.favorite.upsert({
      where: { userId_target_targetRef: { userId, target, targetRef } },
      create: { userId, target, targetRef },
      update: {},
    })
  } else {
    await prisma.favorite.deleteMany({ where: { userId, target, targetRef } })
  }
}

/** File-wins rating. A null in the file clears a local rating. Returns true if one was set. */
async function setRating(userId: number, target: 'SHOW' | 'MOVIE', targetRef: number, value: number | null) {
  if (value === null) {
    await prisma.rating.deleteMany({ where: { userId, target, targetRef } })
    return false
  }
  await prisma.rating.upsert({
    where: { userId_target_targetRef: { userId, target, targetRef } },
    create: { userId, target, targetRef, value },
    update: { value },
  })
  return true
}

/** Applies a movie match (auto or manual resolution): cache + events/watchlist. */
export async function applyMovieMatch(
  userId: number,
  movieTmdbId: number,
  kind: 'WATCHED' | 'WATCHLIST',
  watchedAts: Date[],
) {
  await cacheMovie(movieTmdbId)
  if (kind === 'WATCHED') {
    await prisma.watchEvent.createMany({
      data: watchedAts.map((watchedAt) => ({ userId, movieId: movieTmdbId, watchedAt })),
      skipDuplicates: true,
    })
  } else {
    await prisma.movieWatchlistEntry.upsert({
      where: { userId_movieTmdbId: { userId, movieTmdbId } },
      create: { userId, movieTmdbId },
      update: {},
    })
  }
}
