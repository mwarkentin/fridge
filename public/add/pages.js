// Whether a page of a PDF is blank, measured as scripts/fridge.py's `measure`
// does it, so the page and the import script leave out the same pages.
// tests/test_add_art.py runs both on the same pixels.
//
// The page is rendered at most 320 pixels on its long side (as the survey
// renders it), shrunk to fit 200 × 200 the way Pillow's thumbnail() does,
// then: the paper is the commonest colour (so construction paper counts as
// paper), "ink" is the share of pixels clearly different from it, and
// "coloured" is the share of that ink that's clearly coloured.

export const BLANK_INK = 0.004; // under 0.4% of the page marked
export const ART_SHARE = 0.1; // at least a tenth of the marks clearly coloured

export const kindOf = ([ink, coloured]) => (ink < BLANK_INK ? 'blank' : coloured >= ART_SHARE ? 'art' : 'plain');

// [ink, coloured] for an opaque RGBA picture (a canvas's ImageData).
export function measure(rgba, width, height) {
  const { px, w, h } = thumbnail(rgba, width, height, 200);
  const n = w * h;
  const counts = new Uint32Array(4096);
  const first = new Int32Array(4096).fill(-1);
  for (let i = 0; i < n; i++) {
    const key = ((px[i * 4] >> 4) << 8) | ((px[i * 4 + 1] >> 4) << 4) | (px[i * 4 + 2] >> 4);
    if (counts[key]++ === 0) first[key] = i;
  }
  // The commonest colour; with a tie, the one seen first (as Counter does).
  let paper = 0;
  for (let k = 1; k < 4096; k++) {
    if (counts[k] > counts[paper] || (counts[k] === counts[paper] && counts[k] > 0 && first[k] < first[paper])) paper = k;
  }
  const pr = ((paper >> 8) << 4) + 8;
  const pg = (((paper >> 4) & 15) << 4) + 8;
  const pb = ((paper & 15) << 4) + 8;
  let marks = 0;
  let coloured = 0;
  for (let i = 0; i < n; i++) {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    if ((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2 > 60 ** 2) {
      marks++;
      if (Math.max(r, g, b) - Math.min(r, g, b) >= 48) coloured++;
    }
  }
  return marks ? [marks / n, coloured / marks] : [0, 0];
}

// ---- Pillow's Image.thumbnail((size, size)), for these pictures ----
// The size it picks, keeping the shape.
export function thumbnailSize(width, height, size) {
  if (size >= width && size >= height) return null;
  const aspect = width / height;
  const round = (v, key) => Math.max([Math.floor(v), Math.ceil(v)].reduce((a, b) => (key(b) < key(a) ? b : a)), 1);
  if (size / size >= aspect) return [round(size * aspect, (n) => Math.abs(aspect - n / size)), size];
  return [size, round(size / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - size / n)))];
}

// Pillow resamples with a bicubic filter, horizontally then vertically, in
// fixed point (libImaging/Resample.c). The survey's renders are under twice
// the final size, so Pillow's reducing step never applies.
const PRECISION_BITS = 32 - 8 - 2;
function bicubic(x) {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}
function coefficients(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const ss = 1 / filterscale;
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
    const xmax = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
    const k = new Float64Array(xmax);
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      k[x] = bicubic((x + xmin - center + 0.5) * ss);
      ww += k[x];
    }
    for (let x = 0; x < xmax; x++) {
      const v = (ww !== 0 ? k[x] / ww : k[x]) * (1 << PRECISION_BITS);
      kk[xx * ksize + x] = Math.trunc(v < 0 ? v - 0.5 : v + 0.5);
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { kk, bounds, ksize };
}
const clip8 = (v) => (v >= 2 ** (PRECISION_BITS + 8) ? 255 : v <= 0 ? 0 : Math.floor(v / 2 ** PRECISION_BITS));

export function thumbnail(rgba, width, height, size) {
  const to = thumbnailSize(width, height, size);
  if (!to) return { px: rgba, w: width, h: height };
  const [w, h] = to;
  const horiz = coefficients(width, w);
  const vert = coefficients(height, h);
  // Only the rows the vertical pass reads.
  const first = vert.bounds[0];
  const last = vert.bounds[h * 2 - 2] + vert.bounds[h * 2 - 1];
  const rows = last - first;
  let src = rgba;
  let srcW = width;
  let rowOffset = 0;
  if (w !== width) {
    const tmp = new Uint8ClampedArray(w * rows * 4);
    for (let y = 0; y < rows; y++) {
      for (let xx = 0; xx < w; xx++) {
        const xmin = horiz.bounds[xx * 2];
        const xmax = horiz.bounds[xx * 2 + 1];
        const base = xx * horiz.ksize;
        let s0 = 1 << (PRECISION_BITS - 1);
        let s1 = s0;
        let s2 = s0;
        for (let x = 0; x < xmax; x++) {
          const k = horiz.kk[base + x];
          const i = ((y + first) * width + x + xmin) * 4;
          s0 += rgba[i] * k;
          s1 += rgba[i + 1] * k;
          s2 += rgba[i + 2] * k;
        }
        const o = (y * w + xx) * 4;
        tmp[o] = clip8(s0);
        tmp[o + 1] = clip8(s1);
        tmp[o + 2] = clip8(s2);
        tmp[o + 3] = 255;
      }
    }
    src = tmp;
    srcW = w;
    rowOffset = first;
  }
  if (h === height) return { px: src, w, h };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const ymin = vert.bounds[yy * 2] - rowOffset;
    const ymax = vert.bounds[yy * 2 + 1];
    const base = yy * vert.ksize;
    for (let xx = 0; xx < w; xx++) {
      let s0 = 1 << (PRECISION_BITS - 1);
      let s1 = s0;
      let s2 = s0;
      for (let y = 0; y < ymax; y++) {
        const k = vert.kk[base + y];
        const i = ((y + ymin) * srcW + xx) * 4;
        s0 += src[i] * k;
        s1 += src[i + 1] * k;
        s2 += src[i + 2] * k;
      }
      const o = (yy * w + xx) * 4;
      out[o] = clip8(s0);
      out[o + 1] = clip8(s1);
      out[o + 2] = clip8(s2);
      out[o + 3] = 255;
    }
  }
  return { px: out, w, h };
}
