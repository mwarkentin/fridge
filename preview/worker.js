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
  const { pathname } = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: NOT_SAVED }, 403);
  // The visitor is a parent in the first family.
  if (pathname === '/api/session') return json({ email: 'visitor@example.com', canEdit: true, preview: true, families: [FAMILIES[0].id] });
  if (pathname === '/api/gallery') return json(gallery(new Date()));
  if (pathname === '/api/comments') return json(talkSummary(new Date()));
  const talk = pathname.match(/^\/api\/pieces\/(\d+)\/comments$/);
  if (talk) {
    const id = Number(talk[1]);
    if (!PIECES.some((p) => p.id === id)) return json({ error: 'That isn’t on the fridge.' }, 404);
    return json(pieceTalk(new Date(), id));
  }
  if (pathname.startsWith('/api/')) return json({ error: 'There’s nothing at that address.' }, 404);
  const img = pathname.match(/^\/img\/(\d+)\/(thumb|display|original)$/);
  if (img) {
    const piece = PIECES.find((p) => p.id === Number(img[1]));
    if (!piece) return json({ error: 'There’s no piece with that id.' }, 404);
    return new Response(drawing(piece), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
  }
  const res = await env.ASSETS.fetch(request);
  if (pathname === '/' && (res.headers.get('Content-Type') || '').startsWith('text/html')) return markAsPreview(res);
  return res;
}

// The page itself, saying in its title and a strip across the top that it's
// a preview. The strip scrolls away under the header, so it covers nothing.
async function markAsPreview(res) {
  const strip = '<div style="padding:7px max(16px,env(safe-area-inset-right,0px)) 7px max(16px,env(safe-area-inset-left,0px));background:#1c2a30;color:#fff;font:700 13px/1.3 system-ui,sans-serif;text-align:center">Preview with a made-up family</div>';
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
  { id: 'oaks', name: 'The Oaks' },
  { id: 'willows', name: 'The Willows' },
];
const KIDS = [
  { id: 1, name: 'Ada', family: 'oaks', born: [8, 64] },
  { id: 2, name: 'Bo', family: 'oaks', born: [5, 288] },
  { id: 3, name: 'Cy', family: 'willows', born: [7, 150] },
  { id: 4, name: 'Dee', family: 'willows', born: [3, 200] },
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
// The same shape as the real /api/gallery, kids oldest first like the real one.
function gallery(today) {
  const kids = KIDS.map(({ id, name, family, born }) => ({ id, name, born: iso(back(today, born)), family })).sort((a, b) => (a.born < b.born ? -1 : a.born > b.born ? 1 : a.id - b.id));
  const pieces = PIECES.map(({ kind, ago, ...p }) => {
    const d = back(today, ago);
    if (p.made_precision === 'month') d.setUTCDate(15);
    if (p.made_precision === 'year') d.setUTCMonth(6, 1);
    const added = new Date(today.getTime() - (PIECES.length - p.id) * 36e5);
    return { ...p, made: iso(d > today ? today : d), source_name: null, created_at: added.toISOString().slice(0, 19).replace('T', ' ') };
  }).sort((a, b) => (a.made < b.made ? 1 : a.made > b.made ? -1 : b.id - a.id));
  return { families: FAMILIES, kids, pieces };
}

// ---- Made-up comments and stickers ----
// In the real Worker's shapes (talk() in src/worker.js). The visitor's
// sign-in is shared by two parents in the first family, Mum and Dad on its
// kids' art and Aunt Oak and Uncle Oak on the other family's, so the page
// says which of them is commenting. They've read up to comment 9, so the
// three after it are new. As parents in the first family, they could remove
// comments on its kids' art. The page keeps what the visitor adds to
// itself: the Worker above refuses every change.
const VISITOR_FAMILY = 'oaks';
// [id, piece, who, the kid it is (or none), minutes ago, what they said]
const COMMENTS = [
  [1, 4, 'Grandma', null, 4380, 'Look at those flames! Where is it going?'],
  [2, 4, 'Ada', 1, 4340, 'To the moon and then back for tea'],
  [3, 4, 'Pop', null, 2900, 'Can I come too? I’ll bring sandwiches.'],
  [4, 12, 'Auntie Jo', null, 1560, 'Crunchy is my new favourite dinosaur.'],
  [5, 12, 'Bo', 2, 1500, 'He is very hungry'],
  [6, 13, 'Nana', null, 1200, 'What a brave sailor! Where’s the island?'],
  [7, 13, 'Ada', 1, 1150, 'I like the flag'],
  [8, 18, 'Grandma', null, 300, 'One for everybody! Is there one for me?'],
  [9, 18, 'Dee', 4, 240, 'Yes the yellow one is yours'],
  [10, 1, 'Pop', null, 180, 'That hat is very like Grandma’s.'],
  [11, 8, 'Auntie Jo', null, 50, 'Hot! Hot! Hot! made me laugh out loud.'],
  [12, 20, 'Cy', 3, 20, 'Blub!'],
].map(([id, piece_id, by, kid_id, ago, body]) => ({ id, piece_id, by, kid_id, ago, body }));
const STICKERS = ['heart', 'star', 'wow', 'smile', 'rainbow'];
// Who gave which stickers to each piece.
const GIVEN = {
  1: { heart: ['Grandma', 'Pop', 'Nana', 'Auntie Jo'] },
  3: { rainbow: ['Grandma', 'Cy'] },
  4: { star: ['Grandma', 'Pop', 'Nana'], heart: ['Grandma'], wow: ['Bo', 'Cy'] },
  8: { smile: ['Auntie Jo', 'Bo'] },
  12: { wow: ['Auntie Jo', 'Ada'], smile: ['Pop'] },
  13: { star: ['Nana'], rainbow: ['Grandma'] },
  18: { heart: ['Grandma', 'Dee'], rainbow: ['Pop', 'Auntie Jo', 'Ada'] },
  20: { smile: ['Cy', 'Dee'] },
};
const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
function comment(today, c) {
  const kid = KIDS.find((k) => k.id === PIECES.find((p) => p.id === c.piece_id).kid_id);
  return { id: c.id, piece_id: c.piece_id, body: c.body, created_at: stamp(new Date(today.getTime() - c.ago * 6e4)), edited: false, by: c.by, kid_id: c.kid_id, mine: false, can_remove: kid.family === VISITOR_FAMILY };
}
const stickersOn = (id) => STICKERS.map((kind) => ({ kind, count: (GIVEN[id]?.[kind] || []).length, mine: [], by: GIVEN[id]?.[kind] || [] }));
function talkSummary(today) {
  const counts = {};
  for (const p of PIECES) {
    const on = COMMENTS.filter((c) => c.piece_id === p.id);
    const stickers = stickersOn(p.id).reduce((n, s) => n + s.count, 0);
    if (on.length || stickers) counts[p.id] = { comments: on.length, stickers, newest: Math.max(0, ...on.map((c) => c.id)) };
  }
  const latest = [...COMMENTS].sort((a, b) => b.id - a.id).slice(0, 8).map((c) => comment(today, c));
  return { me: { names: [{ name: 'Aunt Oak', home: 'Mum' }, { name: 'Uncle Oak', home: 'Dad' }], families: [VISITOR_FAMILY], kid: null, kid_id: null, seen: 9 }, newest: Math.max(...COMMENTS.map((c) => c.id)), counts, latest };
}
const pieceTalk = (today, id) => ({ comments: COMMENTS.filter((c) => c.piece_id === id).map((c) => comment(today, c)), stickers: stickersOn(id) });

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
