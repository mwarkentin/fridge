-- Comments and stickers on the art, from anyone signed in.
--
-- Who someone is, for comments and stickers: the name they asked to be
-- called ("What should we call you?" on the page), by the address they sign
-- in with, and the newest comment the page has shown them, so newer ones are
-- marked new. Kids aren't named here: a kid's own address (FAMILIES' artist
-- and devices) is that kid. The page gets names, never addresses.
CREATE TABLE people (
  email TEXT PRIMARY KEY, -- lowercase, as auth.js has it
  name TEXT,
  seen INTEGER, -- a comments.id
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Two people can't both be "Grandma": the page would muddle them.
CREATE UNIQUE INDEX people_by_name ON people (name COLLATE NOCASE);

-- What people said about a piece. They go when the piece goes (the Worker
-- deletes them with it, and the foreign key would too). AUTOINCREMENT so an
-- id is never reused: people.seen counts on ids only growing.
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id INTEGER NOT NULL REFERENCES pieces (id) ON DELETE CASCADE,
  author TEXT NOT NULL, -- the address they signed in with
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT
);
CREATE INDEX comments_by_piece ON comments (piece_id, id);
CREATE INDEX comments_by_author ON comments (author, created_at);

-- Stickers on a piece: one of each kind per person, given with a tap and
-- taken back with another. The kinds are the Worker's (STICKERS), so adding
-- one needs no migration.
CREATE TABLE stickers (
  piece_id INTEGER NOT NULL REFERENCES pieces (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  sticker TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (piece_id, author, sticker)
);
