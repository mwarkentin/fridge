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
  // Only the bindings from the proxy: it also loads a developer's .dev.vars
  // (DEV_EMAIL, FAMILIES, ...), which would change what every test sees.
  const { DB, ART, ASSETS } = proxy.env;
  env = { DB, ART, ASSETS, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, PARENT_EMAILS: `Someone@example.com, ${PARENT}` };
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
  assert.deepEqual(await res.json(), { email: PARENT, canEdit: true, families: [], artist: null });
});

test('knows parents from viewers, case-insensitively', async () => {
  assert.deepEqual(await (await call('/api/session', { as: 'PARENT@Example.com' })).json(), { email: PARENT, canEdit: true, families: [], artist: null });
  assert.deepEqual(await (await call('/api/session', { as: VIEWER })).json(), { email: VIEWER, canEdit: false, families: [], artist: null });
});

test('sends security headers', async () => {
  const res = await call('/api/session');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('keeps the Content-Security-Policy strict, with pdf.js too', async () => {
  // Add art's copy of pdf.js runs without WebAssembly or eval, so the policy
  // needs nothing new: scripts, workers and fetches from this origin only.
  const csp = (await call('/')).headers.get('Content-Security-Policy');
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(directives['default-src'], "'self'");
  assert.equal(directives['script-src'], "'self'");
  assert.equal(directives['connect-src'], "'self'");
  assert.equal(directives['worker-src'], undefined, 'workers fall back to script-src');
  assert.doesNotMatch(csp, /unsafe-eval|wasm-unsafe-eval|https?:/);
});

test('serves Add art’s modules and pdf.js as JavaScript, only to signed-in people', async () => {
  for (const path of ['/add/sheet.js', '/add/pdf.js', '/pdfjs/pdf.min.mjs', '/pdfjs/pdf.worker.min.mjs', '/pdfjs/wasm/openjpeg_nowasm_fallback.js', '/pdfjs/wasm/jbig2_nowasm_fallback.js']) {
    const res = await call(path, { as: VIEWER });
    assert.equal(res.status, 200, path);
    // Module scripts and workers need a JavaScript type: nosniff is on.
    assert.match(res.headers.get('Content-Type'), /^(text|application)\/javascript/, path);
    assert.equal((await call(path, { as: null })).status, 403, path);
  }
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
const DEE = 'dee@example.com'; // Dee's own address: she adds her own art
const PINES = { id: 'pine', name: 'The Pines', parents: [PINE, 'Pine.Too@Example.com ', BOTH, NAMED_ONLY], kids: [{ name: 'Ada', born: '2019-04-02' }, { name: 'Bo', born: '2021-07-02' }] };
const OAKS = { id: 'oak', name: 'The Oaks', parents: [OAK, BOTH], kids: [{ name: 'Cy', born: '2020-02-02' }, { name: 'Dee', born: '2018-05-05', artist: 'Dee@Example.com' }] };
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
    assert.deepEqual(await (await call('/api/session', { localEnv })).json(), { email: PARENT, canEdit: true, families: [], artist: null });
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
  assert.deepEqual(await session(PINE), { email: PINE, canEdit: true, families: ['pine'], artist: null });
  assert.deepEqual(await session('PINE.TOO@example.com'), { email: PINE_TOO, canEdit: true, families: ['pine'], artist: null });
  assert.deepEqual(await session(BOTH), { email: BOTH, canEdit: true, families: ['pine', 'oak'], artist: null });
  assert.deepEqual(await session(LONER), { email: LONER, canEdit: true, families: [], artist: null });
  assert.deepEqual(await session(VIEWER), { email: VIEWER, canEdit: false, families: [], artist: null });
  assert.deepEqual(await session(NAMED_ONLY), { email: NAMED_ONLY, canEdit: false, families: [], artist: null }, 'PARENT_EMAILS says who’s a parent');
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
  assert.deepEqual(await (await call('/api/session', { as: OAK, localEnv: pinesOnly })).json(), { email: OAK, canEdit: true, families: [], artist: null });
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
    family([{ name: 'Ada', born: '2019-04-02', artist: 'not an address' }]),
    family([{ name: 'Ada', born: '2019-04-02', artist: 7 }]),
    family([{ name: 'Ada', born: '2019-04-02', artist: 'a@example.com' }, { name: 'Bo', born: '2021-07-02', artist: 'A@example.com' }]),
  ];
  for (const FAMILIES of broken) {
    for (const as of [PINE, VIEWER]) {
      const res = await call('/api/gallery', { as, localEnv: { ...familyEnv(), FAMILIES } });
      assert.equal(res.status, 503, `${FAMILIES} as ${as}`);
    }
  }
});

test('a kid who’s an artist adds their own art, and changes only the pieces they added', async () => {
  const as = (who) => ({ as: who });
  assert.deepEqual(await (await fam('/api/session', as(DEE))).json(), { email: DEE, canEdit: false, families: [], artist: 'Dee' });
  assert.deepEqual((await (await fam('/api/gallery', as(DEE))).json()).mine, []);

  const add = (who, kid) => fam('/api/pieces', { as: who, method: 'POST', form: pieceForm({ kid_id: fk[kid], made: '2025-08-01', title: 'By Dee' }) });
  let res = await add(DEE, 'Dee');
  assert.equal(res.status, 201);
  const own = (await res.json()).id;
  res = await add(DEE, 'Cy');
  assert.equal(res.status, 403, 'only her own art');
  assert.equal(await errorOf(res), 'You can add your own art, and change only the pieces you added yourself.');
  assert.deepEqual((await (await fam('/api/gallery', as(DEE))).json()).mine, [own], 'the pieces she can change');
  assert.deepEqual((await (await fam('/api/gallery', as(OAK))).json()).mine, [], 'a parent’s list is empty: their rights are by family');

  const patch = (who, id, json) => fam(`/api/pieces/${id}`, { as: who, method: 'PATCH', json });
  assert.equal((await patch(DEE, own, { title: 'Mine', favourite: true, tags: ['ink'] })).status, 200);
  assert.equal((await pieceNow(own)).title, 'Mine');
  assert.equal((await patch(DEE, fp.Dee, { title: 'Not mine' })).status, 403, 'her art that a parent added');
  assert.equal((await fam(`/api/pieces/${fp.Dee}`, { as: DEE, method: 'DELETE' })).status, 403);
  assert.equal((await patch(DEE, fp.Cy, { favourite: true })).status, 403, 'someone else’s art');
  assert.equal((await patch(DEE, own, { kid_id: fk.Cy })).status, 403, 'nor give hers to someone else');
  assert.equal((await pieceNow(own)).kid_id, fk.Dee);

  // Her parents still look after all of her art, including what she adds.
  assert.equal((await patch(OAK, own, { title: 'Ours too' })).status, 200);
  assert.equal((await patch(PINE, own, { title: 'Not ours' })).status, 403);

  // The importer is for parents.
  assert.equal((await fam('/api/imported', as(DEE))).status, 403);
  assert.equal((await fam('/api/skipped', { as: DEE, method: 'POST', json: { add: ['f'.repeat(64)] } })).status, 403);

  assert.equal((await fam(`/api/pieces/${own}`, { as: DEE, method: 'DELETE' })).status, 204);
  assert.equal(await pieceNow(own), undefined);

  // Without artist in FAMILIES she can only look, and a parent's address is a parent's.
  const notArtist = familyEnv([PINES, { ...OAKS, kids: OAKS.kids.map(({ artist, ...k }) => k) }]);
  assert.equal((await call('/api/session', { as: DEE, localEnv: notArtist }).then((r) => r.json())).artist, null);
  assert.equal((await call('/api/pieces', { as: DEE, method: 'POST', form: pieceForm({ kid_id: fk.Dee, made: '2025-08-01' }), localEnv: notArtist })).status, 403);
  const alsoParent = { ...familyEnv(), PARENT_EMAILS: `${familyEnv().PARENT_EMAILS}, ${DEE}` };
  assert.deepEqual(await (await call('/api/session', { as: DEE, localEnv: alsoParent })).json(), { email: DEE, canEdit: true, families: [], artist: null });
});

// ---- Comments and stickers ----
// Everyone signed in comments and gives stickers, on either family's art:
// the parents above, Gran (a grandparent, who only looks), Grandma and Pop
// (two grandparents who share a sign-in), Nana (whom NAMES doesn't list),
// Dee (an artist) and Ada's iPad (one of Ada's devices: it only looks, but
// it's Ada). Names come from NAMES, as infra writes it.
const GRAN = 'gran@example.com';
const SHARED = 'grandparents@example.com';
const NANA = 'nana@example.com';
const ADA_IPAD = 'ada.ipad@example.com';
const TALK_FAMILIES = [{ ...PINES, kids: [{ ...PINES.kids[0], devices: ['Ada.iPad@Example.com '] }, PINES.kids[1]] }, OAKS];
const NAMES = { [GRAN]: 'Gran', 'Grandparents@Example.com': ['Grandma', ' Pop '], [PINE]: 'Pine Mum', [OAK]: ['Oak Dad'] };
const talkEnv = (names = NAMES) => ({ ...familyEnv(TALK_FAMILIES), NAMES: JSON.stringify(names) });
const t = (path, opts = {}) => call(path, { localEnv: talkEnv(), ...opts });
const COMMENT_KEYS = ['body', 'by', 'can_remove', 'created_at', 'edited', 'id', 'kid_id', 'mine', 'piece_id'];
const tp = {}; // a piece of each kid's, for these tests
const say = (as, piece, body) => t(`/api/pieces/${piece}/comments`, { as, method: 'POST', json: { body } });
const said = async (as, piece, body) => {
  const res = await say(as, piece, body);
  assert.equal(res.status, 201, `${as} on ${piece}: ${body}`);
  return (await res.json()).comment;
};
const talkOf = async (piece, as = GRAN) => (await t(`/api/pieces/${piece}/comments`, { as })).json();
const commentOf = async (id, piece, as = GRAN, localEnv = talkEnv()) => (await (await call(`/api/pieces/${piece}/comments`, { as, localEnv })).json()).comments.find((c) => c.id === id);
const summary = async (as = GRAN, localEnv = talkEnv()) => (await call('/api/comments', { as, localEnv })).json();
const sticker = (as, piece, kind, method = 'POST', name) => t(`/api/pieces/${piece}/stickers/${kind}${name ? `?as=${encodeURIComponent(name)}` : ''}`, { as, method });
// Each test starts with no comments, stickers or reading.
const clean = () => env.DB.batch(['comments', 'stickers', 'people'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
// The database's clock, as created_at has it.
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
// Moves something back in time by some minutes, so a test can say what came when.
const at = (table, id, minutes) => env.DB.prepare(`UPDATE ${table} SET created_at = datetime('now', ?) WHERE id = ?`).bind(`-${minutes} minutes`, id).run();

test('everyone signed in comments on any kid’s art, and gives it stickers', async () => {
  await clean();
  for (const kid of ['Ada', 'Bo', 'Cy', 'Dee', 'Di']) {
    const res = await t('/api/pieces', { as: kid === 'Cy' || kid === 'Dee' ? OAK : PINE, method: 'POST', form: pieceForm({ kid_id: fk[kid], made: '2025-09-01', title: `${kid}’s talk piece` }) });
    assert.equal(res.status, 201, kid);
    tp[kid] = (await res.json()).id;
  }
  const everyone = [PINE, OAK, BOTH, LONER, GRAN, NANA, DEE, ADA_IPAD];
  for (const as of everyone) {
    for (const kid of ['Ada', 'Cy', 'Di']) {
      const c = await said(as, tp[kid], `From ${as} to ${kid}`);
      assert.deepEqual(Object.keys(c).sort(), COMMENT_KEYS);
      assert.equal(c.piece_id, tp[kid]);
      assert.equal(c.mine, true);
      assert.equal(c.edited, false);
      assert.equal(c.can_remove, true, 'their own');
    }
    const res = await sticker(as, tp.Cy, 'star');
    assert.equal(res.status, 200, as);
  }
  const { comments, stickers } = await talkOf(tp.Cy);
  assert.deepEqual(comments.map((c) => c.body), everyone.map((as) => `From ${as} to Cy`), 'oldest first');
  assert.deepEqual(stickers.map((s) => s.kind), ['heart', 'star', 'wow', 'smile', 'rainbow']);
  assert.equal(stickers.find((s) => s.kind === 'star').count, everyone.length);
  // Signing in is still needed, to look and to say anything.
  assert.equal((await call('/api/comments', { as: null, localEnv: talkEnv() })).status, 403);
  assert.equal((await call(`/api/pieces/${tp.Cy}/comments`, { as: null, localEnv: talkEnv() })).status, 403);
  assert.equal((await call(`/api/pieces/${tp.Cy}/comments`, { as: null, method: 'POST', json: { body: 'Hi' }, localEnv: talkEnv() })).status, 403);
  // A kid's device only looks at the art: it can't add any.
  assert.deepEqual(await (await t('/api/session', { as: ADA_IPAD })).json(), { email: ADA_IPAD, canEdit: false, families: [], artist: null });
  assert.equal((await t('/api/pieces', { as: ADA_IPAD, method: 'POST', form: pieceForm({ kid_id: fk.Ada, made: '2025-09-01' }) })).status, 403);
  assert.equal((await t(`/api/pieces/${tp.Ada}`, { as: ADA_IPAD, method: 'PATCH', json: { favourite: true } })).status, 403);
});

test('names: from NAMES, a kid by their own addresses, and never an address', async () => {
  await clean();
  const gran = await said(GRAN, tp.Ada, 'Lovely!');
  assert.equal(gran.by, 'Gran');
  assert.deepEqual((await summary(GRAN)).me, { names: [{ name: 'Gran', home: null }], families: [], kid: null, kid_id: null, seen: null });
  // Someone NAMES doesn't list shows as the part of their address before the @.
  assert.equal((await said(NANA, tp.Ada, 'Gorgeous')).by, 'nana');
  assert.deepEqual((await summary(NANA)).me, { names: [], families: [], kid: null, kid_id: null, seen: null });
  // NAMES changes in infra show everywhere, even on what was said before.
  assert.equal((await commentOf(gran.id, tp.Ada, PINE, talkEnv({ ...NAMES, [GRAN]: 'Granny' }))).by, 'Granny');

  // Kids are named by their own addresses, whatever they send.
  assert.deepEqual((await summary(DEE)).me, { names: [], families: [], kid: 'Dee', kid_id: fk.Dee, seen: null });
  assert.deepEqual((await summary(ADA_IPAD)).me, { names: [], families: [], kid: 'Ada', kid_id: fk.Ada, seen: null });
  const fromIpad = await said(ADA_IPAD, tp.Ada, 'I made it!');
  assert.deepEqual([fromIpad.by, fromIpad.kid_id], ['Ada', fk.Ada]);
  const fromDee = await t(`/api/pieces/${tp.Ada}/comments`, { as: DEE, method: 'POST', json: { body: 'Cool rocket', as: 'Gran' } });
  assert.deepEqual(await fromDee.json().then((r) => [r.comment.by, r.comment.kid_id]), ['Dee', fk.Dee]);
  // Without its address in FAMILIES, the iPad is someone NAMES doesn't list.
  const plain = { ...familyEnv(), NAMES: JSON.stringify(NAMES) };
  assert.deepEqual((await summary(ADA_IPAD, plain)).me, { names: [], families: [], kid: null, kid_id: null, seen: null });
  assert.equal((await commentOf(fromIpad.id, tp.Ada, GRAN, plain)).by, 'ada.ipad');
  // And without NAMES, everyone but the kids shows as their address's first part.
  assert.equal((await commentOf(gran.id, tp.Ada, PINE, familyEnv(TALK_FAMILIES))).by, 'gran');

  // Names are infra's: nothing here changes them.
  assert.equal((await t('/api/me', { as: GRAN, method: 'PATCH', json: { name: 'Queen Gran' } })).status, 400);
  assert.equal((await t('/api/me', { as: GRAN, method: 'PATCH', json: { seen: 1 }, headers: { 'X-Requested-With': 'elsewhere' } })).status, 403);

  // The page never gets anyone's address.
  await sticker(GRAN, tp.Ada, 'heart');
  for (const as of [GRAN, PINE, DEE, NANA]) {
    for (const path of ['/api/comments', `/api/pieces/${tp.Ada}/comments`]) assert.doesNotMatch(await (await t(path, { as })).text(), /@/, `${path} as ${as}`);
  }
});

test('a shared sign-in: each comment and sticker says which of them it’s from', async () => {
  await clean();
  assert.deepEqual((await summary(SHARED)).me.names, [{ name: 'Grandma', home: null }, { name: 'Pop', home: null }], 'as NAMES lists them, tidied');
  let res = await say(SHARED, tp.Bo, 'Who am I?');
  assert.equal(res.status, 400, 'two names: say which');
  assert.equal(await errorOf(res), 'Say which of you this is: Grandma or Pop.');
  const ask = (as, body, name) => t(`/api/pieces/${tp.Bo}/comments`, { as, method: 'POST', json: { body, as: name } });
  const pop = (await (await ask(SHARED, 'From Pop', 'pop')).json()).comment;
  const grandma = (await (await ask(SHARED, 'From Grandma', 'Grandma')).json()).comment;
  assert.deepEqual([pop.by, grandma.by], ['Pop', 'Grandma']);
  assert.equal((await ask(SHARED, 'Not me', 'Gran')).status, 403, 'only their own names');
  assert.equal((await ask(GRAN, 'Not me either', 'Pop')).status, 403);
  assert.equal((await ask(GRAN, 'Just me', 'gran')).status, 201, 'a single name may be said');
  // Either of them can change what the other said: the fridge can't tell them apart.
  assert.deepEqual([(await commentOf(pop.id, tp.Bo, SHARED)).mine, (await commentOf(pop.id, tp.Bo, SHARED)).can_remove], [true, true]);
  assert.equal((await t(`/api/comments/${pop.id}`, { as: SHARED, method: 'PATCH', json: { body: 'From Pop, edited' } })).status, 200);
  assert.equal((await commentOf(pop.id, tp.Bo)).by, 'Pop', 'still Pop’s');

  // A sticker each.
  assert.equal((await sticker(SHARED, tp.Bo, 'star')).status, 400, 'say which');
  let st = (await (await sticker(SHARED, tp.Bo, 'star', 'POST', 'Grandma')).json()).stickers.find((x) => x.kind === 'star');
  assert.deepEqual(st, { kind: 'star', count: 1, mine: ['Grandma'], by: ['Grandma'] });
  st = (await (await sticker(SHARED, tp.Bo, 'star', 'POST', 'Pop')).json()).stickers.find((x) => x.kind === 'star');
  assert.deepEqual(st, { kind: 'star', count: 2, mine: ['Grandma', 'Pop'], by: ['Grandma', 'Pop'] });
  st = (await (await sticker(SHARED, tp.Bo, 'star', 'DELETE', 'Grandma')).json()).stickers.find((x) => x.kind === 'star');
  assert.deepEqual(st, { kind: 'star', count: 1, mine: ['Pop'], by: ['Pop'] });
  assert.equal((await sticker(SHARED, tp.Bo, 'star', 'POST', 'Gran')).status, 403);
  assert.deepEqual((await talkOf(tp.Bo, GRAN)).stickers.find((x) => x.kind === 'star').mine, [], 'nobody else’s');

  // Said before NAMES listed them: shown as both, until they say which.
  const before = (await (await call(`/api/pieces/${tp.Bo}/comments`, { as: SHARED, method: 'POST', json: { body: 'Early' }, localEnv: familyEnv(TALK_FAMILIES) })).json()).comment;
  assert.equal(before.by, 'grandparents');
  assert.equal((await commentOf(before.id, tp.Bo)).by, 'Grandma & Pop');
});

test('a parent is their family name on their own family’s art, and their name on everyone else’s, to everyone', async () => {
  await clean();
  const names = { ...NAMES, [PINE]: [{ name: 'Aunt Pine', family: 'Mom' }], [OAK]: [{ name: 'Aunt Oak', family: 'Mom' }, { name: 'Uncle Oak', family: 'Dad' }] };
  const localEnv = talkEnv(names);
  const everyone = [PINE, PINE_TOO, ADA_IPAD, BOTH, OAK, DEE, GRAN, NANA, LONER];
  const sees = async (as, id, piece) => (await commentOf(id, piece, as, localEnv)).by;
  const post = async (as, piece, body, name) => (await (await call(`/api/pieces/${piece}/comments`, { as, method: 'POST', json: name ? { body, as: name } : { body }, localEnv })).json()).comment;
  // On her own family's art she's Mom, and on the other family's, Aunt Pine, whoever's looking, herself included.
  const onAda = await post(PINE, tp.Ada, 'Lovely, Ada');
  const onCy = await post(PINE, tp.Cy, 'Lovely, Cy');
  assert.deepEqual([onAda.by, onCy.by], ['Mom', 'Aunt Pine'], 'to herself, as she posts');
  for (const as of everyone) assert.deepEqual([await sees(as, onAda.id, tp.Ada), await sees(as, onCy.id, tp.Cy)], ['Mom', 'Aunt Pine'], as);
  // The same on Home's latest comments.
  const latest = (await (await call('/api/comments', { as: GRAN, localEnv })).json()).latest;
  assert.deepEqual([onAda.id, onCy.id].map((id) => latest.find((c) => c.id === id).by), ['Mom', 'Aunt Pine']);

  // A shared sign-in: each person, with both their names and the families where the second shows.
  assert.deepEqual((await (await call('/api/comments', { as: OAK, localEnv })).json()).me, { names: [{ name: 'Aunt Oak', home: 'Mom' }, { name: 'Uncle Oak', home: 'Dad' }], families: ['oak'], kid: null, kid_id: null, seen: null });
  let res = await call(`/api/pieces/${tp.Dee}/comments`, { as: OAK, method: 'POST', json: { body: 'From Dad' }, localEnv });
  assert.equal(res.status, 400, 'say which');
  res = await call(`/api/pieces/${tp.Dee}/comments`, { as: OAK, method: 'POST', json: { body: 'From Dad', as: 'Dad' }, localEnv });
  assert.equal(res.status, 403, '`as` is the name everyone sees');
  const fromDad = await post(OAK, tp.Dee, 'From Dad', 'uncle oak');
  const onBo = await post(OAK, tp.Bo, 'From your uncle', 'Uncle Oak');
  assert.deepEqual([fromDad.by, onBo.by], ['Dad', 'Uncle Oak']);
  for (const as of [OAK, DEE, PINE, ADA_IPAD, GRAN]) assert.deepEqual([await sees(as, fromDad.id, tp.Dee), await sees(as, onBo.id, tp.Bo)], ['Dad', 'Uncle Oak'], as);

  // Stickers too.
  const star = async (as, piece, method, name) => (await (await call(`/api/pieces/${piece}/stickers/star${name ? `?as=${encodeURIComponent(name)}` : ''}`, { as, method, localEnv })).json()).stickers.find((x) => x.kind === 'star');
  assert.deepEqual(await star(OAK, tp.Dee, 'POST', 'Uncle Oak'), { kind: 'star', count: 1, mine: ['Uncle Oak'], by: ['Dad'] });
  assert.deepEqual((await star(PINE, tp.Dee, 'POST')).by, ['Dad', 'Aunt Pine']);
  assert.deepEqual((await (await call(`/api/pieces/${tp.Dee}/comments`, { as: GRAN, localEnv })).json()).stickers.find((x) => x.kind === 'star').by, ['Dad', 'Aunt Pine']);
  assert.deepEqual((await star(PINE, tp.Ada, 'POST')).by, ['Mom']);

  // A parent in both families is their family name on either's art.
  const bothNames = { ...names, [BOTH]: [{ name: 'Aunt Both', family: 'Gaga' }] };
  const fromBoth = (await (await call(`/api/pieces/${tp.Cy}/comments`, { as: BOTH, method: 'POST', json: { body: 'Hi' }, localEnv: talkEnv(bothNames) })).json()).comment;
  assert.equal(fromBoth.by, 'Gaga');

  // Said before NAMES listed them: all of them, named by whose art it is.
  const before = (await (await call(`/api/pieces/${tp.Dee}/comments`, { as: OAK, method: 'POST', json: { body: 'Early' }, localEnv: familyEnv(TALK_FAMILIES) })).json()).comment;
  for (const as of [DEE, GRAN]) assert.equal(await sees(as, before.id, tp.Dee), 'Mom & Dad', as);
});

test('a NAMES that can’t be read turns comments off, and only comments', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = [
    '{',
    '["Gran"]',
    JSON.stringify({ 'not an address': 'Gran' }),
    JSON.stringify({ [GRAN]: [] }),
    JSON.stringify({ [GRAN]: ['1', '2', '3', '4', '5', '6', '7'] }),
    JSON.stringify({ [GRAN]: 'Gr@n' }),
    JSON.stringify({ [GRAN]: 'x'.repeat(31) }),
    JSON.stringify({ [GRAN]: 7 }),
    JSON.stringify({ [GRAN]: 'Gran', [NANA]: 'gran ' }),
    JSON.stringify({ [GRAN]: 'Gran', 'GRAN@example.com': 'Granny' }),
    JSON.stringify({ [GRAN]: 'ada' }),
    JSON.stringify({ [DEE]: 'Dee two' }),
    JSON.stringify({ [GRAN]: [{ name: 'Gran', family: 'Nan' }] }), // a family name for someone in no family
    JSON.stringify({ [PINE]: [{ name: 'Aunt Pine', family: 'Mom' }], [PINE_TOO]: [{ name: 'Uncle Pine', family: 'mom' }] }), // two Moms in one family
    JSON.stringify({ [PINE]: [{ name: 'Aunt Pine', family: 'Bo' }] }), // a kid's name
    JSON.stringify({ [PINE]: [{ name: 'Aunt Pine', family: 'Gran' }], [GRAN]: 'Gran' }), // someone else's name
    JSON.stringify({ [PINE]: [{ family: 'Mom' }] }),
  ];
  for (const NAMES of broken) {
    const localEnv = { ...familyEnv(TALK_FAMILIES), NAMES };
    const res = await call('/api/comments', { as: GRAN, localEnv });
    assert.equal(res.status, 503, NAMES);
    assert.match(await errorOf(res), /names can’t be read/);
    assert.equal((await call(`/api/pieces/${tp.Ada}/comments`, { as: GRAN, method: 'POST', json: { body: 'Hi' }, localEnv })).status, 503, NAMES);
    assert.equal((await call('/api/gallery', { as: GRAN, localEnv })).status, 200, 'the fridge still opens');
  }
  for (const NAMES of [undefined, '', ' ', '{}']) assert.equal((await call('/api/comments', { as: GRAN, localEnv: { ...familyEnv(TALK_FAMILIES), NAMES } })).status, 200, String(NAMES));
});

test('authors edit and delete their own comments, and nobody rewords anyone else’s', async () => {
  await clean();
  const c = await said(GRAN, tp.Ada, 'Lovely');
  const edit = (as, id, body) => t(`/api/comments/${id}`, { as, method: 'PATCH', json: { body } });
  let res = await edit(GRAN, c.id, ' Lovely colours ');
  assert.equal(res.status, 200);
  const edited = (await res.json()).comment;
  assert.deepEqual([edited.body, edited.edited, edited.mine], ['Lovely colours', true, true]);
  assert.equal((await commentOf(c.id, tp.Ada)).body, 'Lovely colours');
  const same = await said(GRAN, tp.Ada, 'Same');
  assert.equal((await (await edit(GRAN, same.id, 'Same')).json()).comment.edited, false, 'unchanged words aren’t an edit');

  // Not even the parents who look after the art can put words in Gran's mouth.
  for (const as of [PINE, BOTH, OAK, NANA, DEE, ADA_IPAD]) {
    res = await edit(as, c.id, 'Changed');
    assert.equal(res.status, 403, as);
  }
  assert.equal(await errorOf(res), 'You can change only what you wrote yourself.');
  assert.equal((await commentOf(c.id, tp.Ada)).body, 'Lovely colours');
  assert.equal((await commentOf(c.id, tp.Ada, PINE)).mine, false);
  assert.equal((await edit(GRAN, c.id, '   ')).status, 400);

  assert.equal((await t(`/api/comments/${c.id}`, { as: GRAN, method: 'DELETE' })).status, 204);
  assert.equal(await commentOf(c.id, tp.Ada), undefined);
  assert.equal((await t(`/api/comments/${c.id}`, { as: GRAN, method: 'DELETE' })).status, 404);
  assert.equal((await edit(GRAN, c.id, 'Back')).status, 404);
  // A kid edits and deletes their own too.
  const mine = await said(DEE, tp.Dee, 'I did the sky first');
  assert.equal((await edit(DEE, mine.id, 'I did the sky last')).status, 200);
  assert.equal((await t(`/api/comments/${mine.id}`, { as: DEE, method: 'DELETE' })).status, 204);
});

test('parents remove comments on their own family’s kids’ art, and kids’ in no family, but nobody else’s', async () => {
  await clean();
  const on = {};
  for (const kid of ['Ada', 'Cy', 'Di']) on[kid] = await said(GRAN, tp[kid], `For ${kid}`);
  const may = async (as) => Object.fromEntries(await Promise.all(Object.entries(on).map(async ([kid, c]) => [kid, (await commentOf(c.id, tp[kid], as)).can_remove])));
  assert.deepEqual(await may(PINE), { Ada: true, Cy: false, Di: true });
  assert.deepEqual(await may(OAK), { Ada: false, Cy: true, Di: true });
  assert.deepEqual(await may(BOTH), { Ada: true, Cy: true, Di: true });
  assert.deepEqual(await may(LONER), { Ada: false, Cy: false, Di: true });
  for (const as of [NANA, DEE, ADA_IPAD]) assert.deepEqual(await may(as), { Ada: false, Cy: false, Di: false }, as);

  const remove = (as, kid) => t(`/api/comments/${on[kid].id}`, { as, method: 'DELETE' });
  let res = await remove(OAK, 'Ada');
  assert.equal(res.status, 403);
  assert.equal(await errorOf(res), 'Only Ada’s family’s parents can remove other people’s comments on Ada’s art.');
  assert.equal((await remove(LONER, 'Cy')).status, 403);
  assert.ok(await commentOf(on.Ada.id, tp.Ada), 'still there');
  assert.equal((await remove(PINE, 'Ada')).status, 204);
  assert.equal(await commentOf(on.Ada.id, tp.Ada), undefined);
  assert.equal((await remove(OAK, 'Cy')).status, 204);
  assert.equal((await remove(LONER, 'Di')).status, 204);

  // Without families, every parent looks after every kid's comments, as with their art.
  const none = { ...familyEnv(), FAMILIES: undefined };
  on.Cy = await said(GRAN, tp.Cy, 'Again');
  assert.equal((await call(`/api/comments/${on.Cy.id}`, { as: LONER, method: 'DELETE', localEnv: none })).status, 204);
});

test('someone who only looks, a kid and a kid’s iPad remove only what they wrote', async () => {
  await clean();
  const fromParent = await said(OAK, tp.Dee, 'Dee did this at school');
  for (const as of [GRAN, DEE, ADA_IPAD]) {
    const res = await t(`/api/comments/${fromParent.id}`, { as, method: 'DELETE' });
    assert.equal(res.status, 403, as);
    assert.equal(await errorOf(res), 'You can remove only what you wrote yourself.');
  }
  assert.equal((await commentOf(fromParent.id, tp.Dee, DEE)).can_remove, false, 'not even on her own art');
  assert.ok(await commentOf(fromParent.id, tp.Dee));
  for (const as of [GRAN, DEE, ADA_IPAD]) {
    const own = await said(as, tp.Dee, 'Mine to take back');
    assert.equal((await t(`/api/comments/${own.id}`, { as, method: 'DELETE' })).status, 204, as);
  }
});

test('across families: anyone comments, and the art’s own family looks after what’s said', async () => {
  await clean();
  const fromPine = await said(PINE, tp.Cy, 'Cy, that’s brilliant');
  const fromGran = await said(GRAN, tp.Cy, 'Gorgeous');
  assert.equal((await t(`/api/comments/${fromPine.id}`, { as: PINE, method: 'PATCH', json: { body: 'Cy, that’s amazing' } })).status, 200, 'their own, on the other family’s art');
  const res = await t(`/api/comments/${fromGran.id}`, { as: PINE, method: 'DELETE' });
  assert.equal(res.status, 403);
  assert.match(await errorOf(res), /^Only Cy’s family’s parents/);
  assert.equal((await t(`/api/comments/${fromPine.id}`, { as: OAK, method: 'DELETE' })).status, 204, 'the Oaks remove a Pine’s comment on their art');
  assert.equal((await t(`/api/comments/${fromGran.id}`, { as: OAK, method: 'PATCH', json: { body: 'Changed' } })).status, 403, 'but not reword it');
  const own = await said(PINE, tp.Cy, 'Again');
  assert.equal((await t(`/api/comments/${own.id}`, { as: PINE, method: 'DELETE' })).status, 204);
});

test('stickers: one of each kind per person, taken back only by whoever gave it', async () => {
  await clean();
  const kind = async (res, k) => {
    assert.equal(res.status, 200);
    return (await res.json()).stickers.find((s) => s.kind === k);
  };
  assert.deepEqual(await kind(await sticker(GRAN, tp.Bo, 'star'), 'star'), { kind: 'star', count: 1, mine: [''], by: ['Gran'] });
  assert.equal((await kind(await sticker(GRAN, tp.Bo, 'star'), 'star')).count, 1, 'giving it twice is still one');
  assert.deepEqual(await kind(await sticker(DEE, tp.Bo, 'star'), 'star'), { kind: 'star', count: 2, mine: [''], by: ['Gran', 'Dee'] });
  await sticker(GRAN, tp.Bo, 'heart');
  const forPine = (await talkOf(tp.Bo, PINE)).stickers;
  assert.deepEqual(forPine.map((s) => [s.kind, s.count, s.mine]), [['heart', 1, []], ['star', 2, []], ['wow', 0, []], ['smile', 0, []], ['rainbow', 0, []]]);

  // A parent can't take anyone else's back, even on their own family's art.
  assert.equal((await kind(await sticker(PINE, tp.Bo, 'star', 'DELETE'), 'star')).count, 2);
  assert.deepEqual(await kind(await sticker(GRAN, tp.Bo, 'star', 'DELETE'), 'star'), { kind: 'star', count: 1, mine: [], by: ['Dee'] });
  assert.equal((await kind(await sticker(GRAN, tp.Bo, 'star', 'DELETE'), 'star')).count, 1, 'taking it back twice is fine');

  for (const bad of ['poop', 'hearts']) assert.equal((await sticker(GRAN, tp.Bo, bad)).status, 400, bad);
  assert.equal((await sticker(GRAN, 99999, 'star')).status, 404);
  assert.equal((await t(`/api/pieces/${tp.Bo}/stickers/star`, { as: GRAN, method: 'PATCH', json: {} })).status, 405);
  assert.equal((await t(`/api/pieces/${tp.Bo}/stickers/star`, { as: GRAN, method: 'POST', headers: { 'X-Requested-With': 'elsewhere' } })).status, 403);
  assert.equal((await summary(GRAN)).counts[tp.Bo].stickers, 2);
});

test('comments and stickers go with their piece', async () => {
  await clean();
  const id = (await (await t('/api/pieces', { as: PINE, method: 'POST', form: pieceForm({ kid_id: fk.Bo, made: '2025-09-02' }) })).json()).id;
  const c = await said(GRAN, id, 'Going, going');
  await sticker(GRAN, id, 'wow');
  assert.equal((await summary()).counts[id].comments, 1);
  assert.equal((await t(`/api/pieces/${id}`, { as: PINE, method: 'DELETE' })).status, 204);

  const left = await env.DB.batch([env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE piece_id = ?').bind(id), env.DB.prepare('SELECT COUNT(*) AS n FROM stickers WHERE piece_id = ?').bind(id)]);
  assert.deepEqual(left.map((r) => r.results[0].n), [0, 0]);
  assert.equal((await t(`/api/pieces/${id}/comments`, { as: GRAN })).status, 404);
  assert.equal((await say(GRAN, id, 'Hello?')).status, 404);
  assert.equal((await sticker(GRAN, id, 'star')).status, 404);
  assert.equal((await t(`/api/comments/${c.id}`, { as: GRAN, method: 'PATCH', json: { body: 'Hello?' } })).status, 404);
  const after = await summary();
  assert.equal(after.counts[id], undefined);
  assert.ok(!after.latest.some((x) => x.piece_id === id));
});

test('comments are checked: text, length, and how many', async () => {
  await clean();
  for (const body of [undefined, 7, ['Hi'], '', '  \n\t ', 'x'.repeat(501), '🎨'.repeat(501)]) assert.equal((await say(GRAN, tp.Ada, body)).status, 400, JSON.stringify(body));
  assert.equal((await say(GRAN, tp.Ada, 'x'.repeat(500))).status, 201);
  assert.equal((await say(GRAN, tp.Ada, '🎨'.repeat(500))).status, 201, 'characters, not UTF-16 units');
  const tidy = await said(GRAN, tp.Ada, '  Hi\u0000 there‮  \r\n\r\n\r\n\r\nLove, Gran⁦  ');
  assert.equal(tidy.body, 'Hi there\n\nLove, Gran');
  // As sent: escaping is the page's job (esc() in app.js), and the words stay as written.
  assert.equal((await said(GRAN, tp.Ada, '<img src=x onerror=alert(1)> & “quotes”')).body, '<img src=x onerror=alert(1)> & “quotes”');
  assert.equal((await t(`/api/pieces/${tp.Ada}/comments`, { as: GRAN, method: 'POST', headers: { 'Content-Type': 'text/plain' }, form: 'Hi' })).status, 400, 'JSON only');
  for (const [method, path] of [['POST', `/api/pieces/${tp.Ada}/comments`], ['PATCH', `/api/comments/${tidy.id}`], ['DELETE', `/api/comments/${tidy.id}`]]) {
    assert.equal((await t(path, { as: GRAN, method, json: { body: 'Hi' }, headers: { 'X-Requested-With': 'elsewhere' } })).status, 403, `${method} ${path}`);
  }
  assert.equal((await t(`/api/pieces/${tp.Ada}/comments`, { as: GRAN, method: 'PUT', json: { body: 'Hi' } })).status, 405);

  // Ten in ten minutes each.
  await clean();
  for (let i = 0; i < 10; i++) await said(NANA, tp.Bo, `Number ${i + 1}`);
  const res = await say(NANA, tp.Bo, 'Number 11');
  assert.equal(res.status, 429);
  assert.equal(await errorOf(res), 'That’s 10 comments in 10 minutes. Have a little rest, then try again.');
  await said(GRAN, tp.Bo, 'Someone else still can');
  await env.DB.prepare("UPDATE comments SET created_at = datetime('now', '-11 minutes') WHERE author = ?").bind(NANA).run();
  await said(NANA, tp.Bo, 'Number 11, later');

  // A piece holds 200.
  await clean();
  await env.DB.batch(Array.from({ length: 200 }, (_, i) => env.DB.prepare("INSERT INTO comments (piece_id, author, body, created_at) VALUES (?, ?, 'Hi', datetime('now', '-1 day'))").bind(tp.Cy, `someone${i}@example.com`)));
  const full = await say(GRAN, tp.Cy, 'One more');
  assert.equal(full.status, 409);
  assert.match(await errorOf(full), /200 comments/);
  await said(GRAN, tp.Dee, 'Another piece is fine');
});

test('what’s new: each piece’s newest comment by someone else, and how far someone has caught up', async () => {
  await clean();
  const a1 = await said(GRAN, tp.Ada, 'First');
  const a2 = await said(PINE, tp.Ada, 'Second');
  const c1 = await said(PINE, tp.Cy, 'Third');
  await sticker(GRAN, tp.Ada, 'smile');
  // A minute apart, so the order is plain.
  await at('comments', a1.id, 30);
  await at('comments', a2.id, 20);
  await at('comments', c1.id, 10);
  const when = async (id) => (await env.DB.prepare('SELECT created_at FROM comments WHERE id = ?').bind(id).first()).created_at;

  let s = await summary(GRAN);
  assert.deepEqual(Object.keys(s).sort(), ['counts', 'latest', 'me']);
  assert.deepEqual(s.counts[tp.Ada], { comments: 2, stickers: 1, newest: await when(a2.id) });
  assert.deepEqual(s.counts[tp.Cy], { comments: 1, stickers: 0, newest: await when(c1.id) });
  assert.equal(s.me.seen, null);
  assert.deepEqual(s.latest.map((c) => c.id), [c1.id, a2.id, a1.id], 'newest first');
  for (const c of s.latest) assert.deepEqual(Object.keys(c).sort(), COMMENT_KEYS);
  assert.deepEqual(s.latest.map((c) => c.can_remove), [false, false, true]);
  s = await summary(PINE);
  assert.deepEqual(s.counts[tp.Ada], { comments: 2, stickers: 1, newest: await when(a1.id) }, 'their own don’t count as new');
  assert.equal(s.counts[tp.Cy].newest, '');
  assert.deepEqual(s.latest.map((c) => c.can_remove), [true, true, true]);

  // How far they've caught up is a time, as the notifications' as_of has it.
  const seen = (as, value) => t('/api/me', { as, method: 'PATCH', json: { seen: value } });
  let res = await seen(GRAN, await when(a2.id));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).me.seen, await when(a2.id));
  await seen(GRAN, await when(a1.id));
  assert.equal((await summary(GRAN)).me.seen, await when(a2.id), 'never goes back');
  await seen(GRAN, await when(c1.id));
  assert.equal((await summary(GRAN)).me.seen, await when(c1.id));
  assert.deepEqual((await summary(GRAN)).me.names, [{ name: 'Gran', home: null }], 'catching up changes nothing else');
  res = await seen(GRAN, '2999-01-01 00:00:00');
  assert.equal(res.status, 200);
  assert.ok((await res.json()).me.seen <= sqlNow(), 'never past now');
  for (const bad of ['5', 5, -1, null, '', '2026-11-26', '2026-11-26T09:30:00Z', '2026-02-30 10:00:00', '2026-11-26 25:00:00', '2026-11-26 09:30:00 extra']) assert.equal((await seen(NANA, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await summary(NANA)).me.seen, null);
  assert.equal((await seen(DEE, await when(c1.id))).status, 200);
  assert.equal((await summary(DEE)).me.kid, 'Dee');

  // Only the eight latest.
  for (let i = 0; i < 9; i++) await said(OAK, tp.Dee, `More ${i}`);
  assert.equal((await summary()).latest.length, 8);
});

test('a kid’s devices in FAMILIES are checked like the rest of it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const withAda = (ada) => JSON.stringify([{ ...PINES, kids: [{ ...PINES.kids[0], ...ada }, PINES.kids[1]] }, OAKS]);
  for (const FAMILIES of [withAda({ devices: 'ada.ipad@example.com' }), withAda({ devices: [7] }), withAda({ devices: ['not an address'] }), withAda({ devices: ['Dee@example.com'] }), withAda({ artist: 'ada@example.com', devices: ['dee@example.com'] })]) {
    const res = await call('/api/gallery', { as: GRAN, localEnv: { ...familyEnv(), FAMILIES } });
    assert.equal(res.status, 503, FAMILIES);
  }
  // Her own artist address listed again among her devices is just her.
  const both = { ...familyEnv(), FAMILIES: withAda({ artist: 'ada@example.com', devices: ['ADA@example.com', 'ada.ipad@example.com'] }) };
  assert.equal((await call('/api/session', { as: 'ada@example.com', localEnv: both }).then((r) => r.json())).artist, 'Ada');
  assert.equal((await call('/api/comments', { as: 'ada.ipad@example.com', localEnv: both }).then((r) => r.json())).me.kid, 'Ada');
  // And a parent's address is a parent's.
  const parentToo = { ...familyEnv(TALK_FAMILIES), PARENT_EMAILS: `${familyEnv().PARENT_EMAILS}, ${ADA_IPAD}` };
  assert.deepEqual((await call('/api/comments', { as: ADA_IPAD, localEnv: parentToo }).then((r) => r.json())).me, { names: [], families: [], kid: null, kid_id: null, seen: null });
});

// ---- Notifications ----
// Worked out from the art, comments and stickers each time. These tests set
// when things happened, minutes ago, so what's new is plain. Nothing from the
// current second is listed (see notifications() in worker.js), so each test
// moves what it adds back in time first.
const notes = async (as, localEnv = talkEnv()) => {
  const res = await call('/api/notifications', { as, localEnv });
  assert.equal(res.status, 200, as);
  return res.json();
};
const NOTE_KEYS = { art: ['count', 'pieces'], comment: ['body'], reply: ['body'], sticker: ['stickers'] };
// Each notification as [kind, by, piece, and what's particular to it].
const brief = (n) => n.items.map((x) => [x.kind, x.by, x.piece_id, x.kind === 'art' ? x.count : x.kind === 'sticker' ? [...x.stickers].sort().join('+') : x.body]);
const addArt = async (as, kid, title) => {
  const res = await t('/api/pieces', { as, method: 'POST', form: pieceForm({ kid_id: fk[kid], made: '2025-10-01', title }) });
  assert.equal(res.status, 201, `${as} adds for ${kid}`);
  return (await res.json()).id;
};
const stickerAt = (piece, author, kind, minutes) => env.DB.prepare("UPDATE stickers SET created_at = datetime('now', ?) WHERE piece_id = ? AND author = ? AND sticker = ?").bind(`-${minutes} minutes`, piece, author, kind).run();
const minutesAgo = (m) => new Date(Date.now() - m * 6e4).toISOString().slice(0, 19).replace('T', ' ');
// Only what each test adds is new art.
const oldArt = () => env.DB.prepare("UPDATE pieces SET created_at = datetime('now', '-100 days')").run();

test('notifications: new art, and stickers and comments on someone’s art or after they commented', async () => {
  await clean();
  await oldArt();
  const bo = await addArt(PINE, 'Bo', 'Boat');
  const cy1 = await addArt(OAK, 'Cy', 'Kite');
  const cy2 = await addArt(OAK, 'Cy', 'Cloud');
  const dee = await addArt(DEE, 'Dee', 'Self portrait');
  const ada = await addArt(PINE, 'Ada', 'Moon');
  for (const [id, m] of [[bo, 50], [cy1, 45], [cy2, 45], [dee, 40], [ada, 15]]) await at('pieces', id, m);
  const g1 = await said(GRAN, tp.Ada, 'Lovely!');
  const k1 = await said(ADA_IPAD, tp.Ada, 'Thanks Gran');
  const o1 = await said(OAK, tp.Cy, 'Nice one');
  const x1 = await said(PINE, tp.Cy, 'Great kite, Cy');
  const x2 = await said(OAK, tp.Cy, 'Thank you!');
  for (const [c, m] of [[g1, 35], [k1, 30], [o1, 28], [x1, 26], [x2, 24]]) await at('comments', c.id, m);
  await sticker(GRAN, tp.Ada, 'star');
  await sticker(GRAN, tp.Ada, 'heart');
  await sticker(SHARED, tp.Dee, 'wow', 'POST', 'Grandma');
  await sticker(DEE, tp.Dee, 'smile');
  await stickerAt(tp.Ada, GRAN, 'star', 20);
  await stickerAt(tp.Ada, GRAN, 'heart', 20);
  await stickerAt(tp.Dee, SHARED, 'wow', 18);
  await stickerAt(tp.Dee, DEE, 'smile', 17);

  // A parent: both families' new art but their own, and what's said and
  // stuck on their kids' art, and replies after they commented elsewhere.
  const pine = await notes(PINE);
  assert.deepEqual(Object.keys(pine).sort(), ['as_of', 'items', 'seen', 'unread']);
  assert.deepEqual(brief(pine), [
    ['sticker', 'Gran', tp.Ada, 'heart+star'],
    ['reply', 'Oak Dad', tp.Cy, 'Thank you!'],
    ['comment', 'Ada', tp.Ada, 'Thanks Gran'],
    ['comment', 'Gran', tp.Ada, 'Lovely!'],
    ['art', 'Dee', dee, 1],
    ['art', 'Oak Dad', cy2, 2],
  ]);
  for (const n of pine.items) {
    assert.deepEqual(Object.keys(n).sort(), ['at', 'by', 'by_kid_id', 'key', 'kid_id', 'kind', 'new', 'piece_id', 'title', ...NOTE_KEYS[n.kind]].sort(), n.key);
    assert.equal(n.new, false, 'someone who has never caught up has nothing new yet');
  }
  assert.equal(pine.unread, 0);
  const cy = pine.items.find((n) => n.kind === 'art' && n.piece_id === cy2);
  assert.deepEqual([cy.kid_id, cy.title, cy.pieces], [fk.Cy, 'Cloud', [cy2, cy1]], 'a day’s art by one person for one kid is one notification, newest first');
  assert.equal(pine.items.find((n) => n.by === 'Ada').by_kid_id, fk.Ada, 'a kid is named as the kid, with their magnet');
  assert.equal(pine.items.find((n) => n.kind === 'art' && n.by === 'Dee').by_kid_id, fk.Dee);

  // The other family's parent, from their side.
  assert.deepEqual(brief(await notes(OAK)), [
    ['art', 'Pine Mum', ada, 1],
    ['sticker', 'Dee', tp.Dee, 'smile'],
    ['sticker', 'Grandma', tp.Dee, 'wow'],
    ['comment', 'Pine Mum', tp.Cy, 'Great kite, Cy'],
    ['art', 'Dee', dee, 1],
    ['art', 'Pine Mum', bo, 1],
  ]);
  // In both families: everything said and stuck on all four kids' art.
  const both = brief(await notes(BOTH));
  assert.ok(both.some(([k, by]) => k === 'comment' && by === 'Gran') && both.some(([k, by]) => k === 'comment' && by === 'Pine Mum'));
  assert.equal(both.filter(([k]) => k === 'sticker').length, 3);

  // A grandparent: new art from everyone, and replies after they commented.
  assert.deepEqual(brief(await notes(GRAN)), [
    ['art', 'Pine Mum', ada, 1],
    ['reply', 'Ada', tp.Ada, 'Thanks Gran'],
    ['art', 'Dee', dee, 1],
    ['art', 'Oak Dad', cy2, 2],
    ['art', 'Pine Mum', bo, 1],
  ]);
  // A sign-in two people share, and someone NAMES doesn't list, who haven't said anything.
  for (const as of [SHARED, NANA]) assert.deepEqual(brief(await notes(as)).map(([k]) => k), ['art', 'art', 'art', 'art'], as);

  // A kid's iPad: only about that kid's art, put up, said or stuck by someone else.
  const ipad = await notes(ADA_IPAD);
  assert.deepEqual(brief(ipad), [
    ['art', 'Pine Mum', ada, 1],
    ['sticker', 'Gran', tp.Ada, 'heart+star'],
    ['comment', 'Gran', tp.Ada, 'Lovely!'],
  ]);
  // An artist: their own pieces, not what they did themselves.
  assert.deepEqual(brief(await notes(DEE)), [['sticker', 'Grandma', tp.Dee, 'wow']]);
  // A kid's addresses are all that kid: what Ada said from her iPad isn't new to her own sign-in.
  const adaToo = { ...familyEnv([{ ...PINES, kids: [{ ...PINES.kids[0], artist: 'ada@example.com', devices: [ADA_IPAD] }, PINES.kids[1]] }, OAKS]), NAMES: JSON.stringify(NAMES) };
  assert.deepEqual(brief(await notes('ada@example.com', adaToo)), brief(ipad));
  // A parent in no family looks after kids in no family; there's nothing on Di's art.
  assert.deepEqual(brief(await notes(LONER)).map(([k]) => k), ['art', 'art', 'art', 'art']);

  // Names, never addresses.
  for (const as of [PINE, OAK, GRAN, SHARED, NANA, ADA_IPAD, DEE]) assert.doesNotMatch(JSON.stringify(await notes(as)), /@/, as);
  // Nothing about a piece or kid someone doesn't see (canSee): every
  // notification's pieces and kid are in their own gallery.
  for (const as of [PINE, OAK, BOTH, LONER, GRAN, SHARED, NANA, ADA_IPAD, DEE]) {
    const g = await (await call('/api/gallery', { as, localEnv: talkEnv() })).json();
    for (const n of (await notes(as)).items) {
      for (const id of n.pieces ?? [n.piece_id]) assert.ok(g.pieces.some((p) => p.id === id && p.kid_id === n.kid_id), `${as}: ${n.key}`);
      assert.ok(g.kids.some((k) => k.id === n.kid_id), `${as}: ${n.key}`);
    }
  }
});

test('notifications: caught up per sign-in, by time, and never past what was listed', async () => {
  await clean();
  await oldArt();
  const a = await said(GRAN, tp.Bo, 'Old news');
  const b = await said(NANA, tp.Bo, 'Newer');
  const c = await said(OAK, tp.Bo, 'Newest');
  for (const [x, m] of [[a, 30], [b, 8], [c, 5]]) await at('comments', x.id, m);
  const seen = (as, value) => t('/api/me', { as, method: 'PATCH', json: { seen: value } });

  // Caught up ten minutes ago: what came since is new.
  const tenAgo = minutesAgo(10);
  assert.equal((await seen(PINE, tenAgo)).status, 200);
  let n = await notes(PINE);
  assert.equal(n.seen, tenAgo);
  assert.deepEqual(n.items.map((x) => [x.body, x.new]), [['Newest', true], ['Newer', true], ['Old news', false]]);
  assert.equal(n.unread, 2);
  // Someone else on the same family has their own place.
  assert.equal((await notes(PINE_TOO)).unread, 0);
  // Opening the bell: caught up to as_of.
  assert.equal((await seen(PINE, n.as_of)).status, 200);
  n = await notes(PINE);
  assert.equal(n.unread, 0);
  assert.ok(n.items.every((x) => !x.new));
  // And the walls' New marks go by the same place.
  assert.equal((await summary(PINE)).me.seen, n.seen);

  // A sign-in two people share is one reader: either one's comment makes a
  // reply for both, neither's own is new to them, and either reading reads it.
  const grandma = (await (await t(`/api/pieces/${tp.Cy}/comments`, { as: SHARED, method: 'POST', json: { body: 'From Grandma', as: 'Grandma' } })).json()).comment;
  const pop = (await (await t(`/api/pieces/${tp.Cy}/comments`, { as: SHARED, method: 'POST', json: { body: 'From Pop', as: 'Pop' } })).json()).comment;
  const answer = await said(OAK, tp.Cy, 'Thank you both');
  for (const [x, m] of [[grandma, 7], [pop, 6], [answer, 4]]) await at('comments', x.id, m);
  await seen(SHARED, minutesAgo(9));
  n = await notes(SHARED);
  assert.deepEqual(n.items.filter((x) => x.kind !== 'art').map((x) => [x.kind, x.by, x.body, x.new]), [['reply', 'Oak Dad', 'Thank you both', true]]);
  await seen(SHARED, n.as_of);
  assert.equal((await notes(SHARED)).unread, 0);

  // Something stamped with a second that hasn't finished isn't listed yet,
  // and catching up to as_of doesn't pass over it.
  const late = await said(OAK, tp.Ada, 'Just now');
  await env.DB.prepare("UPDATE comments SET created_at = datetime('now', '+1 second') WHERE id = ?").bind(late.id).run();
  n = await notes(PINE);
  assert.ok(!n.items.some((x) => x.body === 'Just now'));
  await seen(PINE, n.as_of);
  await new Promise((r) => setTimeout(r, 2100));
  n = await notes(PINE);
  assert.deepEqual(n.items.filter((x) => x.new).map((x) => x.body), ['Just now']);
  assert.equal(n.unread, 1);

  // Only the last 60 days, and at most 40.
  await env.DB.prepare("UPDATE comments SET created_at = datetime('now', '-61 days') WHERE id = ?").bind(late.id).run();
  assert.ok(!(await notes(PINE)).items.some((x) => x.body === 'Just now'));
  await clean();
  await env.DB.batch(Array.from({ length: 45 }, (_, i) => env.DB.prepare("INSERT INTO comments (piece_id, author, body, created_at) VALUES (?, ?, ?, datetime('now', ?))").bind(tp.Ada, GRAN, `Number ${i}`, `-${i + 1} minutes`)));
  n = await notes(PINE);
  assert.equal(n.items.length, 40);
  assert.equal(n.items[0].body, 'Number 0', 'newest first');
});

test('notifications go when their piece, comment or sticker does', async () => {
  await clean();
  await oldArt();
  const piece = await addArt(PINE_TOO, 'Bo', 'Going soon');
  await at('pieces', piece, 9);
  const c = await said(GRAN, tp.Ada, 'Taking this back');
  const d = await said(GRAN, piece, 'On a piece that goes');
  await at('comments', c.id, 8);
  await at('comments', d.id, 7);
  await sticker(GRAN, tp.Ada, 'rainbow');
  await sticker(NANA, piece, 'heart');
  await stickerAt(tp.Ada, GRAN, 'rainbow', 6);
  await stickerAt(piece, NANA, 'heart', 5);
  const kinds = async () => brief(await notes(PINE)).map(([k, by, p]) => `${k} ${by} ${p === piece ? 'piece' : p}`);
  assert.deepEqual(await kinds(), ['sticker nana piece', `sticker Gran ${tp.Ada}`, 'comment Gran piece', `comment Gran ${tp.Ada}`, 'art pine.too piece']);

  assert.equal((await t(`/api/comments/${c.id}`, { as: GRAN, method: 'DELETE' })).status, 204);
  assert.deepEqual(await kinds(), ['sticker nana piece', `sticker Gran ${tp.Ada}`, 'comment Gran piece', 'art pine.too piece']);
  assert.equal((await sticker(GRAN, tp.Ada, 'rainbow', 'DELETE')).status, 200);
  assert.deepEqual(await kinds(), ['sticker nana piece', 'comment Gran piece', 'art pine.too piece']);
  assert.equal((await t(`/api/pieces/${piece}`, { as: PINE, method: 'DELETE' })).status, 204);
  assert.deepEqual(await kinds(), []);
});

test('notifications need a sign-in, and are off with comments when NAMES can’t be read', async (t2) => {
  t2.mock.method(console, 'error', () => {});
  assert.equal((await call('/api/notifications', { as: null, localEnv: talkEnv() })).status, 403);
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await t('/api/notifications', { as: GRAN, method, json: {} })).status, 405, method);
  assert.equal((await t('/api/notifications/1', { as: PINE })).status, 404);
  assert.equal((await call('/api/notifications', { as: GRAN, localEnv: { ...talkEnv(), NAMES: '{not json' } })).status, 503);
  // Without NAMES or FAMILIES at all, it still works: everyone's a viewer or a parent of every kid.
  const plain = await call('/api/notifications', { as: PARENT });
  assert.equal(plain.status, 200);
  assert.deepEqual(Object.keys(await plain.json()).sort(), ['as_of', 'items', 'seen', 'unread']);
});

