// The fridge: a private gallery of the kids' art. This Worker checks who's
// asking (auth.js), then serves the page (public/), a small JSON API for it
// and the importer, and the scans themselves from the ART bucket.

import { identify } from './auth.js';

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

async function handle(request, env) {
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
    if (url.pathname.startsWith('/api/')) return await api(request, env, who, url);
    const img = url.pathname.match(/^\/img\/(\d+)\/(thumb|display|original)$/);
    if (img) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Images can only be fetched.');
      return await image(env, Number(img[1]), img[2]);
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
  if (method === 'GET' && path === '/api/session') return json({ email: who.email, canEdit: who.canEdit });
  if (method === 'GET' && path === '/api/gallery') return json(await gallery(env));

  if (!who.canEdit) throw new HttpError(403, 'Only parents can change what’s on the fridge.');
  let m;
  if (method === 'POST' && path === '/api/kids') return json(await addKid(env, await body(request)), 201);
  if (method === 'PATCH' && (m = path.match(/^\/api\/kids\/(\d+)$/))) {
    await update(env, 'kids', Number(m[1]), kidFields(await body(request), true));
    return json({ ok: true });
  }
  if (method === 'GET' && path === '/api/imported') {
    const rows = (await env.DB.prepare('SELECT source_hash FROM pieces WHERE source_hash IS NOT NULL').all()).results;
    return json({ hashes: rows.map((r) => r.source_hash) });
  }
  if (method === 'POST' && path === '/api/pieces') return await addPiece(env, who, request);
  if ((m = path.match(/^\/api\/pieces\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const fields = pieceFields(await body(request), true);
      if ('kid_id' in fields) await kidExists(env, fields.kid_id);
      await update(env, 'pieces', id, fields);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await deletePiece(env, id);
      return new Response(null, { status: 204 });
    }
  }
  throw new HttpError(404, 'There’s nothing at that address.');
}

async function gallery(env) {
  const kids = (await env.DB.prepare('SELECT id, name, born FROM kids ORDER BY born, id').all()).results;
  const rows = (
    await env.DB.prepare(
      'SELECT id, kid_id, made, made_precision, title, story, medium, tags, favourite, width, height, source_name, created_at FROM pieces ORDER BY made DESC, id DESC',
    ).all()
  ).results;
  const pieces = rows.map(({ tags, favourite, ...p }) => ({ ...p, tags: JSON.parse(tags), favourite: Boolean(favourite) }));
  return { kids, pieces };
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

function kidFields(b, partial) {
  const out = {};
  if (!partial || 'name' in b) {
    out.name = str(b.name, 60, 'Name');
    if (!out.name) bad('Give the kid a name.');
  }
  if (!partial || 'born' in b) {
    if (!validDate(b.born)) bad('Birthday must be a date like 2018-03-14.');
    out.born = b.born;
  }
  return out;
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

async function kidExists(env, id) {
  if (!(await env.DB.prepare('SELECT 1 FROM kids WHERE id = ?').bind(id).first())) bad('There’s no kid with that id.');
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
async function addKid(env, b) {
  const { name, born } = kidFields(b, false);
  const row = await env.DB.prepare('INSERT INTO kids (name, born) VALUES (?, ?) RETURNING id').bind(name, born).first();
  return { id: row.id };
}

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
  await kidExists(env, fields.kid_id);
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
  return json({ id: row.id }, 201);
}

async function deletePiece(env, id) {
  const res = await env.DB.prepare('DELETE FROM pieces WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'That isn’t on the fridge.');
  await env.ART.delete(['original', 'display', 'thumb'].map((v) => keyFor(id, v)));
}

async function image(env, id, variant) {
  const obj = await env.ART.get(keyFor(id, variant));
  if (!obj) return text('That picture isn’t on the fridge.', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  // A piece's images never change (edits only touch its details), and ids are
  // never reused. Private: only the signed-in browser keeps them.
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (variant === 'original') {
    const type = obj.httpMetadata?.contentType || '';
    headers.set('Content-Disposition', `attachment; filename="fridge-${id}${ORIGINAL_EXT[type] || ''}"`);
  }
  return new Response(obj.body, { headers });
}
