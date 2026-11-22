import { describe, expect, it } from 'vitest'
// The backend's language list, read as text: the packages share no code.
import backendLangs from '../../../backend/src/lib/langs.ts?raw'
import de from './de.json'
import en from './en.json'
import fr from './fr.json'
import { browserLang, LANGS, screenshotLang, toLang } from '.'

type Tree = { [key: string]: string | Tree }

const flatten = (tree: Tree, prefix = ''): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[prefix + k, v] as [string, string]] : flatten(v, `${prefix}${k}.`)))

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort()
const tags = (s: string) => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort()

const reference = new Map(flatten(en))
const translations = { fr, de } as Record<string, Tree>

describe.each(Object.keys(translations))('%s translation', (lang) => {
  const strings = new Map(flatten(translations[lang]!))

  it('has every key the English source has, and no stale ones', () => {
    expect([...reference.keys()].filter((k) => !strings.has(k))).toEqual([])
    expect([...strings.keys()].filter((k) => !reference.has(k))).toEqual([])
  })

  it('keeps the same {{placeholders}} and <tags>', () => {
    const mismatches = [...reference]
      .filter(([key]) => strings.has(key))
      .filter(([key, source]) => {
        const translated = strings.get(key)!
        return placeholders(source).join() !== placeholders(translated).join() || tags(source).join() !== tags(translated).join()
      })
      .map(([key]) => key)
    expect(mismatches).toEqual([])
  })

  it('has no empty strings', () => {
    expect([...strings].filter(([, v]) => v.trim() === '').map(([k]) => k)).toEqual([])
  })
})

describe('languages', () => {
  it('ships a bundle for every language it offers', () => {
    expect(Object.keys({ en, ...translations }).sort()).toEqual([...LANGS].sort())
  })

  it('offers exactly the languages the backend accepts', () => {
    // The two packages keep separate lists (see the comment in index.ts).
    const list = /export const LANGS = \[([^\]]*)\]/.exec(backendLangs)?.[1] ?? ''
    expect([...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()).toEqual([...LANGS].sort())
  })

  it('narrows unknown values', () => {
    expect(toLang('de')).toBe('de')
    expect(toLang('pt')).toBe('en')
    expect(toLang(undefined)).toBe('en')
    expect(screenshotLang('de')).toBe('en') // no German screenshots yet
    expect(screenshotLang('fr')).toBe('fr')
  })

  it('reads the browser language by its base subtag', () => {
    const original = navigator.language
    Object.defineProperty(navigator, 'language', { value: 'fr-CA', configurable: true })
    expect(browserLang()).toBe('fr')
    Object.defineProperty(navigator, 'language', { value: original, configurable: true })
  })
})