// ---- Who sees what ----
// Nonna is a grandparent on the Pines' side (SEES lists her with the Pines
// only): she sees Ada and Bo, and nothing of the Oaks or of Di, a kid in no
// family. Gran, a grandparent who isn't listed, sees everything, as do the
// parents in either family, Dee (an artist) and Ada's iPad. Without SEES,
// Nonna sees everything too, as everyone did before it. Cy's Nana's name
// says a kid's name Nonna doesn't see.
const NONNA = 'nonna@example.com';
const CY_NANA = 'cys.nana@example.com';
const SEE_NAMES = { ...NAMES, [NONNA]: 'Nonna', [CY_NANA]: 'Cy’s Nana' };
const seeEnv = (sees = { [NONNA]: ['pine'] }) => ({ ...talkEnv(SEE_NAMES), SEES: JSON.stringify(sees) });
const unrestricted = () => ({ ...talkEnv(SEE_NAMES), SEES: undefined });
const s = (path, opts = {}) => call(path, { localEnv: seeEnv(), ...opts });
const EVERYONE_ELSE = [GRAN, PINE, OAK, BOTH, DEE, ADA_IPAD];
// Anything that would say who's in the families Nonna doesn't see.
const HIDDEN = /\b(Cy|Dee|Di)\b|\boaks?\b|Oak Dad|@/i;

