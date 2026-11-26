// A public preview of the fridge's page, with two made-up families. It has no
// database, no bucket and no sign-in, on purpose: every family, kid, piece and
// picture here is invented in this file, so there's nothing private for it
// to reach. It refuses every change, so nobody can put anything on it.
//
// The preview workflow deploys one per pull request, as
// fridge-preview-pr-<number> on workers.dev, from preview/wrangler.toml. It's
// one file with no imports, because it's uploaded as it is (no_bundle).

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};
const NOT_SAVED = 'This is a preview with a made-up family, so changes aren’t saved.';

export default {
  async fetch(request, env) {
    const res = await handle(request, env);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: NOT_SAVED }, 403);
  const who = persona(request);
  const now = new Date();
  if (pathname === '/api/session') return json(session(who));
  if (pathname === '/api/view-as') return owns(who) ? json(viewAsList(who)) : json({ error: 'Only the fridge’s owners can view it as someone else.' }, 403);
  if (pathname === '/api/gallery') return json(gallery(now, who));
  if (pathname === '/api/comments') return json(talkSummary(now, who));
  if (pathname === '/api/notifications') return json(notifications(now, who));
  const talk = pathname.match(/^\/api\/pieces\/(\d+)\/comments$/);
  if (talk) {
    const id = Number(talk[1]);
    if (!seenPieces(who).some((p) => p.id === id)) return json({ error: 'That isn’t on the fridge.' }, 404);
    return json(pieceTalk(now, who, id));
  }
  if (pathname.startsWith('/api/')) return json({ error: 'There’s nothing at that address.' }, 404);
  const img = pathname.match(/^\/img\/(\d+)\/(thumb|display|original)$/);
  if (img) {
    const piece = seenPieces(who).find((p) => p.id === Number(img[1]));
    if (!piece) return json({ error: 'There’s no piece with that id.' }, 404);
    return new Response(drawing(piece), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  }
  const res = await env.ASSETS.fetch(request);
  if (pathname === '/' && (res.headers.get('Content-Type') || '').startsWith('text/html')) return markAsPreview(res, who);
  return res;
}

