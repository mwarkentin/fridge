// Add art: several pictures and PDFs at once, from a phone, an iPad or a
// computer. Choose them, look each piece over (whose, when, what it's
// called), then they go up one after another. app.js loads this the first
// time Add art opens and hands it what it needs (open(ctx)).
//
// It names, dates, splits and leaves out pieces as scripts/fridge.py does
// (./names.js, ./ids.js, ./pages.js), so a piece added here is "already on
// the fridge" to the import script, and the other way round.

import { dateIn, stemOf, titleFrom } from './names.js';
import { pieceId, sha256 } from './ids.js';
import { kindOf, measure } from './pages.js';
import { photoDate } from './exif.js';

const $ = (s, el = document) => el.querySelector(s);
const wrap = $('#add');
const sheet = $('#add-sheet');
const input = $('#a-file');
const list = $('#a-list');

// As the import script: with the copies, under the Worker's 90 MB limit.
const MAX_BYTES = 85 * 1024 * 1024;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif', pdf: 'application/pdf' };
const PDF = 'application/pdf';

let ctx = null; // from app.js: kids, preview, today, api, esc, icon, avatar, kidStyle, lock, toast, refresh, show
let keys = 0;
let batch = fresh();
let pdfModule = null;
const pdfjs = () => {
  pdfModule ||= import('./pdf.js');
  pdfModule.catch(() => (pdfModule = null));
  return pdfModule;
};

function fresh(kidId = null) {
  return {
    files: [], // what was chosen, in order: { key, file, name, stem, type, pieces, looking, error }
    pieces: [], // what they become
    kidId, // the batch's "Who made these?"
    known: null, // what the fridge has: { hashes, skipped }, 'asking' or 'failed'
    queue: Promise.resolve(), // files are looked at one at a time
    looking: 0,
    sending: false,
    stop: false, // closed while sending: stop after the piece going up
    said: null, // what the footer says after a run: { text, kind }
  };
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const kidName = (id) => ctx.kids.find((k) => k.id === id)?.name ?? '';
const typeOf = (file) => {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const known = new Set(Object.values(TYPES));
  if (file.type === 'image/jpg') return 'image/jpeg';
  return known.has(file.type) ? file.type : TYPES[ext] || null;
};
// Pieces that can go up: new ones, and ones skipped before.
const tickable = (p) => (p.state === 'new' || p.state === 'skipped') && p.up !== 'done';
const toSend = () => batch.pieces.filter((p) => tickable(p) && p.include);

// ---- Opening and closing ----
export function open(context) {
  ctx = context;
  if (!ctx.kids.some((k) => k.id === batch.kidId)) batch.kidId = ctx.kids[0]?.id ?? null;
  draw();
  wrap.hidden = false;
  ctx.lock(true);
  // A toast saying to open Add art has done its job, and would cover the buttons.
  $('#toast').hidden = true;
  sheet.scrollTop = 0;
  (batch.files.length ? $('#a-summary') : input).focus({ preventScroll: true });
}

export function close() {
  if (wrap.hidden) return;
  wrap.hidden = true;
  ctx.lock(false);
  if (batch.sending && !batch.stop) {
    batch.stop = true;
    ctx.toast('Stopping once the piece going up now is on the fridge.');
  }
}

$('#add-close').onclick = close;
wrap.addEventListener('click', (e) => {
  if (e.target === wrap) close();
});

// ---- Choosing ----
input.addEventListener('change', () => {
  const files = [...input.files];
  input.value = '';
  if (files.length) choose(files);
});
$('#a-more').onclick = () => input.click();
// Dropping files on the sheet, on a computer.
sheet.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files') || batch.sending) return;
  e.preventDefault();
  sheet.classList.add('dropping');
});
sheet.addEventListener('dragleave', (e) => {
  if (!sheet.contains(e.relatedTarget)) sheet.classList.remove('dropping');
});
sheet.addEventListener('drop', (e) => {
  sheet.classList.remove('dropping');
  if (!e.dataTransfer?.files.length || batch.sending) return;
  e.preventDefault();
  choose([...e.dataTransfer.files]);
});