test('someone SEES lists sees only those families: their kids, art, tags and pictures', async () => {
  await clean();
  // A tag only the Oaks' art has, and one both families' art has.
  assert.equal((await s(`/api/pieces/${tp.Cy}`, { as: OAK, method: 'PATCH', json: { tags: ['boats', 'shared'] } })).status, 200);
  assert.equal((await s(`/api/pieces/${tp.Ada}`, { as: PINE, method: 'PATCH', json: { tags: ['shared'] } })).status, 200);

  const gallery = async (as, localEnv = seeEnv()) => (await call('/api/gallery', { as, localEnv })).json();
  const nonna = await gallery(NONNA);
  assert.deepEqual(nonna.families, [{ id: 'pine', name: 'The Pines' }]);
  assert.deepEqual(nonna.kids.map((k) => k.name), ['Ada', 'Bo']);
  assert.ok(nonna.pieces.length && nonna.pieces.every((p) => p.kid_id === fk.Ada || p.kid_id === fk.Bo), 'only their art');
  assert.ok(nonna.pieces.some((p) => p.id === tp.Ada) && !nonna.pieces.some((p) => [tp.Cy, tp.Dee, tp.Di].includes(p.id)));
  const tags = new Set(nonna.pieces.flatMap((p) => p.tags));
  assert.ok(tags.has('shared') && !tags.has('boats'), 'tags only the Oaks’ art has aren’t there');
  assert.deepEqual(nonna.mine, []);
  assert.doesNotMatch(JSON.stringify(nonna), HIDDEN);
  // She's a viewer like any other, and the page isn't told who sees what.
  assert.deepEqual(await (await s('/api/session', { as: NONNA })).json(), { email: NONNA, canEdit: false, families: [], artist: null });

  // Everyone else sees every family and kid, and so does Nonna without SEES.
  const all = await gallery(GRAN, unrestricted());
  assert.deepEqual(all.kids.map((k) => k.name).sort(), ['Ada', 'Bo', 'Cy', 'Dee', 'Di']);
  assert.equal(all.families.length, 2);
  for (const as of EVERYONE_ELSE) {
    const g = await gallery(as);
    assert.deepEqual([g.families, g.kids, g.pieces], [all.families, all.kids, all.pieces], as);
  }
  const before = await gallery(NONNA, unrestricted());
  assert.deepEqual([before.families, before.kids, before.pieces], [all.families, all.kids, all.pieces], 'no SEES: everything');
  for (const SEES of [undefined, '', ' ', '{}']) assert.equal((await gallery(NONNA, { ...seeEnv(), SEES })).kids.length, 5, String(SEES));

  // Pictures: every size, even by their address, are as if they weren't there.
  const missing = await s('/img/99999/thumb', { as: NONNA });
  assert.equal(missing.status, 404);
  const nothing = [missing.headers.get('Content-Type'), await missing.text()];
  for (const id of [tp.Cy, tp.Dee, tp.Di]) {
    for (const variant of ['thumb', 'display', 'original']) {
      const res = await s(`/img/${id}/${variant}`, { as: NONNA });
      assert.equal(res.status, 404, `${id} ${variant}`);
      assert.deepEqual([res.headers.get('Content-Type'), await res.text()], nothing);
      assert.equal(res.headers.get('Content-Disposition'), null);
      assert.equal((await s(`/img/${id}/${variant}`, { as: NONNA, method: 'HEAD' })).status, 404);
      for (const as of EVERYONE_ELSE) assert.equal((await s(`/img/${id}/${variant}`, { as })).status, 200, `${as}: ${id} ${variant}`);
      assert.equal((await call(`/img/${id}/${variant}`, { as: NONNA, localEnv: unrestricted() })).status, 200, 'no SEES');
    }
  }
  for (const variant of ['thumb', 'display', 'original']) assert.equal((await s(`/img/${tp.Ada}/${variant}`, { as: NONNA })).status, 200);

  // Seeing both families is everything but kids in no family.
  const both = await gallery(NONNA, seeEnv({ [NONNA]: ['oak', 'pine'] }));
  assert.deepEqual(both.kids.map((k) => k.name).sort(), ['Ada', 'Bo', 'Cy', 'Dee']);
  assert.equal(both.families.length, 2);
  // Addresses and ids are read as everywhere else.
  assert.deepEqual((await gallery(NONNA, seeEnv({ 'Nonna@Example.com ': [' pine ', 'pine'] }))).kids.map((k) => k.name), ['Ada', 'Bo']);
});

