-- The kids whose art hangs on the fridge. Names and birthdays live only in
-- this database, never in the repo. Ages on each piece come from `born`.
CREATE TABLE kids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  born TEXT NOT NULL, -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per piece of art. Its images are in the ART bucket under
-- pieces/<id>/original, display and thumb. AUTOINCREMENT so a deleted piece's
-- id never comes back: browsers cache images by id for a year.
CREATE TABLE pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id INTEGER NOT NULL REFERENCES kids (id),
  -- When it was made. With only a month known it's the 15th, with only a
  -- year it's July 1st, so ages come out close; made_precision says which,
  -- and the page shows only what's known.
  made TEXT NOT NULL,
  made_precision TEXT NOT NULL DEFAULT 'day' CHECK (made_precision IN ('day', 'month', 'year')),
  title TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '', -- what the artist said about it
  medium TEXT,
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array of lowercase strings
  favourite INTEGER NOT NULL DEFAULT 0,
  -- Size of the display copy in pixels, for the page's layout.
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  original_type TEXT NOT NULL,
  -- SHA-256 of the original file, so importing a folder again skips what's
  -- already here, even if a file was renamed or moved.
  source_hash TEXT UNIQUE,
  source_name TEXT, -- where it came from, relative to the imported folder
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX pieces_by_kid ON pieces (kid_id, made);
