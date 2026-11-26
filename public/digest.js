// The email digest: what's new on the fridge for someone, as an email (a
// subject, HTML and plain text), from the bell's notifications. The Worker
// sends it with the pictures attached (worker.js, sendDigest); the page
// shows the same email in the bell (See it), with the pictures from /img.
// The words are the bell's (notes.js).
//
// It has names, titles, what was said and the pictures, and never an
// address. Everything in it comes from notifications() in worker.js, so it
// follows the same rules: only kids this person sees, and the people in
// families they don't see are "Family".
//
// It looks like the fridge: the wordmark's letter magnets beside the app
// icon, squiggles under the headings, each piece taped up on paper with
// its title in handwriting, the kids' and everyone else's magnets, and what
// was said in a speech bubble. Email can't fetch the page's fonts (they're
// behind the sign-in), so it asks for them by name and falls back to the
// nearest ones a phone or computer has. Mail apps that ignore some of it
// (Gmail drops the tilts and the edges on the magnets) still show the
// colours, the paper and the words.
//
// Nothing here touches the page or the Worker, so both, and the tests, run it.

import { andList, noteWords } from './notes.js';

// The page's kid colours in light and dark, and their soft tints (--kid-0
// to --kid-5 and --kid-N-soft in app.css); families.js picks each kid's.
export const KID_COLOURS = ['#2361b5', '#b04f00', '#22773a', '#7341b0', '#b3306c', '#0a706c'];
export const KID_COLOURS_DARK = ['#86baf7', '#f6a964', '#74d38e', '#c3a0f4', '#f396c1', '#63d3cc'];
export const KID_SOFT = ['#e3edfb', '#fcebdc', '#e1f2e3', '#eee6fa', '#fbe4ee', '#dcf1ef'];
export const KID_SOFT_DARK = ['#1d3550', '#3b2e22', '#1d3b2b', '#2f2a4a', '#3e2536', '#173c3d'];
// The wordmark's letter magnets, as index.html's .brand has them: each
// letter, its colour and the darker plastic edge under it, in light and
// dark (--mg-* in app.css), and its tilt.
export const MAGNETS = [
  ['F', '#d3362b', '#9e2018', '#ff6b5e', '#b8352b', -6],
  ['R', '#f2b705', '#b88800', '#ffd23f', '#b8900f', 5],
  ['I', '#2468c4', '#17488c', '#69a8ff', '#3168b8', -2],
  ['D', '#2b8a3e', '#1c5f2a', '#5fd07a', '#2b8c45', 7],
  ['G', '#bd5b00', '#843f00', '#ffa04a', '#b8661c', -6],
  ['E', '#8048c0', '#5a2d8e', '#b98cff', '#7650c0', 5],
];
// The squiggles under the headings, in the page's order (SQUIGGLES in
// app.js): orange, blue, green, in light and dark (--cr-* in app.css).
const SQUIGGLES = [
  ['#f08a24', '#ffa04a'],
  ['#2f7ad6', '#69a8ff'],
  ['#3aa152', '#5fd07a'],
];
// The most pictures one email carries; the rest are words only.
export const PICTURES_MAX = 12;
const EMOJI = { heart: '❤️', star: '⭐', wow: '😮', smile: '😊', rainbow: '🌈' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const asDate = (at) => new Date(`${at.replace(' ', 'T')}Z`);
const initial = (name) => (Array.from(String(name ?? '').trim())[0] || '?').toLocaleUpperCase();

// "8 am", "12 pm", "9 pm".
export const hourWords = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
// "every Sunday at 8 am", "every day at 7 am", or "off".
export const scheduleWords = (every, hour) => (every === 'weekly' ? `every Sunday at ${hourWords(hour)}` : every === 'daily' ? `every day at ${hourWords(hour)}` : 'off');

// The page's colours (app.css) and fonts, by name, then the nearest a phone
// or computer is likely to have: Apple's rounded and chalkboard ones.
const INK = '#1c2a30';
const MUTED = '#3f5258';
const BG = '#d3ebe1';
const PAPER = '#fffdf6';
const LINE = '#e4dfd0';
const TAPE = '#f2e1a2';
const DISPLAY = "'Fredoka', 'Avenir Next Rounded', 'Arial Rounded MT Bold', 'Nunito', -apple-system, 'Segoe UI', Roboto, sans-serif";
const BODY = "'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const HAND = "'Schoolbell', 'Chalkboard SE', 'Comic Sans MS', cursive";
// The magnets' plastic edge and shadow, as the page draws them.
const edge = (e) => `0 0.035em 0 ${e}, 0 0.07em 0 ${e}, 0 0.1em 0.12em rgba(0,0,0,0.28)`;
const TILTS = [-1.5, 1.2, -0.8, 1.6];

// The email for these notifications (newest first, only the ones to tell
// about), for someone who sees `kids` ({ id, name, ci }: their colour from
// families.js). `titles` has each piece's title by id, for a day's art
// beyond the first. `kidId` is their own kid's, on a kid's sign-in. `since`
// (a time like created_at, in UTC) and `zone` say what it covers, `url` is
// the fridge's address, `picture(id)` where a piece's thumbnail is
// (cid:piece-<id> in the email), and `icon` where the app icon is (cid:fridge
// in the email), or nothing to leave it out. `test` marks one sent when
// asked, which covers the last day or week whatever has been seen.
//
// Returns { subject, html, text, pictures }: `pictures` are the piece ids
// whose thumbnails it shows, at most PICTURES_MAX.
export function digestMail({ items, kids = [], titles = {}, kidId = null, every = 'weekly', hour = 8, zone = 'UTC', since = null, url, picture, icon = null, test = false }) {
  const ctx = { kids, kidId };
  // Each kind of date is made once: making one takes a while.
  const short = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
  const long = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' });
  const day = (at, format = short) => format.format(asDate(at));
  const kidById = (id) => kids.find((k) => k.id === id);
  const ci = (n) => kidById(n.kid_id)?.ci ?? 0;
  const pieceUrl = (id) => `${url}/?piece=${Number(id)}`;
  const bellUrl = `${url}/?bell=1`;
  const settingsUrl = `${url}/?bell=email`;
  const shown = [];
  const pic = (id) => {
    if (!shown.includes(id)) {
      if (shown.length >= PICTURES_MAX) return null;
      shown.push(id);
    }
    return picture(id);
  };

  const art = items.filter((n) => n.kind === 'art');
  const talk = items.filter((n) => n.kind === 'comment' || n.kind === 'reply');
  const stickers = items.filter((n) => n.kind === 'sticker');
  const pieces = art.reduce((t, n) => t + n.count, 0);
  const stuck = stickers.reduce((t, n) => t + n.stickers.length, 0);
  const counts = [pieces && plural(pieces, 'new piece'), talk.length && plural(talk.length, 'comment'), stuck && plural(stuck, 'sticker')].filter(Boolean);
  const subject = `${test ? 'Test: ' : ''}What’s new on the fridge: ${counts.length ? andList(counts) : 'nothing yet'}`;
  const when = test || !since ? (every === 'daily' ? 'In the last day' : 'In the last week') : `Since ${day(since, long)}`;
  const schedule = scheduleWords(every, hour);
  const words = (n) => noteWords(n, ctx);
  const plain = (n) => noteWords(n, ctx, false);
  const said = (body) => esc(body).replace(/\r?\n/g, '<br>');

  // A magnet with someone's first letter: a kid's in their colour, anyone
  // else's grey, as the page draws them.
  const magnet = (name, kidCi, size = 30) =>
    `<span class="${kidCi == null ? 'avg' : `a${kidCi}`}" style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${kidCi == null ? MUTED : KID_COLOURS[kidCi]};color:#ffffff;font:700 ${Math.round(size * 0.54)}px/${size}px ${DISPLAY};text-align:center;vertical-align:middle;box-shadow:inset 0 -2px 0 rgba(0,0,0,0.16),0 1px 3px rgba(0,0,0,0.22)">${esc(initial(name))}</span>`;
  // Whose art it is, or who said or stuck something.
  const kidMagnet = (n) => {
    const kid = kidById(n.kid_id);
    return kid ? magnet(kid.name, kid.ci) : '';
  };
  const whoMagnet = (n) => {
    const kid = n.by_kid_id != null ? kidById(n.by_kid_id) : null;
    return kid ? magnet(kid.name, kid.ci) : magnet(n.by, null);
  };
  // A piece taped up on paper, linked to itself, or nothing past the limit.
  const taped = (id, width, alt, i) => {
    const src = pic(id);
    if (!src) return '';
    const tilt = TILTS[i % TILTS.length];
    return `<div class="tape" style="width:${Math.round(width * 0.46)}px;height:13px;margin:0 auto -8px;background:${TAPE};opacity:0.92;position:relative;z-index:1;transform:rotate(${tilt > 0 ? -3 : 3}deg)"></div><a href="${esc(pieceUrl(id))}" style="display:block;text-decoration:none;border:0"><div class="paper" style="background:#ffffff;padding:5px;box-shadow:0 1px 2px rgba(25,45,40,0.16),0 8px 14px -6px rgba(25,45,40,0.34);transform:rotate(${tilt}deg)"><img src="${esc(src)}" width="${width - 10}" alt="${esc(alt)}" style="display:block;width:100%;height:auto;border:0;background:${LINE}"></div></a>`;
  };
  const meta = (n) => `<div class="muted" style="color:${MUTED};font:600 13px/18px ${BODY};margin-top:4px">${esc(day(n.at))}</div>`;
  const lead = (who, n) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${who ? `<td width="40" valign="top" style="width:40px;padding-top:1px">${who}</td>` : ''}<td valign="top" class="ink" style="color:${INK};font:500 16px/22px ${BODY}"><a href="${esc(pieceUrl(n.piece_id))}" class="ink" style="color:${INK};text-decoration:none">${words(n)}</a>${meta(n)}</td></tr></table>`;
  const row = (inner) => `<tr><td class="line" style="padding:16px 0;border-top:1px solid ${LINE}">${inner}</td></tr>`;

  // A day's new art: whose, then its pictures taped up with their titles.
  const artRow = (n) => {
    const ids = n.pieces.length ? n.pieces : [n.piece_id];
    const tiles = ids
      .map((id, i) => {
        const title = titles[id] ?? (id === n.piece_id ? n.title : '') ?? '';
        const img = taped(id, 128, title || 'A new piece', i);
        return img ? `<div style="display:inline-block;vertical-align:top;width:128px;margin:16px 14px 0 0">${img}<div class="ink" style="color:${INK};font:400 18px/1.15 ${HAND};margin-top:8px;text-align:center">${title ? esc(title) : `<span class="muted" style="color:${MUTED}">Untitled</span>`}</div></div>` : '';
      })
      .join('');
    const more = n.count > ids.length ? `<div class="muted" style="color:${MUTED};font:600 13px ${BODY};margin-top:8px">and ${plural(n.count - ids.length, 'more piece')} on the fridge</div>` : '';
    return row(`${lead(kidMagnet(n), n)}${tiles ? `<div>${tiles}</div>` : ''}${more}`);
  };
  // A comment or stickers: the piece taped up beside who and what.
  const sideRow = (n, extra, i) => {
    const img = taped(n.piece_id, 80, n.title || 'The piece', i);
    return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${img ? `<td width="96" valign="top" style="width:96px;padding:6px 16px 0 0">${img}</td>` : ''}<td valign="top">${lead(whoMagnet(n), n)}${extra}</td></tr></table>`);
  };
  // What was said, in a speech bubble in the colours of the kid whose art
  // it's on; a kid's own words in handwriting.
  const talkRow = (n, i) => {
    const k = ci(n);
    const font = n.by_kid_id != null ? `400 20px/1.2 ${HAND}` : `500 16px/1.4 ${BODY}`;
    return sideRow(n, `<div class="said b${k}" style="display:inline-block;max-width:100%;box-sizing:border-box;margin-top:10px;padding:9px 16px 11px;background:${KID_SOFT[k]};border:2.5px solid ${KID_COLOURS[k]};border-radius:22px;color:${INK};font:${font}">${said(n.body)}</div>`, i);
  };
  const stickerRow = (n, i) => sideRow(n, `<div style="font-size:26px;line-height:32px;margin-top:6px" aria-hidden="true">${n.stickers.map((s) => EMOJI[s] ?? '').join(' ')}</div>`, i);
  const section = (title, list, draw, s) =>
    list.length
      ? `<tr><td style="padding:28px 0 6px"><h2 class="ink" style="margin:0;color:${INK};font:600 23px/1.2 ${DISPLAY}"><span class="sq${s}" style="text-decoration:underline wavy ${SQUIGGLES[s][0]};text-decoration-thickness:3px;text-underline-offset:8px">${esc(title)}</span></h2></td></tr>${list.map((n, i) => draw(n, i)).join('')}`
      : '';

  const wordmark = `<div class="muted" style="color:${MUTED};font:400 19px/1 ${HAND};margin:0 0 0 3px"><span style="display:inline-block;transform:rotate(-6deg)">the</span></div><div style="font:700 36px/1.05 ${DISPLAY};letter-spacing:0.03em;white-space:nowrap">${MAGNETS.map(([letter, colour, e, , , tilt], i) => `<span class="m${i}" style="display:inline-block;color:${colour};text-shadow:${edge(e)};transform:rotate(${tilt}deg)">${letter}</span>`).join('')}</div>`;
  const header = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${icon ? `<td width="64" valign="middle" style="width:64px;padding-right:14px"><img src="${esc(icon)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border:0;border-radius:14px"></td>` : ''}<td valign="middle">${wordmark}</td></tr></table><div class="muted" style="color:${MUTED};font:600 15px/21px ${BODY};margin-top:12px">${esc(when)}</div>`;

  const preheader = items.length ? plain(items[0]) : 'Nothing new yet';
  const footer = test
    ? `This is a test you asked for, with everything from ${every === 'daily' ? 'the last day' : 'the last week'}, seen or not. Your email is set to ${esc(schedule)}.`
    : `You get this ${esc(schedule)}, because you asked for it on the fridge. To change it or stop it, open the <a href="${esc(settingsUrl)}" class="ink" style="color:${INK}">email settings</a> at the top of What’s new and choose Never.`;
  const dark = [
    ...MAGNETS.map(([, , , colour, e], i) => `.m${i}{color:${colour}!important;text-shadow:${edge(e)}!important}`),
    ...KID_COLOURS_DARK.map((c, i) => `.a${i}{background:${c}!important;color:#13232a!important}.b${i}{background:${KID_SOFT_DARK[i]}!important;border-color:${c}!important;color:#eef6f3!important}`),
    ...SQUIGGLES.map(([, c], i) => `.sq${i}{text-decoration-color:${c}!important}`),
  ].join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>