test('comments and stickers on art someone doesn’t see aren’t there for them, and its people aren’t named', async () => {
  await clean();
  const noSees = unrestricted();
  // Said before SEES listed Nonna, on what she no longer sees.
  const oldOnCy = (await (await call(`/api/pieces/${tp.Cy}/comments`, { as: NONNA, method: 'POST', json: { body: 'Old news' }, localEnv: noSees })).json()).comment;
  assert.equal((await call(`/api/pieces/${tp.Dee}/stickers/heart`, { as: NONNA, method: 'POST', localEnv: noSees })).status, 200);

  const post = async (as, piece, body) => {
    const res = await s(`/api/pieces/${piece}/comments`, { as, method: 'POST', json: { body } });
    assert.equal(res.status, 201, `${as} on ${piece}`);
    return (await res.json()).comment;
  };
  const fromGran = await post(GRAN, tp.Ada, 'Gorgeous colours');
  const fromDee = await post(DEE, tp.Ada, 'I like the purple'); // an artist in the Oaks
  const fromOak = await post(OAK, tp.Bo, 'So cheerful'); // a parent in the Oaks
  const fromBoth = await post(BOTH, tp.Ada, 'From a parent in both');
  const fromCyNana = await post(CY_NANA, tp.Ada, 'Wonderful');
  const fromIpad = await post(ADA_IPAD, tp.Ada, 'I made it');
  const fromNonna = await post(NONNA, tp.Ada, 'Bellissimo');
  for (const as of [GRAN, DEE, OAK]) assert.equal((await s(`/api/pieces/${tp.Ada}/stickers/star`, { as, method: 'POST' })).status, 200);
  const onCy = await post(GRAN, tp.Cy, 'The newest of all');
  await s(`/api/pieces/${tp.Cy}/stickers/wow`, { as: GRAN, method: 'POST' });
  // A minute apart, oldest first, so which is newest is plain.
  const order = [oldOnCy, fromGran, fromDee, fromOak, fromBoth, fromCyNana, fromIpad, fromNonna, onCy];
  for (const [i, c] of order.entries()) await at('comments', c.id, order.length - i);
  const when = async (c) => (await env.DB.prepare('SELECT created_at FROM comments WHERE id = ?').bind(c.id).first()).created_at;

  // What she sees on the Pines' art: grown-ups and kids in the Oaks only are
  // Family, and so is anyone whose name says a kid she doesn't see.
  const onAda = await (await s(`/api/pieces/${tp.Ada}/comments`, { as: NONNA })).json();
  const by = (c) => onAda.comments.find((x) => x.id === c.id);
  assert.deepEqual([fromGran, fromDee, fromBoth, fromCyNana, fromIpad, fromNonna].map((c) => [by(c).by, by(c).kid_id]), [
    ['Gran', null],
    ['Family', null],
    ['both', null],
    ['Family', null],
    ['Ada', fk.Ada],
    ['Nonna', null],
  ]);
  assert.deepEqual([by(fromNonna).mine, by(fromNonna).can_remove, by(fromGran).can_remove], [true, true, false]);
  assert.deepEqual(onAda.stickers.find((x) => x.kind === 'star').by, ['Gran', 'Family', 'Family']);
  assert.equal((await (await s(`/api/pieces/${tp.Bo}/comments`, { as: NONNA })).json()).comments.find((c) => c.id === fromOak.id).by, 'Family');
  // To everyone else they're who they are.
  for (const as of [GRAN, PINE, DEE]) {
    const theirs = await (await s(`/api/pieces/${tp.Ada}/comments`, { as })).json();
    const of = (c) => theirs.comments.find((x) => x.id === c.id);
    assert.deepEqual([of(fromDee).by, of(fromDee).kid_id, of(fromCyNana).by], ['Dee', fk.Dee, 'Cy’s Nana'], as);
    assert.deepEqual(theirs.stickers.find((x) => x.kind === 'star').by, ['Gran', 'Dee', 'Oak Dad'], as);
  }
  // And to Nonna too, without SEES.
  assert.equal((await (await call(`/api/pieces/${tp.Ada}/comments`, { as: NONNA, localEnv: noSees })).json()).comments.find((c) => c.id === fromDee.id).by, 'Dee');

  // The whole page's: counts and Latest comments, only on the Pines' art.
  const summary = async (as, localEnv = seeEnv()) => (await call('/api/comments', { as, localEnv })).json();
  const hers = await summary(NONNA);
  assert.deepEqual(Object.keys(hers.counts).map(Number).sort((a, b) => a - b), [tp.Ada, tp.Bo]);
  assert.deepEqual(hers.counts[tp.Ada], { comments: 6, stickers: 3, newest: await when(fromIpad) });
  assert.ok(hers.latest.length && hers.latest.every((c) => c.piece_id === tp.Ada || c.piece_id === tp.Bo));
  assert.equal(hers.latest[0].id, fromNonna.id, 'not the newest on art she doesn’t see');
  assert.deepEqual(hers.me, { names: [{ name: 'Nonna', home: null }], families: [], kid: null, kid_id: null, seen: null });
  for (const as of EVERYONE_ELSE) {
    const theirs = await summary(as);
    assert.deepEqual([theirs.counts[tp.Cy], theirs.counts[tp.Dee]?.stickers], [{ comments: 2, stickers: 1, newest: await when(as === GRAN ? oldOnCy : onCy) }, 1], as);
    assert.equal(theirs.latest[0].id, onCy.id, as);
  }
  assert.equal((await summary(NONNA, noSees)).latest[0].id, onCy.id, 'no SEES: everything');
  const caughtUp = (await (await s('/api/notifications', { as: NONNA })).json()).as_of;
  assert.equal((await s('/api/me', { as: NONNA, method: 'PATCH', json: { seen: caughtUp } })).status, 200);

  // A piece she doesn't see is one that isn't there, whatever's asked of it,
  // her own old comment and sticker included: 404, and the same words.
  const asked = [
    ['GET', (id) => `/api/pieces/${id}/comments`],
    ['POST', (id) => `/api/pieces/${id}/comments`, { body: 'Hello?' }],
    ['POST', (id) => `/api/pieces/${id}/stickers/heart`],
    ['DELETE', (id) => `/api/pieces/${id}/stickers/heart`],
  ];
  for (const [method, path, json] of asked) {
    const gone = await s(path(99999), { as: NONNA, method, json });
    assert.equal(gone.status, 404, `${method} ${path(99999)}`);
    const words = await errorOf(gone);
    for (const id of [tp.Cy, tp.Dee, tp.Di]) {
      const res = await s(path(id), { as: NONNA, method, json });
      assert.deepEqual([res.status, await errorOf(res)], [404, words], `${method} ${path(id)}`);
    }
  }
  for (const [method, json] of [['PATCH', { body: 'Changed' }], ['DELETE']]) {
    const gone = await s('/api/comments/99999', { as: NONNA, method, json });
    const words = [gone.status, await errorOf(gone)];
    assert.equal(words[0], 404);
    for (const c of [oldOnCy, onCy]) {
      const res = await s(`/api/comments/${c.id}`, { as: NONNA, method, json });
      assert.deepEqual([res.status, await errorOf(res)], words, `${method} ${c.id}`);
    }
  }
  assert.equal((await (await s(`/api/pieces/${tp.Cy}/comments`, { as: GRAN })).json()).comments.length, 2, 'still there for everyone else');
  assert.equal((await (await s(`/api/pieces/${tp.Dee}/comments`, { as: GRAN })).json()).stickers.find((x) => x.kind === 'heart').count, 1);
  // Without SEES, her own are hers again.
  assert.equal((await call(`/api/comments/${oldOnCy.id}`, { as: NONNA, method: 'PATCH', json: { body: 'Still old news' }, localEnv: noSees })).status, 200);

  // Nothing she's sent says who's in the families she doesn't see. (Her
  // session, with her own address, is checked above.)
  const everything = [
    await (await s('/api/gallery', { as: NONNA })).text(),
    await (await s('/api/comments', { as: NONNA })).text(),
    ...(await Promise.all([tp.Ada, tp.Bo].map(async (id) => (await s(`/api/pieces/${id}/comments`, { as: NONNA })).text()))),
  ];
  for (const body of everything) assert.doesNotMatch(body, HIDDEN);
});

