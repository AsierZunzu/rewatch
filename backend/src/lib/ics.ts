// Minimal RFC 5545 writer for the episode feed. Hand-rolled rather than pulled
// from a package: the feed emits one shape of all-day event and nothing else.
// https://datatracker.ietf.org/doc/html/rfc5545

/** TEXT values escape backslash, semicolon, comma and newline. Order matters. */
const escapeText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/**
 * Content lines are limited to 75 octets, continuations start with one space
 * which counts toward the limit. Splitting is done on the UTF-8 bytes, backing
 * off any cut that lands inside a multi-byte character: an accented show title
 * would otherwise reach the client as mojibake.
 */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length === 0 ? 75 : 74), bytes.length)
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    parts.push(bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return parts.join('\r\n ')
}

/** Date-only value (YYYYMMDD). air_date is a DATE column, so Prisma hands back
 *  UTC midnight: reading the UTC parts keeps the published day whatever the
 *  server's timezone is. */
const dateValue = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`

/** UTC timestamp value (YYYYMMDDTHHMMSSZ). */
const stampValue = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000)

export type IcsEvent = {
  uid: string
  /** All-day event: the calendar day the episode airs. */
  date: Date
  summary: string
  description?: string
  url?: string
}

export function buildCalendar(
  { name, events }: { name: string; events: IcsEvent[] },
  now = new Date(),
): string {
  const stamp = stampValue(now)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rewatch//Episode calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    // Both spellings: the standard property and the one Outlook and Google read.
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ]

  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `DTSTAMP:${stamp}`,
      // DTEND is exclusive for DATE values, so a one-day event ends the next day.
      `DTSTART;VALUE=DATE:${dateValue(ev.date)}`,
      `DTEND;VALUE=DATE:${dateValue(addDays(ev.date, 1))}`,
      `SUMMARY:${escapeText(ev.summary)}`,
    )
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`)
    if (ev.url) lines.push(`URL:${ev.url}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  // CRLF throughout, including the final line: RFC 5545 section 3.1.
  return lines.map(fold).join('\r\n') + '\r\n'
}
