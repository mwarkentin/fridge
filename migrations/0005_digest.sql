-- The email digest: what's new on the fridge, by email, for each sign-in
-- that asks for it (worker.js, sendDigests). It's worked out from the
-- notifications each time it goes, like the bell, so only the settings and
-- how far the last one got are kept.
--
-- digest is how often: 'daily', 'weekly' (Sunday), or NULL for never, which
-- is everyone to start with. digest_hour (0 to 23) and digest_zone (an IANA
-- time zone, like America/Toronto) say when, in their own time, and stay
-- when it's turned off, for next time. digest_at is how far the last one
-- got (the notifications' as_of), or, before the first, the time it would
-- have gone last, so the first covers the time since then.
ALTER TABLE people ADD COLUMN digest TEXT CHECK (digest IN ('daily', 'weekly'));
ALTER TABLE people ADD COLUMN digest_hour INTEGER CHECK (digest_hour BETWEEN 0 AND 23);
ALTER TABLE people ADD COLUMN digest_zone TEXT;
-- Like created_at: YYYY-MM-DD HH:MM:SS, UTC.
ALTER TABLE people ADD COLUMN digest_at TEXT;