test('notifications for someone who sees only some families: nothing of the others, nor their names', async () => {
  await clean();
  await oldArt();
  const noSees = unrestricted();
  // Said before SEES listed Nonna, on art she no longer sees: a reply after
  // it would have been hers.
  const oldOnCy = (await (await call(`/api/pieces/${tp.Cy}/comments`, { as: NONNA, method: 'POST', json: { body: 'Old news' }, localEnv: noSees })).json()).comment;
  const onAda = await said(NONNA, tp.Ada, 'Bellissimo');
  const ada = await addArt(PINE, 'Ada', 'Moon');
  const cy = await addArt(OAK, 'Cy', 'Kite');
  const di = await addArt(PINE, 'Di', 'Cloud');
  const answers = [
    await said(GRAN, tp.Cy, 'After Nonna, on art she doesn’t see'),
    await said(DEE, tp.Ada, 'From a kid in the other family, after Nonna'),
    await said(OAK, tp.Ada, 'From a parent in the other family'),
    await (await call(`/api/pieces/${tp.Ada}/comments`, { as: CY_NANA, method: 'POST', json: { body: 'From someone whose name says a kid’s' }, localEnv: seeEnv() })).json().then((r) => r.comment),
    await said(GRAN, tp.Ada, 'From Gran'),
  ];
  for (const [i, c] of [oldOnCy, onAda, ...answers].entries()) await at('comments', c.id, 30 - i);
  for (const [id, m] of [[ada, 12], [cy, 11], [di, 10]]) await at('pieces', id, m);

  const hers = await (await s('/api/notifications', { as: NONNA })).json();
  // New art from the Pines, and the replies after she commented there, with
  // the Oaks' people as Family: nothing of Cy, Dee or Di.
  assert.deepEqual(brief(hers), [
    ['art', 'Pine Mum', ada, 1],
    ['reply', 'Gran', tp.Ada, 'From Gran'],
    ['reply', 'Family', tp.Ada, 'From someone whose name says a kid’s'],
    ['reply', 'Family', tp.Ada, 'From a parent in the other family'],
    ['reply', 'Family', tp.Ada, 'From a kid in the other family, after Nonna'],
  ]);
  assert.ok(hers.items.every((n) => n.by_kid_id === null || n.by_kid_id === fk.Ada || n.by_kid_id === fk.Bo), 'no other family’s kid’s magnet');
  assert.doesNotMatch(JSON.stringify(hers), HIDDEN);
  // Everyone else sees what she doesn't.
  const gran = brief(await (await s('/api/notifications', { as: GRAN })).json());
  assert.ok(gran.some(([k, , p]) => k === 'art' && p === cy) && gran.some(([k, , p]) => k === 'art' && p === di));
  // And without SEES, so does she.
  const all = brief(await (await call('/api/notifications', { as: NONNA, localEnv: noSees })).json());
  assert.ok(all.some(([k, , p]) => k === 'art' && p === cy) && all.some(([k, by]) => k === 'reply' && by === 'Gran' && true));
  assert.ok(all.some(([k, , p, body]) => k === 'reply' && p === tp.Cy && body === 'After Nonna, on art she doesn’t see'));
});

