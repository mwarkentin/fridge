// How the page orders, groups and colours the kids by family (public/families.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../public/families.js';

// The API's order: oldest first. Two made-up families, interleaved by age.
const kids = [
  { id: 1, name: 'Ada', born: '2018-01-10', family: 'oaks' },
  { id: 3, name: 'Cy', born: '2019-06-02', family: 'willows' },
  { id: 2, name: 'Bo', born: '2021-02-20', family: 'oaks' },
  { id: 4, name: 'Dee', born: '2023-04-01', family: 'willows' },
];
const families = [
  { id: 'oaks', name: 'The Oaks' },
  { id: 'willows', name: 'The Willows' },
];
const names = (list) => list.map((k) => k.name);
const CLOSE = [[0, 3], [0, 5], [2, 5], [3, 4]];
const near = (a, b) => a === b || CLOSE.some(([x, y]) => (a === x && b === y) || (a === y && b === x));

test('with no families, everything is as it was: the API’s order, colours by position, no groups', () => {
  const plain = kids.map(({ family, ...k }) => k);
  for (const fams of [undefined, null, [], 'nonsense']) {
    const out = arrange(plain, fams, ['oaks']);
    assert.equal(out.grouped, false);
    assert.equal(out.heads, false);
    assert.deepEqual(out.groups, []);
    assert.deepEqual(names(out.kids), ['Ada', 'Cy', 'Bo', 'Dee']);
    assert.deepEqual(out.kids.map((k) => k.ci), [0, 1, 2, 3]);
  }
  // A kid's family, if the API sends one without the families, is left as it came.
  assert.deepEqual(arrange(kids, []).kids.map((k) => k.family), ['oaks', 'willows', 'oaks', 'willows']);
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `Kid ${i}`, born: '2020-01-01' }));
  assert.deepEqual(arrange(eight, []).kids.map((k) => k.ci), [0, 1, 2, 3, 4, 5, 0, 1]);
});

test('a parent sees their own family first, headed “Our kids”', () => {
  const oaks = arrange(kids, families, ['oaks']);
  assert.equal(oaks.grouped, true);
  assert.equal(oaks.heads, true);
  assert.deepEqual(oaks.groups.map((g) => g.label), ['Our kids', 'The Willows']);
  assert.deepEqual(names(oaks.kids), ['Ada', 'Bo', 'Cy', 'Dee']);

  const willows = arrange(kids, families, ['willows']);
  assert.deepEqual(willows.groups.map((g) => g.label), ['Our kids', 'The Oaks']);
  assert.deepEqual(names(willows.kids), ['Cy', 'Dee', 'Ada', 'Bo']);
  assert.deepEqual(willows.groups.map((g) => names(g.kids)), [['Cy', 'Dee'], ['Ada', 'Bo']]);
  assert.equal(willows.kids[0].familyName, 'The Willows');
  // The family stays the id the API sent: the page's edit rights go by it.
  assert.deepEqual(willows.kids.map((k) => k.family), ['willows', 'willows', 'oaks', 'oaks']);
});

test('someone in no family sees the families in the API’s order, by name', () => {
  for (const mine of [[], undefined]) {
    const out = arrange(kids, families, mine);
    assert.deepEqual(out.groups.map((g) => g.label), ['The Oaks', 'The Willows']);
    assert.deepEqual(names(out.kids), ['Ada', 'Bo', 'Cy', 'Dee']);
  }
});

test('a parent in two families sees them by name, not both as “Our kids”', () => {
  const out = arrange(kids, families, ['willows', 'oaks']);
  assert.deepEqual(out.groups.map((g) => g.label), ['The Oaks', 'The Willows']);
});

test('a kid’s colour is the same whoever looks, and four kids get four far-apart colours', () => {
  const by = (out) => Object.fromEntries(out.kids.map((k) => [k.name, k.ci]));
  const seen = [['oaks'], ['willows'], [], undefined].map((mine) => by(arrange(kids, families, mine)));
  for (const s of seen) assert.deepEqual(s, seen[0]);
  // Blue, orange, green and pink: purple stays out, as it's close to blue.
  assert.deepEqual(new Set(Object.values(seen[0])), new Set([0, 1, 2, 4]));
});

