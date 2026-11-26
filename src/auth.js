// Who is asking. Cloudflare Access signs every request it lets through with
// a JWT in the Cf-Access-Jwt-Assertion header. Checking it here as well means
// nothing reaches the gallery without a sign-in, even if Access were
// misconfigured or the Worker were reachable some other way.

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

// Access rotates its signing keys every few weeks, so they're fetched, kept
// for an hour, and fetched again early (at most once a minute) when a token
// names a key we haven't seen.
let certs = { domain: '', keys: [], at: 0 };

async function signingKey(domain, kid) {
  const age = Date.now() - certs.at;
  const known = certs.domain === domain && certs.keys.some((k) => k.kid === kid);
  if (certs.domain !== domain || age > 3_600_000 || (!known && age > 60_000)) {
    const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access signing keys: HTTP ${res.status}`);
    certs = { domain, keys: (await res.json()).keys || [], at: Date.now() };
  }
  return certs.keys.find((k) => k.kid === kid);
}

// The token's claims if Access signed it for this application and it hasn't
// expired, otherwise null.
export async function verifyAccessJwt(token, { domain, aud }, now = Date.now() / 1000) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const jwk = await signingKey(domain, header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), signed))) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud) || claims.iss !== `https://${domain}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
  return claims;
}

// The families and their kids, from FAMILIES: a Worker secret infra hands to
// the deploy, JSON like
//   [{ "id": "pine", "name": "The Pines", "parents": ["a@example.com"],
//      "kids": [{ "name": "Ada", "born": "2019-04-02", "artist": null,
//                 "devices": ["ada.ipad@example.com"] }] }]
// in the order the page shows them. The kids are the fridge's: the Worker
// adds them (worker.js, syncKids). A kid's artist is the address they sign
// in with to add their own art, or null. Their devices (optional) are the
// addresses their own iPad or tablet signs in with: it only looks, but its
// comments and stickers are the kid's. Missing or empty means no families, and
// then every parent can change everything. A FAMILIES that can't be read
// throws, so nobody gets in until it's fixed, rather than every parent
// getting every family's rights.
const realDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isEmail = (s) => typeof s === 'string' && /^[^@\s]+@[^@\s]+$/.test(s.trim());

export function readFamilies(env) {
  const raw = (env.FAMILIES || '').trim();
  if (!raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('FAMILIES isn’t valid JSON.');
  }
  if (!Array.isArray(list)) throw new Error('FAMILIES must be a JSON list.');
  const seen = new Set();
  const kidNames = [];
  const addresses = []; // every kid's artist and devices addresses
  return list.map((f, i) => {
    const id = typeof f?.id === 'string' ? f.id.trim() : '';
    if (!id || id.length > 60) throw new Error(`FAMILIES entry ${i + 1} needs an id of 1 to 60 characters.`);
    if (seen.has(id)) throw new Error(`FAMILIES has the id ${JSON.stringify(id)} twice.`);
    seen.add(id);
    if (typeof f.name !== 'string' || !f.name.trim()) throw new Error(`FAMILIES entry ${i + 1} needs a name.`);
    if (!Array.isArray(f.parents) || !f.parents.every((e) => typeof e === 'string')) throw new Error(`FAMILIES entry ${i + 1} needs parents, a list of emails.`);
    if (!Array.isArray(f.kids ?? [])) throw new Error(`FAMILIES entry ${i + 1}'s kids must be a list.`);
    const kids = (f.kids ?? []).map((k, j) => {
      const name = typeof k?.name === 'string' ? k.name.trim() : '';
      if (!name || name.length > 60) throw new Error(`FAMILIES entry ${i + 1}'s kid ${j + 1} needs a name of 1 to 60 characters.`);
      if (!realDate(k.born)) throw new Error(`FAMILIES entry ${i + 1}'s kid ${j + 1} needs born, a date like 2018-03-14.`);
      // A kid's family is the one listing them, so one family each.
      if (kidNames.some((n) => sameName(n, name))) throw new Error(`FAMILIES lists a kid's name twice.`);
      kidNames.push(name);
      if (k.artist != null && !isEmail(k.artist)) throw new Error(`FAMILIES entry ${i + 1}'s kid ${j + 1} has an artist that isn't an email.`);
      if (k.devices != null && (!Array.isArray(k.devices) || !k.devices.every(isEmail))) throw new Error(`FAMILIES entry ${i + 1}'s kid ${j + 1} has devices that aren't a list of emails.`);
      const artist = k.artist == null ? null : k.artist.trim().toLowerCase();
      const devices = [...new Set((k.devices ?? []).map((e) => e.trim().toLowerCase()))].filter((e) => e !== artist);
      // An address is one kid's: their comments can't be two kids'.
      for (const address of [artist, ...devices].filter(Boolean)) {
        if (addresses.includes(address)) throw new Error('FAMILIES gives two kids the same address.');
        addresses.push(address);
      }
      return { name, born: k.born, artist, devices };
    });
    return { id, name: f.name.trim(), parents: f.parents.map((e) => e.trim().toLowerCase()).filter(Boolean), kids };
  });
}

// Everyone's names but the kids', from NAMES: a Worker secret infra hands to
// the deploy, JSON like
//   { "gran@example.com": ["Grandma", "Pop"],
//     "pine@example.com": [{ "name": "Aunt Pine", "family": "Mom" }] }
// keyed by the address someone signs in with, each with a person or a list
// of them. A sign-in two people share, like grandparents with one email,
// has one for each, and they pick which of them is commenting. A person is
// a name everyone sees, or { name, family }: a parent's own family (FAMILIES)
// sees them as `family` ("Mom"), and everyone else as `name` ("Aunt Pine").
// Kids aren't in it: their own addresses are theirs (FAMILIES). The names
// show beside comments and stickers and give nobody any rights. Missing or
// empty means nobody has a name yet, and comments show the part of an
// address before the @. One that can't be read throws, and comments are off
// until it's fixed (worker.js, talk).
//
// Returns each address's people as [{ name, family }], family null for
// one name everyone sees.
export const NAMES_MAX = 6; // on one shared sign-in
export function readNames(env) {
  const raw = (env.NAMES || '').trim();
  const out = new Map();
  if (!raw) return out;
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error('NAMES isn’t valid JSON.');
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('NAMES must be a JSON object of addresses to names.');
  const families = readFamilies(env);
  const kids = families.flatMap((f) => f.kids);
  const kidAddresses = new Set(kids.flatMap((k) => [k.artist, ...k.devices]).filter(Boolean));
  const tidy = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim() : '');
  const ok = (n) => n && [...n].length <= 30 && !n.includes('@');
  for (const [key, value] of Object.entries(map)) {
    if (!isEmail(key)) throw new Error('NAMES has a key that isn’t an email.');
    const email = key.trim().toLowerCase();
    if (out.has(email)) throw new Error('NAMES lists an address twice.');
    if (kidAddresses.has(email)) throw new Error('NAMES names a kid’s own address: FAMILIES names kids.');
    const list = Array.isArray(value) ? value : [value];
    if (!list.length || list.length > NAMES_MAX) throw new Error(`Each address in NAMES needs 1 to ${NAMES_MAX} people.`);
    const parentOf = families.some((f) => f.parents.includes(email));
    out.set(
      email,
      list.map((p) => {
        const person = typeof p === 'string' ? { name: tidy(p), family: null } : { name: tidy(p?.name), family: p?.family == null ? null : tidy(p.family) };
        if (!ok(person.name) || (person.family !== null && !ok(person.family))) throw new Error('Each name in NAMES needs 1 to 30 characters, and no @.');
        if (person.family !== null && !parentOf) throw new Error('NAMES gives a family name to someone who isn’t a parent in FAMILIES.');
        return person;
      }),
    );
  }
  // What anyone sees is never two people with one name, nor a kid's name, so
  // nobody passes for a kid: names everyone sees are all different, and each
  // family's own names differ from each other and from those.
  const everyone = [...out.values()].flat();
  const names = everyone.map((p) => p.name);
  const clash = (list) => list.some((n, i) => list.findIndex((m) => sameName(m, n)) !== i);
  if (clash(names)) throw new Error('NAMES gives two people the same name.');
  if ([...names, ...everyone.map((p) => p.family).filter(Boolean)].some((n) => kids.some((k) => sameName(k.name, n)))) throw new Error('NAMES gives someone a kid’s name.');
  for (const f of families) {
    const own = [...out].filter(([email]) => f.parents.includes(email)).flatMap(([, people]) => people.map((p) => p.family).filter(Boolean));
    if (clash(own) || own.some((n) => everyone.some((p) => !own.includes(p.family) && sameName(p.name, n)))) throw new Error(`NAMES gives two people in ${f.name} the same name.`);
  }
  return out;
}