test('someone who sees only some families changes nothing, and a piece they don’t see is no different from one that isn’t there', async () => {
  for (const [method, json] of [['PATCH', { favourite: true }], ['DELETE']]) {
    const answers = [];
    for (const id of [tp.Ada, tp.Cy, 99999]) {
      const res = await s(`/api/pieces/${id}`, { as: NONNA, method, json });
      answers.push([res.status, await errorOf(res)]);
    }
    assert.equal(answers[0][0], 403);
    assert.deepEqual(answers, [answers[0], answers[0], answers[0]], method);
  }
  assert.equal((await s('/api/pieces', { as: NONNA, method: 'POST', form: pieceForm({ kid_id: fk.Cy, made: '2025-09-01' }) })).status, 403);
  // The importer's routes are parents', and parents see every family.
  assert.equal((await s('/api/imported', { as: NONNA })).status, 403);
  assert.equal((await s('/api/skipped', { as: NONNA, method: 'POST', json: { add: ['e'.repeat(64)] } })).status, 403);
  for (const as of [PINE, OAK]) {
    const { hashes } = await (await s('/api/imported', { as })).json();
    assert.deepEqual(hashes, (await (await call('/api/imported', { as, localEnv: unrestricted() })).json()).hashes, as);
  }
  // A parent's and an artist's rights are as they were.
  assert.equal((await s(`/api/pieces/${tp.Cy}`, { as: OAK, method: 'PATCH', json: { title: 'Cy’s talk piece' } })).status, 200);
  assert.equal((await s(`/api/pieces/${tp.Cy}`, { as: PINE, method: 'PATCH', json: { title: 'Nope' } })).status, 403);
  assert.equal((await s(`/api/pieces/${tp.Dee}`, { as: DEE, method: 'PATCH', json: { title: 'Nope' } })).status, 403);
});

