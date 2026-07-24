-- Episodes gain an absolute air instant, so "has it aired?" stops being decided
-- by a bare calendar date compared against now() (which unlocked an episode at
-- midnight — up to a day before it actually aired).
--
-- air_date stays: it is still what the calendar and show page display.

CREATE TYPE "AirsAtSource" AS ENUM ('TRAKT', 'SCHEDULE', 'FALLBACK');

-- Broadcast slot, in the show's own country. origin_country comes from TMDB,
-- airs_time/airs_timezone from Trakt when the instance has it configured.
ALTER TABLE "shows"
  ADD COLUMN "origin_country" TEXT,
  ADD COLUMN "airs_time" TEXT,
  ADD COLUMN "airs_timezone" TEXT,
  ADD COLUMN "airs_cached_at" TIMESTAMP(3);

ALTER TABLE "episodes"
  ADD COLUMN "airs_at" TIMESTAMPTZ(3),
  ADD COLUMN "airs_at_source" "AirsAtSource";

CREATE INDEX "episodes_show_tmdb_id_airs_at_idx" ON "episodes"("show_tmdb_id", "airs_at");

-- Local day used for calendar grouping and the "today's releases" push.
ALTER TABLE "users" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- Backfill. No show has an origin_country yet (TMDB's field was never stored)
-- and no show has a Trakt slot, so every row takes the country-less fallback:
-- end of air_date in UTC-12, the zone where a date ends later than anywhere
-- else. That is the only instant guaranteed to be after the broadcast whatever
-- the show's country, which keeps the upgrade from re-introducing the very bug
-- it fixes. It runs late — up to ~36h for a US primetime show — until the show
-- is re-cached, at which point resolveAirsAtSql() replaces this with the real
-- slot (or Trakt's exact instant) and the lateness drops to hours or zero.
UPDATE "episodes"
SET "airs_at" = ("air_date" + interval '1 day') AT TIME ZONE 'Etc/GMT+12',
    "airs_at_source" = 'FALLBACK'
WHERE "air_date" IS NOT NULL;
