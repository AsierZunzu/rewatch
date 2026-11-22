// OpenID Connect login against the instance's single identity provider
// (Authelia, Authentik, Keycloak, Pocket ID…). Authorization code flow with
// PKCE; openid-client does discovery and ID token validation. A successful
// login ends in an ordinary session, so nothing downstream knows about OIDC.
import * as client from 'openid-client'
import { prisma } from './prisma.js'
import { getSetting, onSettingsChange } from './settings.js'
import { DEFAULT_LANG, type Lang } from './langs.js'

export const oidcConfigured = () =>
  getSetting('OIDC_ISSUER') !== undefined &&
  getSetting('OIDC_CLIENT_ID') !== undefined &&
  getSetting('OIDC_CLIENT_SECRET') !== undefined

/** Password login stays on unless the operator explicitly turns it off. */
export const passwordLoginEnabled = () => getSetting('PASSWORD_LOGIN_ENABLED') !== 'false'

export const oidcButtonLabel = () => getSetting('OIDC_BUTTON_LABEL') ?? 'SSO'

const appUrl = () => (getSetting('APP_URL') ?? 'http://localhost:5173').replace(/\/$/, '')

// Must be registered verbatim on the IdP side. Built from APP_URL rather than
// the request so it is stable behind any reverse proxy.
export const redirectUri = () => `${appUrl()}/api/auth/oidc/callback`

// Discovery is one network round-trip: done once, redone when settings change.
let config: Promise<client.Configuration> | null = null
onSettingsChange(() => {
  config = null
})

function getConfig(): Promise<client.Configuration> {
  if (!config) {
    const issuer = new URL(getSetting('OIDC_ISSUER')!)
    config = client
      .discovery(
        issuer,
        getSetting('OIDC_CLIENT_ID')!,
        getSetting('OIDC_CLIENT_SECRET')!,
        undefined,
        // A homelab IdP on plain HTTP is the operator's call, not ours.
        issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        config = null // retry on the next login instead of caching the failure
        throw err
      })
  }
  return config
}

/** What travels in the short-lived state cookie between start and callback. */
export type OidcState = {
  state: string
  nonce: string
  verifier: string
  lang: Lang
  timezone: string
  linkUserId?: number
}

export async function buildAuthUrl(
  extra: Pick<OidcState, 'lang' | 'timezone' | 'linkUserId'>,
): Promise<{ url: URL; state: OidcState }> {
  const cfg = await getConfig()
  const verifier = client.randomPKCECodeVerifier()
  const state: OidcState = { ...extra, state: client.randomState(), nonce: client.randomNonce(), verifier }
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(),
    scope: getSetting('OIDC_SCOPES') ?? 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: state.state,
    nonce: state.nonce,
  })
  return { url, state }
}

export type OidcClaims = {
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean
  preferredUsername: string | null
  name: string | null
}

/** Exchanges the code and returns the validated identity. Throws on any mismatch. */
export async function handleCallback(requestUrl: string, stored: OidcState): Promise<OidcClaims> {
  const cfg = await getConfig()
  // Rebuilt on APP_URL so it matches the registered redirect_uri exactly.
  const currentUrl = new URL(requestUrl, appUrl())
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: stored.verifier,
    expectedState: stored.state,
    expectedNonce: stored.nonce,
    idTokenExpected: true,
  })
  let claims: Record<string, unknown> = { ...tokens.claims()! }
  // Some IdPs keep email/profile out of the ID token and only serve them here.
  if (typeof claims.email !== 'string') {
    const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub as string)
    claims = { ...info, ...claims }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return {
    issuer: cfg.serverMetadata().issuer,
    subject: claims.sub as string,
    email: str(claims.email)?.toLowerCase() ?? null,
    // Some IdPs send the string "true".
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    preferredUsername: str(claims.preferred_username),
    name: str(claims.name),
  }
}

export class OidcError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

/** Username for a new account, derived from the IdP claims and made unique. */
async function pickUsername(claims: OidcClaims): Promise<string> {
  const source = claims.preferredUsername ?? claims.email?.split('@')[0] ?? claims.name ?? 'user'
  let base = source.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 26)
  if (base.length < 3) base = `user${base}`.slice(0, 26)
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`
    if (!(await prisma.user.findUnique({ where: { username: candidate } }))) return candidate
  }
}

/**
 * Maps a validated identity to a local user id: known identity, else link by
 * a trusted email, else create the account. Throws OidcError with a code the
 * login screen can show.
 */
export async function resolveUser(claims: OidcClaims, stored: OidcState): Promise<number> {
  const identity = await prisma.oidcIdentity.findUnique({
    where: { issuer_subject: { issuer: claims.issuer, subject: claims.subject } },
  })
  const emailTrusted = claims.emailVerified || getSetting('OIDC_SKIP_EMAIL_VERIFIED') === 'true'

  // Linking from the profile page: the session already says who this is.
  if (stored.linkUserId !== undefined) {
    if (identity && identity.userId !== stored.linkUserId) throw new OidcError('oidc_already_linked')
    await prisma.oidcIdentity.upsert({
      where: { userId: stored.linkUserId },
      create: { userId: stored.linkUserId, issuer: claims.issuer, subject: claims.subject },
      update: { issuer: claims.issuer, subject: claims.subject },
    })
    return stored.linkUserId
  }

  if (identity) return identity.userId

  if (claims.email) {
    const existing = await prisma.user.findUnique({ where: { email: claims.email } })
    if (existing) {
      // Linking on an unverified email would let anyone who can set an
      // arbitrary address at the IdP take over the matching local account.
      if (!emailTrusted) throw new OidcError('oidc_email_unverified')
      await prisma.$transaction([
        prisma.oidcIdentity.create({ data: { userId: existing.id, issuer: claims.issuer, subject: claims.subject } }),
        ...(existing.emailVerifiedAt
          ? []
          : [prisma.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date() } })]),
      ])
      return existing.id
    }
  }

  if (getSetting('REGISTRATION_ENABLED') === 'false' || getSetting('OIDC_AUTO_REGISTER') === 'false') {
    throw new OidcError('registration_closed')
  }

  // Same rule as password signup: the very first account is the operator.
  const isFirstAccount = (await prisma.user.count()) === 0
  const user = await prisma.user.create({
    data: {
      username: await pickUsername(claims),
      email: claims.email,
      emailVerifiedAt: claims.email && emailTrusted ? new Date() : null,
      language: stored.lang ?? DEFAULT_LANG,
      timezone: stored.timezone,
      isAdmin: isFirstAccount,
      passwordHash: null,
      oidcIdentity: { create: { issuer: claims.issuer, subject: claims.subject } },
    },
  })
  return user.id
}
