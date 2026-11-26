// The fridge's page: reads the gallery from /api/gallery, draws it, and lets
// parents edit details, mark favourites and add new pieces, for the kids in
// their own families (and kids in none), and lets a kid who's an artist add
// their own art and change the pieces they added. Everyone can give a piece
// stickers and comment on it.

import { arrange } from './families.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let KIDS = [];
let PIECES = [];
let CAN_EDIT = false;
// The public preview of a pull request (preview/worker.js), which saves nothing.
let PREVIEW = false;
// The kids by family, the viewer's own first (families.js). Until families
// are set up there are none, and the page is as it was before them.
let GROUPED = false;
let GROUPS = [];
// More than one family, so their names show.
let HEADS = false;
let MY_FAMILIES = [];
let ARTIST = null; // the kid's name, for a kid signed in to add their own art
// An owner, who can look at the fridge as someone else (ADMINS), and while
// they are, whom: { name, detail, as }. Everything else on the page is then
// that person's, with nothing to change: the Worker refuses every change.
let OWNER = false;
let VIEWING = null;
let MINE = new Set(); // the pieces that artist added
// The Worker's rules, so the page offers only what it would allow: a parent
// can change a kid's pieces if the kid is in one of the parent's families
// or in none; an artist can add their own art, and change the pieces they
// added.
const canChange = (kid) => CAN_EDIT && (kid?.family == null || MY_FAMILIES.includes(kid.family));
const isArtist = (kid) => ARTIST != null && kid != null && kid.name.trim().toLowerCase() === ARTIST.trim().toLowerCase();
const canAddFor = (kid) => canChange(kid) || isArtist(kid);
const canChangePiece = (p) => canChange(kidOf(p)) || (isArtist(kidOf(p)) && MINE.has(p.id));

