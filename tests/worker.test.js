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
// Kids come only from FAMILIES (infra's file). A test that isn't about
// families puts one straight into the database, like a kid from before them.
const kidRow = async (name, born) => (await env.DB.prepare('INSERT INTO kids (name, born) VALUES (?, ?) RETURNING id').bind(name, born).first()).id;
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
  assert.deepEqual(await res.json(), { email: PARENT, canEdit: true, families: [] });
});

test('knows parents from viewers, case-insensitively', async () => {
  assert.deepEqual(await (await call('/api/session', { as: 'PARENT@Example.com' })).json(), { email: PARENT, canEdit: true, families: [] });
  assert.deepEqual(await (await call('/api/session', { as: VIEWER })).json(), { email: VIEWER, canEdit: false, families: [] });
});

test('sends security headers', async () => {
  const res = await call('/api/session');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('serves the icons to anyone, and nothing else without a sign-in', async () => {
  // iOS fetches Home Screen icons without the sign-in cookie.
  for (const path of ['/icons/apple-touch-icon.png', '/icons/icon-512.png', '/icons/favicon.svg']) {
    const res = await call(path, { as: null });
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('Content-Type'), /^image\//, path);
    assert.match(res.headers.get('Content-Security-Policy'), /^default-src 'self';/, path);
  }
  assert.equal((await call('/icons/apple-touch-icon.png', { as: null, method: 'HEAD' })).status, 200);
  assert.equal((await call('/icons/nothing-here.png', { as: null })).status, 404);
  for (const path of ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icons/', '/icons/../index.html', '/icons/%2e%2e/index.html', '/icons/x/../../app.js', '/img/1/thumb', '/api/gallery']) {
    assert.equal((await call(path, { as: null })).status, 403, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await call('/icons/apple-touch-icon.png', { as: null, method })).status, 403, method);
  }
});

test('serves the web app manifest only to signed-in people', async () => {
  assert.equal((await call('/manifest.webmanifest', { as: null })).status, 403);
  const res = await call('/manifest.webmanifest', { as: VIEWER });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^application\/manifest\+json/);
  assert.match(res.headers.get('Content-Security-Policy'), /^default-src 'self';/);
  const manifest = await res.json();
  assert.equal(manifest.short_name, 'Fridge');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const img = await call(icon.src, { as: VIEWER });
    assert.equal(img.status, 200, icon.src);
    assert.equal(img.headers.get('Content-Type'), icon.type, icon.src);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});

test('serves every icon and the manifest the page links to', async () => {
  const html = readFileSync('public/index.html', 'utf8');
  const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(links.length, 3);
  for (const href of links) assert.equal((await call(href, { as: VIEWER })).status, 200, href);
});

test('serves every font the stylesheet names, each with its licence, and no others', async () => {
  const css = readFileSync('public/app.css', 'utf8');
  const fonts = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(fonts.length > 0);
  const files = readdirSync('public/fonts');
  for (const font of fonts) {
    assert.match(font, /\.woff2$/, font);
    const res = await call(`/fonts/${font}`, { as: VIEWER });
    assert.equal(res.status, 200, font);
    assert.match(res.headers.get('Content-Type'), /^font\/woff2/, font);
    const name = font.replace(/\.woff2$/, '');
    assert.ok(files.includes(`OFL-${name}.txt`) || files.includes(`LICENSE-${name}.txt`), `${font} needs its licence beside it`);
  }
  // Nothing left over from fonts the page stopped using.
  for (const file of files) {
    const name = file.replace(/^(OFL|LICENSE)-|\.(txt|woff2?)$/g, '');
    assert.ok(fonts.includes(`${name}.woff2`), `public/fonts/${file} isn't used by app.css`);
  }
});