<style>
  body { margin: 0; padding: 0; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    .bg { background: #13232a !important; }
    .card { background: #1c3139 !important; }
    .ink, .ink a { color: #eef6f3 !important; }
    .muted { color: #a9c0c0 !important; }
    .line { border-color: #2a444d !important; }
    .paper { background: #f4f0e4 !important; }
    .tape { background: #e2d298 !important; opacity: 0.66 !important; }
    .avg { background: #a9c0c0 !important; color: #13232a !important; }
    ${dark}
  }
</style></head>
<body class="bg" style="margin:0;padding:0;background:${BG}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG}"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:${PAPER};border-radius:18px;font-family:${BODY};box-shadow:0 1px 2px rgba(25,45,40,0.16),0 10px 18px -8px rgba(25,45,40,0.34)"><tr><td style="padding:24px 22px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td>${header}</td></tr>
${items.length ? '' : `<tr><td class="ink" style="padding:22px 0 0;color:${INK};font:500 16px ${BODY}">Nothing new yet.</td></tr>`}
${section('New art', art, artRow, 0)}
${section('Comments', talk, talkRow, 1)}
${section('Stickers', stickers, stickerRow, 2)}
<tr><td style="padding:28px 0 0"><a href="${esc(bellUrl)}" style="display:inline-block;background:#ffcc33;color:${INK};font:800 16px/1.1 ${BODY};text-decoration:none;padding:13px 22px;border-radius:14px;border:2px solid #d29c12;box-shadow:0 3px 0 #d29c12">Open the fridge</a></td></tr>
<tr><td class="muted" style="padding:24px 0 0;color:${MUTED};font:500 13px/19px ${BODY}">${footer}</td></tr>
</table></td></tr></table>
</td></tr></table>
</body></html>`;

  const lines = [`What’s new on the fridge ${when.charAt(0).toLowerCase()}${when.slice(1)}`, ''];
  const textSection = (title, list, more) => {
    if (!list.length) return;
    lines.push(title.toUpperCase());
    for (const n of list) {
      lines.push(`- ${plain(n)} (${day(n.at)})`);
      const extra = more(n);
      if (extra) lines.push(...extra.split(/\r?\n/).map((l) => `  ${l}`));
      lines.push(`  ${pieceUrl(n.piece_id)}`);
    }
    lines.push('');
  };
  if (!items.length) lines.push('Nothing new yet.', '');
  textSection('New art', art, (n) => (n.pieces.length > 1 ? n.pieces.map((id) => titles[id] || 'Untitled').map((t) => `“${t}”`).join(', ') : ''));
  textSection('Comments', talk, (n) => `“${n.body}”`);
  textSection('Stickers', stickers, (n) => n.stickers.map((s) => EMOJI[s] ?? '').join(' '));
  lines.push(`Open the fridge: ${bellUrl}`, '');
  lines.push(test ? `This is a test you asked for, with everything from ${every === 'daily' ? 'the last day' : 'the last week'}, seen or not. Your email is set to ${schedule}.` : `You get this ${schedule}, because you asked for it on the fridge. To change it or stop it, open the email settings at the top of What’s new (${settingsUrl}) and choose Never.`);
  return { subject, html, text: lines.join('\n'), pictures: shown };
}
