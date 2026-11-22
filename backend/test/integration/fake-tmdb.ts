// In-memory stand-in for src/lib/tmdb.ts. Test files swap it in with
//   vi.mock('../../src/lib/tmdb.js', () => import('./fake-tmdb.js'))
// and seed it with `addShow()` / `addMovie()` from the test body.
//
// Same exports as the real module, so anything importing tmdb.js keeps working.
import type { TmdbMovie, TmdbSearchResult, TmdbShow } from '../../src/lib/tmdb.js'

export class TmdbError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const defaultLanguage = () => 'en-US'

type FakeEpisode = { number: number; airDate: string | null; name?: string; runtime?: number | null }
type FakeSeason = { number: number; episodes: FakeEpisode[] }
export type FakeShow = {
  id: number
  name: string
  status?: string
  originCountry?: string | null
  genres?: string[]
  network?: string
  firstAirDate?: string | null
  runtime?: number
  tvdbId?: number | null
  imdbId?: string | null
  posterPath?: string | null
  seasons: FakeSeason[]
  /** Per TMDB locale ("fr-FR"), overriding the base name. */
  translations?: Record<string, { name?: string; overview?: string; genres?: string[] }>
}
export type FakeMovie = {
  id: number
  title: string
  runtime?: number | null
  genres?: string[]
  releaseDate?: string | null
  translations?: Record<string, { title?: string; overview?: string }>
}

const shows = new Map<number, FakeShow>()
const movies = new Map<number, FakeMovie>()
export const calls: string[] = []

export function resetTmdb() {
  shows.clear()
  movies.clear()
  calls.length = 0
}

export const addShow = (show: FakeShow) => void shows.set(show.id, show)
export const addMovie = (movie: FakeMovie) => void movies.set(movie.id, movie)

/** Deterministic TMDB episode id, so tests can refer to episodes by S/E. */
export const episodeTmdbId = (showId: number, season: number, number: number) => showId * 10_000 + season * 100 + number

function notFound(path: string): never {
  throw new TmdbError(404, `TMDB 404 on ${path}`)
}

function showOrThrow(id: number) {
  return shows.get(id) ?? notFound(`/tv/${id}`)
}

export async function getShow(tmdbId: number, language = 'en-US'): Promise<TmdbShow> {
  calls.push(`show:${tmdbId}:${language}`)
  const s = showOrThrow(tmdbId)
  const t = s.translations?.[language]
  return {
    id: s.id,
    name: t?.name ?? s.name,
    poster_path: s.posterPath ?? null,
    backdrop_path: null,
    overview: t?.overview ?? `${s.name} overview`,
    genres: (t?.genres ?? s.genres ?? ['Drama']).map((name, i) => ({ id: i, name })),
    status: s.status ?? 'Returning Series',
    first_air_date: s.firstAirDate ?? '2020-01-01',
    episode_run_time: [s.runtime ?? 45],
    origin_country: s.originCountry === null ? [] : [s.originCountry ?? 'US'],
    networks: [{ name: s.network ?? 'HBO' }],
    seasons: s.seasons.map((season) => ({ season_number: season.number, episode_count: season.episodes.length })),
  }
}

export async function getSeason(showTmdbId: number, seasonNumber: number, language = 'en-US') {
  calls.push(`season:${showTmdbId}:${seasonNumber}:${language}`)
  const s = showOrThrow(showTmdbId)
  const season = s.seasons.find((x) => x.number === seasonNumber) ?? notFound(`/tv/${showTmdbId}/season/${seasonNumber}`)
  return {
    season_number: seasonNumber,
    episodes: season.episodes.map((e) => ({
      id: episodeTmdbId(showTmdbId, seasonNumber, e.number),
      season_number: seasonNumber,
      episode_number: e.number,
      name: language === 'en-US' ? (e.name ?? `Episode ${e.number}`) : `${e.name ?? `Episode ${e.number}`} [${language}]`,
      air_date: e.airDate,
      runtime: e.runtime === undefined ? null : e.runtime,
    })),
  }
}

export async function getMovie(tmdbId: number, language = 'en-US'): Promise<TmdbMovie> {
  calls.push(`movie:${tmdbId}:${language}`)
  const m = movies.get(tmdbId) ?? notFound(`/movie/${tmdbId}`)
  const t = m.translations?.[language]
  return {
    id: m.id,
    title: t?.title ?? m.title,
    poster_path: null,
    backdrop_path: null,
    overview: t?.overview ?? `${m.title} overview`,
    genres: (m.genres ?? ['Action']).map((name, i) => ({ id: i, name })),
    release_date: m.releaseDate === undefined ? '2010-07-16' : m.releaseDate,
    runtime: m.runtime === undefined ? 120 : m.runtime,
  }
}

export async function getShowCredits(tmdbId: number) {
  showOrThrow(tmdbId)
  return {
    cast: Array.from({ length: 15 }, (_, i) => ({
      name: `Actor ${i}`,
      profile_path: null,
      roles: [{ character: `Role ${i}`, episode_count: 1 }],
    })),
  }
}

export async function getMovieCredits(tmdbId: number) {
  if (!movies.has(tmdbId)) notFound(`/movie/${tmdbId}/credits`)
  return { cast: [{ name: 'Lead', profile_path: '/lead.jpg', character: 'Hero' }] }
}

export async function searchMulti(query: string): Promise<{ results: TmdbSearchResult[] }> {
  const q = query.toLowerCase()
  const results: TmdbSearchResult[] = [
    ...[...shows.values()]
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({ id: s.id, media_type: 'tv' as const, name: s.name, poster_path: null, first_air_date: s.firstAirDate ?? '2020-01-01' })),
    ...[...movies.values()]
      .filter((m) => m.title.toLowerCase().includes(q))
      .map((m) => ({ id: m.id, media_type: 'movie' as const, title: m.title, poster_path: null, release_date: m.releaseDate === undefined ? '2010-07-16' : (m.releaseDate ?? '') })),
    { id: 1, media_type: 'person' as const, name: `${query} person`, poster_path: null },
  ]
  return { results }
}

export async function searchMovie(query: string) {
  const q = query.toLowerCase()
  return {
    results: await Promise.all(
      [...movies.values()].filter((m) => m.title.toLowerCase().includes(q)).map((m) => getMovie(m.id)),
    ),
  }
}

export async function searchTv(query: string) {
  const q = query.toLowerCase()
  return { results: [...shows.values()].filter((s) => s.name.toLowerCase().includes(q)).map((s) => ({ id: s.id, name: s.name })) }
}

export async function getShowExternalIds(tmdbId: number) {
  const s = showOrThrow(tmdbId)
  return { tvdb_id: s.tvdbId ?? null, imdb_id: s.imdbId ?? null }
}

export async function findShowByTvdbId(tvdbId: number) {
  const s = [...shows.values()].find((x) => x.tvdbId === tvdbId)
  return s ? { id: s.id, name: s.name } : null
}
