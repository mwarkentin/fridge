// The public preview (preview/worker.js): two made-up families, nothing
// private it could reach, and no way to change anything. It's seen as a
// parent in the first family, or with ?as=nonna as Nonna, who sees only that
// family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import preview from '../preview/worker.js';
import worker from '../src/worker.js';

const html = readFileSync('public/index.html', 'utf8');
const env = {
  ASSETS: {
    fetch: async (req) =>
      new URL(req.url).pathname === '/'
        ? new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(html)) } })
        : new Response('a file from public/', { headers: { 'Content-Type': 'text/plain' } }),
  },
};
const call = (path, init) => preview.fetch(new Request(`https://fridge-preview-pr-1.example.workers.dev${path}`, init), env);

test('has nothing to reach but the page: no bindings, no imports, no build', () => {
  const toml = readFileSync('preview/wrangler.toml', 'utf8');
  const tables = [...toml.matchAll(/^\s*\[\[?\s*([a-z0-9_.]+)\s*\]?\]/gm)].map((m) => m[1]);
  assert.deepEqual(tables, ['assets']);
  assert.doesNotMatch(toml, /^\s*(d1_databases|r2_buckets|kv_namespaces|services|vars|durable_objects|queues|routes?|secrets)\s*=/m);
  assert.match(toml, /^name = "fridge-preview"$/m);
  assert.match(toml, /^no_bundle = true$/m);
  assert.doesNotMatch(readFileSync('preview/worker.js', 'utf8'), /^\s*import\b|\bimport\s*\(/m);
});

test('serves made-up families to anyone, in the real gallery’s shape', async () => {
  const res = await call('/api/gallery');
  assert.equal(res.status, 200);
  const { families, kids, pieces } = await res.json();
  // Oldest first, as the real Worker sorts them, so the families interleave.
  assert.deepEqual(kids.map((k) => k.name), ['Ada', 'Cy', 'Bo', 'Dee']);
  assert.deepEqual(kids.map((k) => k.born), kids.map((k) => k.born).sort());
  for (const k of kids) assert.deepEqual(Object.keys(k).sort(), ['born', 'family', 'id', 'name']);
  // Families as the families contract has them: an id and a name each, and each kid's family by id.
  assert.equal(families.length, 2);
  for (const f of families) {
    assert.deepEqual(Object.keys(f).sort(), ['id', 'name']);
    assert.equal(typeof f.id, 'string');
    assert.equal(typeof f.name, 'string');
    assert.deepEqual(kids.filter((k) => k.family === f.id).length, 2, f.name);
  }
  assert.ok(kids.every((k) => families.some((f) => f.id === k.family)));
  assert.ok(pieces.length >= 10);
  for (const k of kids) assert.ok(pieces.filter((p) => p.kid_id === k.id).length >= 3, `${k.name} has art`);
  // Tags shared across the families, so a tag's page shows kids from both.
  const familyOf = (p) => kids.find((k) => k.id === p.kid_id).family;
  assert.ok(pieces.some((p) => p.tags.includes('animals') && familyOf(p) === families[0].id) && pieces.some((p) => p.tags.includes('animals') && familyOf(p) === families[1].id));
  // The same fields the real Worker selects for the page.
  const fields = readFileSync('src/worker.js', 'utf8').match(/SELECT (id, kid_id[^]*?) FROM pieces/)[1].split(',').map((s) => s.trim());
  const today = new Date().toISOString().slice(0, 10);
  for (const p of pieces) {
    assert.deepEqual(Object.keys(p).sort(), [...fields].sort(), `piece ${p.id}`);
    assert.match(p.made, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.made <= today, `piece ${p.id} is made in the future`);
    assert.ok(kids.find((k) => k.id === p.kid_id).born < p.made, `piece ${p.id} is made before its artist was born`);
    assert.ok(['day', 'month', 'year'].includes(p.made_precision));
    assert.equal(typeof p.favourite, 'boolean');
    assert.ok(Array.isArray(p.tags));
  }
  assert.ok(pieces.some((p) => p.favourite) && pieces.some((p) => p.story) && pieces.some((p) => !p.title));

  const session = await (await call('/api/session')).json();
  assert.equal(session.canEdit, true);
  assert.equal(session.preview, true);
  assert.match(session.email, /@example\.com$/);
  // A parent in the first family.
  assert.deepEqual(session.families, [families[0].id]);
});

test('draws every piece, at its size', async () => {
  const { pieces } = await (await call('/api/gallery')).json();
  for (const p of pieces) {
    for (const variant of ['thumb', 'display', 'original']) {
      const res = await call(`/img/${p.id}/${variant}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('Content-Type'), /^image\/svg\+xml/);
      assert.match(await res.text(), new RegExp(`^<svg [^>]*width="${p.width}" height="${p.height}"`));
    }
  }
  assert.equal((await call('/img/999/thumb')).status, 404);
  assert.equal((await call('/api/imported')).status, 404);
});

test('refuses every change', async () => {
  const talk = [['POST', '/api/pieces/4/comments'], ['PATCH', '/api/comments/1'], ['DELETE', '/api/comments/1'], ['POST', '/api/pieces/4/stickers/star'], ['DELETE', '/api/pieces/4/stickers/star'], ['PATCH', '/api/me']];
  for (const [method, path] of [['POST', '/api/pieces'], ['PATCH', '/api/pieces/1'], ['DELETE', '/api/pieces/1'], ['POST', '/api/kids'], ['POST', '/api/skipped'], ['PUT', '/'], ...talk]) {
    const res = await call(path, { method, headers: { 'X-Requested-With': 'fridge' } });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match((await res.json()).error, /preview/, `${method} ${path}`);
  }
});

test('serves made-up comments and stickers, in the real Worker’s shapes', async () => {
  const { kids, pieces } = await (await call('/api/gallery')).json();
  const s = await (await call('/api/comments')).json();
  // The same keys as the real Worker's (tests/worker.test.js, COMMENT_KEYS).
  const KEYS = ['body', 'by', 'can_remove', 'created_at', 'edited', 'id', 'kid_id', 'mine', 'piece_id'];
  assert.deepEqual(Object.keys(s).sort(), ['counts', 'latest', 'me', 'newest']);
  assert.deepEqual(s.me, { names: [{ name: 'Aunt Pine', home: 'Mum' }, { name: 'Uncle Pine', home: 'Dad' }], families: ['pines'], kid: null, kid_id: null, seen: 9 }, 'a shared sign-in, so the page says which of them it is');
  assert.equal(s.latest.length, 8);
  assert.deepEqual(s.latest.map((c) => c.id), [...s.latest.map((c) => c.id)].sort((a, b) => b - a), 'newest first');
  assert.ok(s.latest.filter((c) => c.id > s.me.seen).length >= 2, 'some are new');
  const visitorFamily = (await (await call('/api/session')).json()).families[0];
  let all = [];
  for (const p of pieces) {
    const res = await call(`/api/pieces/${p.id}/comments`);
    assert.equal(res.status, 200);
    const { comments, stickers } = await res.json();
    assert.deepEqual(stickers.map((x) => x.kind), ['heart', 'star', 'wow', 'smile', 'rainbow']);
    for (const x of stickers) assert.deepEqual([x.count, x.mine], [x.by.length, []]);
    const counted = s.counts[p.id] || { comments: 0, stickers: 0, newest: 0 };
    assert.deepEqual(counted, { comments: comments.length, stickers: stickers.reduce((n, x) => n + x.count, 0), newest: Math.max(0, ...comments.map((c) => c.id)) }, `piece ${p.id}`);
    const kid = kids.find((k) => k.id === p.kid_id);
    for (const c of comments) {
      assert.deepEqual(Object.keys(c).sort(), KEYS);
      assert.match(c.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(c.can_remove, kid.family === visitorFamily, 'a parent removes comments only on their family’s art');
      if (c.kid_id != null) assert.equal(kids.find((k) => k.id === c.kid_id).name, c.by, 'a kid is named as the kid');
    }
    all = all.concat(comments);
  }
  assert.ok(all.some((c) => c.kid_id != null && c.kid_id === pieces.find((p) => p.id === c.piece_id).kid_id), 'an artist answers on their own art');
  assert.ok(all.some((c) => c.kid_id != null && c.kid_id !== pieces.find((p) => p.id === c.piece_id).kid_id), 'and a kid on someone else’s');
  assert.doesNotMatch(JSON.stringify({ s, all }), /@/, 'no addresses, even made up');
  assert.equal((await call('/api/pieces/999/comments')).status, 404);
});

test('says it’s a preview, with the real Worker’s security headers', async () => {
  const page = await call('/');
  const body = await page.text();
  assert.match(body, /<title>Preview · The Fridge<\/title>/);
  assert.match(body, /<body[^>]*><div [^>]*>Preview with a made-up family\. <a href="\/\?as=nonna"[^>]*>See it as Nonna, who sees only the Pines<\/a><\/div>/);
  assert.equal(page.headers.get('Content-Length'), null);
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const real = await worker.fetch(new Request('https://fridge.example.com/'), {});
  for (const res of [page, await call('/img/1/thumb'), await call('/api/gallery'), await call('/app.js')]) {
    for (const h of ['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options']) assert.equal(res.headers.get(h), real.headers.get(h), h);
  }
});

// Nonna's page asks with its own address as the Referer, as a browser does.
const page = 'https://fridge-preview-pr-1.example.workers.dev/?as=nonna';
const asNonna = (path, init = {}) => call(path, { ...init, headers: { Referer: `${page}#home`, ...init.headers } });
// Anything that would say who's in the Oaks.
const OAKS = /\b(Cy|Dee)\b|\boaks?\b|Aunt Oak/i;

test('as Nonna, shows only the first family: its kids, art, tags and pictures', async () => {
  const all = await (await call('/api/gallery')).json();
  const g = await (await asNonna('/api/gallery')).json();
  assert.deepEqual(g.families, [all.families[0]]);
  assert.deepEqual(g.kids.map((k) => k.name), ['Ada', 'Bo']);
  assert.ok(g.kids.every((k) => k.family === all.families[0].id));
  assert.deepEqual(g.pieces, all.pieces.filter((p) => g.kids.some((k) => k.id === p.kid_id)));
  // Some tags are only on the other family's art (winter, party), so they aren't there.
  const theirs = new Set(g.pieces.flatMap((p) => p.tags));
  assert.ok(all.pieces.flatMap((p) => p.tags).filter((t) => !theirs.has(t)).length > 0);
  assert.ok(!theirs.has('winter') && !theirs.has('party') && theirs.has('animals'));
  assert.doesNotMatch(JSON.stringify(g), OAKS);

  const session = await (await asNonna('/api/session')).json();
  assert.deepEqual([session.canEdit, session.families, session.preview], [false, [], true]);

  const missing = await asNonna('/img/999/thumb');
  for (const p of all.pieces) {
    const res = await asNonna(`/img/${p.id}/display`);
    if (g.pieces.some((q) => q.id === p.id)) assert.equal(res.status, 200, `piece ${p.id}`);
    else assert.deepEqual([res.status, await res.text()], [404, await missing.clone().text()], `piece ${p.id}`);
  }
  // Only the page's own address counts.
  assert.equal((await call('/api/gallery', { headers: { Referer: 'https://elsewhere.example.com/?as=nonna' } }).then((r) => r.json())).kids.length, 4);
  assert.equal((await call('/api/gallery?as=nonna').then((r) => r.json())).kids.length, 2);
});

test('as Nonna, shows comments and stickers only on that family’s art, and the other family’s people as Family', async () => {
  const all = await (await call('/api/gallery')).json();
  const { pieces } = await (await asNonna('/api/gallery')).json();
  const s = await (await asNonna('/api/comments')).json();
  assert.deepEqual(s.me, { names: [{ name: 'Nonna', home: null }], families: [], kid: null, kid_id: null, seen: 10 });
  assert.ok(Object.keys(s.counts).every((id) => pieces.some((p) => p.id === Number(id))));
  assert.ok(s.latest.length && s.latest.every((c) => pieces.some((p) => p.id === c.piece_id)));
  assert.ok(s.latest.some((c) => c.id > s.me.seen && !c.mine), 'some are new');
  let said = [];
  for (const p of all.pieces) {
    const res = await asNonna(`/api/pieces/${p.id}/comments`);
    if (!pieces.some((q) => q.id === p.id)) {
      assert.equal(res.status, 404, `piece ${p.id}`);
      continue;
    }
    const { comments, stickers } = await res.json();
    for (const c of comments) assert.equal(c.can_remove, c.mine, 'she removes only her own');
    said = said.concat(comments, stickers);
  }
  const words = JSON.stringify({ s, said });
  assert.doesNotMatch(words, OAKS);
  assert.match(words, /"by":"Family","kid_id":null/, 'a kid from the other family, on her family’s art');
  assert.ok(said.some((x) => Array.isArray(x.by) && x.by.includes('Family')), 'and their stickers');
  assert.ok(said.some((c) => c.by === 'Nonna' && c.mine && c.can_remove), 'her own');
  // To the parents, they're who they are.
  assert.match(JSON.stringify((await (await call('/api/comments')).json()).latest), /"by":"Aunt Oak"/);
});

test('says when it’s Nonna’s view, with a way back', async () => {
  const body = await (await call('/?as=nonna')).text();
  assert.match(body, /<div [^>]*>Preview as Nonna, who sees only the Pines\. <a href="\/"[^>]*>See it as their parent<\/a><\/div>/);
});
