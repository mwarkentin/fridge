// PDFs in the browser, with the copy of pdf.js in /pdfjs/ (AGENTS.md says how
// to update it). It's loaded the first time a PDF is chosen, so the page
// stays light.
//
// Set up to need nothing the Worker's Content-Security-Policy doesn't allow:
// no WebAssembly (useWasm: false), so its JBIG2 and JPEG 2000 decoders are
// the plain JavaScript ones in /pdfjs/wasm/, imported from this origin; and
// no font loading (disableFontFace), so glyphs are drawn as paths.

const BASE = '/pdfjs/';
let loading = null;

function pdfjs() {
  if (!loading) {
    loading = import(`${BASE}pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
      return { lib, worker: new lib.PDFWorker({ verbosity: lib.VerbosityLevel.ERRORS }) };
    });
    loading.catch(() => (loading = null)); // so a later PDF tries again
  }
  return loading;
}

export class PdfError extends Error {}

// An open PDF, from its bytes (which pdf.js takes over: pass a copy).
export async function open(bytes) {
  const { lib, worker } = await pdfjs();
  const task = lib.getDocument({
    data: bytes,
    worker,
    useWasm: false,
    wasmUrl: `${BASE}wasm/`,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: lib.VerbosityLevel.ERRORS,
  });
  let locked = false;
  task.onPassword = () => {
    locked = true;
    task.destroy();
  };
  try {
    return await task.promise;
  } catch {
    throw new PdfError(locked ? 'This PDF has a password, so the fridge can’t open it.' : 'This PDF won’t open. It may be damaged.');
  }
}

export const close = (doc) => doc?.loadingTask.destroy().catch(() => {});

// Page `number` (from 1) drawn on white, `scale` pixels per point, or the
// scale that `scaleFor(width, height)` picks from its size in points.
export async function render(doc, number, scaleFor) {
  const page = await doc.getPage(number);
  try {
    const { width, height } = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: scaleFor(width, height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    return canvas;
  } finally {
    page.cleanup();
  }
}

// The survey's look at a page: at most 320 pixels on its long side, and
// never more than a pixel per point (scripts/fridge.py's survey_file).
export const SURVEY = (w, h) => Math.min(1, 320 / Math.max(w, h));
// The screen-sized copy: as the import script makes it, 200 dpi and at most
// 2000 pixels on its long side.
export const DISPLAY = (w, h) => Math.min(200 / 72, 2000 / Math.max(w, h));

// Page `number` as a PDF of its own: the original for its piece, as the
// import script uploads it.
export async function extract(doc, number) {
  const bytes = await doc.extractPages([{ document: null, includePages: [number - 1] }]);
  if (!bytes?.length) throw new PdfError('Couldn’t take that page out of its PDF.');
  return bytes;
}
