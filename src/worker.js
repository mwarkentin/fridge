// The fridge: a private gallery of the kids' art. This Worker checks who's
// asking (auth.js), then serves the page (public/), a small JSON API for it
// and the importer, and the scans themselves from the ART bucket.

import { canChangeKid, canSee, identify, isArtistOf, isOwner, kidAddresses, readFamilies, readNames, sameName, seesEverything, seesFamily, viewable, viewedAs } from './auth.js';

const MAX_UPLOAD = 90 * 1024 * 1024; // under the Workers plan's 100 MB request limit
const ORIGINAL_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif', 'image/webp': '.webp', 'image/tiff': '.tif', 'image/gif': '.gif', 'application/pdf': '.pdf' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => {
  throw new HttpError(400, message);
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};
function secure(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    return secure(await handle(request, env));
  },
};

// The one thing anyone may fetch without signing in: the app icons. iOS
// fetches Home Screen icons from a system process that doesn't have the
// sign-in cookie, so behind Access it gets the sign-in page and shows a
// letter instead. These files are public in the GitHub repo anyway, and
// infra's Access settings bypass this path too. Only plain file names in
// public/icons/, only to look at.
const PUBLIC_ICON = /^\/icons\/[a-z0-9-]+\.(?:png|svg)$/;

async function handle(request, env) {
  const { pathname } = new URL(request.url);
  if (PUBLIC_ICON.test(pathname) && (request.method === 'GET' || request.method === 'HEAD')) return env.ASSETS.fetch(request);

  let who;
  try {
    who = await identify(request, env);
  } catch (e) {
    console.error('sign-in check failed', e);
    return text('Couldn’t check your sign-in just now. Try again in a minute.', 503);
  }
  if (!who) return text('Sign in to see the fridge.', 403);

  const url = new URL(request.url);
  try {
    who = viewAs(request, env, who);
    if (who.viewing) readOnly(request, url, who);
    if (url.pathname.startsWith('/api/')) return await api(request, env, who, url);
    const img = url.pathname.match(/^\/img\/(\d+)\/(thumb|display|original)$/);
    if (img) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Images can only be fetched.');
      return await image(env, who, Number(img[1]), img[2]);
    }
    return await env.ASSETS.fetch(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('request failed', e);
    return json({ error: 'Something went wrong on the fridge’s side. Try again.' }, 500);
  }
}