test('a parent adds a piece, and everyone can see it', async () => {
  const kidId = await kidRow('Ada', '2019-04-02');

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
  const kidId = await kidRow('Di', '2018-05-05');
  assert.equal((await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2025-01-03', source_hash: h('b') }) })).status, 201);
  known = await (await call('/api/imported')).json();
  assert.deepEqual(known.skipped, []);
  assert.ok(known.hashes.includes(h('b')));

  assert.equal((await call('/api/skipped', { method: 'POST', json: { add: ['not a hash'] } })).status, 400);
  assert.equal((await call('/api/skipped', { method: 'POST', json: { add: h('d') } })).status, 400);
  assert.equal((await call('/api/skipped', { as: VIEWER, method: 'POST', json: { add: [h('d')] } })).status, 403);
});

test('viewers can’t change anything', async () => {
  assert.equal((await call('/api/pieces/1', { as: VIEWER, method: 'DELETE' })).status, 403);
  assert.equal((await call('/api/pieces/1', { as: VIEWER, method: 'PATCH', json: { favourite: true } })).status, 403);
  assert.equal((await call('/api/imported', { as: VIEWER })).status, 403);
});

test('changes need the X-Requested-With header', async () => {
  const res = await call('/api/pieces/1', { method: 'PATCH', json: { title: 'Nope' }, headers: { 'X-Requested-With': 'elsewhere' } });
  assert.equal(res.status, 403);
});

test('editing and removing a piece', async () => {
  const kidId = await kidRow('Bo', '2021-07-02');
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
  const kidId = await kidRow('Cy', '2020-02-02');
  const notImage = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  assert.equal((await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: '2025-01-03' }, notImage) })).status, 400);
  assert.equal((await call('/api/pieces', { method: 'POST', form: pieceForm({ kid_id: kidId, made: 'last week' }) })).status, 400);
  const noThumb = pieceForm({ kid_id: kidId, made: '2025-01-03' });
  noThumb.delete('thumb');
  assert.equal((await call('/api/pieces', { method: 'POST', form: noThumb })).status, 400);
});

// ---- Families ----
// Two made-up families: the Pines (Ada and Bo) and the Oaks (Cy and Dee),
// a parent in both, a parent in neither, and Di, a kid on the fridge that
// FAMILIES doesn't list. The kids come from FAMILIES, as from infra's file.
const PINE = 'pine@example.com';
const PINE_TOO = 'pine.too@example.com';
const OAK = 'oak@example.com';
const BOTH = 'both@example.com';
const LONER = 'loner@example.com';
const NAMED_ONLY = 'named.only@example.com'; // in a family's list, but not a parent
const PINES = { id: 'pine', name: 'The Pines', parents: [PINE, 'Pine.Too@Example.com ', BOTH, NAMED_ONLY], kids: [{ name: 'Ada', born: '2019-04-02' }, { name: 'Bo', born: '2021-07-02' }] };
const OAKS = { id: 'oak', name: 'The Oaks', parents: [OAK, BOTH], kids: [{ name: 'Cy', born: '2020-02-02' }, { name: 'Dee', born: '2018-05-05' }] };
const FAMILIES = [PINES, OAKS];
const familyEnv = (families = FAMILIES) => ({ ...env, PARENT_EMAILS: [PARENT, PINE, PINE_TOO, OAK, BOTH, LONER].join(', '), FAMILIES: JSON.stringify(families) });
const fam = (path, opts = {}) => call(path, { localEnv: familyEnv(), ...opts });
const errorOf = async (res) => (await res.json()).error;
const galleryNow = async (localEnv = familyEnv()) => (await call('/api/gallery', { as: VIEWER, localEnv })).json();
const kidsNow = async (localEnv) => Object.fromEntries((await galleryNow(localEnv)).kids.map((k) => [k.name, k]));
const pieceNow = async (id) => (await galleryNow()).pieces.find((p) => p.id === id);
const fk = {}; // kid ids by name
const fp = {}; // a piece of each kid's, by kid name

test('with no families set up, nobody is in one, and every parent can change every kid', async () => {
  for (const FAMILIES of [undefined, '', '  ', '[]']) {
    const localEnv = { ...env, FAMILIES };
    assert.deepEqual(await (await call('/api/session', { localEnv })).json(), { email: PARENT, canEdit: true, families: [] });
    const g = await galleryNow(localEnv);
    assert.deepEqual(g.families, []);
    assert.ok(g.kids.length && g.kids.every((k) => k.family === null), 'every kid is in no family');
  }
  // FAMILIES from before it listed kids: the kids here are in no family.
  const { kids } = await galleryNow({ ...env, FAMILIES: JSON.stringify([{ id: 'pine', name: 'The Pines', parents: [PARENT] }]) });
  assert.ok(kids.every((k) => k.family === null));
});

test('kids can’t be added or changed through the API: they come from FAMILIES', async () => {
  assert.equal((await call('/api/kids', { method: 'POST', json: { name: 'Ada', born: '2019-04-02' } })).status, 404);
  assert.equal((await call('/api/kids/1', { method: 'PATCH', json: { name: 'Ada' } })).status, 404);
  assert.equal((await fam('/api/kids', { as: PINE, method: 'POST', json: { name: 'Ada', born: '2019-04-02' } })).status, 404);
});

