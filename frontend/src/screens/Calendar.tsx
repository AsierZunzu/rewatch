import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCalendar } from '../api/hooks'
import type { CalendarEpisode } from '../api/types'
import { Poster } from '../components/Poster'
import { ScreenTitle, Spinner } from '../components/ui'
import { calendarDayLabel, clockTime, epCode, frDate } from '../lib/format'
import { knownAirInstant } from '../lib/airing'

/** The day an instant falls on for the viewer, in the same shape as the group keys. */
const localDayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export default function Calendar() {
  const { t } = useTranslation()
  const { data, isLoading } = useCalendar()

  // Group by broadcast day (days without a release simply don't exist). The
  // grouping stays on `airDate` — the schedule as the broadcaster publishes it —
  // while each row shows the instant in the viewer's zone, so a late-night US
  // slot reads "Sun · 04:00" for a European viewer rather than being filed
  // under a day nothing was announced for.
  const groups = new Map<string, CalendarEpisode[]>()
  for (const ep of data ?? []) {
    if (!ep.airDate) continue
    const key = ep.airDate.slice(0, 10)
    groups.set(key, [...(groups.get(key) ?? []), ep])
  }
  // Within a day, order by the hour when it is known; episodes without a time
  // keep the server's order (show, then episode number) behind those with one.
  for (const [day, eps] of groups) {
    groups.set(
      day,
      [...eps].sort((a, b) => {
        const [x, y] = [knownAirInstant(a), knownAirInstant(b)]
        if (!x || !y) return x ? -1 : y ? 1 : 0
        return x.getTime() - y.getTime()
      }),
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTitle title={t('calendar.title')} />
      {isLoading ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-5 px-4 pt-3.5 pb-4 lg:max-w-3xl lg:px-8">
          {[...groups.entries()].map(([day, eps]) => {
            const { label, sub, today, daysUntil } = calendarDayLabel(new Date(day))
            return (
              <div key={day} className="flex flex-col gap-2.25">
                <div className="flex items-baseline gap-2 px-1">
                  <span className={`text-sm font-extrabold tracking-wider uppercase ${today ? 'text-accent' : 'text-text'}`}>
                    {label}
                  </span>
                  {sub && <span className="text-dim text-xs font-semibold">{sub}</span>}
                  {daysUntil !== null && <span className="text-dim text-xs font-semibold">{t('calendar.daysUntil', { count: daysUntil })}</span>}
                </div>
                {eps.map((ep) => {
                  const at = knownAirInstant(ep)
                  // The local instant can land on another calendar day than the
                  // one it is filed under; when it does the weekday comes along,
                  // so the clock is never read against the wrong day.
                  const shifted = at !== null && localDayKey(at) !== day
                  return (
                    <Link
                      viewTransition
                      key={ep.id}
                      to={`/show/${ep.show.tmdbId}`}
                      className="bg-card flex items-center gap-3.25 rounded-2xl border border-line px-3 py-2.5"
                    >
                      <Poster path={ep.show.posterPath} title={ep.show.name} size="w185" className="h-[72px] w-12 rounded-[9px] text-[13px]" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.75">
                        <div className="truncate text-[15px] font-bold">{ep.show.name}</div>
                        <div className="text-muted truncate text-[13px]">
                          <span className="text-text font-bold">{epCode(ep.season, ep.number)}</span>
                          {ep.name ? ` · ${ep.name}` : ''}
                        </div>
                      </div>
                      {(at || ep.show.network) && (
                        <div className="flex flex-none flex-col items-end gap-1">
                          {at && (
                            <div className={`text-[12.5px] font-extrabold ${today ? 'text-accent' : 'text-text'}`}>
                              {shifted ? `${frDate(at, { weekday: 'short' })} · ${clockTime(at)}` : clockTime(at)}
                            </div>
                          )}
                          {ep.show.network && (
                            <div className="text-soft bg-track rounded-[7px] px-2.25 py-1.25 text-[10.5px] font-bold tracking-wide uppercase">
                              {ep.show.network}
                            </div>
                          )}
                        </div>
                      )}
                    </Link>
                  )
                })}
              </div>
            )
          })}
          <div className="text-dim pt-2 text-center text-[12.5px]">
            {groups.size === 0 ? t('calendar.noUpcoming') : t('calendar.onlyDaysWithReleases')}
          </div>
        </div>
      )}
    </div>
  )
}