// The page itself, saying in its title and a strip across the top that it's
// a preview, with links to see it as each kind of person. The strip scrolls
// away under the header, so it covers nothing.
async function markAsPreview(res, who) {
  const link = (key) => `<a href="/?as=${key}" style="display:inline-block;padding:7px 9px;color:#fff;${PERSONAS[key] === who ? 'text-decoration:none;background:#fff;color:#1c2a30;border-radius:999px' : 'text-decoration:underline'}"${PERSONAS[key] === who ? ' aria-current="page"' : ''}>${PERSONAS[key].label}</a>`;
  // While the parent views it as someone (View as, ?view=), the page's own
  // strip says whom, so this one offers no other way to look.
  const others = who.viewing ? '' : `<nav aria-label="See the preview as" style="font-size:14px">See it as: ${Object.keys(PERSONAS).map(link).join(' ')}</nav>`;
  const strip = `<div style="padding:3px max(16px,env(safe-area-inset-right,0px)) 3px max(16px,env(safe-area-inset-left,0px));background:#1c2a30;color:#fff;font:700 13px/1.3 system-ui,sans-serif;text-align:center">Preview with a made-up family${others}</div>`;
  const html = (await res.text()).replace(/<title>([^<]*)<\/title>/, '<title>Preview · $1</title>').replace(/<body[^>]*>/, (body) => body + strip);
  const headers = new Headers(res.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.set('Cache-Control', 'no-store');
  return new Response(html, { status: res.status, headers });
}

// ---- The made-up families ----
// Dates count back from today, so ages stay put and "This time of year"
// always has something in it.
const FAMILIES = [
  { id: 'pines', name: 'The Pines' },
  { id: 'oaks', name: 'The Oaks' },
];
const KIDS = [
  { id: 1, name: 'Ada', family: 'pines', born: [8, 64] },
  { id: 2, name: 'Bo', family: 'pines', born: [5, 288] },
  { id: 3, name: 'Cy', family: 'oaks', born: [7, 150] },
  { id: 4, name: 'Dee', family: 'oaks', born: [3, 200] },
];
// [id, kid, drawing, width, height, [years, days] ago, precision, title, what they said, medium, tags, favourite]
const PIECES = [
  [1, 1, 'family', 1400, 1000, [1, -9], 'day', 'Our family at the park', 'That’s me, that’s Bo, and that’s Grandma with her big hat.', 'Crayon', ['family', 'outside'], true],
  [2, 1, 'house', 1000, 1300, [2, 3], 'month', 'My house', 'The door is purple because purple is the best.', 'Marker', ['home', 'family'], true],
  [3, 1, 'rainbow', 1400, 1000, [0, 168], 'day', 'Rainbow after the rain', '', 'Crayon', ['weather', 'outside'], false],
  [4, 1, 'rocket', 1000, 1400, [0, 248], 'day', 'Rocket to the moon', 'It goes faster than a car. Way faster.', 'Coloured pencil', ['space', 'night sky'], true],
  [5, 1, 'cat', 1100, 1100, [3, 7], 'month', 'Mittens', '', 'Crayon', ['cat', 'animals'], false],
  [6, 1, 'tree', 1000, 1350, [3, 200], 'year', 'Apple tree', '', 'Paint', ['outside'], false],
  [7, 2, 'scribble', 1300, 1000, [0, 27], 'day', '', '', 'Crayon', [], false],
  [8, 2, 'sun', 1000, 1000, [0, 97], 'day', 'Sunny sun', 'Hot! Hot! Hot!', 'Paint', ['summer', 'été', 'outside'], true],
  [9, 2, 'sea', 1350, 1000, [0, 135], 'day', 'Fishies', 'The orange one is the daddy.', 'Marker', ['sea', 'animals', 'été'], false],
  [10, 2, 'flowers', 1400, 1000, [2, -2], 'month', 'Flowers for Mum', '', 'Crayon', ['flowers', 'family', 'outside'], true],
  [11, 2, 'night', 1000, 1350, [0, 303], 'day', 'Night time', 'The moon is watching our house.', 'Chalk pastel', ['night sky', 'home'], false],
  [12, 2, 'dino', 1400, 950, [1, 16], 'day', 'A very big dinosaur with spiky bits on its back', 'He is called Crunchy and he eats trees.', 'Marker', ['dinosaur', 'animals'], true],
  [13, 3, 'boat', 1400, 1000, [0, 52], 'day', 'Sailing to the island', 'The flag says go faster.', 'Coloured pencil', ['sea', 'outside'], true],
  [14, 3, 'butterfly', 1300, 1000, [3, -5], 'day', 'Butterfly', '', 'Watercolour', ['animals', 'outside'], false],
  [15, 3, 'car', 1400, 900, [1, 120], 'day', 'Race car', 'Number one because it wins.', 'Marker', [], false],
  [16, 3, 'snowman', 1000, 1300, [2, 300], 'month', 'Snowman with a scarf', '', 'Crayon', ['winter', 'outside'], true],
  [17, 3, 'house', 1000, 1300, [4, 90], 'year', 'Our house', '', 'Crayon', ['home', 'family'], false],
  [18, 4, 'balloons', 1000, 1300, [0, 12], 'day', 'Party balloons', 'One for everybody!', 'Crayon', ['party', 'family'], true],
  [19, 4, 'scribble', 1300, 1000, [1, 4], 'day', '', '', 'Marker', [], false],
  [20, 4, 'fishbowl', 1100, 1100, [0, 210], 'day', 'Blub the fish', 'He says blub.', 'Paint', ['animals', 'sea'], false],
  [21, 4, 'sun', 1000, 1000, [1, 180], 'month', 'Big sun', '', 'Chalk pastel', ['summer', 'outside'], false],
].map(([id, kid_id, kind, width, height, ago, made_precision, title, story, medium, tags, favourite]) => ({ id, kid_id, kind, width, height, ago, made_precision, title, story, medium, tags, favourite }));

const iso = (d) => d.toISOString().slice(0, 10);
function back(today, [years, days]) {
  const d = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}
// The same shape as the real /api/gallery, kids oldest first like the real
// one. `mine` is what an artist added, which they can change.
function gallery(today, who) {
  const kids = KIDS.filter((k) => seesKid(who, k.id)).map(({ id, name, family, born }) => ({ id, name, born: iso(back(today, born)), family })).sort((a, b) => (a.born < b.born ? -1 : a.born > b.born ? 1 : a.id - b.id));
  const pieces = seenPieces(who).map(({ kind, ago, ...p }) => {
    const d = back(today, ago);
    if (p.made_precision === 'month') d.setUTCDate(15);
    if (p.made_precision === 'year') d.setUTCMonth(6, 1);
    return { ...p, made: iso(d > today ? today : d), source_name: null, created_at: addedAt(today, p.id) };
  }).sort((a, b) => (a.made < b.made ? 1 : a.made > b.made ? -1 : b.id - a.id));
  return { families: FAMILIES.filter((f) => who.sees === null || who.sees.includes(f.id)), kids, pieces, mine: who.artist ? PIECES.filter((p) => addedBy(p.id) === who.signin).map((p) => p.id) : [] };
}

// ---- Made-up people, comments and stickers ----
// In the real Worker's shapes (talk() and notifications() in src/worker.js).
// The page can be seen as each kind of person (PERSONAS, from the strip's
// links). By default the visitor is a sign-in shared by two parents in the
// first family: Mum and Dad on its kids' art, and Aunt Pine and Uncle Pine
// on the other family's, so the page says which of them is commenting.
// Nonna, a grandparent on their side, sees only the first family (as SEES
// has it in the real Worker): not the other family, its kids, their art,
// what's said about it, nor their names, which are "Family" to her. The page
// keeps what the visitor adds to itself: the Worker above refuses every change.
//
// Everyone's sign-in, by a made-up key: a family's parents, people who only
// look, and the kids, who are their kid.
const SIGNINS = {
  pines: { family: 'pines', people: [{ name: 'Aunt Pine', home: 'Mum' }, { name: 'Uncle Pine', home: 'Dad' }] },
  oaks: { family: 'oaks', people: [{ name: 'Aunt Oak', home: 'Mama' }] },
  grandma: { people: [{ name: 'Grandma' }] },
  pop: { people: [{ name: 'Pop' }] },
  nana: { people: [{ name: 'Nana' }] },
  jo: { people: [{ name: 'Auntie Jo' }] },
  nonna: { people: [{ name: 'Nonna' }] },
  ada: { kid: 1 },
  bo: { kid: 2 },
  cy: { kid: 3 },
  dee: { kid: 4 },
};
// Who the page is for: what they see (null for everything), and how far
// they'd caught up, minutes ago.
const PERSONAS = {
  parents: { label: 'Mum and Dad', signin: 'pines', canEdit: true, families: ['pines'], artist: null, sees: null, seen: 420 },
  grandma: { label: 'Grandma', signin: 'grandma', canEdit: false, families: [], artist: null, sees: null, seen: 500 },
  nonna: { label: 'Nonna, who sees only the Pines', signin: 'nonna', canEdit: false, families: [], artist: null, sees: ['pines'], seen: 1000 },
  ada: { label: 'Ada’s iPad', signin: 'ada', canEdit: false, families: [], artist: null, sees: null, seen: 1440 },
  dee: { label: 'Dee, an artist', signin: 'dee', canEdit: false, families: [], artist: 'Dee', sees: null, seen: 1440 },
};
// Whom the parents, who own the fridge, can view it as (View as), in the
// shape of the real /api/view-as, each one of the people above.
const VIEW = [
  { key: 'aunt-pine', group: 'pines', persona: 'parents', email: 'visitor@example.com', as: 'Aunt Pine', name: 'Aunt Pine', detail: 'Parent, “Mum” at home' },
  { key: 'uncle-pine', group: 'pines', persona: 'parents', email: 'visitor@example.com', as: 'Uncle Pine', name: 'Uncle Pine', detail: 'Parent, “Dad” at home' },
  { key: 'ada-ipad', group: 'pines', persona: 'ada', email: 'ada.ipad@example.com', as: null, name: 'Ada', detail: 'Their iPad' },
  { key: 'nonna', group: null, persona: 'nonna', email: 'nonna@example.com', as: null, name: 'Nonna', detail: 'Sees only The Pines' },
];
// Who's looking: ?as= on the page's address, which its own requests carry as
// their Referer, or with ?view=, the parents viewing it as one of VIEW, with
// changes off, as the real Worker's View as does with a cookie. Nothing is
// remembered, and nothing signs anyone in.
function persona(request) {
  const url = new URL(request.url);
  let from = url;
  if (!url.searchParams.has('as') && !url.searchParams.has('view')) {
    try {
      const referer = new URL(request.headers.get('Referer'));
      if (referer.origin === url.origin) from = referer;
    } catch {}
  }
  const view = VIEW.find((v) => v.key === from.searchParams.get('view'));
  if (view) return { ...PERSONAS[view.persona], viewing: view };
  return PERSONAS[from.searchParams.get('as')] || PERSONAS.parents;
}
// The parents own the fridge; while they view it as someone, they still do.
const owns = (who) => Boolean(who.viewing) || who === PERSONAS.parents;
function session(who) {
  const out = { email: 'visitor@example.com', canEdit: who.canEdit, preview: true, families: who.families, artist: who.artist };
  if (owns(who)) out.owner = true;
  if (who.viewing) out.viewing = { name: who.viewing.name, detail: who.viewing.detail, as: who.viewing.as };
  return out;
}
const viewAsList = (who) => ({
  groups: [
    { id: 'pines', name: 'The Pines', people: VIEW.filter((v) => v.group === 'pines') },
    { id: null, name: 'Everyone else', people: VIEW.filter((v) => v.group === null) },
  ].map((g) => ({ ...g, people: g.people.map(({ key, email, as, name, detail }) => ({ key, email, as, name, detail, address: false })) })),
  viewing: who.viewing ? { email: who.viewing.email, as: who.viewing.as } : null,
});
const seesKid = (who, id) => who.sees === null || who.sees.includes(KIDS.find((k) => k.id === id).family);
const seenPieces = (who) => PIECES.filter((p) => seesKid(who, p.kid_id));
// Who put each piece up, and when, minutes ago. The rest went up months ago,
// by their family's parents.
const ADDED = { 20: [100, 'oaks'], 8: [70, 'pines'], 18: [360, 'dee'], 3: [600, 'pines'], 7: [600, 'pines'], 13: [1300, 'oaks'], 21: [1300, 'oaks'], 12: [1600, 'pines'], 1: [3100, 'pines'], 4: [4400, 'pines'] };
const kidOf = (pieceId) => KIDS.find((k) => k.id === PIECES.find((p) => p.id === pieceId).kid_id);
const addedBy = (id) => ADDED[id]?.[1] ?? kidOf(id).family;
const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const ago = (today, minutes) => stamp(new Date(today.getTime() - minutes * 6e4));
const addedAt = (today, id) => ago(today, ADDED[id]?.[0] ?? 60 * 24 * 90 + id * 60);
// The name everyone sees for someone, on a piece: as the real Worker names
// them (namesFor), a kid as the kid, and a parent by their family name on
// their own family's kids' art. On a shared sign-in, the person who spoke.
// To someone who doesn't see their family, anyone in it is "Family".
function shown(signin, as, pieceId, who) {
  const s = SIGNINS[signin];
  const family = s.family ?? (s.kid && KIDS.find((k) => k.id === s.kid).family);
  if (who && family && who.sees !== null && !who.sees.includes(family)) return { name: 'Family', kid_id: null };
  if (s.kid) return { name: KIDS.find((k) => k.id === s.kid).name, kid_id: s.kid };
  const home = s.family && s.family === kidOf(pieceId).family;
  const name = (p) => (home && p.home) || p.name;
  const spoke = as && s.people.find((p) => p.name === as);
  return { name: spoke ? name(spoke) : s.people.map(name).join(' & '), kid_id: null };
}
// [id, piece, who, which of them on a shared sign-in, minutes ago, what they said]
const COMMENTS = [
  [1, 4, 'grandma', '', 4380, 'Look at those flames! Where is it going?'],
  [2, 4, 'ada', '', 4340, 'To the moon and then back for tea'],
  [3, 4, 'pop', '', 2900, 'Can I come too? I’ll bring sandwiches.'],
  [4, 12, 'jo', '', 1560, 'Crunchy is my new favourite dinosaur.'],
  [5, 12, 'bo', '', 1500, 'He is very hungry'],
  [6, 13, 'nana', '', 1200, 'What a brave sailor! Where’s the island?'],
  [7, 13, 'pines', 'Aunt Pine', 1170, 'Love the flag. Can we come sailing too?'],
  [8, 13, 'ada', '', 1150, 'I like the flag'],
  [9, 13, 'cy', '', 400, 'Yes! Everybody can come'],
  [10, 18, 'grandma', '', 300, 'One for everybody! Is there one for me?'],
  [11, 18, 'dee', '', 240, 'Yes the yellow one is yours'],
  [12, 1, 'pop', '', 180, 'That hat is very like Grandma’s.'],
  [13, 8, 'jo', '', 50, 'Hot! Hot! Hot! made me laugh out loud.'],
  [14, 20, 'cy', '', 20, 'Blub!'],
  [15, 2, 'dee', '', 15, 'Can you draw my house next?'],
  [16, 10, 'oaks', '', 12, 'These would cheer anyone up.'],
  [17, 4, 'nonna', '', 8, 'What a rocket! Save me a seat.'],
  [18, 4, 'ada', '', 5, 'You can have the window'],
].map(([id, piece_id, signin, as, minutes, body]) => ({ id, piece_id, signin, as, minutes, body }));
const STICKERS = ['heart', 'star', 'wow', 'smile', 'rainbow'];
// Who gave which stickers to each piece, and when: [kind, who, which of them, minutes ago].
const GIVEN = [
  [1, 'heart', 'grandma', '', 3000], [1, 'heart', 'pop', '', 2950], [1, 'heart', 'nana', '', 2000], [1, 'heart', 'jo', '', 1700], [1, 'heart', 'nonna', '', 150],
  [3, 'rainbow', 'grandma', '', 590], [3, 'rainbow', 'cy', '', 580],
  [4, 'star', 'grandma', '', 4300], [4, 'heart', 'grandma', '', 4300], [4, 'star', 'pop', '', 2890], [4, 'wow', 'bo', '', 1400], [4, 'star', 'nana', '', 1190], [4, 'wow', 'cy', '', 600], [4, 'star', 'nonna', '', 140],
  [8, 'smile', 'jo', '', 50], [8, 'smile', 'bo', '', 30],
  [12, 'wow', 'jo', '', 1555], [12, 'smile', 'pop', '', 1450], [12, 'wow', 'ada', '', 1000],
  [13, 'star', 'nana', '', 1200], [13, 'rainbow', 'grandma', '', 310],
  [16, 'star', 'pines', 'Aunt Pine', 2000],
  [19, 'heart', 'nana', '', 2900],
  [18, 'heart', 'grandma', '', 300], [18, 'heart', 'dee', '', 230], [18, 'rainbow', 'pop', '', 170], [18, 'rainbow', 'jo', '', 160], [18, 'rainbow', 'ada', '', 90],
  [20, 'smile', 'cy', '', 20], [20, 'smile', 'dee', '', 15],
].map(([piece_id, kind, signin, as, minutes], rid) => ({ rid: rid + 1, piece_id, kind, signin, as, minutes }));

function comment(today, who, c) {
  const kid = kidOf(c.piece_id);
  const by = shown(c.signin, c.as, c.piece_id, who);
  const mine = c.signin === who.signin;
  return { id: c.id, piece_id: c.piece_id, body: c.body, created_at: ago(today, c.minutes), edited: false, by: by.name, kid_id: by.kid_id, mine, can_remove: mine || (who.canEdit && who.families.includes(kid.family)) };
}
const stickersOn = (id, who) =>
  STICKERS.map((kind) => {
    const given = GIVEN.filter((g) => g.piece_id === id && g.kind === kind).sort((a, b) => b.minutes - a.minutes);
    return { kind, count: given.length, mine: given.filter((g) => g.signin === who.signin).map((g) => g.as), by: given.map((g) => shown(g.signin, g.as, id, who).name) };
  });
function me(today, who) {
  const s = SIGNINS[who.signin];
  const kid = s.kid ? KIDS.find((k) => k.id === s.kid) : null;
  return { names: kid ? [] : s.people.map((p) => ({ name: p.name, home: p.home ?? null })), families: who.families, kid: kid?.name ?? null, kid_id: kid?.id ?? null, seen: ago(today, who.seen) };
}
function talkSummary(today, who) {
  const counts = {};
  for (const p of seenPieces(who)) {
    const on = COMMENTS.filter((c) => c.piece_id === p.id);
    const stickers = GIVEN.filter((g) => g.piece_id === p.id).length;
    const others = on.filter((c) => c.signin !== who.signin);
    if (on.length || stickers) counts[p.id] = { comments: on.length, stickers, newest: others.length ? ago(today, Math.min(...others.map((c) => c.minutes))) : '' };
  }
  const latest = COMMENTS.filter((c) => seesKid(who, kidOf(c.piece_id).id)).sort((a, b) => b.id - a.id).slice(0, 8).map((c) => comment(today, who, c));
  return { me: me(today, who), counts, latest };
}
const pieceTalk = (today, who, id) => ({ comments: COMMENTS.filter((c) => c.piece_id === id).map((c) => comment(today, who, c)), stickers: stickersOn(id, who) });

// What's new for whoever's looking, by the real Worker's rules: new art
// (only their own, for a kid), and stickers and comments on their art or
// their kids', or after they commented. A day's art by one person for one
// kid is one notification, and so is a day's stickers from one person on one
// piece. Only about kids they see, and the people in families they don't
// see are "Family". Nothing here is from the current second, so as_of is a
// second ago.
function notifications(today, who) {
  const s = SIGNINS[who.signin];
  const theirs = (s.kid ? [s.kid] : who.canEdit ? KIDS.filter((k) => who.families.includes(k.family)).map((k) => k.id) : []).filter((id) => seesKid(who, id));
  const groups = new Map();
  const day = (minutes) => ago(today, minutes).slice(0, 10);
  const base = (pieceId, minutes, signin, as) => {
    const by = shown(signin, as, pieceId, who);
    const p = PIECES.find((x) => x.id === pieceId);
    return { at: ago(today, minutes), piece_id: pieceId, kid_id: p.kid_id, title: p.title, by: by.name, by_kid_id: by.kid_id };
  };
  const recent = (minutes) => minutes < 60 * 24 * 60;
  for (const p of [...seenPieces(who)].sort((a, b) => (ADDED[a.id]?.[0] ?? 1e9) - (ADDED[b.id]?.[0] ?? 1e9) || b.id - a.id)) {
    const minutes = ADDED[p.id]?.[0] ?? 60 * 24 * 90 + p.id * 60;
    if (!recent(minutes) || addedBy(p.id) === who.signin || (s.kid && p.kid_id !== s.kid)) continue;
    const group = `${p.kid_id}:${addedBy(p.id)}:${day(minutes)}`;
    const g = groups.get(group);
    if (g) {
      g.count++;
      if (g.pieces.length < 4) g.pieces.push(p.id);
      g.key = `art:${Math.min(Number(g.key.slice(4)), p.id)}`;
    } else groups.set(group, { key: `art:${p.id}`, kind: 'art', ...base(p.id, minutes, addedBy(p.id), ''), count: 1, pieces: [p.id] });
  }
  for (const c of COMMENTS) {
    if (c.signin === who.signin || !seesKid(who, kidOf(c.piece_id).id)) continue;
    const onTheirs = theirs.includes(kidOf(c.piece_id).id);
    const after = COMMENTS.some((m) => m.piece_id === c.piece_id && m.id < c.id && m.signin === who.signin);
    if (onTheirs || after) groups.set(`c${c.id}`, { key: `comment:${c.id}`, kind: onTheirs ? 'comment' : 'reply', ...base(c.piece_id, c.minutes, c.signin, c.as), body: c.body });
  }
  for (const g of [...GIVEN].sort((a, b) => a.minutes - b.minutes)) {
    if (g.signin === who.signin || !theirs.includes(kidOf(g.piece_id).id)) continue;
    const group = `s${g.piece_id}:${g.signin}:${g.as}:${day(g.minutes)}`;
    const had = groups.get(group);
    if (had) {
      if (!had.stickers.includes(g.kind)) had.stickers.push(g.kind);
      had.key = `sticker:${Math.min(Number(had.key.slice(8)), g.rid)}`;
    } else groups.set(group, { key: `sticker:${g.rid}`, kind: 'sticker', ...base(g.piece_id, g.minutes, g.signin, g.as), stickers: [g.kind] });
  }
  const seen = ago(today, who.seen);
  const all = [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1));
  for (const n of all) n.new = n.at > seen;
  return { seen, as_of: ago(today, 1 / 60), unread: all.filter((n) => n.new).length, items: all.slice(0, 40) };
}

