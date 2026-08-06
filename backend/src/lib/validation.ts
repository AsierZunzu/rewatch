// Account field rules, shared by HTTP signup and env-based admin bootstrap so
// both paths accept exactly the same values.
import { z } from 'zod'

export const usernameSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'letters, digits, _ . - only')
export const passwordSchema = z.string().min(8).max(128)
export const emailSchema = z.email().max(254).transform((e) => e.toLowerCase())
export const languageSchema = z.enum(['fr', 'en'])
// Validated against the runtime's own IANA database rather than a hand-kept
// list: the value reaches Postgres' AT TIME ZONE, so it must be a real zone.
//
// Asking ICU to *use* the zone rather than checking supportedValuesOf(), which
// lists only canonical zone names and so excludes the aliases "UTC", "Etc/UTC"
// and "GMT" — including the "UTC" this codebase defaults to everywhere.
export const timezoneSchema = z.string().max(64).refine(isKnownTimezone, 'unknown timezone')

function isKnownTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