function choose(files) {
  if (batch.sending) return;
  const first = !batch.files.length;
  const entries = files.map((file) => ({ key: `f${++keys}`, file, name: file.name || 'Untitled', stem: stemOf(file.name || ''), type: typeOf(file), pieces: [], looking: true, error: null }));
  batch.files.push(...entries);
  batch.looking += entries.length;
  batch.said = null;
  if (!batch.known && !ctx.preview) askTheFridge(batch);
  if (first) draw();
  else {
    list.insertAdjacentHTML('beforeend', entries.map(lookingCard).join(''));
    drawSummary();
    drawFoot();
  }
  if (first) $('#a-summary').focus({ preventScroll: true });
  const mine = batch;
  for (const entry of entries) {
    mine.queue = mine.queue.then(async () => {
      if (batch !== mine) return; // started over
      let pieces;
      try {
        pieces = await look(entry, (text) => setLooking(entry, text));
      } catch {
        pieces = [{ ...blankPiece(entry), error: 'Couldn’t look at this file. Try choosing it again.' }];
      }
      if (batch !== mine) return pieces.forEach(forget);
      entry.looking = false;
      batch.looking--;
      for (const p of pieces) {
        p.twice = batch.pieces.some((q) => q.hash && q.hash === p.hash);
        p.state = stateOf(p);
        p.include = p.state === 'new' && p.kind !== 'blank';
        batch.pieces.push(p);
      }
      entry.pieces = pieces;
      const at = list.querySelector(`[data-key="${entry.key}"]`);
      if (at) at.outerHTML = pieces.map(card).join('');
      drawSummary();
      drawFoot();
    });
  }
}

// What the fridge has already, so those pieces are left out, and pieces a
// parent chose not to import before start unticked.
async function askTheFridge(mine) {
  mine.known = 'asking';
  try {
    const { hashes, skipped } = await ctx.api('/api/imported');
    mine.known = { hashes: new Set(hashes), skipped: new Set(skipped) };
  } catch {
    mine.known = 'failed';
  }
  if (batch !== mine) return;
  for (const p of batch.pieces) {
    const state = stateOf(p);
    if (state === p.state) continue;
    p.state = state;
    p.include = state === 'new' && p.kind !== 'blank';
    redraw(p);
  }
  drawSummary();
  drawFoot();
}

function stateOf(p) {
  if (!p.hash) return 'bad';
  if (p.twice) return 'twice';
  const known = typeof batch.known === 'object' ? batch.known : null;
  if (known?.hashes.has(p.hash)) return 'on';
  if (known?.skipped.has(p.hash)) return 'skipped';
  return 'new';
}

// ---- Looking at each file ----
// A file's pieces: one for a picture or a one-page PDF, one per page for a
// PDF of several, each with a little picture to look at, its source hash,
// and the guesses from its name.
async function look(entry, progress) {
  const { file, type } = entry;
  const bad = (error) => [{ ...blankPiece(entry), error }];
  if (!type) return bad('The fridge can’t take this kind of file. Choose photos, scans or PDFs.');
  if (type !== PDF && file.size > MAX_BYTES) return bad('It’s too big: the limit is 85 MB.');
  let bytes;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return bad('Couldn’t read this file. Try choosing it again.');
  }
  const hash = await sha256(bytes);
  if (type !== PDF) {
    let thumb;
    try {
      thumb = await smallPicture(await decode(file));
    } catch {
      return bad('This browser can’t open this picture. Try a JPEG or PNG.');
    }
    return [piece(entry, { hash, page: 1, count: 1, thumb, when: guessWhen(entry, photoDate(bytes)) })];
  }
  let lib, doc;
  try {
    lib = await pdfjs();
    doc = await lib.open(new Uint8Array(bytes));
  } catch (e) {
    return bad(lib && e instanceof lib.PdfError ? e.message : 'Couldn’t open PDFs just now. Check the connection and try again.');
  }
  try {
    const count = doc.numPages;
    const when = guessWhen(entry, null);
    const pieces = [];
    for (let n = 1; n <= count; n++) {
      if (count > 1) progress(`Looking at page ${n} of ${count}…`);
      const canvas = await lib.render(doc, n, lib.SURVEY);
      // A PDF of several pages leaves out its blank pages, as the import does.
      const kind = count > 1 ? kindOf(measure(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)) : null;
      pieces.push(piece(entry, { hash: await pieceId(hash, n, count), page: n, count, kind, thumb: await jpegUrl(canvas, 0.8), when }));
      free(canvas);
    }
    return pieces;
  } catch {
    return bad('Couldn’t draw the pages of this PDF. It may be damaged.');
  } finally {
    lib.close(doc);
  }
}

