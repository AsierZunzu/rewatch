import { describe, expect, it } from 'vitest'
import { buildCalendar } from '../../src/lib/ics.js'

const NOW = new Date('2025-06-01T12:34:56Z')

const unfold = (ics: string) => ics.replace(/\r\n /g, '')

describe('buildCalendar', () => {
  it('writes a valid empty calendar with CRLF line endings', () => {
    const ics = buildCalendar({ name: 'Rewatch', events: [] }, NOW)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('X-WR-CALNAME:Rewatch\r\n')
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('emits one all-day event per episode, DTEND exclusive', () => {
    const ics = buildCalendar(
      {
        name: 'Rewatch',
        events: [{ uid: 'ep-1@host', date: new Date('2025-12-31T00:00:00Z'), summary: 'Show S01E01', description: 'Pilot', url: 'https://x/show/1' }],
      },
      NOW,
    )
    expect(ics).toContain(
      [
        'BEGIN:VEVENT',
        'UID:ep-1@host',
        'DTSTAMP:20250601T123456Z',
        'DTSTART;VALUE=DATE:20251231',
        'DTEND;VALUE=DATE:20260101',
        'SUMMARY:Show S01E01',
        'DESCRIPTION:Pilot',
        'URL:https://x/show/1',
        'END:VEVENT',
      ].join('\r\n'),
    )
  })

  it('omits optional properties that are not set', () => {
    const ics = buildCalendar({ name: 'R', events: [{ uid: 'u', date: new Date('2025-01-01T00:00:00Z'), summary: 's' }] }, NOW)
    expect(ics).not.toContain('DESCRIPTION')
    expect(ics).not.toContain('URL:')
  })

  it('escapes TEXT values', () => {
    const ics = buildCalendar(
      { name: 'A, B; C', events: [{ uid: 'u', date: new Date('2025-01-01T00:00:00Z'), summary: 'x', description: 'line1\nback\\slash' }] },
      NOW,
    )
    expect(ics).toContain('X-WR-CALNAME:A\\, B\\; C')
    expect(ics).toContain('DESCRIPTION:line1\\nback\\\\slash')
  })

  it('folds long lines at 75 octets without splitting a multi-byte character', () => {
    const summary = 'Élite '.repeat(30)
    const ics = buildCalendar({ name: 'R', events: [{ uid: 'u', date: new Date('2025-01-01T00:00:00Z'), summary }] }, NOW)
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    expect(unfold(ics)).toContain(`SUMMARY:${summary}`)
    expect(ics).not.toContain('�')
  })
})
