// Daily job — run by a systemd timer in prod (`node dist/jobs/daily.js`),
// manually in dev. Idempotent: safe to re-run without double sends.
import 'dotenv/config'
import { prisma } from '../lib/prisma.js'
import { loadSettings } from '../lib/settings.js'
import { createAuthToken } from '../lib/auth-tokens.js'
import { sendVerifyReminderEmail, type Lang } from '../lib/mailer.js'
import { REMINDER_BEFORE_MS, VERIFY_GRACE_MS } from '../lib/verification.js'

await loadSettings()

// Verification reminder at D-1 before lockout: unverified accounts whose
// deadline (createdAt + 7d) falls within the next 24h, never reminded before.
async function sendVerifyReminders() {
  const now = Date.now()
  const users = await prisma.user.findMany({
    where: {
      emailVerifiedAt: null,
      email: { not: null },
      verifyReminderSentAt: null,
      createdAt: {
        lte: new Date(now - (VERIFY_GRACE_MS - REMINDER_BEFORE_MS)), // deadline ≤ 24h away
        gte: new Date(now - VERIFY_GRACE_MS), // not locked yet
      },
    },
  })
  for (const user of users) {
    const token = await createAuthToken(user.id, 'VERIFY_EMAIL')
    await sendVerifyReminderEmail(user.email!, user.username, token, user.language as Lang)
    await prisma.user.update({ where: { id: user.id }, data: { verifyReminderSentAt: new Date() } })
    console.log(`verification reminder sent → ${user.username}`)
  }
  return users.length
}

// Housekeeping: drop expired auth tokens.
async function purgeExpiredTokens() {
  const { count } = await prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  return count
}

// Air times for shows nobody has opened recently.
//
// getShowCached() only refreshes a show when someone views it, so a show that
// is followed but watched entirely from the Up Next list would keep the coarse
// origin-country fallback forever — meaning its new episodes surface hours late,
// every week. Ended shows are skipped: their episodes aired long ago, so the
// fallback and the exact instant are both firmly in the past.
const AIR_TIME_TTL_MS = 7 * 24 * 60 * 60 * 1000
const AIR_TIME_BATCH = 50

async function refreshAirTimes() {
  const { syncShowAirTimes } = await import('../lib/catalog.js')
  const shows = await prisma.show.findMany({
    where: {
      status: { notIn: ['Ended', 'Canceled'] },
      follows: { some: { state: 'WATCHING' } },
      OR: [{ airsCachedAt: null }, { airsCachedAt: { lt: new Date(Date.now() - AIR_TIME_TTL_MS) } }],
    },
    // Never-enriched shows first: they are the ones still on the coarse fallback.
    orderBy: [{ airsCachedAt: { sort: 'asc', nulls: 'first' } }],
    take: AIR_TIME_BATCH,
    select: { tmdbId: true },
  })
  let done = 0
  for (const show of shows) {
    try {
      await syncShowAirTimes(show.tmdbId)
      done++
    } catch (err) {
      console.error(`air times failed for tmdb:${show.tmdbId}: ${(err as Error).message}`)
    }
  }
  return done
}

const PUSH_T = {
  fr: {
    one: 'Nouvel épisode disponible',
    many: (n: number) => `${n} nouveaux épisodes disponibles`,
    more: (n: number) => `… et ${n} autres`,
  },
  en: {
    one: 'New episode available',
    many: (n: number) => `${n} new episodes available`,
    more: (n: number) => `… and ${n} more`,
  },
}

// "New episode" push: episodes that have actually aired since the previous run,
// for followed (WATCHING) shows, grouped into one notification per subscriber.
//
// A rolling 24h window rather than a calendar day: users are spread across
// timezones, the job fires once at a fixed hour, and "aired in the last day" is
// the same set for all of them. It also means the push only ever announces an
// episode that is genuinely watchable — matching the Up Next gate.
const PUSH_WINDOW_MS = 24 * 60 * 60 * 1000

async function sendNewEpisodePushes() {
  const { sendPushToUser } = await import('../lib/push.js')
  const now = new Date()
  const since = new Date(now.getTime() - PUSH_WINDOW_MS)

  const episodes = await prisma.episode.findMany({
    where: { airsAt: { gt: since, lte: now }, season: { gt: 0 } },
    include: {
      show: {
        select: {
          name: true,
          follows: {
            where: { state: 'WATCHING', user: { pushSubscriptions: { some: {} } } },
            select: { userId: true },
          },
        },
      },
    },
  })

  const byUser = new Map<number, string[]>()
  for (const ep of episodes) {
    const label = `${ep.show.name} S${String(ep.season).padStart(2, '0')}E${String(ep.number).padStart(2, '0')}`
    for (const f of ep.show.follows) {
      byUser.set(f.userId, [...(byUser.get(f.userId) ?? []), label])
    }
  }

  const langs = new Map(
    (await prisma.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: { id: true, language: true } })).map(
      (u) => [u.id, (u.language === 'fr' ? 'fr' : 'en') as Lang],
    ),
  )

  let sent = 0
  for (const [userId, labels] of byUser) {
    const t = PUSH_T[langs.get(userId) ?? 'en']
    const title = labels.length === 1 ? t.one : t.many(labels.length)
    const body = labels.slice(0, 4).join('\n') + (labels.length > 4 ? `\n${t.more(labels.length - 4)}` : '')
    sent += await sendPushToUser(userId, { title, body, url: '/calendar' })
  }
  return { users: byUser.size, sent }
}

const reminders = await sendVerifyReminders()
const purged = await purgeExpiredTokens()
// Before the pushes: they announce episodes by airs_at, so refresh it first.
const refreshed = await refreshAirTimes().catch((err) => {
  console.error('air time refresh failed:', (err as Error).message)
  return 0
})
const pushes = await sendNewEpisodePushes().catch((err) => {
  console.error('new-episode push failed:', (err as Error).message)
  return { users: 0, sent: 0 }
})
console.log(
  `daily: ${reminders} reminder(s), ${purged} expired token(s) purged, ${refreshed} show(s) air-time refreshed, ` +
    `release push → ${pushes.sent} delivery(ies) / ${pushes.users} user(s)`,
)
await prisma.$disconnect()
