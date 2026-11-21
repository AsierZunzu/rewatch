import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { createSession, getSessionUser } from '../lib/session.js'
import { isLang, DEFAULT_LANG } from '../lib/langs.js'
import {
  OidcError,
  buildAuthUrl,
  handleCallback,
  oidcButtonLabel,
  oidcConfigured,
  passwordLoginEnabled,
  resolveUser,
  type OidcState,
} from '../lib/oidc.js'

const STATE_COOKIE = 'rewatch_oidc'
const STATE_PATH = '/api/auth/oidc'
const STATE_TTL_S = 10 * 60

const strictRateLimit = {
  rateLimit: { max: 10, timeWindow: '1 minute' },
}

// These are top-level browser navigations, not fetches: every outcome is a
// redirect back into the SPA, with an error code the login screen translates.
const backToLogin = (reply: FastifyReply, code: string) =>
  reply.redirect(`/login?error=${encodeURIComponent(code)}`)

function readState(request: FastifyRequest): OidcState | null {
  const raw = request.cookies[STATE_COOKIE]
  if (!raw) return null
  try {
    return JSON.parse(raw) as OidcState
  } catch {
    return null
  }
}

export default async function oidcRoutes(app: FastifyInstance) {
  // Public: the login screen decides which buttons and forms to show.
  app.get('/api/auth/methods', async () => ({
    password: passwordLoginEnabled(),
    oidc: { enabled: oidcConfigured(), label: oidcButtonLabel() },
  }))

  app.get('/api/auth/oidc/start', { config: strictRateLimit }, async (request, reply) => {
    if (!oidcConfigured()) return backToLogin(reply, 'oidc_disabled')
    const query = z
      .object({ lang: z.string().optional(), tz: z.string().max(64).optional(), link: z.literal('1').optional() })
      .safeParse(request.query)
    const q = query.success ? query.data : {}

    // Linking needs a live session; it ties the identity to that account.
    let linkUserId: number | undefined
    if (q.link) {
      const user = await getSessionUser(request)
      if (!user) return backToLogin(reply, 'unauthorized')
      linkUserId = user.id
    }

    try {
      const { url, state } = await buildAuthUrl({
        lang: q.lang && isLang(q.lang) ? q.lang : DEFAULT_LANG,
        // Same check as /register: the value reaches Postgres' AT TIME ZONE.
        timezone: q.tz && Intl.supportedValuesOf('timeZone').includes(q.tz) ? q.tz : 'UTC',
        linkUserId,
      })
      // Random values only, nothing to forge: the IdP round-trip has to come
      // back with the same state, and the verifier never leaves this cookie.
      reply.setCookie(STATE_COOKIE, JSON.stringify(state), {
        path: STATE_PATH,
        httpOnly: true,
        sameSite: 'lax', // must survive the cross-site redirect back from the IdP
        secure: request.protocol === 'https',
        maxAge: STATE_TTL_S,
      })
      return reply.redirect(url.href)
    } catch (err) {
      request.log.error(err, 'oidc discovery failed')
      return backToLogin(reply, 'oidc_failed')
    }
  })

  app.get('/api/auth/oidc/callback', { config: strictRateLimit }, async (request, reply) => {
    const stored = readState(request)
    // Single use, whatever the outcome.
    reply.clearCookie(STATE_COOKIE, { path: STATE_PATH })
    if (!oidcConfigured()) return backToLogin(reply, 'oidc_disabled')
    if (!stored) return backToLogin(reply, 'oidc_failed')
    // A failed link sends the user back where they started, still logged in.
    const fail = (code: string) =>
      stored.linkUserId !== undefined
        ? reply.redirect(`/profile?oidc_error=${encodeURIComponent(code)}`)
        : backToLogin(reply, code)

    // The user cancelled or the IdP refused: not worth an error log.
    const { error } = request.query as { error?: string }
    if (error) return fail(error === 'access_denied' ? 'oidc_cancelled' : 'oidc_failed')

    let userId: number
    try {
      const claims = await handleCallback(request.url, stored)
      userId = await resolveUser(claims, stored)
    } catch (err) {
      if (err instanceof OidcError) return fail(err.code)
      request.log.warn(err, 'oidc callback rejected')
      return fail('oidc_failed')
    }

    if (stored.linkUserId !== undefined) return reply.redirect('/profile')
    await createSession(request, reply, userId)
    return reply.redirect('/')
  })

  // Unlinking an account that has no password would leave no way back in.
  app.delete('/api/auth/oidc', { preHandler: app.requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id } })
    if (!user.passwordHash || !passwordLoginEnabled()) {
      return reply.code(400).send({ error: 'password_required' })
    }
    await prisma.oidcIdentity.deleteMany({ where: { userId: user.id } })
    return { ok: true }
  })
}
