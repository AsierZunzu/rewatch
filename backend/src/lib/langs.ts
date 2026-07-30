// The languages this instance speaks, in one place.
//
// Adding one here is not free: cacheShow and cacheMovie fetch metadata once per
// language, so every entry multiplies the TMDB calls made when a show is first
// cached. Worth revisiting the eager-caching strategy before this list grows
// much further.
//
// The frontend keeps its own copy in src/i18n/index.ts, since the two packages
// don't share code. They have to agree: a language offered in the picker but
// missing here would be rejected by the API.
export const LANGS = ['en', 'fr', 'de'] as const
export type Lang = (typeof LANGS)[number]

export const DEFAULT_LANG: Lang = 'en'

/** TMDB's locale for each language, used for the metadata translations. */
export const LANG_TO_TMDB: Record<Lang, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
}

export const isLang = (value: string): value is Lang => (LANGS as readonly string[]).includes(value)

/** Narrows the plain string carried by users.language. Rows written before a
 *  language was removed, or by hand, fall back instead of crashing a send. */
export const toLang = (value: string | null | undefined): Lang =>
  value && isLang(value) ? value : DEFAULT_LANG
