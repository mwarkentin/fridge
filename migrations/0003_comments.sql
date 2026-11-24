-- Comments and stickers on the art, from anyone signed in.
--
-- Someone signed in, by the address they sign in with: the newest comment
-- the page has shown them, so newer ones are marked new. Their names aren't
-- here: they come from infra, like everything else about who's who (NAMES
-- and FAMILIES, read in src/auth.js).
CREATE TABLE people (
  email TEXT PRIMARY KEY, -- lowercase, as auth.js has it
  seen INTEGER, -- a comments.id
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What people said about a piece. They go when the piece goes (the Worker
-- deletes them with it, and the foreign key would too). AUTOINCREMENT so an
-- id is never reused: people.seen counts on ids only growing.
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id INTEGER NOT NULL REFERENCES pieces (id) ON DELETE CASCADE,
  author TEXT NOT NULL, -- the address they signed in with
  -- Which of that address's names said it, for a sign-in two people share
  -- (like grandparents with one email), or '' for its only name, or none.
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT
);
CREATE INDEX comments_by_piece ON comments (piece_id, id);
CREATE INDEX comments_by_author ON comments (author, created_at);

-- Stickers on a piece: one of each kind per person (each name, on a shared
-- sign-in), given with a tap and taken back with another. The kinds are the
-- Worker's (STICKERS), so adding one needs no migration.
CREATE TABLE stickers (
  piece_id INTEGER NOT NULL REFERENCES pieces (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  sticker TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (piece_id, author, name, sticker)
);
