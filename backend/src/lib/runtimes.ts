// Fallback runtimes for entries TMDB doesn't declare one for. Shared on
// purpose: the time counted as watched in the stats and the time announced as
// left to watch have to rest on the same assumption, or the two screens
// disagree for the same show.
export const FALLBACK_EPISODE_MIN = 40
export const FALLBACK_MOVIE_MIN = 110
