-- Pieces a parent looked at and chose not to import (left unticked in the
-- survey's report, or answered "no" with --ask), by the same source hash as
-- pieces.source_hash. Later imports leave them out, from any computer, and
-- later surveys mark them "skipped before". Only the fingerprint is kept.
-- Importing a piece after all removes its row.
CREATE TABLE skipped (
  source_hash TEXT PRIMARY KEY,
  skipped_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
