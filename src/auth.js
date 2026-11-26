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

// Who sees only some families, from SEES: a Worker secret infra hands to the
// deploy, JSON like
//   { "nonna@example.com": ["pine"] }
// keyed by the address someone signs in with, each with the ids of the
// families (FAMILIES) whose kids they see, with those kids' art and what's
// said about it. It's for people in no family, like grandparents on one
// family's side: anyone it doesn't list sees every family, and parents and
// kids always do, so it can't list their addresses. Missing or empty means
// everyone sees everything, as before it. One that can't be read throws, so
// nobody gets in until it's fixed, rather than someone seeing a family they
// shouldn't.
//
// Returns each listed address's family ids.
export function readSees(env, families = readFamilies(env)) {
  const raw = (env.SEES || '').trim();
  const out = new Map();
  if (!raw) return out;
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error('SEES isn’t valid JSON.');
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('SEES must be a JSON object of addresses to lists of family ids.');
  const ids = families.map((f) => f.id);
  const inFamilies = new Set([...parentEmails(env), ...families.flatMap((f) => [...f.parents, ...f.kids.flatMap((k) => [k.artist, ...k.devices])])].filter(Boolean));
  for (const [key, list] of Object.entries(map)) {
    if (!isEmail(key)) throw new Error('SEES has a key that isn’t an email.');
    const email = key.trim().toLowerCase();
    if (out.has(email)) throw new Error('SEES lists an address twice.');
    if (inFamilies.has(email)) throw new Error('SEES lists a parent’s or a kid’s address: they see every family.');
    if (!Array.isArray(list) || !list.length || !list.every((id) => typeof id === 'string' && ids.includes(id.trim()))) {
      throw new Error('Each address in SEES needs a list of one or more family ids from FAMILIES.');
    }
    out.set(email, [...new Set(list.map((id) => id.trim()))]);
  }
  return out;
}

// { email, canEdit, families, artist, kid, sees } for a signed-in person, or
// null. Parents (PARENT_EMAILS, a Worker secret infra hands to the deploy) can
// change things; everyone else Access lets in can look. `families` are the
// ids of the families (FAMILIES) a parent is in: they can change only those
// families' kids, and kids in no family. `artist` is the name of the kid
// someone signs in as to add their own art (FAMILIES), or null. `kid` is the
// name of the kid whose address it is, as an artist or one of their devices,
// or null: their comments and stickers are that kid's. Anyone signed in can
// comment and give stickers. `sees` is null for someone who sees every
// family, or the ids of the only families they see (SEES; canSee).
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
  // Read for everyone too, so a broken SEES turns everyone away.
  const sees = readSees(env, all).get(me) ?? null;
  return { email: me, canEdit, families, artist: kid?.artist === me ? kid.name : null, kid: kid?.name ?? null, sees };
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

// Who sees what. Everyone sees every kid, except someone SEES lists, who
// sees only the kids in those families: not another family's, nor a kid in
// no family. Whoever doesn't see a kid doesn't see anything of theirs: their
// art and its pictures, what's said about it, nor their name. This is the
// one place that decides it. Every route that shows or changes a kid, a
// piece, or a comment or sticker on one asks it (worker.js: seenKids,
// seenPiece), and so does anything new that tells someone about them.
export const seesEverything = (who) => who.sees === null;
export const seesFamily = (who, id) => who.sees === null || who.sees.includes(id);
export const canSee = (who, kid) => (kid.family == null ? seesEverything(who) : seesFamily(who, kid.family));

// The rules, mirrored in the page. A parent can change a kid's pieces when
// the kid is in one of their families or in none. An artist can add their
// own art, and change only the pieces they added (worker.js, mayChange).
export const canChangeKid = (who, kid) => who.canEdit && (kid.family === null || who.families.includes(kid.family));
export const isArtistOf = (who, kid) => who.artist !== null && sameName(who.artist, kid.name);