// ---- API ----
async function api(path, { method = 'GET', json, body } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Requested-With'] = 'fridge';
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch {
    // Most often an expired sign-in: Access redirects to its sign-in page,
    // which fetch can't follow.
    throw new Error('Couldn’t reach the fridge. Reload the page to sign in again.');
  }
  if (!res.ok) {
    let msg = `Something went wrong (HTTP ${res.status}).`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// ---- Dates and ages ----
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const todayISO = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const ymd = (s) => s.split('-').map(Number);
const asDate = (s) => {
  const [y, m, d] = ymd(s);
  return new Date(y, m - 1, d);
};
function months(from, to) {
  const [y1, m1, d1] = ymd(from);
  const [y2, m2, d2] = ymd(to);
  let m = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) m--;
  return m;
}
function ageLabel(born, on) {
  const m = Math.max(0, months(born, on));
  return `age ${Math.floor(m / 12)}${['', '¼', '½', '¾'][Math.floor((m % 12) / 3)]}`;
}
const ageNow = (kid) => Math.floor(months(kid.born, todayISO) / 12);
const fmt = (s, opts) => asDate(s).toLocaleDateString(undefined, opts);
const madeLong = (p) => (p.made_precision === 'year' ? p.made.slice(0, 4) : p.made_precision === 'month' ? fmt(p.made, { year: 'numeric', month: 'long' }) : fmt(p.made, { year: 'numeric', month: 'long', day: 'numeric' }));
const madeShort = (p) => (p.made_precision === 'year' ? p.made.slice(0, 4) : fmt(p.made, { year: 'numeric', month: 'short' }));
const doy = (d) => Math.round((d - new Date(d.getFullYear(), 0, 1)) / 864e5);
const byMadeDesc = (a, b) => (a.made < b.made ? 1 : a.made > b.made ? -1 : b.id - a.id);
const kidOf = (p) => KIDS.find((k) => k.id === p.kid_id);
const titleOf = (p) => p.title || 'Untitled';
const img = (p, variant) => `/img/${p.id}/${variant}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- Little pictures: icons, doodles and magnets, from the sprite in index.html ----
const icon = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const doodle = (name, cls = '') => `<svg class="doodle${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#d-${name}"/></svg>`;
const said = (story) => `<blockquote class="said">“${esc(story)}”</blockquote>`;
const kidStyle = (kid) => `--kid:${kid.colour};--kid-soft:${kid.soft}`;
// A kid's round magnet, with the first letter of their name.
const avatar = (kid) => `<i class="av" aria-hidden="true" style="${kidStyle(kid)}">${esc((Array.from(kid.name.trim())[0] || '?').toLocaleUpperCase())}</i>`;
// A word spelled out in plastic letter magnets. Screen readers get the plain word.
function magnetWord(text, start = 0) {
  let n = 0;
  const letters = Array.from(String(text)).map((ch) => (/\s/.test(ch) ? '<span class="gap"></span>' : `<b class="mg-${(start + n++) % 6}">${esc(ch)}</b>`));
  return `<span class="sr">${esc(text)}</span><span class="magnets" aria-hidden="true">${letters.join('')}</span>`;
}
// A crayon squiggle under a heading, a different colour each time.
const SQUIGGLES = ['orange', 'blue', 'green', 'pink', 'purple', 'red'];
let squiggles = 0;
const squiggle = () => `<svg class="squig" viewBox="0 0 120 14" preserveAspectRatio="none" aria-hidden="true" style="--c:var(--cr-${SQUIGGLES[squiggles++ % SQUIGGLES.length]})"><use href="#d-squiggle"/></svg>`;
const EMPTY_ART = `<svg class="empty-art" viewBox="0 0 240 224" aria-hidden="true">
  <path class="ink door" d="M66 14c34-3 74-3 108 0 7 .6 10 4 10 11l1 166c0 7-3 10-10 10.6-36 2.4-73 2.4-109 0-7-.6-10-4-10-10.6l1-166c0-7 3-10.4 9-11z"/>
  <path class="ink" d="M57 70c42 2.4 84 2.4 127 0M170 32v24M170 88v44M82 203v9M158 203v9"/>
  <path class="tape-fill" d="M99 85.5l27-2.2.8 9.5-27 2.2z"/>
  <path class="ink dash" d="M84 93l58-4.2 4.4 70-58 4.2z"/>
  <use href="#m-heart" x="84" y="28" width="30" height="27"/>
  <circle class="fill-blue" cx="138" cy="44" r="9"/><circle cx="135" cy="41" r="3" fill="#fff" fill-opacity=".6"/>
  <circle class="fill-yellow" cx="152" cy="176" r="8"/><circle cx="149.5" cy="173.5" r="2.6" fill="#fff" fill-opacity=".6"/>
  <text class="mg-text" x="98" y="192">A</text><text class="mg-text b" x="118" y="190">B</text>
  <g transform="rotate(-22 206 200)"><rect class="fill-red" x="184" y="194" width="38" height="11" rx="2"/><path class="fill-red" d="M222 194l11 5.5-11 5.5z"/><path d="M192 194v11M214 194v11" stroke="#fff" stroke-opacity=".5" stroke-width="2"/></g>
  <use class="st st-yellow" href="#d-sparkle" x="16" y="36" width="24" height="24"/>
  <use class="st st-pink" href="#d-star" x="198" y="20" width="26" height="26"/>
  <use class="st st-blue" href="#d-heart" x="14" y="148" width="28" height="28"/>
</svg>`;

// Each piece hangs at its own slight angle, by tape or a magnet, the same every time.
const MAGNETS = ['blue', 'green', 'yellow', 'purple', 'orange'];
function tilt(id) {
  let a = id * 2654435761;
  const r = () => ((a = (a ^ (a >>> 15)) * 2246822519 + 1013904223) >>> 0) / 4294967296;
  return { tilt: ((r() - 0.5) * 4.4).toFixed(2), tape: ((r() - 0.5) * 6).toFixed(1), tx: Math.round((r() - 0.5) * 24), magnet: r() < 0.3 ? MAGNETS[Math.floor(r() * MAGNETS.length)] : null };
}

// ---- Views ----
const view = $('#view');
let route = null;
let filter = 'all';
let listCtx = [];
let current = null;
let opener = null;
let tagQuery = '';

// ---- Tags ----
// A tag's own address: #tag/<name>. Kids' slugs are kid-<id>, so it can't
// collide with one.
const TAG_ROUTE = 'tag/';
const tagHref = (t) => `#${TAG_ROUTE}${esc(encodeURIComponent(t))}`;
const sameTag = (t) => String(t).normalize('NFC').trim().toLowerCase();
// For the filter box: ignore case and accents, so "ete" finds "été".
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Each tag keeps its own crayon for its border, the same everywhere.
const TAG_CRAYONS = ['blue', 'orange', 'green', 'pink', 'purple', 'red'];
function tagCrayon(t) {
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_CRAYONS[h % TAG_CRAYONS.length];
}
// Every tag in use, with how many pieces have it: most used first.
function tagCounts() {
  const counts = new Map();
  for (const p of PIECES) for (const t of new Set(p.tags)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
// A tag as a sticker you can tap. The link is 44px tall; the sticker inside looks smaller.
const tagLink = (t, n) =>
  `<a class="tag" href="${tagHref(t)}" style="--tc:var(--cr-${tagCrayon(t)})" data-fold="${esc(fold(t))}"${n ? ` aria-label="${esc(t)}, ${plural(n, 'piece')}"` : ''}><span class="tag-s">${icon('tag')}<span class="tag-n">${esc(t)}</span>${n ? `<b class="tag-c" aria-hidden="true">${n}</b>` : ''}</span></a>`;
function tagCloud(tags, { box = true } = {}) {
  const filterable = box && tags.length > 12;
  return `${filterable ? `<label class="field tag-find">${icon('look')}<span class="sr">Find a tag</span><input type="search" id="tag-find" placeholder="Find a tag" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" value="${esc(tagQuery)}"></label>` : ''}<ul class="tag-cloud">${tags.map(([t, n]) => `<li>${tagLink(t, n)}</li>`).join('')}</ul><p class="empty-line tag-none" hidden>${doodle('heart')}No tags match that.</p>`;
}
// Narrow the stickers to the ones matching the filter box, without redrawing the page.
function applyTagQuery() {
  const q = fold(tagQuery.trim());
  let shown = 0;
  document.querySelectorAll('#view .tag-cloud li').forEach((li) => {
    const hit = !q || li.firstElementChild.dataset.fold.includes(q);
    li.hidden = !hit;
    if (hit) shown++;
  });
  const none = $('#view .tag-none');
  if (none) none.hidden = shown > 0;
}

function pieceButton(p, variant = 'thumb') {
  const kid = kidOf(p);
  const t = tilt(p.id);
  // Favourites hang by a red heart; the rest by masking tape or a plain magnet.
  const hanger = p.favourite
    ? '<svg class="heart" aria-hidden="true"><use href="#m-heart"/></svg>'
    : t.magnet
      ? `<span class="magnet" aria-hidden="true" style="--m:var(--cr-${t.magnet});--tx:${Math.round(t.tx / 2)}px"></span>`
      : `<span class="tape" aria-hidden="true" style="--tx:${t.tx}px"></span>`;
  return `<button class="piece" type="button" data-id="${p.id}" style="--tilt:${t.tilt}deg;--tape:${t.tape}deg;--ar:${p.width}/${p.height}" aria-label="${esc(titleOf(p))} by ${esc(kid?.name)}${p.favourite ? ', a favourite' : ''}">${hanger}<img src="${img(p, variant)}" alt="" loading="lazy" width="${p.width}" height="${p.height}"></button>`;
}
function tile(p, opts = {}) {
  const kid = kidOf(p);
  const meta = opts.own ? `${ageLabel(kid.born, p.made)} · ${madeShort(p)}` : `${kid.name} · ${ageLabel(kid.born, p.made)}`;
  const fav = p.favourite ? icon('heart', 'filled fav-mark') : '';
  return `<figure>${pieceButton(p)}<figcaption><span class="t${p.title ? '' : ' untitled'}">${esc(titleOf(p))}${fav}</span><span class="m">${opts.own ? '' : avatar(kid)}<span>${esc(meta)}${opts.ago ? ` · ${opts.ago(p)}` : ''}</span></span>${talkLine(p)}</figcaption></figure>`;
}
const wall = (list, opts) => `<div class="wall">${list.map((p) => tile(p, opts)).join('')}</div>`;
// A filter button, with a kid's magnet or an icon beside the word.
// With `count`, the round magnet shows how many pieces instead of a letter or icon.
const chip = (value, label, { kid, pic, style, cls = '', count } = {}) =>
  `<button class="chip${kid || count != null ? ' has-av' : ''}${cls ? ` ${cls}` : ''}" type="button" data-filter="${esc(value)}" aria-pressed="${filter === value}"${count != null ? ` aria-label="${esc(label)}, ${plural(count, 'piece')}"` : ''}${kid || style ? ` style="${kid ? kidStyle(kid) : style}"` : ''}>${count != null ? `<i class="av av-count" aria-hidden="true"${kid ? ` style="${kidStyle(kid)}"` : ''}>${count}</i>` : kid ? avatar(kid) : pic ? icon(pic) : ''}${esc(label)}</button>`;
// A family's name on a strip of masking tape, as a heading or beside its kids.
const famTag = (g, tag = 'span', attrs = '') => `<${tag} class="fam-tag"${attrs}>${esc(g.label)}</${tag}>`;
// The kids' filter chips, in the page's order. When they come from more than
// one family, each family's chips stay together, after its name.
function kidChips(kids, opts = () => ({})) {
  const one = (k) => chip(String(k.id), k.name, { kid: k, ...opts(k) });
  const groups = HEADS ? GROUPS.map((g) => ({ ...g, kids: g.kids.filter((k) => kids.includes(k)) })).filter((g) => g.kids.length) : [];
  if (groups.length < 2) return kids.map(one).join('');
  return groups.map((g) => `<span class="chip-fam" role="group" aria-label="${esc(g.label)}">${famTag(g, 'span', ' aria-hidden="true"')}${g.kids.map(one).join('')}</span>`).join('');
}
function yearsSpan(list) {
  const ys = list.map((p) => +p.made.slice(0, 4));
  const a = Math.min(...ys);
  const b = Math.max(...ys);
  return a === b ? `${a}` : `${a}–${String(b).slice(2)}`;
}

function emptyFridge() {
  if (!KIDS.length) {
    return CAN_EDIT
      ? `<section class="empty-state">${EMPTY_ART}<h1>The fridge is empty</h1><p>The kids come from <code>fridge_people.auto.tfvars</code> in mwarkentin/infra, and show up here after the next deploy.</p><p>Then bring in the scans from Dropbox with <code>uv run scripts/fridge.py import</code>. The README has the details.</p></section>`
      : `<section class="empty-state">${EMPTY_ART}<h1>The fridge is empty</h1><p>Nothing’s been hung up yet. Check back soon.</p></section>`;
  }
  return KIDS.some(canAddFor)
    ? `<section class="empty-state">${EMPTY_ART}<h1>Nothing on the fridge yet</h1><p>Hang the first piece up here, or bring in the scans from Dropbox with:</p><code class="cmd">uv run scripts/fridge.py import</code><p><button class="btn primary" type="button" data-add>${icon('plus')}Add art</button></p></section>`
    : `<section class="empty-state">${EMPTY_ART}<h1>Nothing on the fridge yet</h1><p>Nothing’s been hung up yet. Check back soon.</p></section>`;
}

function onThisDay() {
  const t = asDate(todayISO);
  const ty = t.getFullYear();
  const td = doy(t);
  return PIECES.filter((p) => {
    if (p.made_precision === 'year') return false;
    const d = asDate(p.made);
    if (d.getFullYear() >= ty) return false;
    const diff = Math.abs(doy(d) - td);
    return Math.min(diff, 365 - diff) <= (p.made_precision === 'month' ? 15 : 21);
  }).sort(byMadeDesc);
}

function viewHome() {
  if (!PIECES.length) return emptyFridge();
  const favs = PIECES.filter((p) => p.favourite).sort(byMadeDesc);
  const pool = favs.length ? favs : [...PIECES].sort(byMadeDesc).slice(0, 12);
  const f = pool[Math.floor(Date.now() / 864e5) % pool.length];
  const kid = kidOf(f);
  const otd = onThisDay();
  const ty = now.getFullYear();
  const ago = (p) => {
    const n = ty - +p.made.slice(0, 4);
    return `${plural(n, 'year')} ago`;
  };
  const tags = tagCounts();
  const newest = [...PIECES].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id)).slice(0, 6);
  return `
    <section class="hero">
      <div class="hero-art">${doodle('star', 'd1')}${doodle('sparkle', 'd2')}${doodle('zigzag', 'd3')}${pieceButton(f, 'display')}</div>
      <div class="hero-copy" style="${kidStyle(kid)}">
        <p class="eyebrow">${icon('star')}On the fridge today</p>
        <h1>${esc(titleOf(f))}</h1>
        <p class="label-line">${avatar(kid)}${esc(kid.name)}, ${ageLabel(kid.born, f.made)} · ${madeLong(f)}</p>
        ${f.story ? said(f.story) : ''}
        ${f.medium ? `<p class="sub">${icon('crayon')}${esc(f.medium)}</p>` : ''}
        <div class="row"><button class="btn primary" type="button" data-open="${f.id}">${icon('look')}Look closer</button><button class="btn" type="button" data-frame>${icon('play')}Play favourites</button></div>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2>The artists${squiggle()}</h2></div>
      ${artists()}
    </section>
    ${otd.length ? `<section data-scope><div class="sec-head"><h2>This time of year${squiggle()}</h2><span class="count">${now.toLocaleDateString(undefined, { month: 'long' })}, in other years</span></div>${wall(otd, { ago })}</section>` : ''}
    <section data-scope><div class="sec-head"><h2>Just added${squiggle()}</h2><a href="#timeline">See everything${icon('right')}</a></div>${wall(newest)}</section>
    ${latestComments()}
    ${tags.length ? `<section class="tag-sec" aria-labelledby="tags-h"><div class="sec-head"><h2 id="tags-h">Tags${squiggle()}</h2><span class="count">${plural(tags.length, 'tag')}, tap one to see them all</span></div>${tagCloud(tags)}</section>` : ''}
    <p class="footnote"><svg class="doodle" aria-hidden="true"><use href="#i-heart"/></svg>Only family can see the fridge. <a href="/cdn-cgi/access/logout">${icon('door')}Sign out</a></p>`;
}

// The artists' cards. With more than one family, each family's under its
// name. With families, they're two to a row at every width, so a family's
// two kids fill the page side by side.
function artists() {
  const pairs = GROUPED && KIDS.length > 1;
  const cards = (kids, h) => `<div class="kids${pairs ? ' pairs' : ''}">${kids.map((k) => kidCard(k, { h, pairs })).join('')}</div>`;
  if (!HEADS) return cards(KIDS, 'h3');
  return GROUPS.map((g) => `<div class="fam">${famTag(g, 'h3')}${cards(g.kids, 'h4')}</div>`).join('');
}

function kidCard(kid, { h = 'h3', pairs = false } = {}) {
  const mine = PIECES.filter((p) => p.kid_id === kid.id).sort(byMadeDesc);
  const thumbs = mine.slice(0, 3).map((p) => `<img src="${img(p, 'thumb')}" alt="" loading="lazy">`);
  while (thumbs.length < 3) thumbs.push('<span></span>');
  const since = mine.length ? ` since ${mine[mine.length - 1].made.slice(0, 4)}` : '';
  return `<a class="kid-card" href="#${kid.slug}" style="${kidStyle(kid)}">
    <div class="kid-top">${avatar(kid)}<div><${h}>${esc(kid.name)}</${h}><ul class="facts"><li>${icon('cake')}${ageNow(kid)} years old</li><li>${icon('pictures')}${plural(mine.length, 'piece')}${since && pairs ? `<span class="since">${since}</span>` : since}</li></ul></div></div>
    <div class="kid-thumbs">${thumbs.join('')}</div>
  </a>`;
}

function viewKid(kid) {
  const mine = PIECES.filter((p) => p.kid_id === kid.id).sort(byMadeDesc);
  const mediums = [...new Set(mine.map((p) => p.medium).filter(Boolean))].sort();
  const shown = mine.filter((p) => filter === 'all' || (filter === 'fav' ? p.favourite : p.medium === filter));
  const groups = new Map();
  for (const p of shown) {
    const a = Math.floor(Math.max(0, months(kid.born, p.made)) / 12);
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(p);
  }
  const body = groups.size
    ? [...groups].map(([age, list]) => `<section><div class="sec-head"><h2>Age <span class="num mg-${age % 6}">${age}</span></h2><span class="count">${yearsSpan(list)} · ${plural(list.length, 'piece')}</span></div>${wall(list, { own: true })}</section>`).join('')
    : `<p class="empty-line">${doodle('heart')}${mine.length ? 'Nothing matches that.' : `Nothing of ${esc(kid.name)}’s is on the fridge yet.`}</p>`;
  const favs = mine.filter((p) => p.favourite).length;
  return `
    <section class="kid-head" style="${kidStyle(kid)}">
      <h1>${magnetWord(kid.name, kid.ci)}</h1>
      <ul class="facts">${HEADS && kid.familyName ? `<li>${icon('home')}${esc(kid.familyName)}</li>` : ''}<li>${icon('cake')}${ageNow(kid)} years old</li><li>${icon('calendar')}Born ${fmt(kid.born, { year: 'numeric', month: 'long' })}</li><li>${icon('pictures')}${plural(mine.length, 'piece')}</li>${favs ? `<li class="fav">${icon('heart', 'filled')}${plural(favs, 'favourite')}</li>` : ''}</ul>
    </section>
    ${mine.length ? `<div class="chips" role="group" aria-label="Show">${chip('all', 'All', { pic: 'pictures' })}${chip('fav', 'Favourites', { pic: 'heart', cls: 'fav', style: '--kid:var(--tab-home)' })}${mediums.map((m) => chip(m, m, { pic: 'crayon' })).join('')}</div>` : ''}
    <div class="groups" data-scope>${body}</div>`;
}

function viewTimeline() {
  if (!PIECES.length) return emptyFridge();
  const shown = PIECES.filter((p) => filter === 'all' || String(p.kid_id) === filter).sort(byMadeDesc);
  const years = new Map();
  for (const p of shown) {
    const y = p.made.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(p);
  }
  return `
    <section class="page-head"><h1>${magnetWord('Timeline', 4)}</h1><p>${plural(PIECES.length, 'piece')}, ${yearsSpan(PIECES)}</p></section>
    <div class="chips" role="group" aria-label="Show">${chip('all', 'Everyone', { pic: 'pictures' })}${kidChips(KIDS)}</div>
    <div class="groups" data-scope>${[...years].map(([y, list]) => `<section class="year"><div class="sec-head"><h2>${magnetWord(y, Number(y))}</h2><span class="count">${plural(list.length, 'piece')}</span></div>${wall(list)}</section>`).join('')}</div>`;
}

function viewTag(name) {
  const tagged = PIECES.filter((p) => p.tags.some((t) => sameTag(t) === name)).sort(byMadeDesc);
  const kids = KIDS.filter((k) => tagged.some((p) => p.kid_id === k.id));
  if (filter !== 'all' && !kids.some((k) => String(k.id) === filter)) filter = 'all';
  const shown = tagged.filter((p) => filter === 'all' || String(p.kid_id) === filter);
  const head = `<section class="page-head tag-head" style="--tc:var(--cr-${tagCrayon(name)})"><p class="eyebrow">${icon('tag')}Tagged</p><h1 tabindex="-1"><span class="tag-big">${esc(name)}</span></h1>`;
  if (!tagged.length) {
    const others = tagCounts();
    return `${head}</section>
      <section class="empty-state tag-empty">${EMPTY_ART}<h2>Nothing’s tagged “${esc(name)}” right now</h2><p>${others.length ? 'Maybe it was changed or taken off. Try one of these:' : 'Nothing on the fridge has a tag yet.'}</p></section>
      ${others.length ? `<section class="tag-sec">${tagCloud(others)}</section>` : ''}
      <p><a class="btn" href="#home">${icon('home')}Back to the fridge</a></p>`;
  }
  return `${head}<p>${plural(tagged.length, 'piece')}${kids.length > 1 ? ` by ${kids.length} artists` : ` by ${esc(kids[0].name)}`}, ${yearsSpan(tagged)}</p></section>
    ${kids.length > 1 ? `<div class="chips" role="group" aria-label="Show">${chip('all', 'Everyone', { count: tagged.length })}${kidChips(kids, (k) => ({ count: tagged.filter((p) => p.kid_id === k.id).length }))}</div>` : ''}
    <section data-scope>${wall(shown)}</section>`;
}

// The tag named in a #tag/<name> address, or null.
function tagFromHash(h) {
  if (!h.startsWith(TAG_ROUTE)) return null;
  const raw = h.slice(TAG_ROUTE.length);
  try {
    return sameTag(decodeURIComponent(raw));
  } catch {
    return sameTag(raw);
  }
}

function render() {
  squiggles = 0;
  const h = location.hash.slice(1) || 'home';
  const tag = tagFromHash(h);
  const kid = tag === null && KIDS.find((k) => k.slug === h);
  const r = tag !== null ? TAG_ROUTE + tag : kid ? h : h === 'timeline' ? 'timeline' : 'home';
  const moved = r !== route;
  const firstLoad = route === null;
  if (moved) {
    if (route !== null) window.scrollTo(0, 0);
    route = r;
    filter = 'all';
  }
  view.innerHTML = tag !== null ? viewTag(tag) : kid ? viewKid(kid) : r === 'timeline' ? viewTimeline() : viewHome();
  applyTagQuery();
  // Arriving at a tag, start reading (and tabbing) from its name.
  if (moved && !firstLoad && tag !== null && detail.hidden) $('#view h1')?.focus({ preventScroll: true });
  document.querySelectorAll('#tabs a, #kids-menu a').forEach((a) => (a.dataset.route === r ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (GROUPED) kidsButton(kid);
  // On a phone the tabs scroll sideways: keep the current one in sight.
  const tab = $('#tabs [aria-current]');
  const tabs = $('#tabs');
  if (tab && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = Math.max(0, tab.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2);
}

// ---- The tabs, with families ----
// The kids' tabs go in family groups. When the tabs don't fit on one line (on
// a phone, or with long names), the kids move into a menu behind one tab,
// and then the tabs drop their words one at a time, keeping their magnets.
// Each step is tried in turn until the tabs fit, so there's never sideways
// scrolling, whatever the names.
const topBar = $('.bar');
const FIT = [[], ['fit-row'], ['fit-menu'], ['fit-menu', 'fit-no-home'], ['fit-menu', 'fit-no-home', 'fit-no-kids'], ['fit-menu', 'fit-no-home', 'fit-no-kids', 'fit-no-timeline']];
const FIT_CLASSES = [...new Set(FIT.flat())];
let kidsMenu = null;
function groupedTabs(section, kidTab) {
  return `${section('home', 'Home', 'home')}${section('timeline', 'Timeline', 'calendar')}${GROUPS.map((g) => `<span class="tab-fam"${HEADS ? ` role="group" aria-label="${esc(g.label)}"` : ''}>${g.kids.map(kidTab).join('')}</span>`).join('')}<button class="kids-btn" id="kids-btn" type="button" aria-expanded="false" aria-controls="kids-menu"></button>`;
}
function buildKidsMenu() {
  if (!kidsMenu) {
    kidsMenu = document.createElement('nav');
    kidsMenu.id = 'kids-menu';
    kidsMenu.className = 'kids-menu';
    kidsMenu.setAttribute('aria-label', 'Kids');
    kidsMenu.hidden = true;
    kidsMenu.addEventListener('click', (e) => {
      if (e.target.closest('a')) setKidsMenu(false);
    });
    // Right after the tabs, so Tab goes from its tab into it.
    $('#tabs').after(kidsMenu);
  }
  kidsMenu.innerHTML = GROUPS.map((g, i) => `<div class="km-fam">${HEADS ? famTag(g, 'p', ` id="km-${i}"`) : ''}<ul${HEADS ? ` aria-labelledby="km-${i}"` : ''}>${g.kids.map((k) => `<li><a href="#${k.slug}" data-route="${k.slug}" style="${kidStyle(k)}">${avatar(k)}${esc(k.name)}</a></li>`).join('')}</ul></div>`).join('');
}
// The menu's tab: the kid whose wall this is, or the first few kids' magnets.
let kidsButtonFor = null;
function kidsButton(kid) {
  kidsButtonFor = kid || null;
  const b = $('#kids-btn');
  const chev = '<svg class="i chev" aria-hidden="true"><use href="#i-right"/></svg>';
  b.classList.toggle('on', Boolean(kid));
  if (kid) b.setAttribute('style', kidStyle(kid));
  else b.removeAttribute('style');
  b.innerHTML = kid
    ? `${avatar(kid)}<span class="sr">Kids: </span><span class="lbl">${esc(kid.name)}</span>${chev}`
    : `<span class="kids-stack" aria-hidden="true">${KIDS.slice(0, 3).map((k) => avatar(k)).join('')}</span><span class="lbl">Kids</span>${chev}`;
}
// The menu's tab is measured at its widest (the longest name, or "Kids"), so
// the tabs keep the same words from page to page.
function fitTabs() {
  if (!GROUPED) return;
  const tabs = $('#tabs');
  const b = $('#kids-btn');
  const showing = kidsButtonFor;
  topBar.classList.remove(...FIT_CLASSES);
  topBar.classList.add('fit-menu');
  let widest = null;
  let most = -1;
  for (const k of [null, ...KIDS]) {
    kidsButton(k);
    if (b.offsetWidth > most) [widest, most] = [k, b.offsetWidth];
  }
  kidsButton(widest);
  for (const level of FIT) {
    topBar.classList.remove(...FIT_CLASSES);
    topBar.classList.add(...level);
    if (tabs.scrollWidth <= tabs.clientWidth + 1) break;
  }
  kidsButton(showing);
  if (!topBar.classList.contains('fit-menu')) setKidsMenu(false);
  else if (kidsMenu && !kidsMenu.hidden) placeKidsMenu();
}
function setKidsMenu(open) {
  if (!kidsMenu) return;
  kidsMenu.hidden = !open;
  $('#kids-btn')?.setAttribute('aria-expanded', String(open));
  if (open) placeKidsMenu();
}
// Under its tab, as far as the screen allows.
function placeKidsMenu() {
  const b = $('#kids-btn').getBoundingClientRect();
  const r = topBar.getBoundingClientRect();
  const gutter = Math.max(16, parseFloat(getComputedStyle($('.bar-inner')).paddingLeft) || 0);
  const left = Math.min(b.left - r.left - 4, r.width - kidsMenu.offsetWidth - gutter);
  kidsMenu.style.setProperty('--km-left', `${Math.round(Math.max(gutter, left))}px`);
}
$('#tabs').addEventListener('click', (e) => {
  if (e.target.closest('#kids-btn')) setKidsMenu(kidsMenu.hidden);
});
document.addEventListener('click', (e) => {
  if (kidsMenu && !kidsMenu.hidden && !e.target.closest('#kids-menu, #kids-btn')) setKidsMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !kidsMenu || kidsMenu.hidden) return;
  setKidsMenu(false);
  $('#kids-btn').focus();
});
// Tabbing away closes it. (A tap elsewhere is the click above: Safari doesn't
// move focus on a tap, so this only acts when focus goes somewhere.)
topBar.addEventListener('focusout', (e) => {
  if (kidsMenu && !kidsMenu.hidden && e.relatedTarget instanceof Element && !e.relatedTarget.closest('#kids-menu, #kids-btn')) setKidsMenu(false);
});
window.addEventListener('hashchange', () => setKidsMenu(false));
let fitWidth = innerWidth;
window.addEventListener('resize', () => {
  if (innerWidth === fitWidth) return;
  fitWidth = innerWidth;
  fitTabs();
});
// Words change width when the fonts arrive.
document.fonts?.addEventListener?.('loadingdone', () => fitTabs());

function buildChrome() {
  document.body.classList.toggle('can-edit', CAN_EDIT || ARTIST != null);
  // Every tab has a round magnet: a kid's initial, or an icon for those who can't read yet.
  const section = (id, label, pic) => `<a href="#${id}" data-route="${id}" style="--kid:var(--tab-${id})"><i class="av" aria-hidden="true">${icon(pic)}</i>${GROUPED ? `<span class="lbl">${label}</span>` : label}</a>`;
  const kidTab = (k) => `<a href="#${k.slug}" data-route="${k.slug}" style="${kidStyle(k)}">${avatar(k)}${esc(k.name)}</a>`;
  topBar.classList.toggle('grouped', GROUPED);
  topBar.classList.toggle('heads', HEADS);
  if (GROUPED) {
    $('#tabs').innerHTML = groupedTabs(section, kidTab);
    buildKidsMenu();
    fitTabs();
  } else {
    $('#tabs').innerHTML = section('home', 'Home', 'home') + section('timeline', 'Timeline', 'calendar') + KIDS.map(kidTab).join('');
    if (kidsMenu) {
      kidsMenu.remove();
      kidsMenu = null;
      topBar.classList.remove(...FIT_CLASSES);
    }
  }
  // Only the kids this parent (or artist) can add art for, or move a piece to.
  const mine = addableKids();
  $('#f-kid').innerHTML = mine.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
  $('#open-add').hidden = !mine.length;
  $('#open-frame').hidden = !PIECES.length;
}

async function load() {
  // Without comments (a database from before them), the page is as it was.
  const [session, data, talk, notes] = await Promise.all([api('/api/session'), api('/api/gallery'), api('/api/comments').catch(() => null), api('/api/notifications').catch(() => null)]);
  TALK = talk;
  // New marks are for this whole visit: since how far they'd caught up when
  // it began. On a first visit nothing is new yet.
  if (TALK && SEEN === null) SEEN = TALK.me.seen ?? NEVER;
  if (notes) NOTES = notes;
  OWNER = Boolean(session.owner);
  VIEWING = session.viewing ?? null;
  // Looking as someone, nothing is offered that would change anything.
  CAN_EDIT = session.canEdit && !VIEWING;
  PREVIEW = Boolean(session.preview);
  MY_FAMILIES = session.families || [];
  ARTIST = VIEWING ? null : (session.artist ?? null);
  MINE = new Set(VIEWING ? [] : data.mine || []);
  showViewing();
  const families = arrange(data.kids, data.families, session.families);
  ({ grouped: GROUPED, heads: HEADS, groups: GROUPS, kids: KIDS } = families);
  for (const k of KIDS) Object.assign(k, { colour: `var(--kid-${k.ci})`, soft: `var(--kid-${k.ci}-soft)`, slug: `kid-${k.id}` });
  PIECES = data.pieces;
  buildChrome();
  render();
  drawBell();
  // Opening the fridge catches someone up, so next time only newer things
  // are new, unless something's waiting for them in the bell: then that
  // waits, and the walls' New marks with it, until they open it. Not while
  // viewing as someone: what's new for them stays new.
  if (NOTES && !NOTES.unread && !VIEWING) caughtUp();
}

// ---- Piece view ----
const detail = $('#detail');
const form = $('#d-form');
const lock = (on) => {
  document.documentElement.style.overflow = on ? 'hidden' : '';
};
function openDetail(id, list, { toTalk = false } = {}) {
  listCtx = list;
  opener = document.activeElement;
  showPiece(id);
  detail.hidden = false;
  lock(true);
  $('#d-close').focus();
  if (toTalk) $('#talk')?.scrollIntoView({ block: 'start' });
}
function closeDetail({ refocus = true } = {}) {
  detail.hidden = true;
  lock(false);
  editing = null;
  if (!refocus || !opener) return;
  // The wall may have been drawn again behind the piece: find its button anew.
  const id = opener.dataset?.id || opener.dataset?.open;
  const again = opener.isConnected ? opener : id && $(`#view [data-id="${id}"], #view [data-open="${id}"]`);
  again?.focus?.();
}
function showPiece(id) {
  const p = (current = PIECES.find((x) => x.id === id));
  if (!p) return closeDetail();
  const kid = kidOf(p);
  const mayChange = canChangePiece(p);
  $('#d-img').src = img(p, 'display');
  $('#d-img').alt = `${titleOf(p)}, by ${kid.name}`;
  $('#d-count').textContent = `${listCtx.indexOf(id) + 1} of ${listCtx.length}`;
  $('#d-read').innerHTML = `<div class="stack" style="${kidStyle(kid)}">
    <p class="d-artist">${avatar(kid)}${esc(kid.name)}, ${ageLabel(kid.born, p.made)}</p>
    <h2 class="d-title" id="d-title">${esc(titleOf(p))}<span>, ${p.made.slice(0, 4)}</span></h2>
    ${p.story ? said(p.story) : ''}
    <ul class="d-facts">
      ${p.medium ? `<li>${icon('crayon')}${esc(p.medium)}</li>` : ''}
      <li>${icon('calendar')}Made ${madeLong(p)}</li>
      ${p.favourite && !mayChange ? `<li>${icon('heart', 'filled fav-mark')}A favourite</li>` : ''}
    </ul>
    ${p.tags.length ? `<ul class="tags" aria-label="Tags">${p.tags.map((t) => `<li><a class="tag" href="${tagHref(t)}"><span class="tag-s">${icon('tag')}${esc(t)}</span></a></li>`).join('')}</ul>` : ''}
    <div class="row">
      ${mayChange ? `<button class="btn" type="button" id="d-fav" aria-pressed="${p.favourite}">${icon('heart', p.favourite ? 'filled' : '')}Favourite</button>
      <button class="btn" type="button" id="d-edit">${icon('pencil')}Edit details</button>` : ''}
      <a class="btn" href="${img(p, 'original')}" download>${icon('download')}Save full scan</a>
    </div>
    ${TALK ? talkSection(p) : ''}
    ${p.source_name ? `<p class="d-source">From ${esc(p.source_name)}</p>` : ''}</div>`;
  $('#d-read').hidden = false;
  form.hidden = true;
  if (TALK) loadPieceTalk(p);
}
function step(n) {
  const i = listCtx.indexOf(current.id);
  showPiece(listCtx[(i + n + listCtx.length) % listCtx.length]);
}
async function savePiece(p, changes, message) {
  try {
    await api(`/api/pieces/${p.id}`, { method: 'PATCH', json: changes });
  } catch (e) {
    toast(e.message);
    return false;
  }
  Object.assign(p, changes);
  showPiece(p.id);
  render();
  toast(message);
  return true;
}
$('#d-close').onclick = closeDetail;
$('#d-prev').onclick = () => step(-1);
$('#d-next').onclick = () => step(1);
$('#d-read').addEventListener('click', async (e) => {
  const p = current;
  // A tag goes to its own page: the link changes the address, and the piece closes.
  const tagA = e.target.closest('a.tag');
  if (tagA) {
    closeDetail({ refocus: false });
    if (tagA.getAttribute('href') === location.hash) $('#view h1')?.focus({ preventScroll: true });
    return;
  }
  if (e.target.closest('#d-fav')) {
    if (await savePiece(p, { favourite: !p.favourite }, p.favourite ? 'Taken off the favourites' : 'Added to favourites')) $('#d-fav').focus();
  } else if (e.target.closest('#d-edit')) {
    $('#f-kid').value = p.kid_id;
    $('#f-title').value = p.title;
    $('#f-made').value = p.made;
    $('#f-precision').value = p.made_precision;
    $('#f-medium').value = p.medium || '';
    $('#f-story').value = p.story;
    $('#f-tags').value = p.tags.join(', ');
    $('#d-read').hidden = true;
    form.hidden = false;
    $('.d-info').scrollTop = 0;
    $('#f-title').focus({ preventScroll: true });
  }
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const changes = {
    kid_id: Number($('#f-kid').value),
    title: $('#f-title').value.trim(),
    made: $('#f-made').value,
    made_precision: $('#f-precision').value,
    medium: $('#f-medium').value.trim() || null,
    story: $('#f-story').value.trim(),
    tags: [...new Set($('#f-tags').value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))],
  };
  await savePiece(current, changes, 'Saved');
});
$('#f-cancel').onclick = () => {
  $('#d-read').hidden = false;
  form.hidden = true;
};
$('#f-delete').onclick = async () => {
  const p = current;
  if (!confirm(`Take “${titleOf(p)}” off the fridge for good? The original in Dropbox isn’t touched.`)) return;
  try {
    await api(`/api/pieces/${p.id}`, { method: 'DELETE' });
  } catch (e) {
    toast(e.message);
    return;
  }
  PIECES = PIECES.filter((x) => x.id !== p.id);
  listCtx = listCtx.filter((id) => id !== p.id);
  closeDetail();
  buildChrome();
  render();
  toast('Removed');
};

// ---- Stickers and comments ----
// Everyone signed in can give a piece stickers and comment on it. The Worker
// has the rules (talk() in worker.js) and says what each person may do
// (`mine`, `can_remove`); the page only shows what it would allow. TALK is
// /api/comments: each piece's counts, the latest comments, and who's looking
// (`me`: their names from infra, or their kid, and how far they'd read). On
// a sign-in two people share, they pick which of them is commenting, and the
// page remembers it on this device. The preview saves nothing, so there
// what's added lives in the page until a reload.
const STICKERS = [
  { kind: 'heart', label: 'Love it' },
  { kind: 'star', label: 'Gold star' },
  { kind: 'wow', label: 'Wow!' },
  { kind: 'smile', label: 'Smiley' },
  { kind: 'rainbow', label: 'Colours' },
];
const COMMENT_MAX = 500;
let TALK = null;
// How far someone had caught up when this visit began (a time, like a
// comment's created_at): newer comments are new. NEVER is later than any
// time, for a first visit.
const NEVER = '\uffff';
let SEEN = null;
const opened = new Set(); // pieces looked at this visit, so no longer new
const drafts = new Map(); // what someone was writing, by piece
let talking = null; // the open piece's { id, comments, stickers }, once loaded
let editing = null; // the id of the comment being reworded
let previewIds = 1e6;
let choosingAs = false; // whether a shared sign-in's names are open to pick from
const AS_KEY = 'fridge-as';

// Which person on a shared sign-in is commenting (the name everyone sees,
// which is what's sent as `as`), or '' for anyone else's. Each of
// TALK.me.names is { name, home }: home ("Mom") is what a parent shows as on
// their own families' kids' art, and name everywhere else, as the Worker
// names them.
function speaking() {
  const people = TALK?.me.names || [];
  if (people.length < 2) return '';
  if (VIEWING) return (people.find((p) => p.name === VIEWING.as) || people[0]).name;
  let saved = null;
  try {
    saved = localStorage.getItem(AS_KEY);
  } catch {}
  return (people.find((p) => p.name === saved) || people[0]).name;
}
// What the preview shows for what its visitor adds.
const shownOn = (person, kid) => (person.home && kid && TALK.me.families.includes(kid.family) && person.home) || person.name;
const talkKid = () => kidOf(PIECES.find((x) => x.id === talking?.id) || {});
const myName = () => {
  const person = TALK.me.names.find((p) => p.name === speaking()) || TALK.me.names[0];
  return TALK.me.kid || (person ? shownOn(person, talkKid()) : 'You');
};

const countsOf = (id) => TALK?.counts[id] || { comments: 0, stickers: 0, newest: '' };
const isNew = (p) => countsOf(p.id).newest > SEEN && !opened.has(p.id);
const commentIsNew = (c) => c.created_at > SEEN && !c.mine && !opened.has(c.piece_id);
const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');
const when = (s) => new Date(`${s.replace(' ', 'T')}Z`);
function ago(s) {
  const d = when(s);
  const mins = Math.round((Date.now() - d) / 6e4);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
const timeTag = (s) => `<time datetime="${esc(when(s).toISOString())}">${esc(ago(s))}</time>`;
// "Gran", "Gran and Pop", "Gran, Pop and 2 more".
function names(list) {
  const all = [...new Set(list)];
  if (all.length <= 3) return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all.at(-1)}` : (all[0] ?? '');
  return `${all.slice(0, 2).join(', ')} and ${all.length - 2} more`;
}
// A kid's own magnet, or for a grown-up a plain one with their initial.
const commenterKid = (c) => (c.kid_id == null ? null : KIDS.find((k) => k.id === c.kid_id) || null);
const whoMagnet = (c) => {
  const kid = commenterKid(c);
  return kid ? avatar(kid) : `<i class="av av-grown" aria-hidden="true">${esc((Array.from(c.by.trim())[0] || '?').toLocaleUpperCase())}</i>`;
};

// Under a piece on the walls: how many comments and stickers, and whether
// there's something new.
function talkLine(p) {
  if (!TALK) return '';
  const { comments, stickers } = countsOf(p.id);
  if (!comments && !stickers) return '';
  const fresh = isNew(p);
  const words = [comments && plural(comments, 'comment'), stickers && plural(stickers, 'sticker'), fresh && 'new'].filter(Boolean).join(', ');
  return `<span class="talk-n"><span class="sr">${words}</span><span class="talk-c" aria-hidden="true">${comments ? `<span>${icon('bubble')}${comments}</span>` : ''}${stickers ? `<span>${icon('star')}${stickers}</span>` : ''}${fresh ? '<b class="new">New</b>' : ''}</span></span>`;
}

// Home: the latest comments anywhere on the fridge. Each opens its piece.
function latestComments() {
  const all = (TALK?.latest || []).filter((c) => PIECES.some((p) => p.id === c.piece_id));
  // Four, or up to six when that many are new: on a phone they stack.
  const fresh = all.slice(0, 6).filter(commentIsNew).length;
  const list = all.slice(0, Math.max(4, fresh));
  if (!list.length) return '';
  return `<section class="latest-sec" data-scope aria-labelledby="latest-h"><div class="sec-head"><h2 id="latest-h">Latest comments${squiggle()}</h2>${fresh ? `<span class="count">${fresh} new since you last looked</span>` : ''}</div><ul class="latest">${list.map(noteCard).join('')}</ul></section>`;
}
function noteCard(c) {
  const p = PIECES.find((x) => x.id === c.piece_id);
  const kid = kidOf(p);
  const fresh = commentIsNew(c);
  return `<li style="${kidStyle(kid)}"><button class="note${commenterKid(c) ? ' by-kid' : ''}${fresh ? ' is-new' : ''}" type="button" data-id="${p.id}"><img src="${img(p, 'thumb')}" alt="" loading="lazy"><span class="note-copy"><span class="note-by">${whoMagnet(c)}<span><b>${esc(c.by)}</b> on ${esc(titleOf(p))}</span></span><span class="note-body">${esc(c.body)}</span><span class="note-meta">${timeTag(c.created_at)}${fresh ? '<b class="new">New</b>' : ''}</span></span></button></li>`;
}

// The piece view's part: stickers, then comments, then somewhere to write.
// Drawn once per piece, then its parts are drawn again as things change, so
// what's being written stays put.
function talkSection(p) {
  const kid = kidOf(p);
  const own = TALK.me.kid_id != null && TALK.me.kid_id === kid.id;
  const people = TALK.me.names;
  const shared = people.length > 1;
  // On a shared sign-in, who's commenting, above the comment box, and their
  // names to pick from once Change is tapped. Stickers go by the same choice.
  if (VIEWING) return talkViewing(kid, shared);
  const asLine = shared ? `<p class="as-line" id="t-as">Commenting as <b id="t-as-name"></b><span aria-hidden="true">·</span><button class="as-change" type="button" id="t-as-change" aria-expanded="false" aria-controls="t-as-pick">Change</button></p>` : '';
  const asPick = shared
    ? `<div class="as-pick" id="t-as-pick" role="group" aria-labelledby="t-as-h" hidden><p class="as-h" id="t-as-h">Who’s commenting?</p><div class="as-opts">${people.map((p) => `<button class="as-card" type="button" data-as="${esc(p.name)}" aria-pressed="false">${icon('check')}${esc(shownOn(p, kid))}</button>`).join('')}</div></div>`
    : '';
  const unnamed = !people.length && !TALK.me.kid ? '<p class="hint as-none">Your comments show the first part of your email address until a parent adds your name to the fridge.</p>' : '';
  return `<section class="talk" id="talk" aria-labelledby="talk-h">
    ${unnamed}
    <h3 class="talk-h" id="talk-h">Stickers</h3>
    <div class="stickers" id="t-stickers" role="group" aria-label="Stickers: tap one to give it, and again to take it back"></div>
    <p class="st-from" id="t-from"></p>
    <h3 class="talk-h">Comments<span class="count" id="t-count"></span></h3>
    <ol class="c-list" id="t-list" aria-label="Comments"></ol>
    <form class="c-form" id="t-form">
      ${PREVIEW ? '<p class="hint">This is a preview with a made-up family, so stickers and comments you add aren’t saved. They’re gone when you reload.</p>' : ''}
      ${asLine}
      ${asPick}
      <label class="sr" for="t-text">Write a comment</label>
      <textarea id="t-text" rows="2" maxlength="${COMMENT_MAX}" placeholder="${esc(own ? 'Tell everyone about it' : `Tell ${kid.name} what you like about it`)}"></textarea>
      <div class="c-send"><span class="c-left" id="t-left" aria-live="polite"></span><button class="btn primary" type="submit" id="t-send">${icon('bubble')}Send</button></div>
    </form>
  </section>`;
}

// The same, looking as someone else: what they'd see, and nothing to do.
function talkViewing(kid, shared) {
  const as = shared ? `<p class="as-line as-fixed">They’d be commenting as <b>${esc(shownOn(TALK.me.names.find((p) => p.name === speaking()) || TALK.me.names[0], kid))}</b></p>` : '';
  return `<section class="talk" id="talk" aria-labelledby="talk-h">
    <h3 class="talk-h" id="talk-h">Stickers</h3>
    <div class="stickers" id="t-stickers" role="list" aria-label="Stickers"></div>
    <p class="st-from" id="t-from"></p>
    <h3 class="talk-h">Comments<span class="count" id="t-count"></span></h3>
    <ol class="c-list" id="t-list" aria-label="Comments"></ol>
    ${as}
    <p class="talk-off">You’re viewing as ${esc(VIEWING.name)}, so stickers and comments are off.</p>
  </section>`;
}

async function loadPieceTalk(p) {
  const id = p.id;
  if ($('#t-text')) $('#t-text').value = drafts.get(id) || '';
  showLeft();
  editing = null;
  choosingAs = false;
  if (talking?.id !== id) talking = { id, comments: null, stickers: null };
  drawTalk();
  try {
    const data = await api(`/api/pieces/${id}/comments`);
    if (current?.id !== id) return;
    talking = { id, ...data };
  } catch (e) {
    if (current?.id !== id) return;
    if (!talking.comments) talking.error = e.message;
  }
  drawTalk();
  // Looked at: its comments aren't new any more, here or on the walls.
  if (!opened.has(id) && isNew(p)) {
    opened.add(id);
    render();
  }
  opened.add(id);
}

function drawTalk() {
  drawAs();
  drawStickers();
  drawComments();
}
// "Commenting as Poppa", and which name is picked once Change is open.
function drawAs() {
  const name = $('#t-as-name');
  if (!name) return;
  const as = speaking();
  const person = TALK.me.names.find((p) => p.name === as);
  name.textContent = person ? shownOn(person, talkKid()) : '';
  $('#t-as-change').setAttribute('aria-expanded', String(choosingAs));
  $('#t-as-pick').hidden = !choosingAs;
  for (const b of $('#t-as-pick').querySelectorAll('[data-as]')) b.setAttribute('aria-pressed', String(b.dataset.as === as));
}
function drawStickers() {
  const box = $('#t-stickers');
  if (!box || !talking) return;
  const loaded = Boolean(talking.stickers);
  const as = speaking();
  // Looking as someone, they're only shown: the ones given, with how many,
  // and nothing that looks like it could be tapped.
  if (VIEWING) {
    const given = STICKERS.map((s) => ({ ...s, ...(talking.stickers?.find((x) => x.kind === s.kind) || { count: 0, mine: [] }) })).filter((s) => s.count);
    box.innerHTML = given.map((s) => `<span class="stk stk-static${s.mine.includes(as) ? ' is-mine' : ''}" role="listitem" aria-label="${esc(s.label)}, ${s.count}${s.mine.includes(as) ? `, one from ${esc(VIEWING.name)}` : ''}"><svg class="stk-art" aria-hidden="true"><use href="#s-${s.kind}"/></svg><span class="stk-l" aria-hidden="true">${esc(s.label)}</span><b class="stk-n" aria-hidden="true">${s.count}</b></span>`).join('');
    box.hidden = !given.length;
    const givers = (talking.stickers || []).flatMap((s) => s.by);
    $('#t-from').textContent = !loaded ? '' : givers.length ? `Stickers from ${names(givers)}` : 'No stickers yet.';
    return;
  }
  box.innerHTML = STICKERS.map((s) => {
    const st = talking.stickers?.find((x) => x.kind === s.kind) || { count: 0, mine: [] };
    return `<button class="stk" type="button" data-sticker="${s.kind}" aria-pressed="${st.mine.includes(as)}" aria-label="${esc(s.label)}${st.count ? `, ${st.count}` : ''}"${loaded ? '' : ' disabled'}><svg class="stk-art" aria-hidden="true"><use href="#s-${s.kind}"/></svg><span class="stk-l" aria-hidden="true">${esc(s.label)}</span>${st.count ? `<b class="stk-n" aria-hidden="true">${st.count}</b>` : ''}</button>`;
  }).join('');
  const givers = (talking.stickers || []).flatMap((s) => s.by);
  $('#t-from').textContent = !loaded ? '' : givers.length ? `Stickers from ${names(givers)}` : 'No stickers yet. Tap one to give it.';
}
function drawComments() {
  const list = $('#t-list');
  if (!list || !talking) return;
  const p = PIECES.find((x) => x.id === talking.id);
  if (!p) return;
  const comments = talking.comments;
  $('#t-count').textContent = comments?.length ? String(comments.length) : '';
  if (!comments) {
    list.innerHTML = `<li class="c-empty">${talking.error ? esc(talking.error) : 'Getting the comments…'}</li>`;
    return;
  }
  list.innerHTML = comments.length ? comments.map((c) => commentHtml(c, p)).join('') : `<li class="c-empty">${doodle('heart')}Nobody’s said anything yet.${VIEWING ? '' : ' Be the first!'}</li>`;
}
function commentHtml(c, p) {
  const kid = commenterKid(c);
  const artist = kid && kid.id === p.kid_id;
  const actions = VIEWING
    ? ''
    : c.mine
    ? `<button type="button" data-c-edit="${c.id}">${icon('pencil')}Edit</button><button type="button" class="danger" data-c-remove="${c.id}">${icon('trash')}Delete</button>`
    : c.can_remove
      ? `<button type="button" class="danger" data-c-remove="${c.id}">${icon('trash')}Remove</button>`
      : '';
  const body =
    editing === c.id
      ? `<form class="c-edit" data-c-save="${c.id}"><label class="sr" for="c-edit-${c.id}">Change your comment</label><textarea id="c-edit-${c.id}" rows="3" maxlength="${COMMENT_MAX}">${esc(c.body)}</textarea><div class="row"><button class="btn primary" type="submit">${icon('check')}Save</button><button class="btn" type="button" data-c-cancel>Cancel</button></div></form>`
      : `<p class="c-body">${esc(c.body)}</p>`;
  return `<li class="c-item${kid ? ' c-kid' : ''}${artist ? ' c-artist' : ''}"${kid ? ` style="${kidStyle(kid)}"` : ''}>
    <p class="c-top">${whoMagnet(c)}<b class="c-by">${esc(c.by)}</b>${artist ? '<span class="c-badge">the artist</span>' : ''}${timeTag(c.created_at)}${c.unsaved ? '<span class="c-note">not saved</span>' : c.edited ? '<span class="c-note">edited</span>' : ''}</p>
    ${body}
    ${actions && editing !== c.id ? `<p class="c-act">${actions}</p>` : ''}
  </li>`;
}
function showLeft() {
  const n = [...($('#t-text')?.value || '')].length;
  const left = $('#t-left');
  if (left) left.textContent = n > COMMENT_MAX - 100 ? `${Math.max(0, COMMENT_MAX - n)} letters left` : '';
}

// Keep the walls' counts and Home's latest comments up with a change here.
function counted(id, change) {
  const c = (TALK.counts[id] ||= { comments: 0, stickers: 0, newest: '' });
  change(c);
  render();
}

async function giveSticker(kind) {
  if (VIEWING) return;
  const id = talking?.id;
  const st = talking?.stickers?.find((s) => s.kind === kind);
  if (!st) return;
  const as = speaking();
  const on = !st.mine.includes(as);
  let stickers;
  try {
    if (PREVIEW) {
      const name = myName();
      stickers = talking.stickers.map((s) => (s.kind !== kind ? s : { ...s, mine: on ? [...s.mine, as] : s.mine.filter((n) => n !== as), count: s.count + (on ? 1 : -1), by: on ? [...s.by, name] : s.by.filter((n) => n !== name) }));
    } else stickers = (await api(`/api/pieces/${id}/stickers/${kind}${as ? `?as=${encodeURIComponent(as)}` : ''}`, { method: on ? 'POST' : 'DELETE' })).stickers;
  } catch (e) {
    toast(e.message);
    return;
  }
  if (talking?.id !== id) return;
  talking.stickers = stickers;
  drawStickers();
  const b = $(`#t-stickers [data-sticker="${kind}"]`);
  b?.focus();
  if (on) b?.classList.add('popped');
  counted(id, (c) => (c.stickers = stickers.reduce((n, s) => n + s.count, 0)));
  if (PREVIEW) toast('Stuck on here only: the preview doesn’t save it');
}

async function sendComment() {
  if (VIEWING) return;
  const id = talking?.id;
  const text = $('#t-text').value.trim();
  if (!text) {
    $('#t-text').focus();
    return;
  }
  if (!talking?.comments) return;
  const send = $('#t-send');
  send.disabled = true;
  const as = speaking();
  let comment;
  try {
    comment = PREVIEW
      ? { id: ++previewIds, piece_id: id, body: text, created_at: stamp(), edited: false, by: myName(), kid_id: TALK.me.kid_id, mine: true, can_remove: true, unsaved: true }
      : (await api(`/api/pieces/${id}/comments`, { method: 'POST', json: as ? { body: text, as } : { body: text } })).comment;
  } catch (e) {
    toast(e.message);
    return;
  } finally {
    send.disabled = false;
  }
  drafts.delete(id);
  TALK.latest = [comment, ...TALK.latest].slice(0, 8);
  if (talking?.id === id) {
    talking.comments.push(comment);
    $('#t-text').value = '';
    showLeft();
    drawComments();
  }
  counted(id, (c) => c.comments++);
  toast(PREVIEW ? 'Added here only: the preview doesn’t save it' : 'Sent');
}

async function saveComment(cid, text) {
  const c = talking.comments.find((x) => x.id === cid);
  if (!c) return;
  let changed;
  try {
    changed = PREVIEW ? { ...c, body: text.trim(), edited: c.edited || text.trim() !== c.body } : (await api(`/api/comments/${cid}`, { method: 'PATCH', json: { body: text } })).comment;
  } catch (e) {
    toast(e.message);
    return;
  }
  Object.assign(c, changed);
  TALK.latest = TALK.latest.map((x) => (x.id === cid ? { ...x, ...changed } : x));
  editing = null;
  drawComments();
  render();
  toast('Saved');
}

async function removeComment(cid) {
  const id = talking.id;
  const c = talking.comments.find((x) => x.id === cid);
  if (!c || !confirm(c.mine ? 'Delete your comment?' : `Remove ${c.by}’s comment? It can’t be brought back.`)) return;
  try {
    if (!PREVIEW) await api(`/api/comments/${cid}`, { method: 'DELETE' });
  } catch (e) {
    toast(e.message);
    return;
  }
  if (talking?.id === id) talking.comments = talking.comments.filter((x) => x.id !== cid);
  TALK.latest = TALK.latest.filter((x) => x.id !== cid);
  drawComments();
  $('#t-text').focus({ preventScroll: true });
  counted(id, (n) => n.comments--);
  toast(c.mine ? 'Deleted' : 'Removed');
}

$('#d-read').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sticker], [data-c-edit], [data-c-remove], [data-c-cancel]');
  if (!b || !talking) return;
  if (b.dataset.sticker) giveSticker(b.dataset.sticker);
  else if (b.dataset.cEdit) {
    editing = Number(b.dataset.cEdit);
    drawComments();
    const area = $(`#c-edit-${editing}`);
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
  } else if (b.dataset.cRemove) removeComment(Number(b.dataset.cRemove));
  else if (b.matches('[data-c-cancel]')) {
    editing = null;
    drawComments();
  }
});
$('#d-read').addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 't-form') sendComment();
  else if (e.target.dataset.cSave) saveComment(Number(e.target.dataset.cSave), e.target.querySelector('textarea').value);
});
$('#d-read').addEventListener('input', (e) => {
  if (e.target.id !== 't-text' || !talking) return;
  drafts.set(talking.id, e.target.value);
  showLeft();
});
// Who's commenting, on a shared sign-in: Change shows their names, and the
// one picked is remembered on this device.
$('#d-read').addEventListener('click', (e) => {
  const b = e.target.closest('#t-as-change, [data-as]');
  if (!b) return;
  if (b.dataset.as != null) {
    try {
      localStorage.setItem(AS_KEY, b.dataset.as);
    } catch {}
    choosingAs = false;
  } else choosingAs = !choosingAs;
  drawAs();
  drawStickers();
  if (b.dataset.as != null) $('#t-as-change').focus();
  else if (choosingAs) $('#t-as-pick [aria-pressed="true"]')?.focus();
});
$('#d-read').addEventListener('animationend', (e) => e.target.closest?.('.stk')?.classList.remove('popped'));

