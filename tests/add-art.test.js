// Add art's modules (public/add/) on their own: the guesses, hashes and blank
// measure it shares with the import script (tests/test_add_art.py checks
// those against the script itself), the photo date, and the copy of pdf.js
// it loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dateIn, stemOf, titleFrom } from '../public/add/names.js';
import { pageHash, pieceId, sha256 } from '../public/add/ids.js';
import { BLANK_INK, kindOf, measure, thumbnailSize } from '../public/add/pages.js';
import { photoDate } from '../public/add/exif.js';

const PDFJS_VERSION = '6.5.438';

test('dates in file names, as the import script reads them', () => {
  assert.deepEqual(dateIn('2024-05-29 rocket'), ['2024-05-29', 'day']);
  assert.deepEqual(dateIn('PXL_20240529_123456789'), ['2024-05-29', 'day']);
  assert.deepEqual(dateIn('rocket 2024-05'), ['2024-05-15', 'month']);
  assert.deepEqual(dateIn('Sept 2023 apple'), ['2023-09-15', 'month']);
  assert.deepEqual(dateIn('2023'), ['2023-07-01', 'year']);
  assert.deepEqual(dateIn('2024-02-30 then 2024-03-01'), ['2024-03-01', 'day'], 'not a real day');
  assert.equal(dateIn('IMG_1234'), null);
});

test('titles from file names, as the import script makes them', () => {
  assert.equal(titleFrom('2024-05-29_ada_rocket-to-the-moon', 'Ada'), 'Rocket to the moon');
  assert.equal(titleFrom('IMG_1234', 'Ada'), '');
  assert.equal(titleFrom('2025-11-05 Theo Art Bundle kite', 'Theodora'), 'Kite');
  assert.equal(titleFrom('me and bo', 'Ada'), 'Me and bo', 'other kids’ names stay');
  assert.equal(titleFrom('Bo dragon', 'Bo'), 'Dragon');
  assert.equal(stemOf('Scan 3.PDF'), 'Scan 3');
  assert.equal(stemOf('.hidden'), '.hidden');
});

test('source hashes: the file’s, or each page’s for a PDF of several pages', async () => {
  const bytes = new TextEncoder().encode('made-up file');
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await sha256(bytes), fileHash);
  assert.equal(await pieceId(fileHash, 1, 1), fileHash);
  const page2 = createHash('sha256').update(`${fileHash}:page 2`).digest('hex');
  assert.equal(await pageHash(fileHash, 2), page2);
  assert.equal(await pieceId(fileHash, 2, 3), page2);
  assert.notEqual(await pieceId(fileHash, 1, 3), fileHash);
});

function page(width, height, paint) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      px.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return px;
}

test('tells blank pages from art and documents', () => {
  const w = 248;
  const h = 320;
  const white = () => [255, 255, 255];
  const pink = () => [241, 198, 208];
  const blob = (x, y) => ((x - 120) ** 2 + (y - 160) ** 2 < 60 ** 2 ? [216, 52, 44] : [255, 255, 255]);
  const lines = (x, y) => (y % 12 < 3 && x > 20 && x < 228 ? [30, 30, 30] : [255, 255, 255]);
  assert.equal(kindOf(measure(page(w, h, white), w, h)), 'blank');
  assert.equal(kindOf(measure(page(w, h, pink), w, h)), 'blank', 'construction paper is paper');
  assert.equal(kindOf(measure(page(w, h, blob), w, h)), 'art');
  assert.equal(kindOf(measure(page(w, h, lines), w, h)), 'plain');
  const speck = (x, y) => (x === 100 && y === 100 ? [0, 0, 0] : [255, 255, 255]);
  assert.ok(measure(page(w, h, speck), w, h)[0] < BLANK_INK, 'one speck of dust is still blank');
});

test('shrinks to fit 200 pixels as Pillow’s thumbnail() does', () => {
  assert.deepEqual(thumbnailSize(248, 320, 200), [155, 200]);
  assert.deepEqual(thumbnailSize(320, 248, 200), [200, 155]);
  assert.deepEqual(thumbnailSize(320, 1, 200), [200, 1]);
  assert.equal(thumbnailSize(180, 200, 200), null, 'small enough already');
});

