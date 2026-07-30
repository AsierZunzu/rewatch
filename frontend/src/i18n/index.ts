// i18n setup: browser language before login, then the account language
// (me.language) takes over once known.
//
// This list has to match LANGS in backend/src/lib/langs.ts: a language offered
// here but unknown there is rejected when the picker tries to save it.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import de from './de.json'
import en from './en.json'
import fr from './fr.json'

export const LANGS = ['en', 'fr', 'de'] as const
export type Lang = (typeof LANGS)[number]

export const DEFAULT_LANG: Lang = 'en'

/** Locale for dates and numbers, which is not the UI language string: "en"
 *  alone would give US formats. */
export const INTL_LOCALE: Record<Lang, string> = {
  en: 'en-GB',
  fr: 'fr-FR',
  de: 'de-DE',
}

export const isLang = (value: string): value is Lang => (LANGS as readonly string[]).includes(value)

/** Narrows a language coming from the account, the browser or i18next. */
export const toLang = (value: string | null | undefined): Lang =>
  value && isLang(value) ? value : DEFAULT_LANG

/** Languages the install screenshots exist in. A UI language without its own
 *  captures gets the English ones rather than a broken image. */
const SCREENSHOT_LANGS: readonly Lang[] = ['en', 'fr']
export const screenshotLang = (value: string | null | undefined): Lang => {
  const lang = toLang(value)
  return SCREENSHOT_LANGS.includes(lang) ? lang : DEFAULT_LANG
}

/** Matches on the base subtag, so "de-AT" and "fr-CA" resolve too. */
export const browserLang = (): Lang => toLang(navigator.language?.toLowerCase().split('-')[0])

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr }, de: { translation: de } },
  lng: browserLang(),
  fallbackLng: DEFAULT_LANG,
  interpolation: { escapeValue: false }, // React already escapes
})

export default i18n
