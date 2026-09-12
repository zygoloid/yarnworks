import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../js/pattern/parser.js';
import { knit } from '../js/knit/knitter.js';
import { Relaxer, relaxKnit } from '../js/sim/relax.js';
import { YarnPathBuilder } from '../js/render/yarnpath.js';

const GAUGE = { stitchWidth: 4.5, rowHeight: 3.3 };

function run(text, opts = {}) {
  const p = parsePattern(text);
  assert.deepEqual(p.errors, []);
  const k = knit(p, { ...GAUGE, ...opts });
  assert.deepEqual(k.messages.filter((m) => m.severity === 'error'), []);
  return k;
}

function stats(pos) {
  const n = pos.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[3 * i + a]); max[a] = Math.max(max[a], pos[3 * i + a]); }
  return { min, max, size: max.map((v, a) => v - min[a]) };
}

test('flat swatch relaxes to a flat sheet of the expected size', () => {
  const k = run(`Cast on 20 sts.
Row 1: k.
Row 2: p.
Repeat rows 1-2 four times.`);
  const pos = relaxKnit(k, GAUGE);
  assert.equal(pos.length, k.nodes.length * 3);
  for (const v of pos) assert.ok(Number.isFinite(v));
  const { size } = stats(pos);
  // 20 stitches wide, 11 rows (cast on + 10) tall, thin.
  assert.ok(Math.abs(size[0] - 19 * 4.5) < 4.5, `width ${size[0]}`);
  assert.ok(Math.abs(size[1] - 10 * 3.3) < 3.3, `height ${size[1]}`);
  assert.ok(size[2] < 3, `thickness ${size[2]}`);
});

test('work in the round relaxes to a tube', () => {
  const k = run(`Cast on 40 sts.
Join in the round.
Rnd 1: k.
Rnds 2-10: as rnd 1.`);
  const pos = relaxKnit(k, GAUGE);
  const { size } = stats(pos);
  const R = 40 * 4.5 / (2 * Math.PI);
  assert.ok(Math.abs(size[0] - 2 * R) < 5, `x extent ${size[0]} vs ${2 * R}`);
  assert.ok(Math.abs(size[2] - 2 * R) < 5, `z extent ${size[2]} vs ${2 * R}`);
  // Every node should be roughly R from the axis.
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(pos[3 * i], pos[3 * i + 2]);
    assert.ok(Math.abs(r - R) < 4, `node ${i} radius ${r}`);
  }
});

test('warm start keeps existing nodes in place', () => {
  const k = run(`Cast on 10 sts.
Row 1: k.
Row 2: p.
Row 3: k.`);
  const pos = relaxKnit(k, GAUGE);
  const prev = new Map();
  for (let i = 0; i < k.nodes.length; i++) prev.set(i, [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
  const r = new Relaxer(k, { ...GAUGE, prev });
  for (let i = 0; i < k.nodes.length; i++) assert.deepEqual(r.get(i), prev.get(i));
});

test('yarn path visits every stitch in order with increasing yarn length', () => {
  const k = run(`Cast on 8 sts.
Row 1: k1, yo, k2tog, sl1 wyif, kfb, k3.
Row 2: p.
Bind off.`);
  const pos = relaxKnit(k, GAUGE);
  const b = new YarnPathBuilder(k, pos, { ...GAUGE, yarnRadius: 0.9 });
  const path = b.build();
  assert.ok(path.points.length / 3 > k.nodes.length * 3);
  let last = -1, lastNode = -1;
  for (let i = 0; i < path.yarn.length; i++) {
    assert.ok(path.yarn[i] >= last - 1e-6, `yarn length decreases at ${i}`);
    assert.ok(path.node[i] >= lastNode, 'node order');
    last = path.yarn[i]; lastNode = path.node[i];
    for (let a = 0; a < 3; a++) assert.ok(Number.isFinite(path.points[3 * i + a]));
  }
  assert.equal(path.strands.length, 1);
});

test('yarn changes split the path into strands', () => {
  const k = run(`Cast on 6 sts.
Row 1: k.
Change to B.
Row 2: p.`);
  const pos = relaxKnit(k, GAUGE);
  const path = new YarnPathBuilder(k, pos, { ...GAUGE, yarnRadius: 0.9 }).build();
  assert.equal(path.strands.length, 2);
});
