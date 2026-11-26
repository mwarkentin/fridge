// The email digest's words and layout (public/digest.js and public/notes.js),
// which the Worker sends and the page shows, run on made-up notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digestMail, hourWords, KID_COLOURS, KID_COLOURS_DARK, PICTURES_MAX, scheduleWords } from '../public/digest.js';
import { noteWords } from '../public/notes.js';

const KIDS = [
  { id: 1, name: 'Ada', ci: 0 },
  { id: 2, name: 'Bo', ci: 1 },
];
const base = { at: '2026-11-25 18:30:00', kid_id: 1, by_kid_id: null, new: true };
const ITEMS = [
  { ...base, key: 'sticker:9', kind: 'sticker', piece_id: 3, title: 'Moon', by: 'Gran', stickers: ['star', 'heart'] },
  { ...base, key: 'comment:7', kind: 'comment', piece_id: 3, title: 'Moon', by: 'Pop', body: 'Look at that!\nSo big' },
  { ...base, key: 'comment:8', kind: 'reply', piece_id: 5, kid_id: 2, title: '', by: 'Bo', by_kid_id: 2, body: 'Thank you' },
  { ...base, key: 'art:10', kind: 'art', piece_id: 12, kid_id: 2, title: 'Boat', by: 'Mum', count: 3, pieces: [12, 11, 10] },
];
const mailOf = (over = {}) =>
  digestMail({ items: ITEMS, kids: KIDS, titles: { 10: 'Kite', 11: '', 12: 'Boat' }, every: 'weekly', hour: 8, zone: 'America/Toronto', since: '2026-11-22 13:00:00', url: 'https://fridge.example.com', picture: (id) => `cid:piece-${id}`, ...over });
// Without the style sheet, whose @media isn't an address.
const body = (html) => html.replace(/<style>[\s\S]*?<\/style>/, '');

test('the bell and the email say the same, as HTML or as plain text', () => {
  const ctx = { kids: KIDS };
  assert.equal(noteWords(ITEMS[0], ctx), '<b>Gran</b> gave Ada’s “Moon” a gold star and a heart');
  assert.equal(noteWords(ITEMS[0], ctx, false), 'Gran gave Ada’s “Moon” a gold star and a heart');
  assert.equal(noteWords(ITEMS[2], ctx, false), 'Bo replied on an untitled piece', 'the artist themselves');
  assert.equal(noteWords(ITEMS[3], ctx, false), 'Mum put up 3 new pieces by Bo');
  // To a kid about their own art: few words.
  assert.equal(noteWords(ITEMS[0], { kids: KIDS, kidId: 1 }, false), 'Gran gave your “Moon” a gold star and a heart');
  assert.equal(noteWords(ITEMS[1], { kids: KIDS, kidId: 1 }, false), 'Pop said');
  // Everything from the Worker is escaped in HTML, and only there.
  const odd = { ...ITEMS[1], by: '<script>x</script>', title: '"Moon" & <i>stars</i>' };
  assert.equal(noteWords(odd, ctx), '<b>&lt;script&gt;x&lt;/script&gt;</b> on Ada’s “&quot;Moon&quot; &amp; &lt;i&gt;stars&lt;/i&gt;”');
  assert.equal(noteWords(odd, ctx, false), '<script>x</script> on Ada’s “"Moon" & <i>stars</i>”');
});