// ---- What's new: the bell ----
// The Worker works out what's new for whoever's signed in (notifications()
// in worker.js): new art, and stickers and comments on their art or their
// kids', or after they commented. NOTES is /api/notifications: the list,
// newest first, `unread`, and `as_of`, how far opening the bell catches
// them up. It's checked again every minute while the page is in sight.
// Opening the bell catches them up, here and on the walls next time. A
// kid's own sign-in gets big stickers and few words.
let NOTES = null;
let bellOpen = false;
let fresh = new Set(); // what was new when the bell opened: it stays marked while it's open
const bell = $('#bell');
const bellBtn = $('#open-bell');
const STICKER_WORDS = { heart: 'a heart', star: 'a gold star', wow: 'a wow', smile: 'a smiley', rainbow: 'a rainbow' };
// "a heart", "a heart and a gold star", "a heart, a wow and a gold star".
const andList = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? ''));
const own = (s) => `${s}’s`;
const forKid = () => TALK?.me.kid_id != null;

// What a notification says, as HTML: everything from the Worker escaped.
function noteWords(n) {
  const kid = KIDS.find((k) => k.id === n.kid_id);
  const by = `<b>${esc(n.by)}</b>`;
  const t = n.title ? esc(n.title) : '';
  if (forKid() && n.kid_id === TALK.me.kid_id) {
    // To a kid, about their own art: few words, and the picture says which.
    const yours = t ? `your “${t}”` : 'your picture';
    if (n.kind === 'sticker') return `${by} gave ${yours} ${andList(n.stickers.map((s) => STICKER_WORDS[s]))}`;
    if (n.kind === 'art') return n.count === 1 ? `${by} put ${yours} on the fridge` : `${by} put ${n.count} of your pictures on the fridge`;
    return `${by} said`;
  }
  if (forKid()) return `${by} said`;
  // The artist themselves isn't "Ada on Ada’s".
  const self = n.by_kid_id != null && n.by_kid_id === n.kid_id;
  const piece = self ? (t ? `“${t}”` : 'an untitled piece') : t ? `${esc(own(kid?.name ?? ''))} “${t}”` : `${esc(own(kid?.name ?? ''))} untitled piece`;
  if (n.kind === 'sticker') return `${by} gave ${piece} ${andList(n.stickers.map((s) => STICKER_WORDS[s]))}`;
  if (n.kind === 'art') {
    if (n.count > 1) return self ? `${by} put up ${n.count} new pieces` : `${by} put up ${n.count} new pieces by ${esc(kid?.name ?? '')}`;
    return `${by} put up ${piece}`;
  }
  if (n.kind === 'reply') return `${by} replied on ${piece}`;
  return `${by} on ${piece}`;
}
// Its picture: the stickers themselves, the commenter's magnet, or the art's.
function notePic(n) {
  if (n.kind === 'sticker') return `<span class="n-st">${n.stickers.slice(0, 3).map((s) => `<svg class="stk-art" aria-hidden="true"><use href="#s-${s}"/></svg>`).join('')}</span>`;
  if (n.kind === 'art') {
    const kid = KIDS.find((k) => k.id === n.kid_id);
    return `<i class="av n-av" aria-hidden="true"${kid ? ` style="${kidStyle(kid)}"` : ''}>${icon('pictures')}</i>`;
  }
  return `<span class="n-who">${whoMagnet({ by: n.by, kid_id: n.by_kid_id })}<i class="n-bub" aria-hidden="true">${icon('bubble')}</i></span>`;
}
function noteItem(n) {
  const kid = KIDS.find((k) => k.id === n.kid_id);
  const isFresh = fresh.has(n.key);
  const said = n.body ? `<span class="n-said${n.by_kid_id != null ? ' by-kid' : ''}">${esc(n.body)}</span>` : '';
  const more = n.kind === 'art' && n.count > 1 ? `<b class="n-more" aria-hidden="true">+${n.count - 1}</b>` : '';
  return `<li${kid ? ` style="${kidStyle(kid)}"` : ''}><button class="n-item n-${n.kind}${isFresh ? ' is-new' : ''}" type="button" data-note="${esc(n.key)}">
    <span class="n-pic">${notePic(n)}</span>
    <span class="n-thumb"><img src="/img/${Number(n.piece_id)}/thumb" alt="" loading="lazy">${more}</span>
    <span class="n-copy"><span class="n-what">${noteWords(n)}</span>${said}<span class="n-meta">${timeTag(n.at)}${isFresh ? '<b class="new">New</b>' : ''}</span></span>
  </button></li>`;
}

