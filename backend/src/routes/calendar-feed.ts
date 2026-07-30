// Read-only .ics feed of upcoming episodes, for calendar apps and Home
// Assistant. Addressed by an opaque per-user token rather than a session,
// because subscribers fetch it unattended with no way to log in.
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { localizeEpisodes, localizeShows } from '../lib/catalog.js'
import { buildCalendar, type IcsEvent } from '../lib/ics.js'
import { getSetting } from '../lib/settings.js'

// Fixed window. Far enough back that a client syncing weekly keeps recent
// context, far enough forward to cover everything TMDB has actually scheduled,
// without turning the feed into the user's whole history.
const PAST_DAYS = 14
const FUTURE_DAYS = 90

const epCode = (season: number, number: number) =>
  `S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`

/** Host of the configured public URL, used to keep event UIDs unique across
 *  instances someone might subscribe to at once. */
function uidHost(): string {
  const appUrl = getSetting('APP_URL')
  if (!appUrl) return 'rewatch'
  try {
    return new URL(appUrl).host
  } catch {
    return 'rewatch'
  }
}

export default async function calendarFeedRoutes(app: FastifyInstance) {
  // The token alone, so the client can build the URL against the origin it is
  // already browsing. Nothing here depends on APP_URL being set correctly.
  app.get('/api/calendar-feed', { preHandler: app.requireAuth }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.id },
      select: { calendarToken: true },
    })
    return { token: user?.calendarToken ?? null }
  })

  // Create or rotate. Rotating is the revoke-and-replace path: the previous URL
  // stops resolving the moment this returns.
  app.post('/api/calendar-feed', { preHandler: app.requireAuth }, async (request) => {
    const token = randomBytes(24).toString('base64url')
    await prisma.user.update({ where: { id: request.user!.id }, data: { calendarToken: token } })
    return { token }
  })

  app.delete('/api/calendar-feed', { preHandler: app.requireAuth }, async (request) => {
    await prisma.user.update({ where: { id: request.user!.id }, data: { calendarToken: null } })
    return { token: null }
  })

  // Public: the token is the credential. Unknown tokens are a plain 404, which
  // is also what a revoked one becomes.
  app.get('/api/calendar/:token.ics', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (!token) return reply.code(404).send({ error: 'not_found' })

    const user = await prisma.user.findUnique({
      where: { calendarToken: token },
      select: { id: true, language: true },
    })
    if (!user) return reply.code(404).send({ error: 'not_found' })

    const today = new Date(new Date().toDateString())
    const episodes = await prisma.episode.findMany({
      where: {
        airDate: {
          gte: new Date(today.getTime() - PAST_DAYS * 86_400_000),
          lte: new Date(today.getTime() + FUTURE_DAYS * 86_400_000),
        },
        season: { gt: 0 },
        show: { follows: { some: { userId: user.id, state: { not: 'ARCHIVED' } } } },
      },
      include: { show: { select: { tmdbId: true, name: true } } },
      orderBy: [{ airDate: 'asc' }, { showTmdbId: 'asc' }, { number: 'asc' }],
    })

    const localized = await localizeEpisodes(episodes, user.language)
    const showNames = new Map(
      (await localizeShows(episodes.map((e) => e.show), user.language)).map((s) => [s.tmdbId, s.name]),
    )

    const host = uidHost()
    const appUrl = getSetting('APP_URL')?.replace(/\/$/, '')
    const events: IcsEvent[] = localized
      .filter((e) => e.airDate !== null)
      .map((e) => ({
        uid: `rewatch-episode-${e.id}@${host}`,
        date: e.airDate!,
        summary: `${showNames.get(e.show.tmdbId) ?? e.show.name} ${epCode(e.season, e.number)}`,
        description: e.name ?? undefined,
        url: appUrl ? `${appUrl}/show/${e.show.tmdbId}` : undefined,
      }))

    reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="rewatch.ics"')
      // The token is the only thing guarding this: never let a shared cache
      // hold a copy.
      .header('Cache-Control', 'private, max-age=900')
    return buildCalendar({ name: 'Rewatch', events })
  })
}