// { email, canEdit, families, artist, kid } for a signed-in person, or null.
// Parents (PARENT_EMAILS, a Worker secret infra hands to the deploy) can
// change things; everyone else Access lets in can look. `families` are the
// ids of the families (FAMILIES) a parent is in: they can change only those
// families' kids, and kids in no family. `artist` is the name of the kid
// someone signs in as to add their own art (FAMILIES), or null. `kid` is the
// name of the kid whose address it is, as an artist or one of their devices,
// or null: their comments and stickers are that kid's. Anyone signed in can
// comment and give stickers.
export async function identify(request, env) {
  const host = new URL(request.url).hostname;
  // Local development only: wrangler dev has no Access in front of it.
  // DEV_EMAIL lives in .dev.vars, which is never deployed, and only counts
  // for requests to localhost.
  if (env.DEV_EMAIL && (host === 'localhost' || host === '127.0.0.1')) return person(env.DEV_EMAIL, env);
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const claims = await verifyAccessJwt(token, { domain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
  // Service tokens have no email; nothing here uses them.
  return typeof claims?.email === 'string' ? person(claims.email, env) : null;
}

const parentEmails = (env) => (env.PARENT_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

function person(email, env) {
  const me = email.trim().toLowerCase();
  const canEdit = parentEmails(env).includes(me);
  // Read for everyone, so a broken FAMILIES turns everyone away. Being named
  // in a family makes nobody a parent: PARENT_EMAILS says who is.
  const all = readFamilies(env);
  const families = canEdit ? all.filter((f) => f.parents.includes(me)).map((f) => f.id) : [];
  // A parent is a parent, even if a kid's address is theirs too.
  const kid = canEdit ? null : (all.flatMap((f) => f.kids).find((k) => k.artist === me || k.devices.includes(me)) ?? null);
  return { email: me, canEdit, families, artist: kid?.artist === me ? kid.name : null, kid: kid?.name ?? null };
}

// The kids' own addresses (artists' and devices'), each to its kid's name,
// leaving out parents' addresses, as person() does. For naming the people
// behind comments and stickers.
export function kidAddresses(env) {
  const parents = parentEmails(env);
  const out = new Map();
  for (const kid of readFamilies(env).flatMap((f) => f.kids)) {
    for (const address of [kid.artist, ...kid.devices]) if (address && !parents.includes(address)) out.set(address, kid.name);
  }
  return out;
}

// The rules, mirrored in the page. A parent can change a kid's pieces when
// the kid is in one of their families or in none. An artist can add their
// own art, and change only the pieces they added (worker.js, mayChange).
export const canChangeKid = (who, kid) => who.canEdit && (kid.family === null || who.families.includes(kid.family));
// Whether someone sees a kid and their art at all. Everyone signed in sees
// every kid for now; showing someone only some families' art is a change
// of its own, and it changes only this. Notifications (worker.js) take
// every kid, piece and count from it.
export const canSee = (who, kid) => Boolean(who && kid);
export const isArtistOf = (who, kid) => who.artist !== null && sameName(who.artist, kid.name);
