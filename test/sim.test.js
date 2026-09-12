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
  // Every node should be roughly R from the axis (a knitted tube settles slightly oval).
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(pos[3 * i], pos[3 * i + 2]);
    assert.ok(Math.abs(r - R) < 0.25 * R, `node ${i} radius ${r}`);
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

function widthOfRow(k, pos, r) {
  let mn = Infinity, mx = -Infinity;
  for (const id of k.rows[r].nodes) { mn = Math.min(mn, pos[3 * id]); mx = Math.max(mx, pos[3 * id]); }
  return mx - mn;
}
function rowY(k, pos, r) { return k.rows[r].nodes.reduce((a, id) => a + pos[3 * id + 1], 0) / k.rows[r].nodes.length; }

test('rib contracts and corrugates, seed stitch stays flat and wide, garter compresses rows', () => {
  const opts = { ...GAUGE, yarnRadius: 0.95, iterations: 400 };
  const stock = run(`Cast on 20 sts.\nRow 1: k.\nRow 2: p.\nRepeat rows 1-2 five times.`);
  const rib = run(`Cast on 20 sts.\nRow 1 (RS): *k1, p1; rep from * to end.\nRow 2: *k1, p1; rep from * to end.\nRepeat rows 1-2 five times.`);
  const seed = run(`Cast on 21 sts.\nRow 1: *k1, p1; rep from * to last st, k1.\nRepeat row 1 ten times.`);
  const garter = run(`Cast on 20 sts.\nRow 1: k.\nRow 2: k.\nRepeat rows 1-2 five times.`);
  const ps = relaxKnit(stock, opts), pr = relaxKnit(rib, opts), pe = relaxKnit(seed, opts), pg = relaxKnit(garter, opts);
  const wStock = widthOfRow(stock, ps, 6), wRib = widthOfRow(rib, pr, 6), wSeed = widthOfRow(seed, pe, 6) * 19 / 20;
  assert.ok(wRib < 0.72 * wStock, `1x1 rib width ${wRib} vs stockinette ${wStock}`);
  assert.ok(Math.abs(wSeed - wStock) < 0.1 * wStock, `seed width ${wSeed} vs stockinette ${wStock}`);
  // Rib corrugates: knit and purl columns sit on opposite sides.
  const row = rib.rows[6];
  let zk = 0, zp = 0, nk = 0, np = 0;
  for (const id of row.nodes) { const z = pr[3 * id + 2]; if (rib.nodes[id].face === 'k') { zk += z; nk++; } else { zp += z; np++; } }
  assert.ok(zk / nk - zp / np > 1.5, `rib depth ${zk / nk - zp / np}`);
  // Garter rows are closer together than stockinette rows.
  const hStock = (rowY(stock, ps, 10) - rowY(stock, ps, 2)) / 8, hGarter = (rowY(garter, pg, 10) - rowY(garter, pg, 2)) / 8;
  assert.ok(hGarter < 0.85 * hStock, `garter row height ${hGarter} vs stockinette ${hStock}`);
  // Stockinette stays flat.
  const { size } = stats(ps);
  assert.ok(size[2] < 3, `stockinette thickness ${size[2]}`);
});

test('with the centre of mass anchored, dragging a stitch deforms the swatch instead of moving it', () => {
  const k = run(`Cast on 15 sts.
Row 1: k.
Row 2: p.
Rows 3-14: repeat rows 1-2.`);
  const settle = () => { const r = new Relaxer(k, GAUGE); r.relax(40); r.centre(); return r; };
  const pick = (r) => k.rows[7].nodes[7]; // a stitch in the middle
  const before = Float64Array.from(settle().pos);
  // The corner on the side the stitch is pulled away from.
  const ends = [k.rows[1].nodes[0], k.rows[1].nodes[k.rows[1].nodes.length - 1]];
  const corner = before[3 * ends[0]] < before[3 * ends[1]] ? ends[0] : ends[1];
  const pull = (r, anchored) => {
    const id = pick(r);
    const target = [r.pos[3 * id] + 30, r.pos[3 * id + 1], r.pos[3 * id + 2]];
    if (anchored) r.anchorCentre(r.centroid());
    r.pin(id, target);
    r.relax(30);
    const c = r.centroid();
    const dist = (pos) => Math.hypot(pos[3 * id] - pos[3 * corner], pos[3 * id + 1] - pos[3 * corner + 1], pos[3 * id + 2] - pos[3 * corner + 2]);
    return { centroidShift: Math.hypot(c[0], c[1], c[2]), cornerShift: r.pos[3 * corner] - before[3 * corner], stretch: dist(r.pos) - dist(before) };
  };
  const free = pull(settle(), false);
  const held = pull(settle(), true);
  // Unanchored, the pull mostly carries the whole swatch along; anchored, the centre stays
  // put and a far corner moves much less than the pulled stitch.
  assert.ok(free.centroidShift > 10, `free centroid moved ${free.centroidShift}`);
  assert.ok(held.centroidShift < 1, `anchored centroid moved ${held.centroidShift}`);
  assert.ok(Math.abs(held.cornerShift) < 15, `anchored corner moved ${held.cornerShift}`);
  assert.ok(held.stretch > 3 * Math.max(1, free.stretch), `stretch anchored ${held.stretch} vs free ${free.stretch}`);
});