function drawBell() {
  bellBtn.hidden = !NOTES;
  if (!NOTES) return;
  const n = NOTES.unread;
  const badge = $('#bell-n');
  const was = badge.hidden ? 0 : Number(badge.dataset.n || 0);
  badge.hidden = !n;
  badge.dataset.n = String(n);
  badge.textContent = n > 9 ? '9+' : String(n);
  if (n > was) badge.classList.add('popped');
  $('#bell-label').textContent = n ? `What’s new: ${plural(n, 'new thing')}` : 'What’s new';
  bellBtn.setAttribute('aria-expanded', String(bellOpen));
  bell.classList.toggle('for-kid', forKid());
  if (!bellOpen) return;
  const count = NOTES.items.filter((x) => fresh.has(x.key)).length;
  $('#bell-count').textContent = count ? `${count} new` : '';
  $('#bell-list').innerHTML = NOTES.items.length
    ? NOTES.items.map(noteItem).join('')
    : `<li class="n-empty">${doodle('heart')}<span>${forKid() ? 'Nothing new yet. When someone gives your art a sticker, it shows up here.' : 'Nothing new yet. New art, and stickers and comments for you, show up here.'}</span></li>`;
}
$('#bell-n').addEventListener('animationend', (e) => e.target.classList.remove('popped'));

