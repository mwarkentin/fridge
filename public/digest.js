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
// Nothing here touches the page or the Worker, so both, and the tests, run it.

import { andList, noteWords } from './notes.js';

// The page's kid colours in light and dark (--kid-0 to --kid-5 in
// app.css); families.js picks each kid's.
export const KID_COLOURS = ['#2361b5', '#b04f00', '#22773a', '#7341b0', '#b3306c', '#0a706c'];
export const KID_COLOURS_DARK = ['#86baf7', '#f6a964', '#74d38e', '#c3a0f4', '#f396c1', '#63d3cc'];
// The most pictures one email carries; the rest are words only.
export const PICTURES_MAX = 12;
const EMOJI = { heart: '❤️', star: '⭐', wow: '😮', smile: '😊', rainbow: '🌈' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const asDate = (at) => new Date(`${at.replace(' ', 'T')}Z`);

// "8 am", "12 pm", "9 pm".
export const hourWords = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
// "every Sunday at 8 am", "every day at 7 am", or "off".
export const scheduleWords = (every, hour) => (every === 'weekly' ? `every Sunday at ${hourWords(hour)}` : every === 'daily' ? `every day at ${hourWords(hour)}` : 'off');

const INK = '#1c2a30';
const MUTED = '#3f5258';
const BG = '#d3ebe1';
const PAPER = '#fffdf6';
const LINE = '#e4dfd0';
const SAID = '#f5efdf';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// The email for these notifications (newest first, only the ones to tell
// about), for someone who sees `kids` ({ id, name, ci }: their colour from
// families.js). `titles` has each piece's title by id, for a day's art
// beyond the first. `kidId` is their own kid's, on a kid's sign-in. `since`
// (a time like created_at, in UTC) and `zone` say what it covers, `url` is
// the fridge's address, and `picture(id)` where a piece's thumbnail is:
// cid:piece-<id> in the email. `test` marks one sent when asked, which
// covers the last day or week whatever has been seen.
//
// Returns { subject, html, text, pictures }: `pictures` are the piece ids
// whose thumbnails it shows, at most PICTURES_MAX.
export function digestMail({ items, kids = [], titles = {}, kidId = null, every = 'weekly', hour = 8, zone = 'UTC', since = null, url, picture, test = false }) {
  const ctx = { kids, kidId };
  // Each kind of date is made once: making one takes a while.
  const short = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' });
  const long = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' });
  const day = (at, format = short) => format.format(asDate(at));
  const kidOf = (n) => kids.find((k) => k.id === n.kid_id);
  const colour = (n) => KID_COLOURS[kidOf(n)?.ci ?? 0] ?? KID_COLOURS[0];
  const ci = (n) => kidOf(n)?.ci ?? 0;
  const pieceUrl = (id) => `${url}/?piece=${Number(id)}`;
  const bellUrl = `${url}/?bell=1`;
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

  // One thumbnail, linked to its piece, or nothing past the limit.
  const thumb = (id, width, alt) => {
    const src = pic(id);
    return src ? `<a href="${esc(pieceUrl(id))}" style="text-decoration:none;border:0"><img src="${esc(src)}" width="${width}" alt="${esc(alt)}" style="display:block;width:${width}px;max-width:100%;height:auto;border:0;border-radius:6px;background:${LINE}"></a>` : '';
  };
  const meta = (n) => `<div class="muted" style="color:${MUTED};font-size:13px;line-height:18px;margin-top:4px">${esc(day(n.at))}</div>`;
  // A day's new art: what happened, then its pictures with their titles.
  const artRow = (n) => {
    const ids = n.pieces.length ? n.pieces : [n.piece_id];
    const tiles = ids
      .map((id) => {
        const title = titles[id] ?? (id === n.piece_id ? n.title : '') ?? '';
        const img = thumb(id, 120, title || 'A new piece');
        return img ? `<div style="display:inline-block;vertical-align:top;width:120px;margin:10px 10px 0 0">${img}<div class="ink" style="color:${INK};font-size:13px;line-height:17px;margin-top:4px">${title ? esc(title) : '<span class="muted" style="color:' + MUTED + '">Untitled</span>'}</div></div>` : '';
      })
      .join('');
    const more = n.count > ids.length ? `<div class="muted" style="color:${MUTED};font-size:13px;margin-top:6px">and ${plural(n.count - ids.length, 'more piece')} on the fridge</div>` : '';
    return `<tr><td class="line" style="padding:14px 0;border-top:1px solid ${LINE}"><div class="k${ci(n)}" style="border-left:4px solid ${colour(n)};padding-left:12px"><div class="ink" style="color:${INK};font-size:16px;line-height:22px"><a href="${esc(pieceUrl(n.piece_id))}" class="ink" style="color:${INK};text-decoration:none">${words(n)}</a></div>${meta(n)}</div>${tiles}${more}</td></tr>`;
  };
  // A comment or stickers: the piece's picture beside what happened.
  const sideRow = (n, extra) => {
    const img = thumb(n.piece_id, 72, n.title || 'The piece');
    return `<tr><td class="line" style="padding:14px 0;border-top:1px solid ${LINE}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${img ? `<td width="84" valign="top" style="width:84px;padding-right:12px">${img}</td>` : ''}<td valign="top" class="k${ci(n)}" style="border-left:4px solid ${colour(n)};padding-left:12px"><div class="ink" style="color:${INK};font-size:16px;line-height:22px"><a href="${esc(pieceUrl(n.piece_id))}" class="ink" style="color:${INK};text-decoration:none">${words(n)}</a></div>${extra}${meta(n)}</td></tr></table></td></tr>`;
  };
  const talkRow = (n) => sideRow(n, `<div class="said ink" style="margin-top:6px;padding:8px 12px;background:${SAID};border-radius:10px;color:${INK};font-size:16px;line-height:22px">${said(n.body)}</div>`);
  const stickerRow = (n) => sideRow(n, `<div style="font-size:24px;line-height:30px;margin-top:4px" aria-hidden="true">${n.stickers.map((s) => EMOJI[s] ?? '').join(' ')}</div>`);
  const section = (title, list, row) => (list.length ? `<tr><td style="padding:22px 0 4px"><h2 class="ink" style="margin:0;color:${INK};font-size:19px;line-height:24px;font-weight:700">${esc(title)}</h2></td></tr>${list.map(row).join('')}` : '');

  const preheader = items.length ? plain(items[0]) : 'Nothing new yet';
  const footer = test
    ? `This is a test you asked for, with everything from ${every === 'daily' ? 'the last day' : 'the last week'}, seen or not. Your email is set to ${esc(schedule)}.`
    : `You get this ${esc(schedule)}, because you asked for it on the fridge. To change it or stop it, open <a href="${esc(bellUrl)}" class="ink" style="color:${INK}">What’s new</a> on the fridge and choose Never.`;
  const darkKids = KID_COLOURS_DARK.map((c, i) => `.k${i}{border-color:${c}!important}`).join('');
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
    .said { background: #13232a !important; }
    .line { border-color: #2a444d !important; }
    ${darkKids}
  }
</style></head>
<body class="bg" style="margin:0;padding:0;background:${BG}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG}"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${PAPER};border-radius:14px;font-family:${FONT}"><tr><td style="padding:22px 20px 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td><div class="ink" style="color:${INK};font-size:24px;line-height:30px;font-weight:800">The Fridge</div><div class="muted" style="color:${MUTED};font-size:15px;line-height:21px;margin-top:2px">${esc(when)}</div></td></tr>
${items.length ? '' : `<tr><td class="ink" style="padding:22px 0 0;color:${INK};font-size:16px">Nothing new yet.</td></tr>`}
${section('New art', art, artRow)}
${section('Comments', talk, talkRow)}
${section('Stickers', stickers, stickerRow)}
<tr><td style="padding:26px 0 0"><a href="${esc(bellUrl)}" style="display:inline-block;background:#ffcc33;color:${INK};font-size:16px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px;border:2px solid #d29c12">Open the fridge</a></td></tr>
<tr><td class="muted" style="padding:22px 0 0;color:${MUTED};font-size:13px;line-height:19px">${footer}</td></tr>
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
  lines.push(test ? `This is a test you asked for, with everything from ${every === 'daily' ? 'the last day' : 'the last week'}, seen or not. Your email is set to ${schedule}.` : `You get this ${schedule}, because you asked for it on the fridge. To change it or stop it, open What’s new on the fridge and choose Never.`);
  return { subject, html, text: lines.join('\n'), pictures: shown };
}
