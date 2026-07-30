// In-container schedule for the daily job, so a plain `docker compose up`
// gets release pushes and verification reminders without the operator wiring a
// cron entry on the host.
//
// Opt-in through DAILY_JOB_AT ("HH:MM", container local time). One variable
// carries both the switch and the time: absent means the schedule is off, and
// an instance already driving `node dist/jobs/daily.js` from cron or a systemd
// timer simply never sets it. Setting both would send every release push twice.
//
// Runs in the app process, so one instance per deployment. Scaling the app to
// several replicas would schedule it once per replica: drive it externally in
// that case and leave DAILY_JOB_AT unset.
import type { FastifyInstance } from 'fastify'
import { runDailyJob } from '../jobs/daily.js'

const CHECK_INTERVAL_MS = 30_000

/** Starts the daily schedule when DAILY_JOB_AT is set. No-op otherwise. */
export function startDailySchedule(app: FastifyInstance): void {
  const raw = process.env.DAILY_JOB_AT?.trim()
  if (!raw) return

  const parsed = /^(\d{1,2}):(\d{2})$/.exec(raw)
  const hour = Number(parsed?.[1])
  const minute = Number(parsed?.[2])
  if (!parsed || hour > 23 || minute > 59) {
    app.log.error(`DAILY_JOB_AT is not a valid HH:MM time: "${raw}". Daily job not scheduled.`)
    return
  }

  const targetOn = (day: Date) => {
    const t = new Date(day)
    t.setHours(hour, minute, 0, 0)
    return t
  }

  // Starting after today's slot means today either already ran or was missed
  // while the container was down. Neither is worth a catch-up: cron doesn't do
  // one either, and re-running would push today's releases a second time.
  const startedAt = new Date()
  let lastRunDay = startedAt >= targetOn(startedAt) ? startedAt.toDateString() : ''

  let running = false
  const tick = async () => {
    const now = new Date()
    const day = now.toDateString()
    // Fires on the first tick at or past the slot rather than on an exact
    // minute match, so a late or skipped tick can't lose the run for the day.
    if (running || day === lastRunDay || now < targetOn(now)) return
    lastRunDay = day
    running = true
    try {
      await runDailyJob(app.log)
    } catch (err) {
      app.log.error(`daily job failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
    }
  }

  // unref: the schedule must never be the reason the process stays alive.
  setInterval(() => void tick(), CHECK_INTERVAL_MS).unref()
  app.log.info(`daily job scheduled at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (container time)`)
}