// Caught up to the notifications' as_of: here, the bell's count, and on the
// Worker, for the bell next time and the walls' New marks next visit. The
// preview saves nothing, so there it's only here, and so is viewing as
// someone: nothing about them moves, and the Worker would refuse it anyway.
function caughtUp() {
  if (!NOTES) return;
  const seen = NOTES.as_of;
  for (const n of NOTES.items) n.new = false;
  NOTES.unread = 0;
  if (PREVIEW || VIEWING || (NOTES.seen && NOTES.seen >= seen)) return;
  NOTES.seen = seen;
  api('/api/me', { method: 'PATCH', json: { seen } }).catch(() => {});
}

function setBell(open) {
  if (open === bellOpen || !NOTES) return;
  bellOpen = open;
  bell.hidden = !open;
  if (open) {
    fresh = new Set(NOTES.items.filter((n) => n.new).map((n) => n.key));
    caughtUp();
    placeBell();
    bell.scrollTop = 0;
  }
  drawBell();
}
// Under the bell, as far as the screen allows.
function placeBell() {
  const b = bellBtn.getBoundingClientRect();
  const r = topBar.getBoundingClientRect();
  const gutter = Math.max(16, parseFloat(getComputedStyle($('.bar-inner')).paddingRight) || 0);
  const right = r.right - b.right - 4;
  bell.style.setProperty('--bell-right', `${Math.round(Math.max(gutter, Math.min(right, r.width - bell.offsetWidth - gutter)))}px`);
}

