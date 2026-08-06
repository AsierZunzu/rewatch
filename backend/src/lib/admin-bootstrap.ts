// Provisions the operator account from the environment, so an instance can be
// brought up declaratively (compose file, Ansible, k8s manifest) without anyone
// visiting the signup page first.
//
// Opt-in: nothing happens unless ADMIN_USERNAME is set, so the documented
// "first account you create becomes the administrator" flow is untouched for
// everyone else. Note that once a seeded admin exists, the user count is no
// longer zero, so that first-account rule in routes/auth.ts stops applying —
// subsequent signups are ordinary accounts, which is the point.
import { readFileSync } from 'node:fs'
import argon2 from 'argon2'
import { prisma } from './prisma.js'
import { emailSchema, languageSchema, passwordSchema, timezoneSchema, usernameSchema } from './validation.js'

type Logger = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void }

/** `X_FILE` points at a file whose contents are the value — for Docker/podman secrets. */
function readEnvOrFile(name: string): string | undefined {
  const direct = process.env[name]
  if (direct !== undefined && direct !== '') return direct
  const path = process.env[`${name}_FILE`]
  if (path === undefined || path === '') return undefined
  return readFileSync(path, 'utf8').trim()
}

export async function bootstrapAdminFromEnv(log: Logger): Promise<void> {
  const rawUsername = readEnvOrFile('ADMIN_USERNAME')
  if (rawUsername === undefined) return

  const parsed = parseAdminEnv(rawUsername)
  if (!parsed.ok) {
    // Logged and skipped rather than thrown: crashing here would put the
    // container in a restart loop over a typo, taking the whole instance down
    // instead of leaving it up and fixable through the normal signup flow.
    log.error({ field: parsed.field, reason: parsed.reason }, 'ADMIN_* bootstrap skipped: invalid configuration')
    return
  }
  const { username, email, password, language, timezone } = parsed.value

  const existing = await prisma.user.findUnique({ where: { username } })

  if (existing) {
    // Promotion strategy: the environment is the source of truth for *who* the
    // operator is, so an existing account under that username is promoted and
    // its email realigned. The password is deliberately never touched — an
    // operator who rotated it in-app keeps that change across restarts.
    const changes: { isAdmin?: boolean; email?: string; emailVerifiedAt?: Date } = {}
    if (!existing.isAdmin) changes.isAdmin = true
    if (email !== undefined && existing.email !== email) {
      // A collision means ADMIN_EMAIL belongs to a *different* account; taking
      // it would break that account's login and violate the unique index.
      const clash = await prisma.user.findUnique({ where: { email } })
      if (clash && clash.id !== existing.id) {
        log.error({ username, email }, 'ADMIN_EMAIL already belongs to another account, keeping the current one')
      } else {
        changes.email = email
        changes.emailVerifiedAt = new Date()
      }
    }
    if (Object.keys(changes).length === 0) {
      log.info({ username }, 'admin bootstrap: already up to date')
      return
    }
    await prisma.user.update({ where: { id: existing.id }, data: changes })
    log.info({ username, changed: Object.keys(changes) }, 'admin bootstrap: promoted existing account')
    return
  }

  if (password === undefined || email === undefined) {
    log.error(
      { username },
      'ADMIN_USERNAME names a new account but ADMIN_EMAIL and/or ADMIN_PASSWORD are missing',
    )
    return
  }

  await prisma.user.create({
    data: {
      username,
      email,
      language,
      timezone,
      isAdmin: true,
      // Pre-verified on purpose: lib/verification.ts blocks unverified accounts
      // after a 7-day grace period, and an instance provisioned from env may
      // have no SMTP at all — the operator would lock themselves out in a week.
      emailVerifiedAt: new Date(),
      passwordHash: await argon2.hash(password),
    },
  })
  log.info({ username, email }, 'admin bootstrap: created administrator account')
}

type ParseResult =
  | { ok: true; value: { username: string; email?: string; password?: string; language: 'fr' | 'en'; timezone: string } }
  | { ok: false; field: string; reason: string }

/** Same rules as HTTP signup; email/password stay optional so a bare
 *  ADMIN_USERNAME can still promote an account that already exists. */
function parseAdminEnv(rawUsername: string): ParseResult {
  const username = usernameSchema.safeParse(rawUsername)
  if (!username.success) return { ok: false, field: 'ADMIN_USERNAME', reason: username.error.issues[0]!.message }

  const rawEmail = readEnvOrFile('ADMIN_EMAIL')
  let email: string | undefined
  if (rawEmail !== undefined) {
    const parsedEmail = emailSchema.safeParse(rawEmail)
    if (!parsedEmail.success) return { ok: false, field: 'ADMIN_EMAIL', reason: parsedEmail.error.issues[0]!.message }
    email = parsedEmail.data
  }

  const rawPassword = readEnvOrFile('ADMIN_PASSWORD')
  let password: string | undefined
  if (rawPassword !== undefined) {
    const parsedPassword = passwordSchema.safeParse(rawPassword)
    if (!parsedPassword.success) return { ok: false, field: 'ADMIN_PASSWORD', reason: 'must be 8 to 128 characters' }
    password = parsedPassword.data
  }

  const language = languageSchema.safeParse(process.env.ADMIN_LANGUAGE ?? 'en')
  if (!language.success) return { ok: false, field: 'ADMIN_LANGUAGE', reason: 'expected "fr" or "en"' }

  const timezone = timezoneSchema.safeParse(process.env.ADMIN_TIMEZONE ?? 'UTC')
  if (!timezone.success) return { ok: false, field: 'ADMIN_TIMEZONE', reason: 'unknown IANA timezone' }

  return { ok: true, value: { username: username.data, email, password, language: language.data, timezone: timezone.data } }
}
