// The Worker against real local D1 and R2 (wrangler's getPlatformProxy), with
// Access tokens signed by a key made for the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/worker.js';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'test-audience';
const PARENT = 'parent@example.com';
const VIEWER = 'grandparent@example.com';
let proxy, env, keys;

before(async () => {
  proxy = await getPlatformProxy({ persist: false });
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key', alg: 'RS256' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url) === `https://${TEAM}/cdn-cgi/access/certs` ? Promise.resolve(Response.json({ keys: [jwk] })) : realFetch(url, init));
  env = { ...proxy.env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, PARENT_EMAILS: `Someone@example.com, ${PARENT}` };
  for (const file of readdirSync('migrations').sort()) {
    const statements = readFileSync(`migrations/${file}`, 'utf8').split(/;\s*$/m).filter((s) => s.replace(/--.*$/gm, '').trim());
    for (const s of statements) await env.DB.prepare(s).run();
  }
});
after(() => proxy?.dispose());

const b64 = (data) => Buffer.from(data).toString('base64url');
async function token(claims = {}, { kid = 'test-key' } = {}) {
  const head = b64(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}
async function call(path, { as = PARENT, method = 'GET', json, form, headers = {}, host = 'fridge.example.com', localEnv } = {}) {
  const h = { ...headers };
  if (as) h['Cf-Access-Jwt-Assertion'] = await token({ email: as });
  if (method !== 'GET' && !('X-Requested-With' in h)) h['X-Requested-With'] = 'fridge';
  let body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  return worker.fetch(new Request(`https://${host}${path}`, { method, headers: h, body }), localEnv || env);
}
const jpeg = (label) => new File([`fake jpeg ${label}`], `${label}.jpg`, { type: 'image/jpeg' });
function pieceForm(meta, original = jpeg('original')) {
  const form = new FormData();
  form.set('meta', JSON.stringify({ width: 1600, height: 2000, ...meta }));
  form.set('original', original);
  form.set('display', jpeg('display'));
  form.set('thumb', jpeg('thumb'));
  return form;
}

test('turns away requests without a valid Access token', async () => {
  assert.equal((await call('/', { as: null })).status, 403);
  assert.equal((await call('/api/gallery', { as: null })).status, 403);
  const forged = async (claims, opts) => worker.fetch(new Request('https://fridge.example.com/api/session', { headers: { 'Cf-Access-Jwt-Assertion': await token(claims, opts) } }), env);
  assert.equal((await forged({ email: PARENT, aud: ['another-app'] })).status, 403, 'wrong audience');
  assert.equal((await forged({ email: PARENT, exp: Math.floor(Date.now() / 1000) - 5 })).status, 403, 'expired');
  assert.equal((await forged({ email: PARENT, iss: 'https://evil.example.com' })).status, 403, 'wrong issuer');
  assert.equal((await forged({ common_name: 'service-token' })).status, 403, 'no email');
  const good = await token({ email: PARENT });
  const tampered = good.slice(0, good.lastIndexOf('.') + 1) + b64('not the signature');
  const res = await worker.fetch(new Request('https://fridge.example.com/api/session', { headers: { 'Cf-Access-Jwt-Assertion': tampered } }), env);
  assert.equal(res.status, 403, 'bad signature');
});

test('fails closed when the Access settings are missing', async () => {
  const unset = { ...env, ACCESS_AUD: '', DEV_EMAIL: PARENT };
  assert.equal((await call('/api/session', { localEnv: unset })).status, 403);
});

test('DEV_EMAIL signs in only on localhost', async () => {
  const dev = { ...env, ACCESS_AUD: '', DEV_EMAIL: PARENT };
  const res = await call('/api/session', { as: null, host: 'localhost:8787', localEnv: dev });
  assert.deepEqual(await res.json(), { email: PARENT, canEdit: true });
});

test('knows parents from viewers, case-insensitively', async () => {
  assert.deepEqual(await (await call('/api/session', { as: 'PARENT@Example.com' })).json(), { email: PARENT, canEdit: true });
  assert.deepEqual(await (await call('/api/session', { as: VIEWER })).json(), { email: VIEWER, canEdit: false });
});

test('sends security headers', async () => {
  const res = await call('/api/session');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('a parent adds a kid and a piece, and everyone can see it', async () => {
  const kid = await call('/api/kids', { method: 'POST', json: { name: 'Ada', born: '2019-04-02' } });
  assert.equal(kid.status, 201);
  const { id: kidId } = await kid.json();

  const added = await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2024-05-15', made_precision: 'month', title: 'Rocket', tags: ['Space', 'space', ''], source_hash: 'a'.repeat(64), source_name: 'Ada/2024-05 rocket.jpg' }) });
  assert.equal(added.status, 201);
  const { id } = await added.json();

  const { kids, pieces } = await (await call('/api/gallery', { as: VIEWER })).json();
  assert.deepEqual(kids.map((k) => k.name), ['Ada']);
  const piece = pieces.find((p) => p.id === id);
  assert.equal(piece.title, 'Rocket');
  assert.equal(piece.made_precision, 'month');
  assert.deepEqual(piece.tags, ['space']);
  assert.equal(piece.favourite, false);

  const thumb = await call(`/img/${id}/thumb`, { as: VIEWER });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(await thumb.text(), 'fake jpeg thumb');
  const original = await call(`/img/${id}/original`, { as: VIEWER });
  assert.match(original.headers.get('Content-Disposition'), new RegExp(`fridge-${id}\\.jpg`));

  const again = await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2024-05-15', source_hash: 'a'.repeat(64) }) });
  assert.deepEqual(await again.json(), { id, duplicate: true }, 'importing the same file again is skipped');
  assert.deepEqual(await (await call('/api/imported')).json(), { hashes: ['a'.repeat(64)], skipped: [] });
});

test('remembers pieces a parent chose not to import', async () => {
  const h = (c) => c.repeat(64);
  assert.deepEqual(await (await call('/api/skipped', { method: 'POST', json: { add: [h('b'), h('c'), h('b')] } })).json(), { added: 2, removed: 0 });
  let known = await (await call('/api/imported')).json();
  assert.deepEqual(known.skipped.sort(), [h('b'), h('c')]);
  assert.ok(Array.isArray(known.hashes));

  await call('/api/skipped', { method: 'POST', json: { remove: [h('c')] } });
  known = await (await call('/api/imported')).json();
  assert.deepEqual(known.skipped, [h('b')]);

  // Importing a skipped piece after all forgets the skip.
  const { id: kidId } = await (await call('/api/kids', { method: 'POST', json: { name: 'Di', born: '2018-05-05' } })).json();
  assert.equal((await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2025-01-03', source_hash: h('b') }) })).status, 201);
  known = await (await call('/api/imported')).json();
  assert.deepEqual(known.skipped, []);
  assert.ok(known.hashes.includes(h('b')));

  assert.equal((await call('/api/skipped', { method: 'POST', json: { add: ['not a hash'] } })).status, 400);
  assert.equal((await call('/api/skipped', { method: 'POST', json: { add: h('d') } })).status, 400);
  assert.equal((await call('/api/skipped', { as: VIEWER, method: 'POST', json: { add: [h('d')] } })).status, 403);
});

test('viewers can’t change anything', async () => {
  assert.equal((await call('/api/kids', { as: VIEWER, method: 'POST', json: { name: 'Bo', born: '2021-01-01' } })).status, 403);
  assert.equal((await call('/api/pieces/1', { as: VIEWER, method: 'PATCH', json: { favourite: true } })).status, 403);
  assert.equal((await call('/api/imported', { as: VIEWER })).status, 403);
});

test('changes need the X-Requested-With header', async () => {
  const res = await call('/api/kids', { method: 'POST', json: { name: 'Bo', born: '2021-01-01' }, headers: { 'X-Requested-With': 'elsewhere' } });
  assert.equal(res.status, 403);
});

test('editing and removing a piece', async () => {
  const { id: kidId } = await (await call('/api/kids', { method: 'POST', json: { name: 'Bo', born: '2021-07-02' } })).json();
  const { id } = await (await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2025-01-03' }) })).json();

  const edit = await call(`/api/pieces/${id}`, { method: 'PATCH', json: { title: '  Snow day ', story: 'Brr.', favourite: true, medium: 'Crayon' } });
  assert.equal(edit.status, 200);
  let piece = (await (await call('/api/gallery')).json()).pieces.find((p) => p.id === id);
  assert.deepEqual([piece.title, piece.story, piece.favourite, piece.medium], ['Snow day', 'Brr.', true, 'Crayon']);

  assert.equal((await call(`/api/pieces/${id}`, { method: 'PATCH', json: { made: '2025-02-30' } })).status, 400, 'not a real date');
  assert.equal((await call(`/api/pieces/${id}`, { method: 'PATCH', json: { kid_id: 9999 } })).status, 400, 'no such kid');
  assert.equal((await call(`/api/pieces/${id}`, { method: 'PATCH', json: { title: 'x'.repeat(201) } })).status, 400);
  assert.equal((await call(`/api/pieces/${id}`, { method: 'PATCH', json: {} })).status, 400);
  assert.equal((await call('/api/pieces/9999', { method: 'PATCH', json: { title: 'Nope' } })).status, 404);

  assert.equal((await call(`/api/pieces/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/img/${id}/display`)).status, 404);
  piece = (await (await call('/api/gallery')).json()).pieces.find((p) => p.id === id);
  assert.equal(piece, undefined);
});

test('uploads are checked', async () => {
  const { id: kidId } = await (await call('/api/kids', { method: 'POST', json: { name: 'Cy', born: '2020-02-02' } })).json();
  const notImage = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  assert.equal((await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2025-01-03' }, notImage) })).status, 400);
  assert.equal((await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: 'last week' }) })).status, 400);
  const noThumb = pieceForm({ kid_id: kidId, made: '2025-01-03' });
  noThumb.delete('thumb');
  assert.equal((await call('/api/pieces', { method: 'POST', form: noThumb })).status, 400);
  assert.equal((await call('/api/kids', { method: 'POST', json: { name: '', born: '2020-02-02' } })).status, 400);
});
