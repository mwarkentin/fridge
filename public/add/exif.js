// When a photo was taken, from its Exif data, as scripts/fridge.py's
// photo_date reads it: DateTimeOriginal, or else DateTime. JPEG, TIFF, PNG,
// WebP and (by looking for the Exif block) HEIC. 'YYYY-MM-DD', or null.

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME = 0x0132; // 306
const TAG_DATE_TIME_ORIGINAL = 0x9003; // 36867

export function photoDate(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const start = findTiff(bytes);
    return start == null ? null : readDate(bytes, start);
  } catch {
    return null;
  }
}

const ascii = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
const isTiff = (bytes, at) => (bytes[at] === 0x49 && bytes[at + 1] === 0x49 && bytes[at + 2] === 42 && bytes[at + 3] === 0) || (bytes[at] === 0x4d && bytes[at + 1] === 0x4d && bytes[at + 2] === 0 && bytes[at + 3] === 42);

// Where the TIFF structure holding the Exif data starts.
function findTiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isTiff(bytes, 0)) return 0;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: the APP1 segment that starts "Exif\0\0".
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break; // the picture itself, or the end
      const size = view.getUint16(at + 2);
      if (marker === 0xe1 && ascii(bytes, at + 4, 6) === 'Exif\0\0' && isTiff(bytes, at + 10)) return at + 10;
      at += 2 + size;
    }
    return null;
  }
  if (ascii(bytes, 1, 3) === 'PNG') {
    // PNG: an eXIf chunk, which is the TIFF structure itself.
    let at = 8;
    while (at + 8 <= bytes.length) {
      const size = view.getUint32(at);
      const type = ascii(bytes, at + 4, 4);
      if (type === 'eXIf') return isTiff(bytes, at + 8) ? at + 8 : ascii(bytes, at + 8, 6) === 'Exif\0\0' ? at + 14 : null;
      if (type === 'IEND') break;
      at += 12 + size;
    }
    return null;
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    // WebP: an EXIF chunk, with or without "Exif\0\0" in front.
    let at = 12;
    while (at + 8 <= bytes.length) {
      const type = ascii(bytes, at, 4);
      const size = view.getUint32(at + 4, true);
      if (type === 'EXIF') return isTiff(bytes, at + 8) ? at + 8 : ascii(bytes, at + 8, 6) === 'Exif\0\0' ? at + 14 : null;
      at += 8 + size + (size & 1);
    }
    return null;
  }
  // HEIC and the rest: the first "Exif\0\0" followed by a TIFF header.
  for (let at = bytes.indexOf(0x45); at !== -1 && at + 10 <= bytes.length; at = bytes.indexOf(0x45, at + 1)) {
    if (ascii(bytes, at, 6) === 'Exif\0\0' && isTiff(bytes, at + 6)) return at + 6;
  }
  return null;
}

function readDate(bytes, start) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[start] === 0x49;
  const u16 = (at) => view.getUint16(start + at, le);
  const u32 = (at) => view.getUint32(start + at, le);
  // The tags of one directory, by number: [type, count, where the value is].
  const ifd = (offset) => {
    const tags = new Map();
    const n = u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = ([0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] || 1) * count;
      tags.set(u16(e), { type, count, at: size > 4 ? u32(e + 8) : e + 8 });
    }
    return tags;
  };
  const text = (tag) => {
    if (!tag || tag.type !== 2) return '';
    const raw = ascii(bytes, start + tag.at, tag.count);
    return raw.replace(/\0[^]*$/, '');
  };
  const ifd0 = ifd(u32(4));
  const exifTag = ifd0.get(TAG_EXIF_IFD);
  const exif = exifTag ? ifd(u32(exifTag.at)) : new Map();
  const raw = text(exif.get(TAG_DATE_TIME_ORIGINAL)) || text(ifd0.get(TAG_DATE_TIME));
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
