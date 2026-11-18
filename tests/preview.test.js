// The public preview (preview/worker.js): a made-up family, nothing private
// it could reach, and no way to change anything.
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

test('serves a made-up family to anyone, in the real gallery’s shape', async () => {
  const res = await call('/api/gallery');
  assert.equal(res.status, 200);
  const { kids, pieces } = await res.json();
  assert.deepEqual(kids.map((k) => k.name), ['Ada', 'Bo']);
  assert.ok(pieces.length >= 10);
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
  for (const [method, path] of [['POST', '/api/pieces'], ['PATCH', '/api/pieces/1'], ['DELETE', '/api/pieces/1'], ['POST', '/api/kids'], ['POST', '/api/skipped'], ['PUT', '/']]) {
    const res = await call(path, { method, headers: { 'X-Requested-With': 'fridge' } });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match((await res.json()).error, /preview/, `${method} ${path}`);
  }
});

test('says it’s a preview, with the real Worker’s security headers', async () => {
  const page = await call('/');
  const body = await page.text();
  assert.match(body, /<title>Preview · The Fridge<\/title>/);
  assert.match(body, /<body[^>]*><div [^>]*>Preview with a made-up family<\/div>/);
  assert.equal(page.headers.get('Content-Length'), null);
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const real = await worker.fetch(new Request('https://fridge.example.com/'), {});
  for (const res of [page, await call('/img/1/thumb'), await call('/api/gallery'), await call('/app.js')]) {
    for (const h of ['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options']) assert.equal(res.headers.get(h), real.headers.get(h), h);
  }
});