async function api(request, env, who, url) {
  const { method } = request;
  const path = url.pathname;
  // Changes need a header a form on another site can't send, so a page
  // elsewhere can't post to the fridge with a family member's sign-in.
  if (method !== 'GET' && method !== 'HEAD' && request.headers.get('X-Requested-With') !== 'fridge') {
    throw new HttpError(403, 'Changes have to come from the fridge’s own page or importer.');
  }
  if (method === 'GET' && path === '/api/session') return json(session(env, who));
  if (path === '/api/view-as') return viewAsRoute(request, env, who);
  if (method === 'GET' && path === '/api/gallery') return json(await gallery(env, who));
  // Comments and stickers are for everyone signed in, with their own rules.
  const talked = await talk(request, env, who, url);
  if (talked) return talked;

  if (!who.canEdit && !who.artist) throw new HttpError(403, 'Only parents can change what’s on the fridge.');
  let m;
  // What the importer and the survey already know: pieces on the fridge
  // (`hashes`), and pieces a parent chose not to import (`skipped`). The
  // importer's, so parents' only.
  if ((path === '/api/imported' || path === '/api/skipped') && !who.canEdit) throw new HttpError(403, 'Only parents can import.');
  if (method === 'GET' && path === '/api/imported') {
    const [imported, skipped] = await env.DB.batch([
      env.DB.prepare('SELECT source_hash FROM pieces WHERE source_hash IS NOT NULL'),
      env.DB.prepare('SELECT source_hash FROM skipped'),
    ]);
    return json({ hashes: imported.results.map((r) => r.source_hash), skipped: skipped.results.map((r) => r.source_hash) });
  }
  if (method === 'POST' && path === '/api/skipped') return json(await recordSkipped(env, who, await body(request)));
  if (method === 'POST' && path === '/api/pieces') return await addPiece(env, who, request);
  if ((m = path.match(/^\/api\/pieces\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const fields = pieceFields(await body(request), true);
      const piece = await pieceOwner(env, who, id);
      mayChange(who, piece);
      // Moving it to another kid needs rights over both.
      if ('kid_id' in fields && fields.kid_id !== piece.kid.id) mayAddFor(who, await kidById(env, who, fields.kid_id));
      await update(env, 'pieces', id, fields);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      mayChange(who, await pieceOwner(env, who, id));
      await deletePiece(env, id);
      return new Response(null, { status: 204 });
    }
  }
  throw new HttpError(404, 'There’s nothing at that address.');
}

// What the page needs to know about who's looking. `owner`, there only for
// an owner, says they may view the fridge as someone else; while they are, everything else is that
// person's, and `viewing` says whom, by name.
function session(env, who) {
  const out = { email: who.email, canEdit: who.canEdit, families: who.families, artist: who.artist };
  if (who.viewing || isOwner(env, who)) out.owner = true;
  if (who.viewing) out.viewing = { name: who.viewing.name, detail: who.viewing.detail, as: who.viewing.as };
  return out;
}

// ---- Viewing as someone else ----
// An owner (ADMINS, auth.js) can see the fridge exactly as someone else
// would: their kids, art, pictures, comments, stickers and names, through
// the same canSee and namesFor, because `who` is the one that person would
// have signed in themselves. It's remembered in a cookie for an hour, so the
// pictures follow it too, and only an owner's own sign-in makes it count:
// anyone else's is ignored, whatever it says. While it's on, nothing
// changes (readOnly), so nothing about the person viewed moves either: not
// their last visit, nor what's new for them.
const VIEW_COOKIE = '__Host-fridge-view-as';
const VIEW_SECONDS = 3600;
const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

function viewCookie(request) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === VIEW_COOKIE) return v.join('=');
  }
  return null;
}
// The person someone's viewing as, from the cookie: { email, as } until it
// expires, else null.
function readViewCookie(request, now = Date.now()) {
  const raw = viewCookie(request);
  const m = raw && raw.match(/^(\d{10,13})\.([A-Za-z0-9_-]+)$/);
  if (!m || Number(m[1]) < now || Number(m[1]) > now + VIEW_SECONDS * 1000 + 60_000) return null;
  try {
    const [email, as] = JSON.parse(unb64url(m[2]));
    return typeof email === 'string' && (as === null || typeof as === 'string') ? { email, as } : null;
  } catch {
    return null;
  }
}
const setViewCookie = (value, seconds) => `${VIEW_COOKIE}=${value}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;

// One of the people an owner can view as (auth.js, viewable), or null.
function findViewable(env, { email, as }) {
  return viewable(env).flatMap((g) => g.people).find((p) => p.email === String(email).trim().toLowerCase() && (p.as ?? null) === (as ?? null)) ?? null;
}

// The `who` to answer as: the person an owner is viewing as, or whoever
// signed in. A cookie from anyone but an owner, or for someone the fridge no
// longer lists, is ignored.
function viewAs(request, env, who) {
  if (!isOwner(env, who)) return who;
  const target = readViewCookie(request);
  if (!target) return who;
  let entry;
  try {
    entry = findViewable(env, target);
  } catch (e) {
    console.error('view as', e);
    return who;
  }
  return entry ? viewedAs(env, who.email, entry) : who;
}

// While viewing as someone, every change is refused here, before any route
// runs: the only one that goes through is stopping. The importer's routes
// are refused too, even to read.
function readOnly(request, url, who) {
  const { method } = request;
  if (url.pathname === '/api/view-as' && method === 'DELETE') return;
  const importer = url.pathname === '/api/imported' || url.pathname === '/api/skipped';
  if (importer || (method !== 'GET' && method !== 'HEAD')) throw new HttpError(403, `You’re viewing as ${who.viewing.name}; changes are off.`);
}

// GET: the people an owner can view as. POST { email, as }: start viewing as
// one of them. DELETE: stop, for anyone, since it only clears the cookie.
async function viewAsRoute(request, env, who) {
  const { method } = request;
  if (method === 'DELETE') return new Response(null, { status: 204, headers: { 'Set-Cookie': setViewCookie('', 0), 'Cache-Control': 'no-store' } });
  const owner = who.viewing ? true : isOwner(env, who);
  if (!owner) throw new HttpError(403, 'Only the fridge’s owners can view it as someone else.');
  if (method === 'GET') {
    try {
      return json({ groups: viewable(env), viewing: who.viewing ? { email: who.email, as: who.viewing.as } : null });
    } catch (e) {
      console.error('view as', e);
      throw new HttpError(503, 'The fridge’s list of people can’t be read just now.');
    }
  }
  if (method !== 'POST') throw new HttpError(405, 'That can’t be done at that address.');
  const b = await body(request);
  if (typeof b.email !== 'string' || (b.as != null && typeof b.as !== 'string')) bad('Say whom to view as: email, and as for a shared sign-in.');
  const entry = findViewable(env, { email: b.email, as: b.as ?? null });
  if (!entry) bad('That isn’t someone the fridge lets in.');
  const value = `${Date.now() + VIEW_SECONDS * 1000}.${b64url(JSON.stringify([entry.email, entry.as]))}`;
  return Response.json({ viewing: { name: entry.name, detail: entry.detail, as: entry.as } }, { headers: { 'Set-Cookie': setViewCookie(value, VIEW_SECONDS), 'Cache-Control': 'no-store' } });
}

// The families, kids and pieces this person sees (canSee): for someone who
// sees only some families, the rest aren't there, so neither are their tags,
// their place on the timeline, nor Frame's slides. `mine` lists the pieces an
// artist added, which they can change.
async function gallery(env, who) {
  const families = readFamilies(env);
  const kids = (await syncKids(env, families)).map((k) => ({ ...k, family: familyOf(families, k) })).filter((k) => canSee(who, k));
  const seen = new Set(kids.map((k) => k.id));
  const rows = (
    await env.DB.prepare(
      'SELECT id, kid_id, made, made_precision, title, story, medium, tags, favourite, width, height, source_name, created_at FROM pieces ORDER BY made DESC, id DESC',
    ).all()
  ).results.filter((p) => seen.has(p.kid_id));
  const pieces = rows.map(({ tags, favourite, ...p }) => ({ ...p, tags: JSON.parse(tags), favourite: Boolean(favourite) }));
  const mine = who.artist ? (await env.DB.prepare('SELECT id FROM pieces WHERE added_by = ?').bind(who.email).all()).results.map((r) => r.id) : [];
  return { kids, pieces, families: families.filter((f) => seesFamily(who, f.id)).map(({ id, name }) => ({ id, name })), mine };
}

// ---- Validation ----
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
function str(v, max, label) {
  if (typeof v !== 'string') bad(`${label} must be text.`);
  if (v.length > max) bad(`${label} can be at most ${max} characters.`);
  return v.trim();
}
function int(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(`${label} must be a positive whole number.`);
  return n;
}

function pieceFields(b, partial) {
  const out = {};
  const has = (k) => !partial || k in b;
  if (has('kid_id')) out.kid_id = int(b.kid_id, 'kid_id');
  if (has('made')) {
    if (!validDate(b.made)) bad('The date it was made must look like 2024-05-29.');
    out.made = b.made;
  }
  if ('made_precision' in b) {
    if (!['day', 'month', 'year'].includes(b.made_precision)) bad('made_precision must be day, month or year.');
    out.made_precision = b.made_precision;
  }
  if ('title' in b) out.title = str(b.title, 200, 'Title');
  if ('story' in b) out.story = str(b.story, 2000, 'What they said');
  if ('medium' in b) out.medium = b.medium == null ? null : str(b.medium, 60, 'Medium') || null;
  if ('tags' in b) {
    if (!Array.isArray(b.tags) || b.tags.length > 20) bad('Tags must be a list of at most 20.');
    out.tags = JSON.stringify([...new Set(b.tags.map((t) => str(t, 40, 'A tag').toLowerCase()).filter(Boolean))]);
  }
  if ('favourite' in b) out.favourite = b.favourite ? 1 : 0;
  return out;
}

async function body(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) bad('Send JSON.');
  let b;
  try {
    b = await request.json();
  } catch {
    bad('That isn’t valid JSON.');
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) bad('Send a JSON object.');
  return b;
}

// ---- Families ----
// A kid's family is the one FAMILIES lists them in, by name, or null. So a
// kid the file doesn't list, or a family taken out of FAMILIES, or FAMILIES
// taken away, leaves those kids to every parent, as before families.
const familyOf = (families, kid) => families.find((f) => f.kids.some((k) => sameName(k.name, kid.name)))?.id ?? null;

// The kids on the fridge, after making them match the kids in FAMILIES: a
// kid it lists who isn't here yet is added, and a changed birthday or
// spelling is copied over. A kid is matched by name or, when renamed there,
// by birthday (when exactly one kid here that it no longer lists has that
// birthday, and exactly one new name does). Kids here that it doesn't list
// stay, with their art, in no family. Kids are never added or changed any
// other way, so infra's file is where they're looked after.
async function syncKids(env, families) {
  const read = async () => (await env.DB.prepare('SELECT id, name, born FROM kids ORDER BY born, id').all()).results;
  const rows = await read();
  const listed = families.flatMap((f) => f.kids);
  const isListed = (row) => listed.some((k) => sameName(k.name, row.name));
  const isHere = (kid) => rows.some((r) => sameName(r.name, kid.name));
  const changes = [];
  for (const kid of listed) {
    let row = rows.find((r) => sameName(r.name, kid.name));
    if (!row) {
      const was = rows.filter((r) => !isListed(r) && r.born === kid.born);
      const twins = listed.filter((k) => !isHere(k) && k.born === kid.born);
      if (was.length === 1 && twins.length === 1) row = was[0];
    }
    if (!row) {
      // Only if it's still not here, in case another request added it first.
      changes.push(env.DB.prepare('INSERT INTO kids (name, born) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM kids WHERE name = ?1 COLLATE NOCASE)').bind(kid.name, kid.born));
    } else if (row.name !== kid.name || row.born !== kid.born) {
      changes.push(env.DB.prepare('UPDATE kids SET name = ?, born = ? WHERE id = ?').bind(kid.name, kid.born, row.id));
    }
  }
  if (!changes.length) return rows;
  await env.DB.batch(changes);
  return read();
}

async function findKid(env, id) {
  const kid = await env.DB.prepare('SELECT id, name FROM kids WHERE id = ?').bind(id).first();
  return kid && { ...kid, family: familyOf(readFamilies(env), kid) };
}
// The kid with that id, or a 400: they were named in what was sent. A kid
// this person doesn't see (canSee) isn't there for them either.
async function kidById(env, who, id) {
  const kid = await findKid(env, id);
  if (!kid || !canSee(who, kid)) bad('There’s no kid with that id.');
  return kid;
}

// ---- Who sees what ----
// canSee (auth.js) decides; these apply it. Someone who sees only some
// families gets the same answer about the others' kids, pieces, pictures,
// comments and stickers as about ones that aren't on the fridge at all:
// a 404 where a piece is named, and nothing in a list.

// The kids this person sees, by id, each with their family, and `only`:
// their ids as JSON, to bind for SQL (seenSql), or null for someone who sees
// every kid.
async function seenKids(env, who) {
  const families = readFamilies(env);
  const rows = (await env.DB.prepare('SELECT id, name FROM kids').all()).results;
  const kids = new Map(rows.map((k) => [k.id, { ...k, family: familyOf(families, k) }]).filter(([, k]) => canSee(who, k)));
  return { kids, only: seesEverything(who) ? null : JSON.stringify([...kids.keys()]) };
}
// A WHERE condition keeping the rows of pieces (`p`) this person sees, with
// seenKids' `only` bound to parameter n.
const seenSql = (n) => `(?${n} IS NULL OR p.kid_id IN (SELECT value FROM json_each(?${n})))`;

// A piece's kid, and who added it, or null if it isn't on the fridge or this
// person doesn't see it.
async function seenPiece(env, who, pieceId) {
  const row = await env.DB.prepare('SELECT kid_id, added_by FROM pieces WHERE id = ?').bind(pieceId).first();
  const kid = row && (await findKid(env, row.kid_id));
  return kid && canSee(who, kid) ? { kid, addedBy: row.added_by } : null;
}
// The same, or a 404.
async function pieceOwner(env, who, pieceId) {
  const piece = await seenPiece(env, who, pieceId);
  if (!piece) throw new HttpError(404, 'That isn’t on the fridge.');
  return piece;
}

// The rules (auth.js), as refusals. A parent can add and change a kid's art
// when the kid is in their family or none; an artist can add their own art,
// and change only the pieces they added.
const refusal = (who, kid) =>
  new HttpError(403, who.artist ? 'You can add your own art, and change only the pieces you added yourself.' : `${kid.name} is in another family. Only their family’s parents can change ${kid.name} or their art.`);
function mayAddFor(who, kid) {
  if (!canChangeKid(who, kid) && !isArtistOf(who, kid)) throw refusal(who, kid);
}
function mayChange(who, { kid, addedBy }) {
  if (!canChangeKid(who, kid) && !(isArtistOf(who, kid) && addedBy === who.email)) throw refusal(who, kid);
}


// Column names come from the fields functions above, never from the request.
async function update(env, table, id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) bad('Nothing to change.');
  const stamp = table === 'pieces' ? ", updated_at = datetime('now')" : '';
  const res = await env.DB.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}${stamp} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'That isn’t on the fridge.');
}

// ---- Changes ----
const keyFor = (id, variant) => `pieces/${id}/${variant}`;

// multipart/form-data: `meta` (JSON: kid_id, made and the other fields, plus
// width and height of the display copy, and optionally source_hash and
// source_name), and three files: `original`, and JPEG `display` and `thumb`
// copies the importer or the page has already made.
async function addPiece(env, who, request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_UPLOAD) throw new HttpError(413, 'That file is too big. The limit is 90 MB.');
  let form;
  try {
    form = await request.formData();
  } catch {
    bad('Send the piece as a form with its files.');
  }
  let meta;
  try {
    meta = JSON.parse(form.get('meta'));
  } catch {
    bad('The piece’s details are missing.');
  }
  if (!meta || typeof meta !== 'object') bad('The piece’s details are missing.');
  const fields = pieceFields(meta, false);
  mayAddFor(who, await kidById(env, who, fields.kid_id));
  const width = int(meta.width, 'width');
  const height = int(meta.height, 'height');

  const files = {};
  for (const name of ['original', 'display', 'thumb']) {
    const f = form.get(name);
    if (!f || typeof f === 'string' || !f.size) bad(`The ${name} file is missing.`);
    files[name] = f;
  }
  if (files.display.type !== 'image/jpeg' || files.thumb.type !== 'image/jpeg') bad('The display and thumbnail copies must be JPEGs.');
  if (!(files.original.type in ORIGINAL_EXT)) bad('The original must be a JPEG, PNG, HEIC, WebP, TIFF, GIF or PDF.');

  let hash = null;
  if (meta.source_hash != null) {
    hash = str(meta.source_hash, 64, 'source_hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) bad('source_hash must be a SHA-256 in hex.');
    const dup = await env.DB.prepare('SELECT id FROM pieces WHERE source_hash = ?').bind(hash).first();
    if (dup) return json({ id: dup.id, duplicate: true });
  }
  const sourceName = meta.source_name == null ? null : str(meta.source_name, 400, 'source_name');

  const row = await env.DB.prepare(
    `INSERT INTO pieces (kid_id, made, made_precision, title, story, medium, tags, favourite, width, height, original_type, source_hash, source_name, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(fields.kid_id, fields.made, fields.made_precision ?? 'day', fields.title ?? '', fields.story ?? '', fields.medium ?? null, fields.tags ?? '[]', fields.favourite ?? 0, width, height, files.original.type, hash, sourceName, who.email)
    .first();
  try {
    await Promise.all([
      env.ART.put(keyFor(row.id, 'original'), files.original, { httpMetadata: { contentType: files.original.type } }),
      env.ART.put(keyFor(row.id, 'display'), files.display, { httpMetadata: { contentType: 'image/jpeg' } }),
      env.ART.put(keyFor(row.id, 'thumb'), files.thumb, { httpMetadata: { contentType: 'image/jpeg' } }),
    ]);
  } catch (e) {
    await env.ART.delete(['original', 'display', 'thumb'].map((v) => keyFor(row.id, v)));
    await env.DB.prepare('DELETE FROM pieces WHERE id = ?').bind(row.id).run();
    throw e;
  }
  // Imported after all: it's no longer a skipped piece.
  if (hash) await env.DB.prepare('DELETE FROM skipped WHERE source_hash = ?').bind(hash).run();
  return json({ id: row.id }, 201);
}