function blankPiece(entry) {
  return { key: `p${++keys}`, file: entry, hash: null, page: 1, count: 1, kind: null, thumb: null, state: 'bad', include: false, up: null };
}

function piece(entry, { hash, page, count, kind = null, thumb, when }) {
  const kidId = batch.kidId;
  return { ...blankPiece(entry), hash, page, count, kind, thumb, ...when, kidId, ownKid: false, title: titleFrom(entry.stem, kidName(kidId)), ownTitle: false, story: '', error: '' };
}

// When it was made: from the file name as the import script reads it, else
// the day the photo was taken, else today. `from` says which.
function guessWhen(entry, taken) {
  const found = dateIn(entry.stem);
  if (found) return { made: found[0], precision: found[1], from: 'name' };
  if (taken && taken <= ctx.today) return { made: taken, precision: 'day', from: 'photo' };
  return { made: ctx.today, precision: 'day', from: 'today' };
}

function forget(p) {
  if (p.thumb) URL.revokeObjectURL(p.thumb);
}

// ---- Pictures ----
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari: an <img> knows more formats than createImageBitmap does.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
const sizeOf = (src) => [src.naturalWidth || src.width, src.naturalHeight || src.height];

// A canvas no bigger than `max` on its long side, on white. A canvas that's
// small enough already is used as it is.
function scaled(src, max) {
  const [sw, sh] = sizeOf(src);
  const s = Math.min(1, max / Math.max(sw, sh));
  if (s === 1 && src instanceof HTMLCanvasElement) return src;
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(sw * s));
  cv.height = Math.max(1, Math.round(sh * s));
  const c = cv.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cv.width, cv.height);
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
const jpeg = (cv, quality) => new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make a copy of this picture.'))), 'image/jpeg', quality));
const jpegUrl = async (cv, quality) => URL.createObjectURL(await jpeg(cv, quality));
// Let go of a canvas's memory now: phones run out with big ones about.
const free = (cv) => {
  if (cv instanceof HTMLCanvasElement) cv.width = cv.height = 0;
  else cv?.close?.();
};

async function smallPicture(src) {
  const cv = scaled(src, 360);
  try {
    return await jpegUrl(cv, 0.8);
  } finally {
    free(cv);
    free(src);
  }
}

// The screen-sized copy and the thumbnail, as Add art has always made them:
// JPEGs at most 2000 and 480 pixels on the long side.
async function copiesOf(src) {
  const display = scaled(src, 2000);
  const thumb = scaled(display, 480);
  try {
    return { display: await jpeg(display, 0.85), thumb: await jpeg(thumb, 0.8), width: display.width, height: display.height };
  } finally {
    free(thumb);
    free(display);
    free(src);
  }
}