test('siblings never get colours close to each other when there’s a choice', () => {
  // Every way of splitting up to six kids, born in any family order, between two or three families.
  const fams = ['a', 'b', 'c'].map((id) => ({ id, name: id }));
  for (let n = 2; n <= 6; n++) {
    for (let code = 0; code < 3 ** n; code++) {
      const of = Array.from({ length: n }, (_, i) => fams[Math.floor(code / 3 ** i) % 3].id);
      const list = of.map((family, i) => ({ id: i + 1, name: `K${i}`, born: `20${10 + i}-01-01`, family }));
      const out = arrange(list, fams, []);
      for (const g of out.groups) {
        const cs = g.kids.map((k) => k.ci);
        if (g.kids.length <= 3) {
          for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) assert.ok(!near(cs[i], cs[j]), `${of.join('')}: ${cs}`);
        } else assert.equal(new Set(cs).size, cs.length, `${of.join('')}: ${cs}`);
      }
      if (n <= 4) assert.equal(new Set(out.kids.map((k) => k.ci)).size, n, `${of.join('')}`);
    }
  }
});

test('a new kid doesn’t change anyone else’s colour', () => {
  const before = arrange(kids, families, []);
  const after = arrange([...kids, { id: 5, name: 'Eve', born: '2025-01-01', family: 'oaks' }], families, []);
  for (const k of before.kids) assert.equal(after.kids.find((x) => x.id === k.id).ci, k.ci, k.name);
});

test('kids in no family, or one that isn’t listed, come last as “Other kids”', () => {
  const list = [...kids, { id: 5, name: 'Eve', born: '2024-01-01', family: null }, { id: 6, name: 'Fin', born: '2024-02-01', family: 'gone' }];
  const out = arrange(list, families, ['oaks']);
  assert.deepEqual(out.groups.map((g) => g.label), ['Our kids', 'The Willows', 'Other kids']);
  assert.deepEqual(names(out.groups[2].kids), ['Eve', 'Fin']);
  assert.deepEqual(out.groups[2].kids.map((k) => k.familyName), [null, null]);
  assert.deepEqual(out.groups[2].kids.map((k) => k.family), [null, 'gone']);
  assert.equal(out.kids.length, list.length);
});

test('family names show only when there’s more than one family with kids', () => {
  const one = arrange(kids.filter((k) => k.family === 'oaks'), families, ['oaks']);
  assert.equal(one.grouped, true);
  assert.equal(one.heads, false);
  assert.deepEqual(one.groups.map((g) => g.label), ['Our kids']);

  const loose = arrange([...kids.filter((k) => k.family === 'oaks'), { id: 5, name: 'Eve', born: '2024-01-01', family: null }], families, []);
  assert.equal(loose.heads, false);
  assert.deepEqual(names(loose.kids), ['Ada', 'Bo', 'Eve']);
});

test('family ids match whether they come as text or numbers', () => {
  const out = arrange([{ id: 1, name: 'Ada', born: '2018-01-01', family: 7 }, { id: 2, name: 'Cy', born: '2019-01-01', family: '8' }], [{ id: '7', name: 'Seven' }, { id: 8, name: 'Eight' }], [8]);
  assert.deepEqual(out.groups.map((g) => g.label), ['Our kids', 'Seven']);
  assert.deepEqual(out.kids.map((k) => k.familyName), ['Eight', 'Seven']);
});

test('someone who sees only one family gets its kids on their own, with no family names to tell apart', () => {
  // What the API sends someone SEES lists with only the Pines: that family, its kids.
  const pines = [
    { id: 1, name: 'Ada', born: '2019-04-02', family: 'pine' },
    { id: 2, name: 'Bo', born: '2021-07-02', family: 'pine' },
  ];
  const out = arrange(pines, [{ id: 'pine', name: 'The Pines' }], []);
  assert.equal(out.grouped, true);
  assert.equal(out.heads, false, 'no family names');
  assert.equal(out.groups.length, 1);
  assert.deepEqual(names(out.kids), ['Ada', 'Bo']);
  assert.ok(!near(out.kids[0].ci, out.kids[1].ci), 'siblings still get colours apart');
});