test('the email has names, titles, what was said and the pictures, in sections, with links', () => {
  const mail = mailOf();
  assert.equal(mail.subject, 'What’s new on the fridge: 3 new pieces, 2 comments and 2 stickers');
  assert.match(mail.html, /Since Sunday 22 November/);
  // New art first, then comments, then stickers.
  const at = (s) => mail.html.indexOf(s);
  assert.ok(at('>New art<') < at('>Comments<') && at('>Comments<') < at('>Stickers<'));
  for (const s of ['<b>Mum</b> put up 3 new pieces by Bo', 'Kite', 'Boat', 'Untitled', '<b>Pop</b> on Ada’s “Moon”', 'Look at that!<br>So big', '<b>Gran</b> gave Ada’s “Moon” a gold star and a heart', '⭐ ❤️', 'Wed 25 Nov']) assert.ok(mail.html.includes(s), s);
  // Each piece links to itself; the button and the footer to the bell, where it's turned off.
  assert.match(mail.html, /href="https:\/\/fridge\.example\.com\/\?piece=3"/);
  assert.match(mail.html, /href="https:\/\/fridge\.example\.com\/\?bell=1"[^>]*>Open the fridge/);
  assert.match(mail.html, /You get this every Sunday at 8 am, because you asked for it on the fridge\. To change it or stop it, open <a href="https:\/\/fridge\.example\.com\/\?bell=1"/);
  // A day's art shows up to four of its pictures; the rest beside what was said about them.
  assert.deepEqual(mail.pictures, [12, 11, 10, 3, 5]);
  assert.deepEqual([...new Set([...mail.html.matchAll(/src="cid:piece-(\d+)"/g)].map((m) => Number(m[1])))].sort((a, b) => a - b), [3, 5, 10, 11, 12]);
  // Each kid's colour, in light and dark.
  assert.match(mail.html, new RegExp(`border-left:4px solid ${KID_COLOURS[1]}`));
  assert.match(mail.html, new RegExp(`\\.k1\\{border-color:${KID_COLOURS_DARK[1]}!important\\}`));
  // The plain text says it all too.
  for (const s of ['What’s new on the fridge since Sunday 22 November', 'NEW ART', '- Mum put up 3 new pieces by Bo (Wed 25 Nov)', '“Boat”, “Untitled”, “Kite”', '“Look at that!', 'https://fridge.example.com/?piece=3', 'Open the fridge: https://fridge.example.com/?bell=1']) assert.ok(mail.text.includes(s), s);
  for (const part of [mail.subject, body(mail.html), mail.text]) assert.doesNotMatch(part, /@/);
});

test('the email escapes everything from the Worker', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const mail = mailOf({ items: [{ ...ITEMS[1], by: evil, title: evil, body: evil }, { ...ITEMS[3], title: evil }], titles: { 10: evil, 11: evil, 12: evil } });
  assert.doesNotMatch(mail.html, /<img src=x|onerror=alert\(1\)>/);
  assert.ok(mail.html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
  assert.ok(mail.text.includes(evil), 'plain text stays as it was said');
});

test('a test says so, a kid’s says few words, and pictures stop at the limit', () => {
  const test_ = mailOf({ test: true, every: 'daily', hour: 18 });
  assert.match(test_.subject, /^Test: What’s new on the fridge:/);
  assert.match(test_.html, /In the last day/);
  assert.match(test_.html, /This is a test you asked for, with everything from the last day, seen or not\. Your email is set to every day at 6 pm\./);
  assert.match(mailOf({ test: true, every: 'off' }).text, /Your email is set to off\./);

  const kid = mailOf({ kidId: 1, items: ITEMS.slice(0, 2) });
  assert.match(kid.html, /<b>Gran<\/b> gave your “Moon” a gold star and a heart/);
  assert.match(kid.html, /<b>Pop<\/b> said/);

  const many = Array.from({ length: 20 }, (_, i) => ({ ...base, key: `comment:${i}`, kind: 'comment', piece_id: 100 + i, title: `Piece ${i}`, by: 'Gran', body: `Number ${i}` }));
  const capped = mailOf({ items: many });
  assert.equal(capped.pictures.length, PICTURES_MAX);
  assert.equal(new Set([...capped.html.matchAll(/src="cid:piece-(\d+)"/g)].map((m) => m[1])).size, PICTURES_MAX);
  assert.ok(capped.html.includes('Number 19'), 'all of them, the rest in words only');

  const empty = mailOf({ items: [] });
  assert.equal(empty.subject, 'What’s new on the fridge: nothing yet');
  assert.deepEqual(empty.pictures, []);
});

test('the email’s colours are the page’s, and its times read plainly', () => {
  const css = readFileSync('public/app.css', 'utf8');
  const light = css.slice(0, css.indexOf('prefers-color-scheme: dark'));
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  for (const [i, c] of KID_COLOURS.entries()) assert.match(light, new RegExp(`--kid-${i}: ${c};`), `--kid-${i}`);
  for (const [i, c] of KID_COLOURS_DARK.entries()) assert.match(dark, new RegExp(`--kid-${i}: ${c};`), `dark --kid-${i}`);
  assert.deepEqual([0, 8, 11, 12, 13, 23].map(hourWords), ['12 am', '8 am', '11 am', '12 pm', '1 pm', '11 pm']);
  assert.deepEqual([scheduleWords('weekly', 8), scheduleWords('daily', 19), scheduleWords('off', 8)], ['every Sunday at 8 am', 'every day at 7 pm', 'off']);
});