test('says which families each parent is in', async () => {
  const session = async (as) => (await fam('/api/session', { as })).json();
  assert.deepEqual(await session(PINE), { email: PINE, canEdit: true, families: ['pine'] });
  assert.deepEqual(await session('PINE.TOO@example.com'), { email: PINE_TOO, canEdit: true, families: ['pine'] });
  assert.deepEqual(await session(BOTH), { email: BOTH, canEdit: true, families: ['pine', 'oak'] });
  assert.deepEqual(await session(LONER), { email: LONER, canEdit: true, families: [] });
  assert.deepEqual(await session(VIEWER), { email: VIEWER, canEdit: false, families: [] });
  assert.deepEqual(await session(NAMED_ONLY), { email: NAMED_ONLY, canEdit: false, families: [] }, 'PARENT_EMAILS says who’s a parent');
});

test('puts the kids FAMILIES lists on the fridge, each in their family, once', async () => {
  // A fridge with only Di on it, from before families.
  await env.DB.batch([env.DB.prepare('DELETE FROM pieces'), env.DB.prepare('DELETE FROM kids')]);
  fk.Di = await kidRow('Di', '2018-09-09');

  const g = await galleryNow();
  assert.deepEqual(g.families, [{ id: 'pine', name: 'The Pines' }, { id: 'oak', name: 'The Oaks' }], 'in FAMILIES’ order, without parents or kids');
  const kids = Object.fromEntries(g.kids.map((k) => [k.name, k]));
  assert.deepEqual(Object.keys(kids).sort(), ['Ada', 'Bo', 'Cy', 'Dee', 'Di']);
  assert.deepEqual(['Ada', 'Bo', 'Cy', 'Dee', 'Di'].map((n) => kids[n].family), ['pine', 'pine', 'oak', 'oak', null]);
  assert.equal(kids.Ada.born, '2019-04-02');
  assert.deepEqual(Object.keys(kids.Ada).sort(), ['born', 'family', 'id', 'name']);
  for (const [name, k] of Object.entries(kids)) fk[name] = k.id;

  // Loading again, or several pages at once, adds nobody twice.
  await Promise.all([galleryNow(), galleryNow(), galleryNow()]);
  const again = await galleryNow();
  assert.equal(again.kids.length, 5);
  assert.deepEqual(Object.fromEntries(again.kids.map((k) => [k.name, k.id])), fk);
  // Nor does a kid written differently in FAMILIES.
  const shouting = [{ ...PINES, kids: [{ name: 'ADA ', born: '2019-04-02' }, PINES.kids[1]] }, OAKS];
  assert.equal((await kidsNow(familyEnv(shouting))).ADA.id, fk.Ada);
  assert.equal((await kidsNow()).Ada.id, fk.Ada, 'and back');
});

test('a parent adds art only for their own family’s kids, and kids in no family', async () => {
  const add = (as, kid) => fam('/api/pieces', { as, method: 'POST', form: pieceForm({ kid_id: fk[kid], made: '2025-06-01', title: `${kid}’s piece` }) });
  for (const kid of ['Ada', 'Bo', 'Cy', 'Dee']) {
    const res = await add(kid === 'Ada' || kid === 'Bo' ? PINE : OAK, kid);
    assert.equal(res.status, 201, kid);
    fp[kid] = (await res.json()).id;
  }
  let res = await add(PINE, 'Cy');
  assert.equal(res.status, 403);
  assert.equal(await errorOf(res), 'Cy is in another family. Only their family’s parents can change Cy or their art.');
  assert.equal((await add(OAK, 'Bo')).status, 403);
  assert.equal((await add(LONER, 'Ada')).status, 403, 'a parent in no family');
  for (const as of [PINE, OAK, LONER]) assert.equal((await add(as, 'Di')).status, 201, `${as} adds Di’s`);
  fp.Di = (await (await add(PINE, 'Di')).json()).id;
  for (const kid of ['Ada', 'Cy']) assert.equal((await add(BOTH, kid)).status, 201, `the parent in both adds ${kid}’s`);
  assert.equal((await fam('/api/pieces', { as: VIEWER, method: 'POST', form: pieceForm({ kid_id: fk.Di, made: '2025-06-01' }) })).status, 403);
});