// A JPEG holding only an Exif block, as cameras write it.
function jpegWithExif({ original, plain, little = false }) {
  const entries0 = [];
  const exifEntries = [];
  const strings = [];
  if (plain) entries0.push([0x0132, plain]);
  const u16 = (v) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (little ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  // Layout: header (8), IFD0, Exif IFD, then the strings.
  const ifd0Size = 2 + (entries0.length + (original ? 1 : 0)) * 12 + 4;
  const exifAt = 8 + ifd0Size;
  if (original) exifEntries.push([0x9003, original]);
  const exifSize = original ? 2 + 12 + 4 : 0;
  let stringAt = exifAt + exifSize;
  const entry = (tag, value) => {
    const text = [...new TextEncoder().encode(value), 0];
    const at = stringAt;
    stringAt += text.length;
    strings.push(...text);
    return [...u16(tag), ...u16(2), ...u32(text.length), ...u32(at)];
  };
  const ifd0 = [...u16(entries0.length + (original ? 1 : 0)), ...entries0.flatMap(([t, v]) => entry(t, v))];
  if (original) ifd0.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt));
  ifd0.push(...u32(0));
  const exif = original ? [...u16(1), ...exifEntries.flatMap(([t, v]) => entry(t, v)), ...u32(0)] : [];
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...ifd0, ...exif, ...strings];
  const app1 = [...new TextEncoder().encode('Exif'), 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xd9]);
}

test('reads when a photo was taken from its Exif data', () => {
  assert.equal(photoDate(jpegWithExif({ original: '2023:06:14 10:11:12', plain: '2025:01:01 00:00:00' })), '2023-06-14');
  assert.equal(photoDate(jpegWithExif({ original: '2023:06:14 10:11:12', little: true })), '2023-06-14', 'Intel byte order');
  assert.equal(photoDate(jpegWithExif({ plain: '2022:12:24 18:00:00' })), '2022-12-24', 'DateTime when there’s no DateTimeOriginal');
  assert.equal(photoDate(jpegWithExif({ original: '2024:02:30 10:00:00' })), null, 'not a real day');
  assert.equal(photoDate(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(photoDate(new Uint8Array([1, 2, 3])), null);
  assert.equal(photoDate(jpegWithExif({ original: '2023:06:14 10:11:12' }).slice(0, 30)), null, 'cut short');
});

test('the copy of pdf.js is one pinned version, with its licences, and nothing else', () => {
  const files = readdirSync('public/pdfjs', { recursive: true }).sort();
  assert.deepEqual(files, ['LICENSE', 'pdf.min.mjs', 'pdf.worker.min.mjs', 'wasm', 'wasm/LICENSE_JBIG2', 'wasm/LICENSE_OPENJPEG', 'wasm/LICENSE_PDFJS_JBIG2', 'wasm/LICENSE_PDFJS_OPENJPEG', 'wasm/jbig2_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js']);
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const source = readFileSync(`public/pdfjs/${file}`, 'utf8');
    assert.ok(source.includes(`"${PDFJS_VERSION}"`), `${file} is pdf.js ${PDFJS_VERSION}`);
    assert.doesNotMatch(source, /sourceMappingURL/, file);
  }
  assert.match(readFileSync('public/pdfjs/LICENSE', 'utf8'), /Apache License\s+Version 2\.0/);
  assert.ok(readFileSync('AGENTS.md', 'utf8').includes(`pdfjs-dist@${PDFJS_VERSION}`), 'AGENTS.md names the version, and how to update it');
});

test('pdf.js loads only when a PDF is chosen, and the page only when Add art opens', () => {
  const statics = (file) => [...readFileSync(file, 'utf8').matchAll(/^import\b[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(statics('public/app.js'), []);
  assert.match(readFileSync('public/app.js', 'utf8'), /import\('\.\/add\/sheet\.js'\)/);
  assert.ok(!statics('public/add/sheet.js').some((m) => /pdf/.test(m)), 'add/sheet.js imports pdf.js only when it needs it');
  assert.match(readFileSync('public/add/sheet.js', 'utf8'), /import\('\.\/pdf\.js'\)/);
  // pdf.js set up for the Worker's CSP: no WebAssembly, no font loading.
  const setup = readFileSync('public/add/pdf.js', 'utf8');
  assert.match(setup, /useWasm: false/);
  assert.match(setup, /disableFontFace: true/);
});

test('Add art takes several pictures and PDFs at once', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const input = html.match(/<input id="a-file"[^>]*>/)[0];
  assert.match(input, /\bmultiple\b/);
  assert.match(input, /accept="image\/\*,application\/pdf,\.pdf"/);
});