// ---- Drawing ----
function draw() {
  const any = batch.files.length > 0;
  $('#a-choose').hidden = any;
  $('#a-review').hidden = !any;
  $('#a-foot').hidden = !any;
  sheet.classList.toggle('reviewing', any);
  drawWho();
  list.innerHTML = batch.files.map((f) => (f.looking ? lookingCard(f) : f.pieces.map(card).join(''))).join('');
  drawSummary();
  drawFoot();
}

// ---- Who made it: the batch's picker, and each piece's ----
// Both list ctx.kids, which is app.js's addableKids(), and only that.
function drawWho() {
  const { esc, avatar, kidStyle } = ctx;
  const many = batch.pieces.length !== 1 || batch.looking > 0;
  $('#a-who').innerHTML = `<legend>Who made ${many ? 'these' : 'it'}?</legend>${ctx.kids.map((k) => `<label class="who-opt" style="${kidStyle(k)}"><input type="radio" name="who" value="${k.id}"${k.id === batch.kidId ? ' checked' : ''}${batch.sending ? ' disabled' : ''}><span class="who-card">${avatar(k)}${esc(k.name)}</span></label>`).join('')}`;
}
function kidPicker(p) {
  if (ctx.kids.length < 2) return '';
  return `<label class="field">Who made it <select data-f="kid">${ctx.kids.map((k) => `<option value="${k.id}"${k.id === p.kidId ? ' selected' : ''}>${ctx.esc(k.name)}</option>`).join('')}</select></label>`;
}

$('#a-who').addEventListener('change', (e) => {
  batch.kidId = Number(e.target.value);
  for (const p of batch.pieces) {
    if (p.ownKid || !p.hash) continue;
    p.kidId = batch.kidId;
    const el = cardOf(p);
    const select = el?.querySelector('[data-f="kid"]');
    if (select) select.value = String(p.kidId);
    retitle(p, el);
  }
});

function lookingCard(entry) {
  return `<li class="a-card looking" data-key="${entry.key}"><div class="a-top"><span class="a-thumb a-none" aria-hidden="true">${ctx.icon('look')}</span><div class="a-what"><p class="a-name">${ctx.esc(entry.name)}</p><p class="a-badge b-muted" data-looking>Looking at it…</p></div></div></li>`;
}
function setLooking(entry, text) {
  const el = list.querySelector(`[data-key="${entry.key}"] [data-looking]`);
  if (el) el.textContent = text;
}

const PRECISIONS = ['day', 'month', 'year'];
function dateNote(p) {
  if (p.from === 'name') return p.precision === 'day' ? 'From the file name.' : `From the file name, which gives the ${p.precision}.`;
  if (p.from === 'photo') return 'No date in the name, so it’s the day the photo was taken.';
  if (p.from === 'today') return p.file.type === PDF ? 'No date in the name, so it’s today.' : 'No date in the name or the photo, so it’s today.';
  return '';
}

function badge(p) {
  if (p.state === 'bad') return ['bad', p.error];
  if (p.state === 'twice') return ['muted', 'Chosen twice, so it’s here once'];
  if (p.state === 'on') return ['on', 'Already on the fridge'];
  if (p.up === 'done') return null;
  if (p.state === 'skipped') return ['muted', 'Skipped before'];
  if (p.kind === 'blank') return ['muted', 'Blank, so it’s left out'];
  if (p.kind === 'plain') return ['plain', 'Plain: a document, or a pencil drawing?'];
  return null;
}
function tickLabel(p) {
  if (p.state === 'skipped') return 'Add it after all';
  if (p.kind === 'blank') return 'Add it anyway';
  return 'Add this one';
}
function upText(p) {
  const { esc, icon } = ctx;
  if (p.up === 'waiting') return 'Waiting its turn';
  if (p.up === 'sending') return 'Going up…';
  if (p.up === 'done') return `${icon('check')}${p.duplicate ? 'It was on the fridge already' : 'On the fridge'}`;
  if (p.up === 'failed') return `Didn’t go up: ${esc(p.error)}`;
  return '';
}

