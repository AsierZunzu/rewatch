// Catalogue entries shared by the integration suites. Dates are relative to
// today so "aired" and "upcoming" stay true whenever the suite runs.
import { addMovie, addShow } from './fake-tmdb.js'
import { isoDay } from './helpers.js'

export const ALPHA = 100 // returning show: aired, upcoming and undated episodes
export const OMEGA = 200 // ended show, every episode long aired
export const INCEPTION = 27205
export const PARASITE = 496243

/**
 * ALPHA, a returning US show:
 *   S0E1  special, aired a year ago
 *   S1E1-3 aired weeks ago (S1E2 has no runtime of its own → show default 45)
 *   S2E1  aired 9 days ago
 *   S2E2  aired 3 days ago
 *   S2E3  airs in 5 days
 *   S2E4  announced, no date yet
 */
export function seedAlpha() {
  addShow({
    id: ALPHA,
    name: 'Alpha',
    genres: ['Drama', 'Mystery'],
    tvdbId: 5001,
    runtime: 45,
    seasons: [
      { number: 0, episodes: [{ number: 1, airDate: isoDay(-365), name: 'Special', runtime: 20 }] },
      {
        number: 1,
        episodes: [
          { number: 1, airDate: isoDay(-60), name: 'Pilot', runtime: 60 },
          { number: 2, airDate: isoDay(-53), name: 'Second' },
          { number: 3, airDate: isoDay(-46), name: 'Third', runtime: 50 },
        ],
      },
      {
        number: 2,
        episodes: [
          { number: 1, airDate: isoDay(-9), name: 'Return', runtime: 40 },
          { number: 2, airDate: isoDay(-3), name: 'Middle', runtime: 40 },
          { number: 3, airDate: isoDay(5), name: 'Upcoming', runtime: 40 },
          { number: 4, airDate: null, name: 'TBA' },
        ],
      },
    ],
    translations: { 'fr-FR': { name: 'Alpha (FR)', overview: 'Résumé', genres: ['Drame'] } },
  })
}

/** OMEGA, an ended UK show with two short seasons, all aired years ago. */
export function seedOmega() {
  addShow({
    id: OMEGA,
    name: 'Omega',
    status: 'Ended',
    originCountry: 'GB',
    genres: ['Comedy'],
    tvdbId: 5002,
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, airDate: '2015-01-01', runtime: 30 },
          { number: 2, airDate: '2015-01-08', runtime: 30 },
        ],
      },
      { number: 2, episodes: [{ number: 1, airDate: '2016-01-01', runtime: 30 }] },
    ],
  })
}

export function seedMovies() {
  addMovie({ id: INCEPTION, title: 'Inception', runtime: 148, genres: ['Science Fiction'], translations: { 'fr-FR': { title: 'Inception (FR)' } } })
  addMovie({ id: PARASITE, title: 'Parasite', runtime: null, genres: ['Thriller'] })
}

export function seedCatalog() {
  seedAlpha()
  seedOmega()
  seedMovies()
}
