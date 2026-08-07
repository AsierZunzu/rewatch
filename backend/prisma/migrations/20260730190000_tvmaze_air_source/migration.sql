-- TVmaze joins Trakt as a source of exact per-episode instants.
--
-- Additive only: existing rows keep their source, and the value is not used
-- anywhere in this migration (Postgres forbids reading a freshly added enum
-- label in the transaction that added it).
ALTER TYPE "AirsAtSource" ADD VALUE 'TVMAZE';