// { add: [hash...], remove: [hash...] }: remember pieces a parent chose not
// to import, or forget that choice.
const HASH = /^[0-9a-f]{64}$/;
async function recordSkipped(env, who, b) {
  const lists = {};
  for (const key of ['add', 'remove']) {
    const list = b[key] ?? [];
    if (!Array.isArray(list) || list.length > 5000 || !list.every((h) => typeof h === 'string' && HASH.test(h))) {
      bad(`${key} must be a list of at most 5000 SHA-256 hashes in hex.`);
    }
    lists[key] = [...new Set(list)];
  }
  const statements = [
    ...lists.add.map((h) => env.DB.prepare('INSERT OR IGNORE INTO skipped (source_hash, skipped_by) VALUES (?, ?)').bind(h, who.email)),
    ...lists.remove.map((h) => env.DB.prepare('DELETE FROM skipped WHERE source_hash = ?').bind(h)),
  ];
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  return { added: lists.add.length, removed: lists.remove.length };
}

// Its comments and stickers go with it.
async function deletePiece(env, id) {
  const [, , res] = await env.DB.batch([
    env.DB.prepare('DELETE FROM comments WHERE piece_id = ?').bind(id),
    env.DB.prepare('DELETE FROM stickers WHERE piece_id = ?').bind(id),
    env.DB.prepare('DELETE FROM pieces WHERE id = ?').bind(id),
  ]);
  if (!res.meta.changes) throw new HttpError(404, 'That isn’t on the fridge.');
  await env.ART.delete(['original', 'display', 'thumb'].map((v) => keyFor(id, v)));
}

