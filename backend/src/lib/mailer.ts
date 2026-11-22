// Transactional emails: plain SMTP configured via env,
// disabled when SMTP_HOST is empty (links are logged instead; handy in dev).
import nodemailer from 'nodemailer'
import { getSetting } from './settings.js'
import { DEFAULT_LANG, type Lang } from './langs.js'

export type { Lang }

const from = () => getSetting('MAIL_FROM') ?? 'Rewatch <no-reply@rewatch.local>'

function transport() {
  const host = getSetting('SMTP_HOST')
  if (!host) return null
  return nodemailer.createTransport({
    host,
    port: Number(getSetting('SMTP_PORT') ?? 587),
    secure: getSetting('SMTP_SECURE') === 'true',
    auth: getSetting('SMTP_USER')
      ? { user: getSetting('SMTP_USER'), pass: getSetting('SMTP_PASS') }
      : undefined,
  })
}

async function send(to: string, subject: string, text: string) {
  const t = transport()
  if (!t) {
    console.log(`[mailer disabled] To: ${to} | ${subject}\n${text}`)
    return
  }
  await t.sendMail({ from: from(), to, subject, text })
}

const appUrl = () => (getSetting('APP_URL') ?? 'http://localhost:5173').replace(/\/$/, '')

const T = {
  verify: {
    fr: (username: string, link: string) => ({
      subject: 'Rewatch — vérifiez votre adresse email',
      text: `Bonjour ${username},

Bienvenue sur Rewatch ! Cliquez sur ce lien pour vérifier votre adresse email :

${link}

Le lien est valable 7 jours. Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message.`,
    }),
    en: (username: string, link: string) => ({
      subject: 'Rewatch — verify your email address',
      text: `Hi ${username},

Welcome to Rewatch! Click this link to verify your email address:

${link}

The link is valid for 7 days. If you didn't sign up, just ignore this message.`,
    }),
    de: (username: string, link: string) => ({
      subject: 'Rewatch — bestätige deine E-Mail-Adresse',
      text: `Hallo ${username},

willkommen bei Rewatch! Klicke auf diesen Link, um deine E-Mail-Adresse zu bestätigen:

${link}

Der Link ist 7 Tage gültig. Falls du dich nicht registriert hast, ignoriere diese Nachricht einfach.`,
    }),
    es: (username: string, link: string) => ({
      subject: 'Rewatch — verifica tu dirección de correo',
      text: `Hola ${username}:

¡Bienvenido a Rewatch! Haz clic en este enlace para verificar tu dirección de correo:

${link}

El enlace es válido durante 7 días. Si no te has registrado, ignora este mensaje.`,
    }),
  },
  verifyReminder: {
    fr: (username: string, link: string) => ({
      subject: 'Rewatch — dernière chance de vérifier votre email',
      text: `Bonjour ${username},

Petit rappel : votre adresse email n'est toujours pas vérifiée, et votre compte Rewatch sera bloqué demain (il sera débloqué dès la vérification, rien n'est perdu).

Cliquez ici pour vérifier :

${link}`,
    }),
    en: (username: string, link: string) => ({
      subject: 'Rewatch — last chance to verify your email',
      text: `Hi ${username},

Quick reminder: your email address is still unverified, and your Rewatch account will be locked tomorrow unless you verify it (it unlocks as soon as you do — nothing is lost).

Click here to verify:

${link}`,
    }),
    de: (username: string, link: string) => ({
      subject: 'Rewatch — letzte Chance, deine E-Mail zu bestätigen',
      text: `Hallo ${username},

kurze Erinnerung: deine E-Mail-Adresse ist noch nicht bestätigt, und dein Rewatch-Konto wird morgen gesperrt, wenn du das nicht nachholst. Die Sperre wird sofort aufgehoben, sobald du bestätigst, es geht nichts verloren.

Hier klicken zum Bestätigen:

${link}`,
    }),
    es: (username: string, link: string) => ({
      subject: 'Rewatch — última oportunidad para verificar tu correo',
      text: `Hola ${username}:

Un recordatorio rápido: tu dirección de correo sigue sin verificar y tu cuenta de Rewatch se bloqueará mañana si no la verificas (se desbloquea en cuanto lo hagas, no se pierde nada).

Haz clic aquí para verificarla:

${link}`,
    }),
  },
  reset: {
    fr: (username: string, link: string) => ({
      subject: 'Rewatch — réinitialisation du mot de passe',
      text: `Bonjour ${username},

Quelqu'un (vous, normalement) a demandé à réinitialiser votre mot de passe Rewatch. Cliquez ici :

${link}

Le lien est valable 1 heure et ne peut servir qu'une fois. Si vous n'avez rien demandé, ignorez ce message — votre mot de passe reste inchangé.`,
    }),
    en: (username: string, link: string) => ({
      subject: 'Rewatch — password reset',
      text: `Hi ${username},

Someone (hopefully you) asked to reset your Rewatch password. Click here:

${link}

The link is valid for 1 hour and can only be used once. If you didn't ask for this, ignore this message — your password stays unchanged.`,
    }),
    de: (username: string, link: string) => ({
      subject: 'Rewatch — Passwort zurücksetzen',
      text: `Hallo ${username},

jemand (hoffentlich du) hat angefragt, dein Rewatch-Passwort zurückzusetzen. Hier klicken:

${link}

Der Link ist 1 Stunde gültig und kann nur einmal verwendet werden. Falls du das nicht angefragt hast, ignoriere diese Nachricht, dein Passwort bleibt unverändert.`,
    }),
    es: (username: string, link: string) => ({
      subject: 'Rewatch — restablecer la contraseña',
      text: `Hola ${username}:

Alguien (esperamos que tú) ha pedido restablecer tu contraseña de Rewatch. Haz clic aquí:

${link}

El enlace es válido durante 1 hora y solo puede usarse una vez. Si no lo has pedido tú, ignora este mensaje: tu contraseña no cambia.`,
    }),
  },
}

export const sendVerificationEmail = (to: string, username: string, token: string, lang: Lang = DEFAULT_LANG) => {
  const { subject, text } = T.verify[lang](username, `${appUrl()}/verify?token=${token}`)
  return send(to, subject, text)
}

export const sendVerifyReminderEmail = (to: string, username: string, token: string, lang: Lang = DEFAULT_LANG) => {
  const { subject, text } = T.verifyReminder[lang](username, `${appUrl()}/verify?token=${token}`)
  return send(to, subject, text)
}

export const sendResetEmail = (to: string, username: string, token: string, lang: Lang = DEFAULT_LANG) => {
  const { subject, text } = T.reset[lang](username, `${appUrl()}/reset?token=${token}`)
  return send(to, subject, text)
}

export const sendTestEmail = (to: string) =>
  send(to, 'Rewatch — test email', 'SMTP is configured correctly. This is a test message from your Rewatch instance.')
