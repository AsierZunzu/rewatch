import { browserLang } from '../i18n'

// Codes the OIDC callback puts in ?error= (login) or ?oidc_error= (profile).
// Anything else is shown as the generic failure.
export const OIDC_ERRORS = [
  'oidc_failed',
  'oidc_cancelled',
  'oidc_disabled',
  'oidc_email_unverified',
  'oidc_already_linked',
  'registration_closed',
]

export const oidcErrorKey = (code: string) =>
  `auth.oidcError.${OIDC_ERRORS.includes(code) ? code : 'oidc_failed'}`

// A full navigation, not a fetch: the API redirects to the IdP. Language and
// timezone seed the account if this login creates one, like signup does.
export const oidcStartUrl = (link = false) =>
  `/api/auth/oidc/start?${new URLSearchParams({
    lang: browserLang(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(link ? { link: '1' } : {}),
  })}`