test('keeps the kids in step with FAMILIES: birthdays, renames, and a kid it stops listing', async () => {
  const withKid = (family, i, kid) => FAMILIES.map((f) => (f === family ? { ...f, kids: f.kids.map((k, j) => (j === i ? kid : k)).filter(Boolean) } : f));

  // A corrected birthday is copied over.
  let kids = await kidsNow(familyEnv(withKid(PINES, 0, { name: 'Ada', born: '2019-04-03' })));
  assert.equal(kids.Ada.born, '2019-04-03');
  assert.equal(kids.Ada.id, fk.Ada);

  // Renamed in FAMILIES, with the same birthday: the same kid, art and all.
  kids = await kidsNow(familyEnv(withKid(PINES, 1, { name: 'Bea', born: '2021-07-02' })));
  assert.equal(kids.Bea.id, fk.Bo);
  assert.equal(kids.Bea.family, 'pine');
  assert.equal(kids.Bo, undefined);
  assert.equal((await galleryNow()).pieces.find((p) => p.id === fp.Bo).kid_id, fk.Bo);

  // Back as they were.
  kids = await kidsNow();
  assert.deepEqual([kids.Ada.born, kids.Bo.id], ['2019-04-02', fk.Bo]);

  // A kid FAMILIES stops listing stays, with their art, in no family.
  const noDee = familyEnv(withKid(OAKS, 1, null));
  kids = await kidsNow(noDee);
  assert.equal(kids.Dee.family, null);
  assert.equal((await call(`/api/pieces/${fp.Dee}`, { as: PINE, method: 'PATCH', json: { title: 'Anyone’s now' }, localEnv: noDee })).status, 200);
  assert.equal((await kidsNow()).Dee.family, 'oak', 'until it lists them again');
  assert.equal((await fam(`/api/pieces/${fp.Dee}`, { as: PINE, method: 'PATCH', json: { title: 'Not now' } })).status, 403);
});

test('a parent edits, favourites and removes only their own family’s art', async () => {
  const patch = (as, kid, json) => fam(`/api/pieces/${fp[kid]}`, { as, method: 'PATCH', json });
  assert.equal((await patch(PINE, 'Ada', { favourite: true, title: 'Ours' })).status, 200);
  assert.deepEqual([(await pieceNow(fp.Ada)).favourite, (await pieceNow(fp.Ada)).title], [true, 'Ours']);

  let res = await patch(PINE, 'Cy', { favourite: true });
  assert.equal(res.status, 403);
  assert.match(await errorOf(res), /^Cy is in another family\./);
  assert.equal((await pieceNow(fp.Cy)).favourite, false, 'unchanged');
  assert.equal((await patch(OAK, 'Bo', { title: 'Theirs' })).status, 403);
  assert.equal((await patch(LONER, 'Dee', { title: 'Theirs' })).status, 403);
  assert.equal((await patch(OAK, 'Cy', { favourite: true })).status, 200);
  assert.equal((await patch(BOTH, 'Bo', { story: 'Both families can.' })).status, 200);
  for (const as of [PINE, OAK, LONER]) assert.equal((await patch(as, 'Di', { story: `Changed by ${as}` })).status, 200, `${as} edits Di’s`);
  assert.equal((await patch(VIEWER, 'Di', { favourite: true })).status, 403);
  assert.equal((await fam('/api/pieces/99999', { as: PINE, method: 'PATCH', json: { title: 'Nope' } })).status, 404);

  const del = (as, kid) => fam(`/api/pieces/${fp[kid]}`, { as, method: 'DELETE' });
  assert.equal((await del(PINE, 'Dee')).status, 403);
  assert.equal((await del(LONER, 'Bo')).status, 403);
  assert.ok(await pieceNow(fp.Dee), 'still on the fridge');
  assert.equal((await call(`/img/${fp.Dee}/display`, { as: PINE, localEnv: familyEnv() })).status, 200, 'and so are its pictures');
  assert.equal((await del(VIEWER, 'Dee')).status, 403);
  assert.equal((await del(OAK, 'Dee')).status, 204);
  assert.equal(await pieceNow(fp.Dee), undefined);
  fp.Dee = (await (await fam('/api/pieces', { as: OAK, method: 'POST', form: pieceForm({ kid_id: fk.Dee, made: '2025-06-02' }) })).json()).id;
});