// ---- Comments and stickers ----
// Everyone signed in can comment on any piece and give it stickers, in
// either family: grandparents, the kids' iPads, the kids and the parents.
// Authors edit and delete their own comments. A parent can also remove
// anyone's comment on art they could change (canChangeKid: their family's
// kids, and kids in no family), but not reword it. Stickers are only ever
// taken back by whoever gave them.
//
// Names come from infra, like everything else about who's who: a kid's own
// addresses (FAMILIES' artist and devices) are that kid, and NAMES names
// everyone else (auth.js, readNames), as whoever's looking knows them: a
// parent's own family sees "Mom", everyone else "Aunt Pine". On a sign-in
// two people share, every comment and sticker says which of them it's from
// (`as`, the name everyone sees), and anything one of them can do, the
// other can too: the fridge can't tell them apart. Someone NAMES doesn't
// list shows as the part of their address before the @. The page gets
// names, never addresses.
//
// Someone who sees only some families (SEES) gets nothing about the others:
// no comments or stickers on their art, nor counts, nor a place in Latest
// comments. What the others' people say on art they do see is there, from
// FAMILY: never a kid's name they don't see, nor a hidden family's parents'
// names, which can carry one ("Cy's mum").
const STICKERS = ['heart', 'star', 'wow', 'smile', 'rainbow'];
const COMMENT_MAX = 500; // characters: a few sentences
const RATE_COUNT = 10; // comments per sign-in...
const RATE_MINUTES = 10; // ...in this many minutes
const PIECE_MAX = 200; // comments a piece can hold
const COMMENT_COLS = 'id, piece_id, author, name, body, created_at, edited_at';
const FAMILY = 'Family'; // who someone is, to a person who doesn't see their family

