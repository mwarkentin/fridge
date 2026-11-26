// How the page orders, groups and colours the kids by family, from
// GET /api/gallery (`families`, and each kid's `family`) and GET /api/session
// (`families`: the ones the signed-in person is a parent in). Nothing here
// touches the page, so the tests can run it.

// The page's six kid colours (--kid-0 to --kid-5 in app.css) are blue,
// orange, green, purple, pink and teal. The first four kids get the four
// furthest apart: blue, orange, green and pink. Purple comes later, since it's
// close to blue and is the Timeline tab's colour.
const PREFERENCE = [0, 1, 2, 4, 3, 5];
// Pairs close enough to muddle at a glance: blue and purple, blue and teal,
// green and teal, purple and pink. Siblings don't share one if there's a choice.
const CLOSE = new Set(['0-3', '0-5', '2-5', '3-4']);
const near = (a, b) => a === b || CLOSE.has(a < b ? `${a}-${b}` : `${b}-${a}`);

// Each kid's colour, in the API's order (oldest first), so a kid is the same
// colour for everyone who looks. A kid's colour depends only on the kids
// before them, so a new baby never changes anyone else's. Someone who sees
// only some families gets only those kids from the API, so their colours
// come from those kids alone, and hint at nobody else.
function colours(kids, familyOf) {
  const uses = [0, 0, 0, 0, 0, 0];
  const taken = new Map(); // family id -> colours its kids have
  return kids.map((kid) => {
    const fam = familyOf(kid);
    const siblings = (fam && taken.get(fam)) || [];
    const order = [...PREFERENCE].sort((a, b) => uses[a] - uses[b] || PREFERENCE.indexOf(a) - PREFERENCE.indexOf(b));
    const ci = order.find((c) => !siblings.some((s) => near(s, c))) ?? order.find((c) => !siblings.includes(c)) ?? order[0];
    uses[ci]++;
    if (fam) taken.set(fam, [...siblings, ci]);
    return ci;
  });
}

// The kids in the order the page lists them, each with `ci` (their colour,
// 0 to 5) and `familyName` (or null), and the groups to show them in. Each
// kid's `family` stays the id the API sent, which edit rights go by.
//
// With no families (before they're set up), it's the API's order and colours
// by position, exactly as the page has always done, and no groups.
//
// With families: the viewer's own families first, then the rest in the API's
// order, then any kids not in a family. `heads` says whether there's more
// than one family to tell apart, so whether to show the families' names:
// someone who sees only one family (SEES) sees no family names at all.
export function arrange(kids, families, mine) {
  const fams = (Array.isArray(families) ? families : []).filter((f) => f && f.id != null);
  if (!fams.length) return { grouped: false, heads: false, groups: [], kids: kids.map((k, i) => ({ ...k, ci: i % 6, familyName: null })) };

  const byId = new Map(fams.map((f) => [String(f.id), f]));
  const familyOf = (k) => (k.family != null && byId.has(String(k.family)) ? String(k.family) : null);
  const ci = colours(kids, familyOf);
  const all = kids.map((k, i) => ({ ...k, ci: ci[i], familyName: familyOf(k) ? String(byId.get(familyOf(k)).name ?? '') : null }));

  const own = new Set((Array.isArray(mine) ? mine : []).map(String));
  const groups = fams.map((f) => ({ id: String(f.id), name: String(f.name ?? ''), mine: own.has(String(f.id)), kids: all.filter((k) => familyOf(k) === String(f.id)) })).filter((g) => g.kids.length);
  groups.sort((a, b) => b.mine - a.mine); // stable: keeps the API's order otherwise
  const ours = groups.filter((g) => g.mine).length;
  for (const g of groups) g.label = g.mine && ours === 1 ? 'Our kids' : g.name || 'A family';
  const loose = all.filter((k) => !familyOf(k));
  if (loose.length) groups.push({ id: null, name: '', mine: false, label: 'Other kids', kids: loose });

  return { grouped: true, heads: groups.filter((g) => g.id !== null).length > 1, groups, kids: groups.flatMap((g) => g.kids) };
}