test('moving a piece to another kid needs rights over both', async () => {
  const move = (as, kid, to) => fam(`/api/pieces/${fp[kid]}`, { as, method: 'PATCH', json: { kid_id: fk[to] } });
  const ownerOf = async (kid) => (await pieceNow(fp[kid])).kid_id;

  let res = await move(PINE, 'Ada', 'Cy');
  assert.equal(res.status, 403, 'to another family');
  assert.match(await errorOf(res), /^Cy is in another family\./);
  assert.equal(await ownerOf('Ada'), fk.Ada);
  res = await move(PINE, 'Cy', 'Ada');
  assert.equal(res.status, 403, 'from another family');
  assert.match(await errorOf(res), /^Cy is in another family\./);
  assert.equal(await ownerOf('Cy'), fk.Cy);

  assert.equal((await move(PINE, 'Ada', 'Bo')).status, 200, 'within the family');
  assert.equal(await ownerOf('Ada'), fk.Bo);
  assert.equal((await move(PINE, 'Ada', 'Ada')).status, 200);

  // A parent in both families can move art between them.
  assert.equal((await move(BOTH, 'Ada', 'Dee')).status, 200);
  assert.equal(await ownerOf('Ada'), fk.Dee);
  assert.equal((await move(PINE, 'Ada', 'Ada')).status, 403, 'it’s the other family’s now');
  assert.equal((await move(BOTH, 'Ada', 'Ada')).status, 200);

  // A kid in no family is anyone’s: moving art there hands it to every parent.
  assert.equal((await move(PINE, 'Ada', 'Di')).status, 200);
  assert.equal((await fam(`/api/pieces/${fp.Ada}`, { as: OAK, method: 'PATCH', json: { title: 'Now Di’s' } })).status, 200);
  assert.equal((await move(OAK, 'Ada', 'Ada')).status, 403, 'and back needs rights over Ada');
  assert.equal((await move(PINE, 'Ada', 'Ada')).status, 200);
  assert.equal((await move(LONER, 'Di', 'Ada')).status, 403);

  assert.equal((await fam(`/api/pieces/${fp.Ada}`, { as: PINE, method: 'PATCH', json: { kid_id: 99999 } })).status, 400, 'no such kid');
});

test('a family taken out of FAMILIES leaves its kids to every parent, and no FAMILIES is how it was', async () => {
  const pinesOnly = familyEnv([PINES]);
  const kids = await kidsNow(pinesOnly);
  assert.equal(kids.Cy.family, null, 'the Oaks aren’t a family any more');
  assert.equal(kids.Ada.family, 'pine');
  assert.deepEqual(await (await call('/api/session', { as: OAK, localEnv: pinesOnly })).json(), { email: OAK, canEdit: true, families: [] });
  assert.equal((await call(`/api/pieces/${fp.Cy}`, { as: PINE, method: 'PATCH', json: { title: 'Anyone’s now' }, localEnv: pinesOnly })).status, 200);
  assert.equal((await call(`/api/pieces/${fp.Ada}`, { as: OAK, method: 'PATCH', json: { title: 'Still not' }, localEnv: pinesOnly })).status, 403);

  const none = { ...familyEnv(), FAMILIES: undefined };
  assert.ok(Object.values(await kidsNow(none)).every((k) => k.family === null));
  for (const kid of ['Ada', 'Cy']) assert.equal((await call(`/api/pieces/${fp[kid]}`, { as: LONER, method: 'PATCH', json: { title: `${kid}’s` }, localEnv: none })).status, 200);
});

test('skips and the import’s list are for any parent, in any family', async () => {
  for (const as of [PINE, OAK, LONER]) {
    assert.equal((await fam('/api/skipped', { as, method: 'POST', json: { add: ['e'.repeat(64)] } })).status, 200, as);
    assert.equal((await fam('/api/imported', { as })).status, 200, as);
  }
  assert.equal((await fam('/api/skipped', { as: VIEWER, method: 'POST', json: { add: ['e'.repeat(64)] } })).status, 403);
});

test('a FAMILIES that can’t be read turns everyone away', async (t) => {
  t.mock.method(console, 'error', () => {});
  const family = (kids) => JSON.stringify([{ id: 'a', name: 'A', parents: [], kids }]);
  const broken = [
    '{',
    '{"id":"pine"}',
    '[{"name":"No id","parents":[]}]',
    '[{"id":"a","name":"A","parents":[]},{"id":"a","name":"Again","parents":[]}]',
    '[{"id":"a","name":"A","parents":"a@example.com"}]',
    '[{"id":"a","parents":[]}]',
    '[{"id":"a","name":"A","parents":[],"kids":{"name":"Ada"}}]',
    family([{ name: 'Ada' }]),
    family([{ name: 'Ada', born: '2019-02-30' }]),
    family([{ name: ' ', born: '2019-02-03' }]),
    JSON.stringify([{ ...PINES }, { ...OAKS, kids: [{ name: 'ada', born: '2020-01-01' }] }]),
  ];
  for (const FAMILIES of broken) {
    for (const as of [PINE, VIEWER]) {
      const res = await call('/api/gallery', { as, localEnv: { ...familyEnv(), FAMILIES } });
      assert.equal(res.status, 503, `${FAMILIES} as ${as}`);
    }
  }
});