function card(p) {
  const { esc, icon } = ctx;
  const where = p.count > 1 ? `Page ${p.page} of ${p.count}` : '';
  const b = badge(p);
  const can = tickable(p);
  const locked = batch.sending || p.up === 'done';
  const id = `n-${p.key}`;
  const classes = ['a-card', `st-${p.state}`, can && p.include ? 'in' : '', p.up ? `up-${p.up}` : ''].filter(Boolean).join(' ');
  return `<li class="${classes}" data-key="${p.key}">
    <div class="a-top">
      ${p.thumb ? `<img class="a-thumb" src="${p.thumb}" alt="">` : `<span class="a-thumb a-none" aria-hidden="true">${icon('picture')}</span>`}
      <div class="a-what">
        <p class="a-name" id="${id}">${esc(p.file.name)}${where ? ` <span>${where}</span>` : ''}</p>
        ${b ? `<p class="a-badge b-${b[0]}">${esc(b[1])}</p>` : ''}
        <p class="a-up" data-up${p.up ? '' : ' hidden'}>${upText(p)}</p>
        ${can && p.up !== 'done' ? `<label class="a-pick"><input type="checkbox" data-f="include" aria-describedby="${id}"${p.include ? ' checked' : ''}${locked ? ' disabled' : ''}><span>${tickLabel(p)}</span></label>` : ''}
      </div>
    </div>
    ${
      can
        ? `<fieldset class="a-fields"${locked ? ' disabled' : ''}>
      <legend class="sr">${esc(p.file.name)}${where ? `, ${where}` : ''}</legend>
      <label class="field">Title <input data-f="title" maxlength="200" placeholder="Untitled" value="${esc(p.title)}" autocomplete="off" enterkeyhint="done"></label>
      <div class="two">
        <label class="field">Made on <input data-f="made" type="date" value="${p.made}" max="${ctx.today}" required></label>
        <label class="field">We know the <select data-f="precision">${PRECISIONS.map((v) => `<option value="${v}"${v === p.precision ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <p class="a-note" data-note${dateNote(p) ? '' : ' hidden'}>${dateNote(p)}</p>
      ${kidPicker(p)}
      <details class="a-story"${p.story ? ' open' : ''}><summary>${icon('plus')}What did they say about it?</summary><textarea data-f="story" rows="2" maxlength="2000" placeholder="Write it down before it’s forgotten" aria-label="What did they say about it?">${esc(p.story)}</textarea></details>
    </fieldset>`
        : ''
    }
  </li>`;
}

const cardOf = (p) => list.querySelector(`[data-key="${p.key}"]`);
function redraw(p) {
  const el = cardOf(p);
  if (el) el.outerHTML = card(p);
}
const pieceOf = (el) => {
  const key = el.closest('[data-key]')?.dataset.key;
  return batch.pieces.find((p) => p.key === key);
};

// A title that follows its kid, until someone types their own: the kid's name
// (or a short form) is left out of it.
function retitle(p, el = cardOf(p)) {
  if (p.ownTitle) return;
  p.title = titleFrom(p.file.stem, kidName(p.kidId));
  const field = el?.querySelector('[data-f="title"]');
  if (field) field.value = p.title;
}

list.addEventListener('input', (e) => {
  const p = pieceOf(e.target);
  if (!p) return;
  if (e.target.dataset.f === 'title') {
    p.title = e.target.value;
    p.ownTitle = true;
  } else if (e.target.dataset.f === 'story') p.story = e.target.value;
});
list.addEventListener('change', (e) => {
  const p = pieceOf(e.target);
  const el = e.target;
  if (!p) return;
  const f = el.dataset.f;
  if (f === 'include') {
    p.include = el.checked;
    cardOf(p).classList.toggle('in', p.include);
    drawSummary();
    drawFoot();
  } else if (f === 'made') {
    // Cleared (iOS has a button for it): keep what it was.
    if (!el.value) el.value = p.made;
    p.made = el.value;
    p.from = 'you';
    cardOf(p).querySelector('[data-note]').hidden = true;
  } else if (f === 'precision') p.precision = el.value;
  else if (f === 'kid') {
    p.kidId = Number(el.value);
    p.ownKid = true;
    retitle(p);
  }
});

function drawSummary() {
  const ps = batch.pieces;
  const count = (test) => ps.filter(test).length;
  const parts = [];
  const going = toSend().length;
  if (batch.looking) parts.push(`Looking at file ${batch.files.length - batch.looking + 1} of ${batch.files.length}…`);
  else parts.push(`${plural(going, 'piece')} to add, from ${plural(batch.files.length, 'file')}.`);
  const blank = count((p) => p.state === 'new' && p.kind === 'blank' && !p.include);
  const on = count((p) => p.state === 'on');
  const skipped = count((p) => p.state === 'skipped' && !p.include);
  const twice = count((p) => p.state === 'twice');
  const bad = count((p) => p.state === 'bad');
  const done = count((p) => p.up === 'done');
  if (done) parts.push(`${plural(done, 'piece')} on the fridge now.`);
  if (blank) parts.push(`${plural(blank, 'blank page')} left out.`);
  if (on) parts.push(`${plural(on, 'piece')} already on the fridge.`);
  if (skipped) parts.push(`${plural(skipped, 'piece')} skipped before.`);
  if (twice) parts.push(`${plural(twice, 'file')} chosen twice.`);
  if (bad) parts.push(`${plural(bad, 'file')} the fridge can’t take.`);
  if (batch.known === 'failed') parts.push('Couldn’t ask the fridge what it has already, so nothing here is marked as on it. Nothing goes up twice either way.');
  if (ctx.preview) parts.push('This preview has no fridge behind it, so nothing here is marked as on it already.');
  $('#a-summary').textContent = parts.join(' ');
}

function drawFoot() {
  const n = toSend().length;
  const tried = batch.pieces.some((p) => p.up === 'failed');
  const submit = $('#a-submit');
  submit.textContent = batch.sending ? 'Adding…' : batch.looking ? 'Looking at the files…' : tried ? `Try ${n === 1 ? 'it' : `the ${n}`} again` : n ? `Add ${plural(n, 'piece')} to the fridge` : 'Nothing to add';
  submit.disabled = batch.sending || batch.looking > 0 || n === 0;
  $('#a-more').disabled = batch.sending;
  $('#a-restart').disabled = batch.sending;
  // On the preview, its note has its own buttons.
  $('#a-foot .a-buttons').hidden = batch.said?.kind === 'preview';
  const said = $('#a-said');
  const unticked = batch.pieces.filter((p) => p.state === 'new' && !p.include && p.kind !== 'blank').length;
  const s = batch.said || (unticked && !batch.sending ? { kind: 'hint', text: `${unticked === 1 ? 'The unticked piece is' : `The ${unticked} unticked pieces are`} remembered as skipped, so the import script leaves ${unticked === 1 ? 'it' : 'them'} out too.` } : null);
  said.hidden = !s;
  said.className = `a-said${s ? ` said-${s.kind}` : ''}`;
  said.innerHTML = s ? s.html || ctx.esc(s.text) : '';
}

$('#a-restart').onclick = () => {
  if (batch.sending) return;
  startOver();
  input.focus({ preventScroll: true });
};
function startOver() {
  batch.pieces.forEach(forget);
  batch = fresh(batch.kidId);
  draw();
  sheet.scrollTop = 0;
}

// ---- Sending ----
$('#a-submit').onclick = () => send();
sheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-done]')) {
    startOver();
    close();
  } else if (e.target.closest('[data-back]')) {
    batch.said = null;
    drawFoot();
  }
});

const holdOn = (e) => {
  e.preventDefault();
  e.returnValue = '';
};

async function send() {
  const todo = toSend();
  if (batch.sending || batch.looking || !todo.length) return;
  if (ctx.preview) {
    const kids = [...new Set(todo.map((p) => kidName(p.kidId)))];
    batch.said = {
      kind: 'preview',
      html: `<p>This is a preview with a made-up family, so nothing is saved. On the fridge, ${todo.length === 1 ? 'this piece would' : `these ${todo.length} pieces would`} go up now, one after another, onto ${ctx.esc(kids.join(' and '))}’s wall${kids.length > 1 ? 's' : ''}.</p><div class="row"><button class="btn primary" type="button" data-done>Done</button><button class="btn" type="button" data-back>Back to the pieces</button></div>`,
    };
    drawFoot();
    $('#a-said button').focus();
    return;
  }
  const mine = batch;
  batch.sending = true;
  batch.stop = false;
  batch.said = null;
  for (const p of todo) {
    p.up = 'waiting';
    p.error = '';
  }
  addEventListener('beforeunload', holdOn);
  const wake = await navigator.wakeLock?.request('screen').catch(() => null);
  draw();
  const bar = $('#a-bar');
  const status = $('#a-status');
  $('#a-progress').hidden = false;
  bar.max = todo.length;
  bar.value = 0;
  let lost = false;
  await rememberSkips(mine);
  for (const [i, p] of todo.entries()) {
    if (mine.stop) break;
    status.textContent = `Adding ${i + 1} of ${todo.length}…`;
    p.up = 'sending';
    redraw(p);
    cardOf(p)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    try {
      const res = await upload(p);
      p.up = 'done';
      p.duplicate = Boolean(res.duplicate);
    } catch (e) {
      p.up = 'failed';
      p.error = e.message;
      // Without a connection (or a sign-in) the rest would fail too.
      lost = Boolean(e.lost);
    }
    redraw(p);
    bar.value = i + 1;
    if (lost) break;
  }
  for (const p of todo) if (p.up === 'waiting') p.up = null;
  await closeDoc();
  wake?.release().catch(() => {});
  removeEventListener('beforeunload', holdOn);
  mine.sending = false;
  $('#a-progress').hidden = true;
  finish(mine, { lost, todo });
}

// What a run (or, once it's all up, the whole batch) added, in a few words.
function addedText(done) {
  const added = done.filter((p) => !p.duplicate);
  if (!added.length) return done.length ? 'Those were on the fridge already' : '';
  const kids = new Set(added.map((p) => p.kidId));
  return `Added ${plural(added.length, 'piece')}${kids.size === 1 ? ` to ${kidName(added[0].kidId)}’s wall` : ''}`;
}

async function finish(mine, { lost, todo }) {
  const done = todo.filter((p) => p.up === 'done');
  const failed = todo.filter((p) => p.up === 'failed');
  const left = toSend();
  if (done.length) await ctx.refresh().catch(() => {});
  if (batch !== mine) return;
  if (!left.length) {
    const all = mine.pieces.filter((p) => p.up === 'done');
    const message = addedText(all);
    startOver();
    close();
    if (all.length) ctx.show(all.map((p) => p.kidId));
    if (message) ctx.toast(message);
    return;
  }
  const message = addedText(done);
  if (wrap.hidden) {
    // Closed part way: what went up is on the fridge, and the rest waits here.
    ctx.toast(`${message ? `${message}. ` : ''}${plural(left.length, 'piece')} still to add: open Add art to finish.`);
    draw();
    return;
  }
  const why = lost
    ? 'Couldn’t reach the fridge. Try again in a moment. If that fails, the sign-in may have run out: reload, then choose the same files. What’s up already is left out.'
    : failed.length
      ? `${failed.length === 1 ? 'One piece didn’t' : `${failed.length} pieces didn’t`} go up: ${failed.length === 1 ? 'it’s' : 'they’re'} marked below. Everything else is on the fridge.`
      : `Stopped with ${plural(left.length, 'piece')} still to add.`;
  batch.said = { kind: 'error', text: `${message ? `${message}. ` : ''}${why}` };
  draw();
  $('#a-submit').focus({ preventScroll: true });
}

// Pieces left unticked are remembered as skipped, as the survey's report
// does, so the import script leaves them out too. Blank pages it leaves out
// by itself.
async function rememberSkips(mine) {
  const add = mine.pieces.filter((p) => p.state === 'new' && !p.include && p.kind !== 'blank' && !p.remembered);
  if (!add.length) return;
  try {
    await ctx.api('/api/skipped', { method: 'POST', json: { add: add.map((p) => p.hash) } });
    for (const p of add) p.remembered = true;
  } catch {
    // Not worth stopping for: the import script would offer them again, that's all.
  }
}

// One piece up: its copies, its original, and what the review says about it.
class Lost extends Error {
  lost = true;
}
async function upload(p) {
  const entry = p.file;
  let copies, original;
  try {
    if (entry.type === PDF) {
      const lib = await pdfjs();
      const doc = await docFor(entry);
      copies = await copiesOf(await lib.render(doc, p.page, lib.DISPLAY));
      // A page of a PDF of several pages goes up as a PDF of that page, as the import script sends it.
      original = p.count > 1 ? new File([await lib.extract(doc, p.page)], `${entry.stem} p${p.page}.pdf`, { type: PDF }) : asType(entry);
    } else {
      copies = await copiesOf(await decode(entry.file));
      original = asType(entry);
    }
  } catch (e) {
    const lib = entry.type === PDF ? await pdfjs().catch(() => null) : null;
    throw new Error(lib && e instanceof lib.PdfError ? e.message : entry.type === PDF ? 'Couldn’t draw this page of the PDF.' : 'This browser can’t open this picture. Try a JPEG or PNG.');
  }
  if (original.size > MAX_BYTES) throw new Error('It’s too big: the limit is 85 MB.');
  const body = new FormData();
  body.set(
    'meta',
    JSON.stringify({
      kid_id: p.kidId,
      made: p.made,
      made_precision: p.precision,
      title: p.title.trim(),
      story: p.story.trim(),
      width: copies.width,
      height: copies.height,
      source_hash: p.hash,
      source_name: p.count > 1 ? `${entry.name}#page=${p.page}` : entry.name,
    }),
  );
  body.set('original', original, original.name);
  body.set('display', copies.display, 'display.jpg');
  body.set('thumb', copies.thumb, 'thumb.jpg');
  let res;
  try {
    res = await fetch('/api/pieces', { method: 'POST', headers: { 'X-Requested-With': 'fridge' }, body });
  } catch {
    // Most often an expired sign-in: Access redirects to its sign-in page,
    // which fetch can't follow.
    throw new Lost('Couldn’t reach the fridge.');
  }
  const isJson = (res.headers.get('Content-Type') || '').includes('json');
  if (!res.ok) {
    if (!isJson && (res.status === 401 || res.status === 403)) throw new Lost('The sign-in has run out.');
    let msg = `Something went wrong (HTTP ${res.status}).`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// The file as the fridge expects it: with its type, even where the browser
// left it out (a HEIC on Windows, say).
const asType = (entry) => (entry.file.type === entry.type ? entry.file : new File([entry.file], entry.name, { type: entry.type }));

// The PDF being uploaded from, kept open while its pages go up.
let openDoc = null;
async function docFor(entry) {
  if (openDoc?.entry === entry) return openDoc.doc;
  await closeDoc();
  const lib = await pdfjs();
  openDoc = { entry, doc: await lib.open(new Uint8Array(await entry.file.arrayBuffer())) };
  return openDoc.doc;
}
async function closeDoc() {
  if (!openDoc) return;
  const { doc } = openDoc;
  openDoc = null;
  (await pdfjs()).close(doc);
}