async function refreshNotes() {
  if (PREVIEW || !NOTES || document.hidden) return;
  let next;
  try {
    next = await api('/api/notifications');
  } catch {
    return;
  }
  // Nothing new: leave the list as it is, so nobody loses their place in it.
  const sig = (x) => JSON.stringify([x.unread, x.items.map((n) => [n.key, n.at, n.count, n.stickers])]);
  if (sig(next) === sig(NOTES)) return;
  NOTES = next;
  // Whatever comes in while the list is open is being looked at.
  if (bellOpen) {
    for (const n of NOTES.items) if (n.new) fresh.add(n.key);
    caughtUp();
  }
  drawBell();
}
setInterval(refreshNotes, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshNotes();
});

bellBtn.addEventListener('click', () => setBell(!bellOpen));
bell.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-note]');
  if (!b) return;
  const n = NOTES.items.find((x) => x.key === b.dataset.note);
  if (!n) return;
  setBell(false);
  // Art added since the page loaded: fetch the gallery again first.
  if (!PIECES.some((p) => p.id === n.piece_id)) {
    try {
      await load();
    } catch {}
  }
  if (!PIECES.some((p) => p.id === n.piece_id)) return toast('That isn’t on the fridge any more.');
  const has = (id) => PIECES.some((p) => p.id === id);
  // Through a day's new art, or else through everything in the list.
  const list = n.kind === 'art' && n.pieces.length > 1 ? n.pieces.filter(has) : [...new Set(NOTES.items.map((x) => x.piece_id))].filter(has);
  // The bell is where focus goes back to.
  bellBtn.focus();
  openDetail(n.piece_id, list, { toTalk: n.kind !== 'art' });
});
document.addEventListener('click', (e) => {
  if (bellOpen && !e.target.closest('#bell, #open-bell')) setBell(false);
});
topBar.addEventListener('focusout', (e) => {
  if (bellOpen && e.relatedTarget instanceof Element && !e.relatedTarget.closest('#bell, #open-bell')) setBell(false);
});
window.addEventListener('hashchange', () => setBell(false));
window.addEventListener('resize', () => bellOpen && placeBell());

