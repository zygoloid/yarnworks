import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../js/pattern/parser.js';
import { knit } from '../js/knit/knitter.js';
import { checkOrientable } from '../js/knit/topology.js';
import { EXAMPLES } from '../js/examples.js';

const G = { stitchWidth: 4.5, rowHeight: 3.3 };
const twistWarnings = (r) => r.messages.filter((m) => m.message.includes('twists on itself'));

test('every example knits an orientable surface', () => {
  for (const ex of EXAMPLES) {
    const r = knit(parsePattern(ex.text), G);
    assert.deepEqual(twistWarnings(r), [], ex.name);
    assert.equal(checkOrientable(r).ok, true, ex.name);
  }
});

test('a sock whose gusset is picked up along the wrong edge first is a Klein bottle, and says so', () => {
  const text = EXAMPLES.find((e) => e.name.startsWith('Plain sock')).text;
  const good = knit(parsePattern(text), { ...G, sizeIndex: 1 });
  assert.deepEqual(twistWarnings(good), []);
  const bad = knit(parsePattern(text), { ...G, sizeIndex: 1, pickUpFirstEdge: 'R' });
  const w = twistWarnings(bad);
  assert.equal(w.length, 1);
  assert.match(w[0].message, /Gusset|Next rnd|Rnd/);
  assert.equal(checkOrientable(bad).ok, false);
});

test('a round attached to the round below with a reflection over half its stitches is not orientable', () => {
  const tube = knit(parsePattern('Cast on 12 sts.\nJoin in the round.\nRnd 1: k.\nRnds 2-6: as rnd 1.'), G);
  assert.equal(checkOrientable(tube).ok, true);
  const nodes = tube.nodes.map((x) => ({ ...x, parents: x.parents.slice(), children: [] }));
  const rows = tube.rows.map((x) => ({ ...x, nodes: x.nodes.slice() }));
  const below = rows[3].nodes, row = rows[4].nodes;
  for (let i = 6; i < 12; i++) nodes[row[i]].parents = [below[17 - i]];
  for (const nd of nodes) for (const p of nd.parents) nodes[p].children.push(nd.id);
  assert.equal(checkOrientable({ nodes, rows }).ok, false);
});
