-- Air times are matched to episodes by air date, not by season/episode number.
--
-- Season numbering is one catalogue's coordinates, not a shared identity: TVmaze
-- and Trakt follow TheTVDB, which regroups seasons differently from TMDB. For
-- Futurama that is a fixed three-season offset (TheTVDB spends 8-10 on the films,
-- so the revival starts at season 11 where TMDB has 8), and every revival episode
-- was handed the exact instant of the episode three seasons earlier — TMDB's
-- S11E06, unaired, inherited "I Know What You Did Next Xmas" going out on
-- 2023-08-28T16:00Z and was displayed as having aired years ago.
--
-- The code no longer produces those rows, but it cannot repair them either:
-- `applyExactInstantsSql` only clears rows a provider has stopped vouching for,
-- and the providers still vouch for the key. So they are reset here, back to the
-- show's broadcast slot or to the coarse origin-country bound, exactly as
-- `resolveAirsAtSql` would. The next sync of each show re-enriches them, now
-- matched on the date.

-- Episodes TMDB does not date can no longer take an instant at all, and
-- `resolveAirsAtSql` skips them, so nothing else would ever clear these.
UPDATE episodes
SET airs_at = NULL, airs_at_source = NULL
WHERE airs_at_source IN ('TRAKT', 'TVMAZE')
  AND air_date IS NULL;

UPDATE episodes e
SET
  airs_at = CASE
    WHEN s.airs_time IS NOT NULL AND s.airs_timezone IS NOT NULL
      THEN (e.air_date + s.airs_time::time) AT TIME ZONE s.airs_timezone
    ELSE (e.air_date + interval '1 day') AT TIME ZONE COALESCE(tz.zone, 'Etc/GMT+12')
  END,
  airs_at_source = CASE
    WHEN s.airs_time IS NOT NULL AND s.airs_timezone IS NOT NULL THEN 'SCHEDULE'::"AirsAtSource"
    ELSE 'FALLBACK'::"AirsAtSource"
  END
FROM shows s
LEFT JOIN (VALUES
    ('US', 'America/Los_Angeles'),
    ('CA', 'America/Vancouver'),
    ('MX', 'America/Tijuana'),
    ('BR', 'America/Rio_Branco'),
    ('AR', 'America/Argentina/Buenos_Aires'),
    ('CL', 'America/Santiago'),
    ('CO', 'America/Bogota'),
    ('GB', 'Europe/London'),
    ('IE', 'Europe/Dublin'),
    ('PT', 'Atlantic/Azores'),
    ('ES', 'Atlantic/Canary'),
    ('FR', 'Europe/Paris'),
    ('BE', 'Europe/Brussels'),
    ('NL', 'Europe/Amsterdam'),
    ('DE', 'Europe/Berlin'),
    ('AT', 'Europe/Vienna'),
    ('CH', 'Europe/Zurich'),
    ('IT', 'Europe/Rome'),
    ('DK', 'Europe/Copenhagen'),
    ('NO', 'Europe/Oslo'),
    ('SE', 'Europe/Stockholm'),
    ('FI', 'Europe/Helsinki'),
    ('IS', 'Atlantic/Reykjavik'),
    ('PL', 'Europe/Warsaw'),
    ('CZ', 'Europe/Prague'),
    ('HU', 'Europe/Budapest'),
    ('RO', 'Europe/Bucharest'),
    ('GR', 'Europe/Athens'),
    ('RU', 'Europe/Kaliningrad'),
    ('UA', 'Europe/Kyiv'),
    ('TR', 'Europe/Istanbul'),
    ('IL', 'Asia/Jerusalem'),
    ('ZA', 'Africa/Johannesburg'),
    ('NG', 'Africa/Lagos'),
    ('IN', 'Asia/Kolkata'),
    ('CN', 'Asia/Shanghai'),
    ('HK', 'Asia/Hong_Kong'),
    ('TW', 'Asia/Taipei'),
    ('JP', 'Asia/Tokyo'),
    ('KR', 'Asia/Seoul'),
    ('TH', 'Asia/Bangkok'),
    ('PH', 'Asia/Manila'),
    ('ID', 'Asia/Jakarta'),
    ('AU', 'Australia/Perth'),
    ('NZ', 'Pacific/Auckland')
  ) AS tz(country, zone) ON tz.country = s.origin_country
WHERE s.tmdb_id = e.show_tmdb_id
  AND e.airs_at_source IN ('TRAKT', 'TVMAZE')
  AND e.air_date IS NOT NULL;

-- Send every show back through the air-time backfill, never-enriched first, so
-- the exact instants come back without waiting for someone to open each one.
UPDATE shows SET airs_cached_at = NULL;
