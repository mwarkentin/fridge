// The fridge's page: reads the gallery from /api/gallery, draws it, and lets
// parents edit details, mark favourites and add new pieces.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let KIDS = [];
let PIECES = [];
let CAN_EDIT = false;

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

// Each piece hangs at its own slight angle, the same every time.
function tilt(id) {
  let a = id * 2654435761;
  const r = () => ((a = (a ^ (a >>> 15)) * 2246822519 + 1013904223) >>> 0) / 4294967296;
  return { tilt: ((r() - 0.5) * 3.2).toFixed(2), tape: ((r() - 0.5) * 10).toFixed(1) };
}

// ---- Views ----
const view = $('#view');
let route = null;
let filter = 'all';
let listCtx = [];
let current = null;
let opener = null;

function pieceButton(p, variant = 'thumb') {
  const kid = kidOf(p);
  const t = tilt(p.id);
  return `<button class="piece" type="button" data-id="${p.id}" style="--tilt:${t.tilt}deg;--tape:${t.tape}deg;--ar:${p.width}/${p.height}" aria-label="${esc(titleOf(p))} by ${esc(kid?.name)}">${p.favourite ? '<span class="magnet" aria-hidden="true"></span>' : '<span class="tape" aria-hidden="true"></span>'}<img src="${img(p, variant)}" alt="" loading="lazy" width="${p.width}" height="${p.height}"></button>`;
}
function tile(p, opts = {}) {
  const kid = kidOf(p);
  const meta = opts.own ? `${ageLabel(kid.born, p.made)} · ${madeShort(p)}` : `${kid.name} · ${ageLabel(kid.born, p.made)}`;
  return `<figure>${pieceButton(p)}<figcaption><span class="t">${esc(titleOf(p))}</span><span class="m"><i class="dot" style="--kid:${kid.colour}"></i>${esc(meta)}${opts.ago ? ` · ${opts.ago(p)}` : ''}</span></figcaption></figure>`;
}
const wall = (list, opts) => `<div class="wall">${list.map((p) => tile(p, opts)).join('')}</div>`;
const chip = (value, label, colour) => `<button class="chip" type="button" data-filter="${esc(value)}" aria-pressed="${filter === value}">${colour ? `<i class="dot" style="--kid:${colour}"></i>` : ''}${esc(label)}</button>`;
function yearsSpan(list) {
  const ys = list.map((p) => +p.made.slice(0, 4));
  const a = Math.min(...ys);
  const b = Math.max(...ys);
  return a === b ? `${a}` : `${a}–${String(b).slice(2)}`;
}

function emptyFridge() {
  if (!KIDS.length) {
    return CAN_EDIT
      ? `<section class="empty-state"><h1>The fridge is empty</h1><p>Add each kid first, from a computer with this repo checked out:</p><p><code>uv run scripts/fridge.py add-kid "Name" 2018-03-14</code></p><p>Then bring in the scans from Dropbox with <code>uv run scripts/fridge.py import</code>. The README has the details.</p></section>`
      : '<section class="empty-state"><h1>The fridge is empty</h1><p>Nothing’s been hung up yet. Check back soon.</p></section>';
  }
  return `<section class="empty-state"><h1>Nothing on the fridge yet</h1><p>${CAN_EDIT ? 'Add a piece with <b>Add art</b>, or bring in the scans from Dropbox with <code>uv run scripts/fridge.py import</code>.' : 'Check back soon.'}</p></section>`;
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
  const newest = [...PIECES].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id)).slice(0, 6);
  return `
    <section class="hero">
      <div class="hero-art">${pieceButton(f, 'display')}</div>
      <div class="hero-copy">
        <p class="eyebrow">On the fridge today</p>
        <h1>${esc(titleOf(f))}</h1>
        <p class="label-line"><i class="dot" style="--kid:${kid.colour}"></i>${esc(kid.name)}, ${ageLabel(kid.born, f.made)} · ${madeLong(f)}</p>
        ${f.medium ? `<p class="sub">${esc(f.medium)}</p>` : ''}
        ${f.story ? `<blockquote class="quote">“${esc(f.story)}”</blockquote>` : ''}
        <div class="row"><button class="btn primary" type="button" data-open="${f.id}">Look closer</button><button class="btn" type="button" data-frame>Play favourites</button></div>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2>The artists</h2></div>
      <div class="kids">${KIDS.map(kidCard).join('')}</div>
    </section>
    ${otd.length ? `<section data-scope><div class="sec-head"><h2>This time of year</h2><span class="count">${now.toLocaleDateString(undefined, { month: 'long' })}, in other years</span></div>${wall(otd, { ago })}</section>` : ''}
    <section data-scope><div class="sec-head"><h2>Just added</h2><a href="#timeline">See everything</a></div>${wall(newest)}</section>
    <p class="footnote">Only family can see the fridge. <a href="/cdn-cgi/access/logout">Sign out</a></p>`;
}

