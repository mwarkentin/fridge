// What a file's name says about a piece, guessed as scripts/fridge.py guesses
// it: when it was made (its date_in) and its title (title_from), line for
// line. tests/test_add_art.py runs both on the same names, so change them
// together.

const NOT_TITLES = new Set(['scan', 'scanned', 'img', 'image', 'photo', 'dsc', 'pxl', 'untitled', 'copy', 'final', 'art', 'artwork', 'page', 'document', 'doc']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = /(?<!\d)((?:19|20)\d{2})[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])(?!\d)/g;
const MONTH = /(?<!\d)((?:19|20)\d{2})[-_. ](0[1-9]|1[0-2])(?!\d)/g;
const MONTH_NAME = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[-_ ,]*((?:19|20)\d{2})(?!\d)/gi;
const YEAR = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;
// A filing label: in "2024-05-29 Ada School Art Bundle rocket", what comes
// before it (kid, nickname, school) is filing, and the title follows it.
const LABEL = /(?<![a-z])(?:art[-_ ]+)?bundle(?![a-z])/gi;

const firstMatch = (rx, text) => text.matchAll(rx).next().value ?? null;
const pad = (n) => String(n).padStart(2, '0');
const realDay = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// The name without its last extension, as Python's Path(name).stem.
export function stemOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}

// The most specific date in some text, as [YYYY-MM-DD, precision], or null.
// A month alone is stored as the 15th and a year alone as July 1st, so ages
// come out close; the precision tells the page to show only what's known.
export function dateIn(text) {
  for (const m of text.matchAll(DAY)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (realDay(y, mo, d)) return [`${m[1]}-${m[2]}-${m[3]}`, 'day'];
  }
  let m;
  if ((m = firstMatch(MONTH, text))) return [`${m[1]}-${m[2]}-15`, 'month'];
  if ((m = firstMatch(MONTH_NAME, text))) return [`${m[2]}-${pad(MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1)}-15`, 'month'];
  if ((m = firstMatch(YEAR, text))) return [`${m[1]}-07-01`, 'year'];
  return null;
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const namePattern = (name) => new RegExp(`(?<![a-z])${escapeRx(name)}(?:'s|s)?(?![a-z])`, 'gi');
const length = (s) => [...s].length;

// Whether word is a short form of name, as Theo is of Theodora. Four letters
// at least, so "The" and "And" stay in titles.
function shortFor(word, name) {
  word = word.toLowerCase().replace(/['’]s$/, '');
  return length(word) >= 4 && name.toLowerCase().startsWith(word);
}

const isDigits = (w) => /^\d+$/.test(w);

// A title from the file name, without its date, the owner's name (or a short
// form of it), camera and scanner words, or anything before a filing label
// such as "Art Bundle". Other kids' names stay: "me and Bo".
export function titleFrom(stem, owner) {
  let t = stem;
  for (const rx of [DAY, MONTH, MONTH_NAME, YEAR]) t = t.replace(rx, ' ');
  const labels = [...t.matchAll(LABEL)];
  if (labels.length) {
    const last = labels[labels.length - 1];
    t = t.slice(last.index + last[0].length);
  }
  if (owner) t = t.replace(namePattern(owner), ' ');
  let words = t
    .replace(/[-_.()[\]]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOT_TITLES.has(w.toLowerCase()));
  if (owner) words = words.filter((w) => !shortFor(w, owner));
  words = words.filter((w) => !(isDigits(w) && w.length >= 3)); // camera counters like 1234
  if (words.every(isDigits)) return ''; // "Scan 3"
  const [head = '', ...rest] = words.join(' ');
  return head.toUpperCase() + rest.join('');
}