// ---- Frame mode ----
const frame = $('#frame');
const layers = frame.querySelectorAll('.stage img');
let frameList = [];
let frameIdx = 0;
let frameLayer = 0;
let frameTimer = null;
let wake = null;
function showFrame() {
  const p = frameList[frameIdx];
  const kid = kidOf(p);
  frameLayer ^= 1;
  layers[frameLayer].src = img(p, 'display');
  layers[frameLayer].alt = `${titleOf(p)}, by ${kid.name}`;
  layers[frameLayer].classList.add('on');
  layers[frameLayer ^ 1].classList.remove('on');
  $('#fr-t').textContent = titleOf(p);
  $('#fr-m').textContent = `${kid.name}, ${ageLabel(kid.born, p.made)} · ${madeShort(p)}`;
}
function frameNext() {
  frameIdx = (frameIdx + 1) % frameList.length;
  showFrame();
}
function restartTimer() {
  clearInterval(frameTimer);
  frameTimer = setInterval(frameNext, 8000);
}
async function keepAwake() {
  try {
    wake = (await navigator.wakeLock?.request('screen')) || null;
  } catch {}
}
function openFrame() {
  if (!PIECES.length) return;
  frameList = PIECES.filter((p) => p.favourite);
  if (frameList.length < 2) frameList = [...PIECES];
  frameIdx = Math.floor(Math.random() * frameList.length);
  frame.hidden = false;
  lock(true);
  showFrame();
  restartTimer();
  keepAwake();
  $('#fr-close').focus();
}
function closeFrame() {
  clearInterval(frameTimer);
  frame.hidden = true;
  lock(false);
  wake?.release().catch(() => {});
  wake = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
$('#stage').onclick = () => {
  frameNext();
  restartTimer();
};
$('#fr-close').onclick = closeFrame;
$('#fr-full').onclick = () => {
  const go = frame.requestFullscreen || frame.webkitRequestFullscreen;
  if (!go) return toast('Full screen isn’t available in this browser.');
  Promise.resolve(go.call(frame)).catch(() => toast('Full screen isn’t available in this browser.'));
};
$('#open-frame').onclick = openFrame;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !frame.hidden && !wake) keepAwake();
});

