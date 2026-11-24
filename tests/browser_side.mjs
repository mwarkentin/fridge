// The page's side of tests/test_add_art.py: what Add art's modules in
// public/add/ make of the same files, names and pixels as the import script.
// Reads a JSON request from the file named first, and writes the answers as
// JSON to the file named second (pdf.js prints warnings on stdout in Node).
//
//   node tests/browser_side.mjs request.json answer.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, pieceId } from '../public/add/ids.js';
import { dateIn, stemOf, titleFrom } from '../public/add/names.js';
import { measure, kindOf } from '../public/add/pages.js';
import { photoDate } from '../public/add/exif.js';

const [request, answer] = process.argv.slice(2);
const ask = JSON.parse(readFileSync(request, 'utf8'));

// The same pdf.js the page loads, here only to count pages.
let pdfjs;
async function pageCount(bytes) {
  if (!pdfjs) {
    pdfjs = await import('../public/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = fileURLToPath(new URL('../public/pdfjs/pdf.worker.min.mjs', import.meta.url));
  }
  const doc = await pdfjs.getDocument({ data: bytes, useWasm: false, verbosity: 0 }).promise;
  const n = doc.numPages;
  await doc.loadingTask.destroy();
  return n;
}

const out = { files: [], titles: [], dates: [], stems: [], measures: [], photoDates: [] };
for (const path of ask.files ?? []) {
  const bytes = new Uint8Array(readFileSync(path));
  const hash = await sha256(bytes);
  const count = path.toLowerCase().endsWith('.pdf') ? await pageCount(bytes.slice()) : 1;
  const pieces = [];
  for (let n = 1; n <= count; n++) pieces.push(await pieceId(hash, n, count));
  out.files.push({ hash, count, pieces });
}
for (const [stem, owner] of ask.titles ?? []) out.titles.push(titleFrom(stem, owner));
for (const text of ask.dates ?? []) out.dates.push(dateIn(text));
for (const name of ask.stems ?? []) out.stems.push(stemOf(name));
for (const { path, width, height } of ask.pixels ?? []) {
  const m = measure(new Uint8ClampedArray(readFileSync(path)), width, height);
  out.measures.push({ measure: m, kind: kindOf(m) });
}
for (const path of ask.photoDates ?? []) out.photoDates.push(photoDate(readFileSync(path)));
writeFileSync(answer, JSON.stringify(out));