// ---- Viewing as someone else ----
// The fridge's owners, from ADMINS: a Worker secret infra hands to the
// deploy, sign-in addresses separated by commas like PARENT_EMAILS, each one
// a parent's. An owner can look at the fridge as anyone else it lets in
// would see it, with changes off (worker.js, viewAs). Missing or empty means
// nobody can. One that can't be read throws, and then nobody can either
// (owner), rather than someone who isn't a parent getting to.
export function readAdmins(env) {
  const raw = (env.ADMINS || '').trim();
  if (!raw) return [];
  const list = raw.split(',').map((e) => e.trim().toLowerCase());
  if (!list.every(isEmail)) throw new Error('ADMINS must be sign-in addresses separated by commas.');
  const parents = parentEmails(env);
  if (!list.every((e) => parents.includes(e))) throw new Error('ADMINS lists someone who isn’t a parent (PARENT_EMAILS).');
  return [...new Set(list)];
}

// Whether this signed-in person is one of the owners. Never for someone
// already viewing as someone else: `who` is then the person viewed.
export function isOwner(env, who) {
  if (!who || who.viewing) return false;
  try {
    return readAdmins(env).includes(who.email);
  } catch (e) {
    console.error('ADMINS', e);
    return false;
  }
}

// Everyone the fridge knows of, as an owner picks whom to view as: each
// family's parents, then its kids (an artist's own address, then each of
// their devices, which are the kid), in FAMILIES' order; then everyone else
// NAMES or SEES lists, and any parent in no family. On a sign-in two people
// share, each of them, so their own names come out right (`as`). Each is
// { email, as, name, detail, address }: `address` is true where the name
// alone wouldn't tell two of them apart, or where it's only the start of
// the address. Returned as groups: [{ id, name, people }], everyone else
// last with id null.
export function viewable(env) {
  const families = readFamilies(env);
  const names = readNames(env);
  const sees = readSees(env, families);
  const parents = parentEmails(env);
  const listed = new Set();
  const nameless = (email) => email.split('@')[0];
  const peopleOn = (email, detail) => {
    const people = names.get(email) || [];
    if (!people.length) return [{ email, as: null, name: nameless(email), detail, address: true }];
    return people.map((p) => ({ email, as: people.length > 1 ? p.name : null, name: p.name, detail: p.family ? `${detail}, “${p.family}” at home` : detail, address: false }));
  };
  const take = (email) => !listed.has(email) && listed.add(email);
  const familyName = (id) => families.find((f) => f.id === id)?.name ?? id;
  const groups = families.map((f) => {
    const people = [];
    for (const email of f.parents) if (take(email)) people.push(...peopleOn(email, parents.includes(email) ? 'Parent' : 'Looks, in this family'));
    for (const kid of f.kids) {
      if (kid.artist && !parents.includes(kid.artist) && take(kid.artist)) people.push({ email: kid.artist, as: null, name: kid.name, detail: 'Artist: adds their own art', address: false });
      for (const device of kid.devices) if (!parents.includes(device) && take(device)) people.push({ email: device, as: null, name: kid.name, detail: 'Their iPad', address: false });
    }
    return { id: f.id, name: f.name, people };
  });
  const others = [];
  for (const email of parents) if (take(email)) others.push(...peopleOn(email, 'Parent, in no family'));
  for (const email of [...names.keys(), ...sees.keys()].sort()) {
    if (!take(email)) continue;
    const only = sees.get(email);
    others.push(...peopleOn(email, only ? `Sees only ${only.map(familyName).join(' and ')}` : 'Sees every family'));
  }
  const all = [...groups, { id: null, name: 'Everyone else', people: others }].filter((g) => g.people.length);
  // Two the same, like a kid's two devices: show their addresses.
  const flat = all.flatMap((g) => g.people);
  for (const p of flat) if (flat.some((q) => q !== p && sameName(q.name, p.name) && q.detail === p.detail)) p.address = true;
  return all;
}

// The `who` of the person `email` would be if they signed in themselves, as
// identify() makes it, with `viewing` saying who's looking and as which of
// the people on that sign-in.
export function viewedAs(env, owner, entry) {
  return { ...person(entry.email, env), viewing: { owner, as: entry.as, name: entry.name, detail: entry.detail } };
}