// ---- Add art (parents) ----
// The sheet is add/sheet.js, loaded the first time it opens, so people who
// only look never fetch it. It takes several pictures and PDFs at once.
const add = $('#add');

// ---- Add art: who made it ----
// The kids Add art offers, for a whole batch and for each piece: the ones
// this parent can add art for (their families' and kids in none), or an
// artist's own name (canAddFor). add/sheet.js draws the pickers from this
// list and nothing else; the Worker checks each piece again.
const addableKids = () => KIDS.filter(canAddFor);

let addArt = null;
function openAdd() {
  addArt ||= import('./add/sheet.js');
  addArt
    .then((sheet) =>
      sheet.open({
        kids: addableKids(),
        // Only parents import: they can ask what's on the fridge already and
        // record skips. An artist adds their own art without either.
        parent: CAN_EDIT,
        preview: PREVIEW,
        today: todayISO,
        api,
        esc,
        icon,
        avatar,
        kidStyle,
        lock,
        toast,
        refresh: load,
        // After adding: a kid's wall if it was all one kid's, else the timeline.
        show(kidIds) {
          const ids = [...new Set(kidIds)];
          const kid = ids.length === 1 && KIDS.find((k) => k.id === ids[0]);
          const to = kid ? kid.slug : 'timeline';
          if (location.hash === `#${to}`) render();
          else location.hash = to;
        },
      }),
    )
    .catch(() => {
      addArt = null;
      toast('Add art didn’t open. Check the connection and try again.');
    });
}
const closeAdd = () => addArt?.then((sheet) => sheet.close());
$('#open-add').onclick = openAdd;

// ---- Shared ----
let toastTimer;
// ---- View as ----
// For the fridge's owners: see it exactly as someone else would, with every
// change off. The Worker does it (viewAs in worker.js): starting it sets a
// cookie for an hour, so the pictures follow too, and the page loads again
// as that person. The preview can't set anything, so there it's the page's
// address instead (?view=).
const viewSheet = $('#view-as');
let viewOpener = null;
// The strip's height, for what's drawn below it (app.css).
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--viewing-h', `${Math.ceil(e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight)}px`)).observe($('#viewing'));
function showViewing() {
  document.body.classList.toggle('viewing-as', Boolean(VIEWING));
  $('#viewing').hidden = !VIEWING;
  $('#viewing-name').textContent = VIEWING ? VIEWING.name : '';
  $('#viewing-switch').hidden = !VIEWING;
  $('#open-view-as').hidden = !OWNER || Boolean(VIEWING);
}
async function openViewAs() {
  viewOpener = document.activeElement;
  viewSheet.hidden = false;
  lock(true);
  $('#va-close').focus();
  const list = $('#va-list');
  let data;
  try {
    data = await api('/api/view-as');
  } catch (e) {
    list.innerHTML = `<p class="hint said-error">${esc(e.message)}</p>`;
    return;
  }
  const now = data.viewing;
  const person = (p, gi, pi) => {
    const current = now && now.email === p.email && (now.as ?? null) === (p.as ?? null);
    const detail = [p.detail, p.address ? p.email : ''].filter(Boolean).join(' · ');
    return `<li><button class="va-person" type="button" data-g="${gi}" data-p="${pi}"${current ? ' aria-current="true"' : ''}><span class="va-name">${esc(p.name)}${current ? ' <span class="va-you">(now)</span>' : ''}</span><span class="va-detail">${esc(detail)}</span></button></li>`;
  };
  list.innerHTML = data.groups
    .map((g, gi) => `<section class="va-fam" aria-labelledby="va-g${gi}"><h3 id="va-g${gi}">${esc(g.name)}</h3><ul>${g.people.map((p, pi) => person(p, gi, pi)).join('')}</ul></section>`)
    .join('') || '<p class="hint">There’s nobody else to view as yet.</p>';
  list.onclick = (e) => {
    const b = e.target.closest('.va-person');
    if (b) startViewing(data.groups[b.dataset.g].people[b.dataset.p]);
  };
}
function closeViewAs() {
  viewSheet.hidden = true;
  lock(false);
  viewOpener?.focus?.();
}
async function startViewing(p) {
  if (PREVIEW) return location.assign(`/?view=${encodeURIComponent(p.key)}${location.hash}`);
  try {
    if (VIEWING) await api('/api/view-as', { method: 'DELETE' });
    await api('/api/view-as', { method: 'POST', json: { email: p.email, as: p.as } });
  } catch (e) {
    toast(e.message);
    return;
  }
  location.reload();
}
async function stopViewing() {
  if (PREVIEW) return location.assign(`/${location.hash}`);
  try {
    await api('/api/view-as', { method: 'DELETE' });
  } catch (e) {
    toast(e.message);
    return;
  }
  location.reload();
}
$('#open-view-as').onclick = openViewAs;
$('#viewing-switch').onclick = openViewAs;
$('#viewing-stop').onclick = stopViewing;
$('#va-close').onclick = closeViewAs;
viewSheet.addEventListener('click', (e) => {
  if (e.target === viewSheet) closeViewAs();
});
viewSheet.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeViewAs();
  }
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#view .piece, #view .note, #view [data-open], #view [data-filter], #view [data-frame], #view [data-add]');
  if (!b) return;
  if (b.matches('[data-filter]')) {
    filter = b.dataset.filter;
    render();
    return;
  }
  if (b.matches('[data-add]')) {
    openAdd();
    return;
  }
  if (b.matches('[data-frame]')) {
    openFrame();
    return;
  }
  const id = Number(b.dataset.id || b.dataset.open);
  const scope = b.closest('[data-scope]');
  let list = scope
    ? [...new Set([...scope.querySelectorAll('.piece, .note')].map((x) => Number(x.dataset.id)))]
    : PIECES.filter((p) => p.favourite).sort(byMadeDesc).map((p) => p.id);
  if (!list.includes(id)) list = [...PIECES].sort(byMadeDesc).map((p) => p.id);
  // From a comment on Home, straight to what's being said.
  openDetail(id, list, { toTalk: b.matches('.note') });
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (bellOpen) {
    if (e.key === 'Escape') {
      setBell(false);
      bellBtn.focus();
    }
  } else if (!frame.hidden) {
    if (e.key === 'Escape') closeFrame();
    else if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      frameNext();
      restartTimer();
    }
  } else if (!add.hidden) {
    if (e.key === 'Escape') closeAdd();
  } else if (!detail.hidden) {
    if (e.key === 'Escape') {
      if (!form.hidden) $('#f-cancel').click();
      else if (editing) {
        editing = null;
        drawComments();
      } else closeDetail();
    } else if (!typing && e.key === 'ArrowLeft') step(-1);
    else if (!typing && e.key === 'ArrowRight') step(1);
  }
});
window.addEventListener('hashchange', () => {
  // Back or forward while a piece is open: close it and show where we went.
  if (!detail.hidden) closeDetail({ refocus: false });
  render();
});
view.addEventListener('input', (e) => {
  if (e.target.id !== 'tag-find') return;
  tagQuery = e.target.value;
  applyTagQuery();
});

load().catch((e) => {
  view.innerHTML = `<section class="empty-state">${EMPTY_ART}<h1>The fridge didn’t open</h1><p>${esc(e.message)}</p><p><button class="btn" type="button" id="retry">${icon('right')}Try again</button></p></section>`;
  $('#retry').onclick = () => location.reload();
});
