// The fridge's page: reads the gallery from /api/gallery, draws it, and lets
// parents edit details, mark favourites and add new pieces, for the kids in
// their own families (and kids in none), and lets a kid who's an artist add
// their own art and change the pieces they added.

import { arrange } from './families.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let KIDS = [];
let PIECES = [];
let CAN_EDIT = false;
// The kids by family, the viewer's own first (families.js). Until families
// are set up there are none, and the page is as it was before them.
let GROUPED = false;
let GROUPS = [];
// More than one family, so their names show.
let HEADS = false;
let MY_FAMILIES = [];
let ARTIST = null; // the kid's name, for a kid signed in to add their own art
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
  return `<figure>${pieceButton(p)}<figcaption><span class="t${p.title ? '' : ' untitled'}">${esc(titleOf(p))}${fav}</span><span class="m">${opts.own ? '' : avatar(kid)}<span>${esc(meta)}${opts.ago ? ` · ${opts.ago(p)}` : ''}</span></span></figcaption></figure>`;
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
  const mine = KIDS.filter(canAddFor);
  $('#f-kid').innerHTML = mine.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
  $('#a-who').innerHTML = `<legend>Who made it?</legend>${mine.map((k, i) => `<label class="who-opt" style="${kidStyle(k)}"><input type="radio" name="who" value="${k.id}"${i === 0 ? ' checked' : ''}><span class="who-card">${avatar(k)}${esc(k.name)}</span></label>`).join('')}`;
  $('#open-add').hidden = !mine.length;
  $('#open-frame').hidden = !PIECES.length;
}

async function load() {
  const [session, data] = await Promise.all([api('/api/session'), api('/api/gallery')]);
  CAN_EDIT = session.canEdit;
  MY_FAMILIES = session.families || [];
  ARTIST = session.artist ?? null;
  MINE = new Set(data.mine || []);
  const families = arrange(data.kids, data.families, session.families);
  ({ grouped: GROUPED, heads: HEADS, groups: GROUPS, kids: KIDS } = families);
  for (const k of KIDS) Object.assign(k, { colour: `var(--kid-${k.ci})`, soft: `var(--kid-${k.ci}-soft)`, slug: `kid-${k.id}` });
  PIECES = data.pieces;
  buildChrome();
  render();
}

// ---- Piece view ----
const detail = $('#detail');
const form = $('#d-form');
const lock = (on) => {
  document.documentElement.style.overflow = on ? 'hidden' : '';
};
function openDetail(id, list) {
  listCtx = list;
  opener = document.activeElement;
  showPiece(id);
  detail.hidden = false;
  lock(true);
  $('#d-close').focus();
}
function closeDetail({ refocus = true } = {}) {
  detail.hidden = true;
  lock(false);
  if (refocus) opener?.focus?.();
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
    ${p.source_name ? `<p class="d-source">From ${esc(p.source_name)}</p>` : ''}</div>`;
  $('#d-read').hidden = false;
  form.hidden = true;
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
const add = $('#add');
const addForm = $('#add-form');
const ORIGINAL_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/tiff', 'image/gif'];
function openAdd() {
  addForm.reset();
  $('#a-made').value = todayISO;
  $('#a-preview').hidden = true;
  $('#a-icon').removeAttribute('hidden');
  $('#a-file-label').textContent = 'Take a photo or choose a scan';
  $('#a-error').hidden = true;
  add.hidden = false;
  lock(true);
  $('#a-file').focus();
}
function closeAdd() {
  add.hidden = true;
  lock(false);
}
function addError(msg) {
  $('#a-error').textContent = msg;
  $('#a-error').hidden = false;
}
// A JPEG no bigger than `max` on its long side, turned the right way up.
async function shrink(file, max, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', quality));
  return { blob, w, h };
}
$('#open-add').onclick = openAdd;
$('#add-close').onclick = closeAdd;
add.addEventListener('click', (e) => {
  if (e.target === add) closeAdd();
});
$('#a-file').addEventListener('change', () => {
  const f = $('#a-file').files[0];
  if (!f) return;
  const preview = $('#a-preview');
  if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(f);
  preview.hidden = false;
  $('#a-icon').setAttribute('hidden', '');
  $('#a-file-label').textContent = f.name;
  $('#a-error').hidden = true;
});
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#a-file').files[0];
  if (!file) return addError('Choose a photo or scan first.');
  if (!ORIGINAL_TYPES.includes(file.type)) return addError('That isn’t a picture the fridge can take. Try a JPEG, PNG or HEIC.');
  const kidId = Number(addForm.querySelector('input[name="who"]:checked')?.value);
  const button = $('#a-submit');
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    let display, thumb;
    try {
      display = await shrink(file, 2000, 0.85);
      thumb = await shrink(file, 480, 0.8);
    } catch {
      throw new Error('This browser can’t open that picture. Try a JPEG or PNG.');
    }
    const body = new FormData();
    body.set('meta', JSON.stringify({ kid_id: kidId, made: $('#a-made').value || todayISO, made_precision: 'day', title: $('#a-title').value.trim(), story: $('#a-story').value.trim(), width: display.w, height: display.h }));
    body.set('original', file);
    body.set('display', display.blob, 'display.jpg');
    body.set('thumb', thumb.blob, 'thumb.jpg');
    await api('/api/pieces', { method: 'POST', body });
    closeAdd();
    await load();
    const kid = KIDS.find((k) => k.id === kidId);
    if (location.hash === `#${kid.slug}`) render();
    else location.hash = kid.slug;
    toast(`Added to ${kid.name}’s wall`);
  } catch (err) {
    addError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Add to the fridge';
  }
});

// ---- Shared ----
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#view .piece, #view [data-open], #view [data-filter], #view [data-frame], #view [data-add]');
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
    ? [...new Set([...scope.querySelectorAll('.piece')].map((x) => Number(x.dataset.id)))]
    : PIECES.filter((p) => p.favourite).sort(byMadeDesc).map((p) => p.id);
  if (!list.includes(id)) list = [...PIECES].sort(byMadeDesc).map((p) => p.id);
  openDetail(id, list);
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (!frame.hidden) {
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
      else closeDetail();
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