function kidCard(kid) {
  const mine = PIECES.filter((p) => p.kid_id === kid.id).sort(byMadeDesc);
  const thumbs = mine.slice(0, 3).map((p) => `<img src="${img(p, 'thumb')}" alt="" loading="lazy">`);
  while (thumbs.length < 3) thumbs.push('<span></span>');
  const since = mine.length ? ` since ${mine[mine.length - 1].made.slice(0, 4)}` : '';
  return `<a class="kid-card" href="#${kid.slug}" style="--kid:${kid.colour}">
    <div class="kid-thumbs">${thumbs.join('')}</div>
    <div class="kid-meta"><h3><i class="dot"></i>${esc(kid.name)}</h3><p>${ageNow(kid)} years old · ${plural(mine.length, 'piece')}${since}</p></div>
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
    ? [...groups].map(([age, list]) => `<section><div class="sec-head"><h2>Age ${age}</h2><span class="count">${yearsSpan(list)} · ${plural(list.length, 'piece')}</span></div>${wall(list, { own: true })}</section>`).join('')
    : `<p class="empty">${mine.length ? 'Nothing matches that.' : `Nothing of ${esc(kid.name)}’s is on the fridge yet.`}</p>`;
  return `
    <section class="kid-head" style="--kid:${kid.colour}">
      <h1>${esc(kid.name)}</h1>
      <p>${ageNow(kid)} years old · born ${fmt(kid.born, { year: 'numeric', month: 'long' })} · ${plural(mine.length, 'piece')}, ${mine.filter((p) => p.favourite).length} favourites</p>
    </section>
    ${mine.length ? `<div class="chips" role="group" aria-label="Show">${chip('all', 'All')}${chip('fav', 'Favourites')}${mediums.map((m) => chip(m, m)).join('')}</div>` : ''}
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
    <section class="page-head"><h1>Timeline</h1><p>${plural(PIECES.length, 'piece')}, ${yearsSpan(PIECES)}</p></section>
    <div class="chips" role="group" aria-label="Show">${chip('all', 'Everyone')}${KIDS.map((k) => chip(String(k.id), k.name, k.colour)).join('')}</div>
    <div class="groups" data-scope>${[...years].map(([y, list]) => `<section><div class="sec-head"><h2>${y}</h2><span class="count">${plural(list.length, 'piece')}</span></div>${wall(list)}</section>`).join('')}</div>`;
}

function render() {
  const h = location.hash.slice(1) || 'home';
  const kid = KIDS.find((k) => k.slug === h);
  const r = kid ? h : h === 'timeline' ? 'timeline' : 'home';
  if (r !== route) {
    if (route !== null) window.scrollTo(0, 0);
    route = r;
    filter = 'all';
  }
  view.innerHTML = kid ? viewKid(kid) : r === 'timeline' ? viewTimeline() : viewHome();
  document.querySelectorAll('#tabs a').forEach((a) => (a.dataset.route === r ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

function buildChrome() {
  document.body.classList.toggle('can-edit', CAN_EDIT);
  $('#tabs').innerHTML = [['home', 'Home'], ['timeline', 'Timeline'], ...KIDS.map((k) => [k.slug, k.name, k.colour])]
    .map(([id, label, c]) => `<a href="#${id}" data-route="${id}">${c ? `<i class="dot" style="--kid:${c}"></i>` : ''}${esc(label)}</a>`)
    .join('');
  const kidOptions = KIDS.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
  $('#f-kid').innerHTML = kidOptions;
  $('#a-who').innerHTML = `<legend>Who made it?</legend>${KIDS.map((k, i) => `<label><input type="radio" name="who" value="${k.id}"${i === 0 ? ' checked' : ''}><i class="dot" style="--kid:${k.colour}"></i>${esc(k.name)}</label>`).join('')}`;
  $('#open-add').hidden = !KIDS.length;
  $('#open-frame').hidden = !PIECES.length;
}

async function load() {
  const [session, data] = await Promise.all([api('/api/session'), api('/api/gallery')]);
  CAN_EDIT = session.canEdit;
  KIDS = data.kids.map((k, i) => ({ ...k, colour: `var(--kid-${i % 6})`, slug: `kid-${k.id}` }));
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
function closeDetail() {
  detail.hidden = true;
  lock(false);
  opener?.focus?.();
}
function showPiece(id) {
  const p = (current = PIECES.find((x) => x.id === id));
  if (!p) return closeDetail();
  const kid = kidOf(p);
  $('#d-img').src = img(p, 'display');
  $('#d-img').alt = `${titleOf(p)}, by ${kid.name}`;
  $('#d-count').textContent = `${listCtx.indexOf(id) + 1} of ${listCtx.length}`;
  $('#d-read').innerHTML = `<div class="stack">
    <p class="d-artist"><i class="dot" style="--kid:${kid.colour}"></i>${esc(kid.name)}, ${ageLabel(kid.born, p.made)}</p>
    <h2 class="d-title" id="d-title">${esc(titleOf(p))}<span>, ${p.made.slice(0, 4)}</span></h2>
    ${p.medium ? `<p class="d-medium">${esc(p.medium)}</p>` : ''}
    ${p.story ? `<blockquote class="quote">“${esc(p.story)}”</blockquote>` : ''}
    <p class="d-medium">Made ${madeLong(p)}</p>
    ${p.tags.length ? `<ul class="tags">${p.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <div class="row">
      <button class="btn edit-only" type="button" id="d-fav" aria-pressed="${p.favourite}">${p.favourite ? '♥' : '♡'} Favourite</button>
      <button class="btn edit-only" type="button" id="d-edit">Edit details</button>
      <a class="btn" href="${img(p, 'original')}" download>Save full scan</a>
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
    $('#f-title').focus();
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
  const b = e.target.closest('#view .piece, #view [data-open], #view [data-filter], #view [data-frame]');
  if (!b) return;
  if (b.matches('[data-filter]')) {
    filter = b.dataset.filter;
    render();
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
window.addEventListener('hashchange', render);

load().catch((e) => {
  view.innerHTML = `<section class="empty-state"><h1>The fridge didn’t open</h1><p>${esc(e.message)}</p><p><button class="btn" type="button" id="retry">Try again</button></p></section>`;
  $('#retry').onclick = () => location.reload();
});