// ---- Crayon drawings, as SVG ----
const C = { red: '#d63031', orange: '#f08c1e', yellow: '#f5c518', green: '#3ca046', blue: '#286ec8', purple: '#8246aa', brown: '#82552f', pink: '#f078aa', black: '#28282d', sky: '#6eb4eb', grass: '#5ab43c', grey: '#c8c8d2' };

function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => ((a = ((a ^ (a >>> 15)) * 2246822519 + 1013904223) >>> 0) / 4294967296);
}

function drawing(piece) {
  const { width: w, height: h } = piece;
  const r = rng(piece.id + 7);
  const out = [];
  const n = (v) => Math.round(v * 10) / 10;
  // A crayon line: a few passes, each a little off, like going back and forth.
  const line = (pts, colour, width) => {
    for (let k = 0; k < 2; k++) {
      const j = width * 0.3;
      const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x + (r() - 0.5) * j)} ${n(y + (r() - 0.5) * j)}`).join('');
      out.push(`<path d="${d}" stroke="${colour}" stroke-width="${n(width * (1 - k * 0.3))}" opacity="${k ? 0.55 : 0.9}"/>`);
    }
  };
  const ring = (cx, cy, rx, ry = rx, steps = 36) => Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * Math.PI * 2;
    const wob = 0.94 + r() * 0.12;
    return [cx + Math.cos(t) * rx * wob, cy + Math.sin(t) * ry * wob];
  });
  const hatch = (x0, y0, x1, y1, colour, gap = 12, width = 9) => {
    for (let y = y0; y <= y1; y += gap) line([[x0 + r() * 8, y], [x1 - r() * 8, y + (r() - 0.5) * 8]], colour, width);
  };
  const dot = (x, y, rad, colour) => out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${rad}" fill="${colour}" stroke="none"/>`);
  const ground = () => {
    hatch(20, h * 0.84, w - 20, h - 24, C.grass, 11);
    hatch(20, 24, w - 20, h * 0.1, C.sky, 11, 8);
  };
  const sun = (x, y, rad) => {
    for (let yy = y - rad * 0.8; yy < y + rad * 0.8; yy += 9) {
      const hw = Math.sqrt(Math.max(0, (rad * 0.85) ** 2 - (yy - y) ** 2));
      line([[x - hw, yy], [x + hw, yy]], C.yellow, 9);
    }
    line(ring(x, y, rad), C.orange, 10);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      line([[x + Math.cos(a) * rad * 1.25, y + Math.sin(a) * rad * 1.25], [x + Math.cos(a) * rad * 1.7, y + Math.sin(a) * rad * 1.7]], C.orange, 9);
    }
  };
  const person = (x, y, s, colour) => {
    line(ring(x, y, s * 0.13), colour, 7);
    line([[x, y + s * 0.13], [x, y + s * 0.55]], colour, 7);
    line([[x - s * 0.25, y + s * 0.25], [x, y + s * 0.3], [x + s * 0.25, y + s * 0.22]], colour, 7);
    line([[x - s * 0.18, y + s * 0.95], [x, y + s * 0.55], [x + s * 0.18, y + s * 0.95]], colour, 7);
    dot(x - 6, y - 3, 3.5, C.black);
    dot(x + 6, y - 3, 3.5, C.black);
    line([[x - 9, y + 7], [x, y + 13], [x + 9, y + 7]], C.red, 4);
  };
  const house = (x, y, s) => {
    hatch(x + 6, y + 6, x + s - 6, y + s * 0.8 - 6, C.red, 10);
    line([[x, y], [x + s, y], [x + s, y + s * 0.8], [x, y + s * 0.8], [x, y]], C.brown, 9);
    line([[x - s * 0.12, y + 4], [x + s / 2, y - s * 0.55], [x + s * 1.12, y + 4]], C.purple, 12);
    hatch(x + s * 0.4, y + s * 0.45, x + s * 0.6, y + s * 0.8, C.purple, 7, 8);
    line([[x + s * 0.12, y + s * 0.15], [x + s * 0.32, y + s * 0.15], [x + s * 0.32, y + s * 0.35], [x + s * 0.12, y + s * 0.35], [x + s * 0.12, y + s * 0.15]], C.blue, 6);
  };
  const tree = (x, y, s) => {
    hatch(x - s * 0.07, y + s * 0.4, x + s * 0.07, y + s, C.brown, 8);
    for (let k = 0; k < 5; k++) line(ring(x + (r() - 0.5) * s * 0.4, y + s * 0.25 + (r() - 0.5) * s * 0.2, s * 0.22, s * 0.22, 24), C.green, 10);
    for (let k = 0; k < 4; k++) dot(x + (r() - 0.5) * s * 0.5, y + s * (0.1 + r() * 0.3), 10, C.red);
  };
  const flower = (x, y, s, colour) => {
    line([[x, y], [x + (r() - 0.5) * 20, y + s * 2.4]], C.green, 8);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      line(ring(x + Math.cos(a) * s * 0.6, y + Math.sin(a) * s * 0.6, s * 0.38, s * 0.38, 18), colour, 7);
    }
    line(ring(x, y, s * 0.25, s * 0.25, 14), C.yellow, 10);
  };
  const fish = (x, y, s, colour) => {
    line(ring(x, y, s, s * 0.55, 30), colour, 8);
    line([[x + s, y], [x + s * 1.5, y - s * 0.4], [x + s * 1.5, y + s * 0.4], [x + s, y]], colour, 8);
    dot(x - s * 0.5, y - s * 0.12, 5, C.black);
  };

  switch (piece.kind) {
    case 'family':
      ground();
      sun(w * 0.84, h * 0.22, 50);
      [C.blue, C.red, C.purple, C.green].forEach((c, i) => person(w * (0.18 + i * 0.19), h * (0.42 + (i % 2) * 0.05), h * (0.38 - i * 0.03), c));
      break;
    case 'house':
      ground();
      house(w * 0.22, h * 0.5, w * 0.46);
      sun(w * 0.16, h * 0.22, 46);
      tree(w * 0.84, h * 0.45, h * 0.38);
      break;
    case 'rainbow':
      [C.red, C.orange, C.yellow, C.green, C.blue, C.purple].forEach((c, i) => {
        const rad = Math.min(w, h) * 0.45 - i * 26;
        line(Array.from({ length: 41 }, (_, k) => [w / 2 + Math.cos((k / 40) * Math.PI) * rad, h * 0.8 - Math.sin((k / 40) * Math.PI) * rad]), c, 22);
      });
      line(ring(w * 0.15, h * 0.8, 55), C.grey, 14);
      line(ring(w * 0.85, h * 0.8, 55), C.grey, 14);
      break;
    case 'rocket': {
      for (let i = 0; i < 40; i++) dot(r() * w, r() * h, 3.5, C.yellow);
      const x = w / 2, y = h * 0.12, s = h * 0.6, bw = s * 0.3;
      hatch(x - bw / 2 + 8, y + s * 0.3, x + bw / 2 - 8, y + s * 0.85, C.grey, 10, 8);
      line([[x, y], [x + bw / 2, y + s * 0.3], [x + bw / 2, y + s * 0.85], [x - bw / 2, y + s * 0.85], [x - bw / 2, y + s * 0.3], [x, y]], C.blue, 9);
      line(ring(x, y + s * 0.45, bw * 0.2, bw * 0.2, 20), C.red, 7);
      for (const sx of [-1, 1]) line([[x + sx * bw / 2, y + s * 0.6], [x + sx * bw * 0.95, y + s * 0.95], [x + sx * bw / 2, y + s * 0.85]], C.red, 8);
      for (let k = 0; k < 5; k++) line([[x + (r() - 0.5) * bw * 0.6, y + s * 0.88], [x + (r() - 0.5) * bw * 0.8, y + s * (1.05 + r() * 0.15)]], C.orange, 10);
      break;
    }
    case 'cat': {
      const x = w / 2, y = h * 0.55, s = Math.min(w, h) * 0.25;
      line(ring(x, y, s), C.orange, 9);
      line([[x - s * 0.8, y - s * 0.55], [x - s * 0.6, y - s * 1.3], [x - s * 0.2, y - s * 0.95]], C.orange, 9);
      line([[x + s * 0.8, y - s * 0.55], [x + s * 0.6, y - s * 1.3], [x + s * 0.2, y - s * 0.95]], C.orange, 9);
      for (const sx of [-1, 1]) {
        dot(x + sx * s * 0.35, y - s * 0.25, 9, C.green);
        for (const k of [-1, 0, 1]) line([[x + sx * s * 0.3, y + s * 0.2], [x + sx * s * 1.4, y + s * (0.1 + k * 0.2)]], C.black, 3);
      }
      line([[x - s * 0.2, y + s * 0.35], [x, y + s * 0.45], [x + s * 0.2, y + s * 0.35]], C.pink, 5);
      line([[w * 0.1, h * 0.9], [w * 0.9, h * 0.88]], C.brown, 10);
      break;
    }
    case 'tree':
      ground();
      tree(w / 2, h * 0.3, h * 0.55);
      break;
    case 'scribble':
      for (const c of [C.red, C.blue, C.green, C.purple, C.orange, C.pink]) {
        let x = w * (0.2 + r() * 0.6), y = h * (0.2 + r() * 0.6);
        const pts = [];
        for (let i = 0; i < 30; i++) {
          x = Math.min(w - 30, Math.max(30, x + (r() - 0.5) * 180));
          y = Math.min(h - 30, Math.max(30, y + (r() - 0.5) * 180));
          pts.push([x, y]);
        }
        line(pts, c, 10);
      }
      break;
    case 'sun':
      sun(w / 2, h / 2, Math.min(w, h) * 0.2);
      break;
    case 'sea':
      hatch(20, h * 0.1, w - 20, h - 24, '#78b4e6', 10);
      [C.orange, C.yellow, C.pink, C.green].forEach((c, i) => fish(w * (0.2 + (i % 2) * 0.45), h * (0.25 + i * 0.18), 55, c));
      break;
    case 'flowers':
      ground();
      [C.red, C.pink, C.purple, C.orange, C.blue].forEach((c, i) => flower(w * (0.12 + i * 0.19), h * (0.42 + (r() - 0.5) * 0.15), 40, c));
      break;
    case 'night':
      out.push(`<rect width="${w}" height="${h}" fill="#232850" stroke="none"/>`);
      for (let i = 0; i < 60; i++) dot(r() * w, r() * h, 3.5, '#faf0b4');
      line(ring(w * 0.7, h * 0.3, 70), C.yellow, 14);
      house(w * 0.15, h * 0.6, w * 0.3);
      break;
    case 'boat': {
      hatch(20, h * 0.62, w - 20, h - 24, '#78b4e6', 11);
      sun(w * 0.82, h * 0.2, 46);
      const x = w * 0.42, y = h * 0.62;
      hatch(x - w * 0.18, y - 2, x + w * 0.18, y + h * 0.1, C.brown, 9);
      line([[x - w * 0.22, y], [x + w * 0.22, y], [x + w * 0.16, y + h * 0.12], [x - w * 0.16, y + h * 0.12], [x - w * 0.22, y]], C.brown, 10);
      line([[x, y], [x, y - h * 0.5]], C.black, 7);
      line([[x + 8, y - h * 0.48], [x + w * 0.2, y - h * 0.08], [x + 8, y - h * 0.08], [x + 8, y - h * 0.48]], C.red, 9);
      line([[x, y - h * 0.5], [x - w * 0.08, y - h * 0.46], [x, y - h * 0.42]], C.green, 7);
      for (let i = 0; i < 4; i++) line([[w * (0.1 + i * 0.22), h * 0.78], [w * (0.16 + i * 0.22), h * 0.75], [w * (0.22 + i * 0.22), h * 0.78]], '#3c78c8', 6);
      break;
    }
    case 'butterfly': {
      const x = w / 2, y = h / 2, s = Math.min(w, h) * 0.3;
      for (const sx of [-1, 1]) {
        line(ring(x + sx * s * 0.62, y - s * 0.35, s * 0.55, s * 0.45, 30), C.purple, 10);
        line(ring(x + sx * s * 0.5, y + s * 0.45, s * 0.38, s * 0.32, 26), C.pink, 10);
        dot(x + sx * s * 0.62, y - s * 0.35, 16, C.yellow);
        dot(x + sx * s * 0.5, y + s * 0.45, 12, C.orange);
        line([[x, y - s * 0.7], [x + sx * s * 0.3, y - s * 1.15]], C.black, 5);
      }
      line([[x, y - s * 0.75], [x, y + s * 0.8]], C.black, 12);
      for (let i = 0; i < 4; i++) flower(w * (0.12 + i * 0.25), h * 0.86, 16, [C.red, C.blue, C.orange, C.pink][i]);
      break;
    }
    case 'car': {
      hatch(20, h * 0.8, w - 20, h - 24, C.grey, 11);
      const x = w * 0.18, y = h * 0.42, cw = w * 0.64, ch = h * 0.24;
      hatch(x + 8, y + 8, x + cw - 8, y + ch - 8, C.red, 10);
      line([[x, y + ch], [x, y], [x + cw * 0.3, y], [x + cw * 0.4, y - ch * 0.7], [x + cw * 0.75, y - ch * 0.7], [x + cw * 0.85, y], [x + cw, y + ch * 0.15], [x + cw, y + ch], [x, y + ch]], C.red, 10);
      line([[x + cw * 0.44, y - ch * 0.55], [x + cw * 0.72, y - ch * 0.55], [x + cw * 0.78, y - 6], [x + cw * 0.4, y - 6], [x + cw * 0.44, y - ch * 0.55]], C.sky, 7);
      for (const wx of [0.22, 0.78]) {
        line(ring(x + cw * wx, y + ch, ch * 0.42), C.black, 12);
        dot(x + cw * wx, y + ch, 10, C.grey);
      }
      line(ring(x + cw * 0.55, y + ch * 0.45, ch * 0.22), C.yellow, 7);
      for (let i = 0; i < 3; i++) line([[x - 30 - i * 25, y + ch * (0.2 + i * 0.25)], [x - 90 - i * 25, y + ch * (0.2 + i * 0.25)]], C.grey, 7);
      break;
    }
    case 'snowman': {
      hatch(20, 24, w - 20, h - 24, '#cfe3f5', 12, 8);
      for (let i = 0; i < 50; i++) dot(r() * w, r() * h * 0.8, 6, '#ffffff');
      const x = w / 2;
      line(ring(x, h * 0.72, w * 0.25, w * 0.22), C.sky, 10);
      line(ring(x, h * 0.45, w * 0.18, w * 0.16), C.sky, 10);
      line(ring(x, h * 0.26, w * 0.12, w * 0.11), C.sky, 10);
      hatch(x - w * 0.12, h * 0.07, x + w * 0.12, h * 0.15, C.black, 8);
      line([[x - w * 0.18, h * 0.16], [x + w * 0.18, h * 0.16]], C.black, 10);
      line([[x - w * 0.16, h * 0.35], [x + w * 0.16, h * 0.36]], C.red, 16);
      line([[x + w * 0.1, h * 0.36], [x + w * 0.14, h * 0.45]], C.red, 14);
      line([[x, h * 0.27], [x + w * 0.12, h * 0.29], [x, h * 0.3]], C.orange, 7);
      dot(x - 18, h * 0.23, 7, C.black);
      dot(x + 18, h * 0.23, 7, C.black);
      for (const k of [0.42, 0.48, 0.66, 0.74]) dot(x, h * k, 9, C.black);
      line([[x - w * 0.17, h * 0.45], [x - w * 0.36, h * 0.36]], C.brown, 8);
      line([[x + w * 0.17, h * 0.45], [x + w * 0.36, h * 0.34]], C.brown, 8);
      break;
    }
    case 'balloons': {
      [C.red, C.blue, C.yellow, C.green, C.purple].forEach((c, i) => {
        const x = w * (0.2 + i * 0.15), y = h * (0.22 + (i % 2) * 0.1);
        hatch(x - 50, y - 50, x + 50, y + 50, c, 13, 8);
        line(ring(x, y, 70, 85, 30), c, 10);
        line([[x, y + 85], [x + (r() - 0.5) * 40, y + 250], [w * 0.5, h * 0.82]], C.black, 4);
      });
      person(w * 0.5, h * 0.72, h * 0.26, C.orange);
      break;
    }
    case 'fishbowl': {
      line(ring(w / 2, h * 0.55, w * 0.38, h * 0.36, 40), C.sky, 10);
      hatch(w * 0.16, h * 0.4, w * 0.84, h * 0.86, '#a8d4f0', 12, 8);
      line([[w * 0.3, h * 0.2], [w * 0.7, h * 0.2]], C.sky, 10);
      fish(w * 0.45, h * 0.55, 80, C.orange);
      for (const [bx, by, br] of [[0.62, 0.42, 12], [0.66, 0.33, 9], [0.6, 0.26, 7]]) line(ring(w * bx, h * by, br, br, 12), C.blue, 4);
      for (let i = 0; i < 4; i++) line([[w * (0.3 + i * 0.12), h * 0.86], [w * (0.3 + i * 0.12) + (r() - 0.5) * 30, h * 0.7]], C.green, 9);
      break;
    }
    case 'dino': {
      ground();
      line([[w * 0.2, h * 0.7], [w * 0.25, h * 0.45], [w * 0.5, h * 0.4], [w * 0.62, h * 0.25], [w * 0.75, h * 0.22], [w * 0.78, h * 0.32], [w * 0.65, h * 0.38], [w * 0.7, h * 0.7], [w * 0.2, h * 0.7]], C.green, 12);
      for (let i = 0; i < 5; i++) line([[w * (0.3 + i * 0.07), h * 0.44], [w * (0.3 + i * 0.07) + 15, h * 0.36], [w * (0.3 + i * 0.07) + 30, h * 0.43]], C.orange, 8);
      dot(w * 0.72, h * 0.26, 8, C.black);
      break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fbf8f0"/><g fill="none" stroke-linecap="round" stroke-linejoin="round">${out.join('')}</g></svg>`;
}
