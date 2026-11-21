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

// The families, from FAMILIES: a Worker secret infra hands to the deploy,
// JSON like [{ "id": "pine", "name": "The Pines", "parents": ["a@example.com"] }],
// in the order the page shows them. Missing or empty means no families, and
// then every parent can change everything. A FAMILIES that can't be read
// throws, so nobody gets in until it's fixed, rather than every parent
// getting every family's rights.
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
  return list.map((f, i) => {
    const id = typeof f?.id === 'string' ? f.id.trim() : '';
    if (!id || id.length > 60) throw new Error(`FAMILIES entry ${i + 1} needs an id of 1 to 60 characters.`);
    if (seen.has(id)) throw new Error(`FAMILIES has the id ${JSON.stringify(id)} twice.`);
    seen.add(id);
    if (typeof f.name !== 'string' || !f.name.trim()) throw new Error(`FAMILIES entry ${i + 1} needs a name.`);
    if (!Array.isArray(f.parents) || !f.parents.every((e) => typeof e === 'string')) throw new Error(`FAMILIES entry ${i + 1} needs parents, a list of emails.`);
    return { id, name: f.name.trim(), parents: f.parents.map((e) => e.trim().toLowerCase()).filter(Boolean) };
  });
}

// { email, canEdit, families } for a signed-in person, or null. Parents
// (PARENT_EMAILS, a Worker secret infra hands to the deploy) can change
// things; everyone else Access lets in can look. `families` are the ids of
// the families (FAMILIES) a parent is in: they can change only those
// families' kids, and kids in no family.
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

function person(email, env) {
  const me = email.trim().toLowerCase();
  const parents = (env.PARENT_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const canEdit = parents.includes(me);
  // Read for everyone, so a broken FAMILIES turns everyone away. Being named
  // in a family makes nobody a parent: PARENT_EMAILS says who is.
  const all = readFamilies(env);
  const families = canEdit ? all.filter((f) => f.parents.includes(me)).map((f) => f.id) : [];
  return { email: me, canEdit, families };
}

// The rule, mirrored in the page: a parent can change a kid, and that kid's
// pieces, when the kid is in one of their families or in none.
export const canChangeKid = (who, kid) => who.canEdit && (kid.family === null || who.families.includes(kid.family));