async function talk(request, env, who, url) {
  const { method } = request;
  const path = url.pathname;
  if (!/^\/api\/(comments|me|pieces\/\d+\/(comments|stickers\/[a-z]+))(\/\d+)?$/.test(path)) return null;
  try {
    readNames(env);
  } catch (e) {
    console.error('NAMES', e);
    throw new HttpError(503, 'The fridge’s list of names can’t be read, so comments are off until it’s fixed.');
  }
  let m;
  if (path === '/api/comments') {
    if (method === 'GET') return json(await talkSummary(env, who));
  } else if (path === '/api/me') {
    if (method === 'PATCH') return json(await changeMe(env, who, await body(request)));
  } else if ((m = path.match(/^\/api\/pieces\/(\d+)\/comments$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return json(await pieceTalk(env, who, id));
    if (method === 'POST') return json({ comment: await addComment(env, who, id, await body(request)) }, 201);
  } else if ((m = path.match(/^\/api\/comments\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') return json({ comment: await editComment(env, who, id, await body(request)) });
    if (method === 'DELETE') {
      await removeComment(env, who, id);
      return new Response(null, { status: 204 });
    }
  } else if ((m = path.match(/^\/api\/pieces\/(\d+)\/stickers\/([a-z]+)$/))) {
    if (method === 'POST' || method === 'DELETE') return json({ stickers: await setSticker(env, who, Number(m[1]), m[2], method === 'POST', url.searchParams.get('as')) });
  } else return null;
  throw new HttpError(405, 'That can’t be done at that address.');
}

// Which person on a shared sign-in is speaking (`as`, their name everyone
// sees), kept with what they say. Anyone else is just their sign-in, kept as
// '', so a name changed in NAMES shows everywhere: a kid (their address is
// theirs), someone with one name, or someone NAMES doesn't list.
function speaker(env, who, as) {
  const people = who.kid ? [] : readNames(env).get(who.email) || [];
  const given = as == null || as === '' ? null : String(as);
  if (given !== null && !who.kid && !people.some((p) => sameName(p.name, given))) throw new HttpError(403, 'That isn’t one of the names on your sign-in.');
  if (people.length < 2) return '';
  if (given === null) bad(`Say which of you this is: ${people.map((p) => p.name).join(' or ')}.`);
  return people.find((p) => sameName(p.name, given)).name;
}

// The name everyone sees for the person behind a comment or sticker, on a
// piece by a kid in `family` (an id, or null): a kid's own address is that
// kid (with their id, so the page draws their magnet); a parent is their
// family name ("Mom") on their own family's kids' art and their name
// everywhere else, to everyone, themselves included; someone with a name has
// it; and anyone else is the part of their address before the @. On a
// shared sign-in, it's the person who spoke, or, for what was said before
// NAMES listed them, all of them.
//
// To someone who sees only some families, everyone in only the others (their
// parents, kids and kids' devices) is FAMILY, and so is anyone whose name
// would say the name of a kid they don't see.
async function namesFor(env, who) {
  const kidsByAddress = kidAddresses(env);
  const names = readNames(env);
  const families = readFamilies(env);
  const kids = (await env.DB.prepare('SELECT id, name FROM kids').all()).results;
  const label = (r, family) => {
    const kidName = kidsByAddress.get(r.author);
    if (kidName) {
      const kid = kids.find((k) => sameName(k.name, kidName));
      return { name: kid?.name ?? kidName, kid_id: kid?.id ?? null };
    }
    const people = names.get(r.author) || [];
    const home = family != null && families.some((f) => f.id === family && f.parents.includes(r.author));
    const shown = (p) => (home && p.family) || p.name;
    const spoke = r.name && people.find((p) => sameName(p.name, r.name));
    return { name: spoke ? shown(spoke) : r.name || people.map(shown).join(' & ') || r.author.split('@')[0], kid_id: null };
  };
  if (seesEverything(who)) return (r, family = null) => label(r, family);
  const strangers = unseenPeople(families, who);
  const unseenKids = [...kids.filter((k) => !canSee(who, { family: familyOf(families, k) })), ...families.filter((f) => !seesFamily(who, f.id)).flatMap((f) => f.kids)].map((k) => k.name);
  return (r, family = null) => {
    const by = strangers.has(r.author) ? null : label(r, family);
    return by && !unseenKids.some((n) => mentions(by.name, n)) ? by : { name: FAMILY, kid_id: null };
  };
}

// The addresses of everyone in a family (its parents, its kids' own and
// their devices') who's in none of the families this person sees.
function unseenPeople(families, who) {
  const member = new Map();
  for (const f of families) {
    for (const address of [...f.parents, ...f.kids.flatMap((k) => [k.artist, ...k.devices])]) if (address) member.set(address, [...(member.get(address) || []), f.id]);
  }
  return new Set([...member].filter(([, ids]) => !ids.some((id) => seesFamily(who, id))).map(([address]) => address));
}

// Whether `text` has `name` in it as words, ignoring case and accents:
// "Cy’s Nana" has Cy, "Cyril" doesn't.
const words = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function mentions(text, name) {
  const t = words(text);
  const n = words(name);
  return n.length > 0 && t.some((_, i) => n.every((w, j) => t[i + j] === w));
}

// Comments as the page gets them. `kidFor` gives each one's piece's kid, for
// whether this person may remove it.
async function commentsOut(env, who, rows, kidFor) {
  const label = await namesFor(env, who);
  return rows.map((r) => {
    const kid = kidFor(r);
    const by = label(r, kid?.family);
    const mine = r.author === who.email;
    return { id: r.id, piece_id: r.piece_id, body: r.body, created_at: r.created_at, edited: r.edited_at != null, by: by.name, kid_id: by.kid_id, mine, can_remove: mine || Boolean(kid && canChangeKid(who, kid)) };
  });
}

// Each kind of sticker on a piece: how many, who gave them (first first),
// and `mine`: which people on a shared sign-in gave one (their `as`), or ''
// for anyone else's sign-in.
async function stickersOut(env, who, pieceId, kid) {
  const rows = (await env.DB.prepare('SELECT sticker, author, name FROM stickers WHERE piece_id = ? ORDER BY created_at, rowid').bind(pieceId).all()).results;
  const label = await namesFor(env, who);
  return STICKERS.map((kind) => {
    const given = rows.filter((r) => r.sticker === kind);
    return { kind, count: given.length, mine: given.filter((r) => r.author === who.email).map((r) => r.name), by: given.map((r) => label(r, kid?.family).name) };
  });
}

// The signed-in person: the people on their sign-in, each with the name
// everyone sees (`name`, what to send as `as`) and, for a parent, the one
// shown on their own families' kids' art (`home`, or null), with those
// families' ids; a kid has their kid instead. And the newest comment the
// page has shown them.
async function me(env, who) {
  const row = await env.DB.prepare('SELECT seen FROM people WHERE email = ?').bind(who.email).first();
  const by = (await namesFor(env, who))({ author: who.email, name: '' });
  const people = who.kid ? [] : readNames(env).get(who.email) || [];
  return { names: people.map((p) => ({ name: p.name, home: p.family ?? null })), families: who.families, kid: who.kid ? by.name : null, kid_id: by.kid_id, seen: row?.seen ?? null };
}

// For the whole page: comments and stickers on each piece (`newest` is the
// id of its newest comment from another sign-in, for marking it new), the
// latest comments anywhere, and the newest comment's id: all of them only on
// the pieces this person sees.
async function talkSummary(env, who) {
  const { kids, only } = await seenKids(env, who);
  const [counts, stickers, latest, newest] = await env.DB.batch([
    env.DB.prepare(`SELECT c.piece_id, COUNT(*) AS n, MAX(CASE WHEN c.author != ?1 THEN c.id END) AS other FROM comments c JOIN pieces p ON p.id = c.piece_id WHERE ${seenSql(2)} GROUP BY c.piece_id`).bind(who.email, only),
    env.DB.prepare(`SELECT s.piece_id, COUNT(*) AS n FROM stickers s JOIN pieces p ON p.id = s.piece_id WHERE ${seenSql(1)} GROUP BY s.piece_id`).bind(only),
    env.DB.prepare(`SELECT ${COMMENT_COLS.split(', ').map((c) => `c.${c}`).join(', ')}, p.kid_id FROM comments c JOIN pieces p ON p.id = c.piece_id WHERE ${seenSql(1)} ORDER BY c.id DESC LIMIT 8`).bind(only),
    env.DB.prepare(`SELECT MAX(c.id) AS id FROM comments c JOIN pieces p ON p.id = c.piece_id WHERE ${seenSql(1)}`).bind(only),
  ]);
  const byPiece = {};
  for (const r of counts.results) byPiece[r.piece_id] = { comments: r.n, stickers: 0, newest: r.other ?? 0 };
  for (const r of stickers.results) (byPiece[r.piece_id] ||= { comments: 0, stickers: 0, newest: 0 }).stickers = r.n;
  return { me: await me(env, who), newest: newest.results[0]?.id ?? 0, counts: byPiece, latest: await commentsOut(env, who, latest.results, (r) => kids.get(r.kid_id)) };
}

async function pieceTalk(env, who, pieceId) {
  const { kid } = await pieceOwner(env, who, pieceId);
  const rows = (await env.DB.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE piece_id = ? ORDER BY id`).bind(pieceId).all()).results;
  return { comments: await commentsOut(env, who, rows, () => kid), stickers: await stickersOut(env, who, pieceId, kid) };
}

// Without the characters that can hide or reorder text, with tidy line
// breaks, and not empty.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g;
function commentText(v) {
  if (typeof v !== 'string') bad('A comment must be text.');
  if (v.length > COMMENT_MAX * 4) bad(`A comment can be at most ${COMMENT_MAX} characters.`);
  const text = v.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) bad('Write something first.');
  if ([...text].length > COMMENT_MAX) bad(`A comment can be at most ${COMMENT_MAX} characters.`);
  return text;
}

async function addComment(env, who, pieceId, b) {
  const { kid } = await pieceOwner(env, who, pieceId);
  const text = commentText(b.body);
  const name = speaker(env, who, b.as);
  // In one statement, so two at once can't both slip under a limit. The
  // rate is per sign-in, shared or not.
  const row = await env.DB.prepare(
    `INSERT INTO comments (piece_id, author, name, body)
     SELECT ?1, ?2, ?7, ?3
     WHERE (SELECT COUNT(*) FROM comments WHERE author = ?2 AND created_at > datetime('now', ?4)) < ?5
       AND (SELECT COUNT(*) FROM comments WHERE piece_id = ?1) < ?6
     RETURNING ${COMMENT_COLS}`,
  )
    .bind(pieceId, who.email, text, `-${RATE_MINUTES} minutes`, RATE_COUNT, PIECE_MAX, name)
    .first();
  if (!row) {
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE piece_id = ?').bind(pieceId).first();
    if (n >= PIECE_MAX) throw new HttpError(409, `This piece has ${PIECE_MAX} comments, as many as it can hold.`);
    throw new HttpError(429, `That’s ${RATE_COUNT} comments in ${RATE_MINUTES} minutes. Have a little rest, then try again.`);
  }
  return (await commentsOut(env, who, [row], () => kid))[0];
}

// A comment and its piece's kid, or a 404: for one that isn't there, and for
// one on a piece this person doesn't see, before anything says whose it is.
async function commentRow(env, who, id) {
  const row = await env.DB.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`).bind(id).first();
  const piece = row && (await seenPiece(env, who, row.piece_id));
  if (!piece) throw new HttpError(404, 'That comment isn’t there any more.');
  return { row, kid: piece.kid };
}

// Only its author can reword a comment: nobody puts words in anyone's mouth.
// On a shared sign-in, that's either of them.
async function editComment(env, who, id, b) {
  const { row, kid } = await commentRow(env, who, id);
  if (row.author !== who.email) throw new HttpError(403, 'You can change only what you wrote yourself.');
  const text = commentText(b.body);
  if (text !== row.body) await env.DB.prepare("UPDATE comments SET body = ?, edited_at = datetime('now') WHERE id = ?").bind(text, id).run();
  return (await commentsOut(env, who, [(await commentRow(env, who, id)).row], () => kid))[0];
}

async function removeComment(env, who, id) {
  const { row, kid } = await commentRow(env, who, id);
  if (row.author !== who.email) {
    if (!canChangeKid(who, kid)) {
      throw new HttpError(403, who.canEdit ? `Only ${kid.name}’s family’s parents can remove other people’s comments on ${kid.name}’s art.` : 'You can remove only what you wrote yourself.');
    }
  }
  await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
}

async function setSticker(env, who, pieceId, kind, on, as) {
  if (!STICKERS.includes(kind)) bad('There’s no sticker like that.');
  const { kid } = await pieceOwner(env, who, pieceId);
  const name = speaker(env, who, as);
  const sql = on ? 'INSERT OR IGNORE INTO stickers (piece_id, author, name, sticker) VALUES (?, ?, ?, ?)' : 'DELETE FROM stickers WHERE piece_id = ? AND author = ? AND name = ? AND sticker = ?';
  await env.DB.prepare(sql).bind(pieceId, who.email, name, kind).run();
  return stickersOut(env, who, pieceId, kid);
}

// { seen }: the newest comment the page has shown this sign-in. Names are
// infra's (NAMES), so there's nothing else to change here.
async function changeMe(env, who, b) {
  if (!('seen' in b)) bad('Nothing to change. Names come from the fridge’s settings in infra.');
  const seen = Number(b.seen);
  if (!Number.isInteger(seen) || seen < 0 || typeof b.seen !== 'number') bad('seen must be a comment’s id.');
  await env.DB.prepare("INSERT INTO people (email, seen) VALUES (?1, ?2) ON CONFLICT (email) DO UPDATE SET seen = max(coalesce(seen, 0), ?2), updated_at = datetime('now')").bind(who.email, seen).run();
  return { me: await me(env, who) };
}

// Someone who sees only some families gets none of the others' pictures, at
// any size or by any address: the same 404 as for a piece that isn't there.
// So each one is looked up for them; everyone else's come straight from the
// bucket, as before.
async function image(env, who, id, variant) {
  const missing = () => text('That picture isn’t on the fridge.', 404);
  if (!seesEverything(who) && !(await seenPiece(env, who, id))) return missing();
  const obj = await env.ART.get(keyFor(id, variant));
  if (!obj) return missing();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  // A piece's images never change (edits only touch its details), and ids are
  // never reused. Private: only the signed-in browser keeps them.
  // Not kept while viewing as someone, so what's shown then is only what
  // the Worker gave for them.
  headers.set('Cache-Control', who.viewing ? 'private, no-store' : 'private, max-age=31536000, immutable');
  if (variant === 'original') {
    const type = obj.httpMetadata?.contentType || '';
    headers.set('Content-Disposition', `attachment; filename="fridge-${id}${ORIGINAL_EXT[type] || ''}"`);
  }
  return new Response(obj.body, { headers });
}
