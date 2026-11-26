-- Whether Cloudflare sent someone's last email digest (worker.js,
-- sendDigests): 'unverified' when it said no because they haven't clicked
-- Verify in its email, so their bell can tell them; NULL once one goes, and
-- before the first. Only that is kept: other refusals are the fridge's to
-- fix, not theirs.
ALTER TABLE people ADD COLUMN digest_error TEXT;