test('a SEES that can’t be read turns everyone away', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = [
    '{',
    '[]',
    '["pine"]',
    JSON.stringify({ 'not an address': ['pine'] }),
    JSON.stringify({ [NONNA]: [] }),
    JSON.stringify({ [NONNA]: 'pine' }),
    JSON.stringify({ [NONNA]: ['willow'] }), // no such family
    JSON.stringify({ [NONNA]: [7] }),
    JSON.stringify({ [NONNA]: ['pine'], 'NONNA@example.com': ['oak'] }),
    JSON.stringify({ [PINE]: ['pine'] }), // a parent
    JSON.stringify({ [LONER]: ['pine'] }), // a parent in no family
    JSON.stringify({ [NAMED_ONLY]: ['oak'] }), // named in a family's parents
    JSON.stringify({ [DEE]: ['oak'] }), // an artist
    JSON.stringify({ [ADA_IPAD]: ['pine'] }), // a kid's iPad
  ];
  for (const SEES of broken) {
    for (const as of [NONNA, GRAN, PINE]) {
      for (const path of ['/api/session', '/api/gallery', `/img/${tp.Ada}/thumb`, '/']) {
        const res = await call(path, { as, localEnv: { ...seeEnv(), SEES } });
        assert.equal(res.status, 503, `${SEES} as ${as}: ${path}`);
      }
    }
  }
  // Families it names that FAMILIES no longer has.
  assert.equal((await call('/api/gallery', { as: GRAN, localEnv: { ...seeEnv(), FAMILIES: undefined } })).status, 503);
  assert.equal((await call('/api/gallery', { as: GRAN, localEnv: { ...seeEnv(), FAMILIES: JSON.stringify([OAKS]) } })).status, 503);
});
