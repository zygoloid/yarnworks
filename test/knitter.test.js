import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../js/pattern/parser.js';
import { knit } from '../js/knit/knitter.js';

function run(text, opts = {}) {
  const p = parsePattern(text);
  assert.deepEqual(p.errors.map((e) => e.message), []);
  return knit(p, { stitchWidth: 4.5, rowHeight: 3.3, ...opts });
}

function counts(r) { return r.rows.map((row) => row.stitchesAfter); }
function errors(r) { return r.messages.filter((m) => m.severity === 'error').map((m) => m.message); }

test('rib swatch', () => {
  const r = run(`Cast on 20 sts.
Row 1 (RS): *k2, p2; rep from * to end.
Row 2: *p2, k2; rep from * to end.
Rows 3-6: Repeat rows 1-2.
Row 7: k2tog, k to last 2 sts, ssk. (18 sts)
Bind off.`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(counts(r), [20, 20, 20, 20, 20, 20, 20, 18, 1]);
  assert.deepEqual(r.rows.map((x) => x.side), ['ws', 'rs', 'ws', 'rs', 'ws', 'rs', 'ws', 'rs', 'ws']);
  assert.deepEqual(r.rows.map((x) => x.label), ['Cast on', 'Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6', 'Row 7', 'Bind off']);
  // Faces: row 1 k2 p2 as seen from RS; row 2 (WS) p2 k2 as worked = k2 p2 from RS.
  const face = (row) => r.rows[row].nodes.map((id) => r.nodes[id].face).join('');
  assert.equal(face(1), 'kkppkkppkkppkkppkkpp');
  assert.equal(face(2), 'kkppkkppkkppkkppkkpp');
  // Row 2 is worked in the opposite direction, so its first stitch is knit into row 1's last stitch.
  const row2first = r.nodes[r.rows[2].nodes[0]];
  assert.deepEqual(row2first.parents, [r.rows[1].nodes[19]]);
  // Bind off chains.
  const bo = r.rows[8].nodes.map((id) => r.nodes[id]);
  assert.equal(bo.length, 18);
  assert.equal(bo[0].passedOver, bo[1].id);
  assert.equal(bo[17].finished, true);
});

test('in the round with sizes, markers and measurement repeats', () => {
  const text = `Sizes: S (M, L)
Cast on 40 (44, 48) sts.
Join in the round, being careful not to twist.
Rnd 1: (k1, p1) to end.
Rnds 2-3: as rnd 1.
Rnd 4: k12 (14, 16), pm, k to end.
Repeat rnd 4 until piece measures 2 cm.
Next rnd: *k2, k2tog; rep from * to end — 30 (33, 36) sts
Next rnd: k to marker, sm, k to end.
Knit 2 rows.
BO all sts loosely.`;
  const r = run(text, { sizeIndex: 1 });
  assert.deepEqual(errors(r), []);
  assert.equal(r.inRound, true);
  assert.deepEqual(counts(r), [44, 44, 44, 44, 44, 44, 44, 44, 33, 33, 33, 33, 1]);
  assert.deepEqual(r.rows.slice(1, 5).map((x) => x.label), ['Rnd 1', 'Rnd 2', 'Rnd 3', 'Rnd 4']);
  assert.ok(r.rows.slice(1).every((x) => x.side === 'rs'));
  // Round 1's first stitch is knit into the first cast-on stitch.
  assert.deepEqual(r.nodes[r.rows[1].nodes[0]].parents, [r.rows[0].nodes[0]]);
  // Size 2 with a 3-size pattern.
  const r3 = run(text, { sizeIndex: 2 });
  assert.equal(r3.rows[1].stitchesAfter, 48);
  const r1 = run(text, { sizeIndex: 0 });
  assert.equal(r1.rows[1].stitchesAfter, 40);
  // A size that doesn't exist.
  const r4 = run(text, { sizeIndex: 3 });
  assert.match(errors(r4)[0], /only has 3 sizes/);
});

test('short rows', () => {
  const r = run(`Cast on 11 sts.
Row 1: k5, w&t.
Row 2: p to end.
Row 3: k to end.
Row 4: p.`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.rows.map((x) => [x.stitchesBefore, x.nodes.length, x.side]), [[0, 11, 'ws'], [11, 5, 'rs'], [5, 5, 'ws'], [11, 11, 'rs'], [11, 11, 'ws']]);
  assert.equal(r.rows[1].short, true);
  // The wrapped stitch is the 6th cast-on stitch worked (from the RS: the one after the 5 knit).
  const wrapped = r.nodes.filter((n) => n.wrapped);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].row, 0);
});

test('increases, decreases, yarn overs, psso', () => {
  const r = run(`Cast on 8 sts.
Row 1: k1, yo, k1, sl1, k1, psso, k2tog, yo, k2.
Row 2: p.
Row 3: kfb, k to last st, kfb.
Row 4: p to end
Rows 5-8: rep rows 3-4 twice`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(counts(r), [8, 8, 8, 10, 10, 12, 12, 14, 14]);
  const row1 = r.rows[1].nodes.map((id) => r.nodes[id]);
  assert.deepEqual(row1.map((n) => n.kind), ['k', 'yo', 'k', 'sl', 'k', 'k', 'yo', 'k', 'k']);
  assert.equal(row1[3].passedOver, row1[4].id);
  assert.equal(row1[5].parents.length, 2);
  assert.equal(row1[5].lean, 'right');
  assert.equal(row1[1].parents.length, 0);
  // kfb: two children from one parent.
  const row3 = r.rows[3].nodes.map((id) => r.nodes[id]);
  assert.deepEqual(row3[0].parents, row3[1].parents);
});

test('to marker and slip marker', () => {
  const r = run(`Cast on 10 sts.
Row 1: k3, pm, k4, pm, k3.
Row 2: p to marker, sm, p to 1 st before marker, p1, sm, p to end.
Row 3: k to marker, m1, sm, k to end. (11 sts)`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(counts(r), [10, 10, 10, 11]);
  assert.deepEqual(r.rows[1].markersAfter, [{ after: 3, name: null }, { after: 7, name: null }]);
});

test('errors: not enough stitches', () => {
  const r = run(`Cast on 5 sts.
Row 1: k4, k2tog.`);
  assert.equal(errors(r).length, 1);
  assert.match(errors(r)[0], /Row 1: "k2tog" needs 2 stitches but only 1 is left/);
  assert.equal(r.messages[0].loc.line, 2);
  assert.equal(r.rows[1].complete, false);
});

test('errors: stitches left over', () => {
  const r = run(`Cast on 10 sts.
Row 1: k5.`);
  assert.match(errors(r)[0], /5 stitches are left unworked/);
});

test('errors: repeat does not fit', () => {
  const r = run(`Cast on 10 sts.
Row 1: *k2, p2; rep from * to end.`);
  assert.match(errors(r)[0], /uses 4 sts, but 10 sts are available: 2 would be left over/);
});

test('problem: stitch count mismatch is reported but knitting continues', () => {
  const r = run(`Cast on 10 sts.
Row 1: k2tog, k to end. (10 sts)
Row 2: p.`);
  assert.deepEqual(errors(r), []);
  const problems = r.messages.filter((m) => m.severity === 'problem');
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /should be 10 sts but there are 9/);
  assert.equal(r.rows.length, 3);
});

test('error: missing row in block', () => {
  const r = run(`Cast on 10 sts.
Row 1: k.
Row 3: p.`);
  assert.match(errors(r)[0], /Row 2 is missing/);
});

test('and all WS rows', () => {
  const r = run(`Cast on 10 sts.
Rows 1, 3 and 5: k.
Row 2 and all WS rows: p.
Row 7: k`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(r.rows.slice(1).map((x) => x.label), ['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5', 'Row 6', 'Row 7']);
  const faces = r.rows.slice(1).map((x) => r.nodes[x.nodes[0]].face);
  assert.deepEqual(faces, ['k', 'k', 'k', 'k', 'k', 'k', 'k']);
});

test('measurement repeat uses the gauge', () => {
  const r = run(`Cast on 10 sts.
Row 1: k.
Row 2: p.
Repeat rows 1-2 until piece measures 3 cm, ending with a RS row.`, { rowHeight: 4 });
  assert.deepEqual(errors(r), []);
  // 30mm / 4mm = 7.5 rows -> 8 rows (4 repeats), then ending with a RS row means one more.
  assert.equal(r.rows.length - 1, 9);
  assert.equal(r.rows[r.rows.length - 1].side, 'rs');
});

test('bind off partway through a row', () => {
  const r = run(`Cast on 10 sts.
Row 1: k3, bo 4, k to end.
Row 2: p3, co 4, p3.`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(counts(r), [10, 6, 10]);
});

test('yarn changes are recorded on nodes', () => {
  const r = run(`Cast on 4 sts.
Row 1: k.
Change to B.
Row 2: p.`);
  assert.equal(r.nodes[r.rows[1].nodes[0]].yarn, null);
  assert.equal(r.nodes[r.rows[2].nodes[0]].yarn, 'B');
});

test('flat override of a pattern in the round', () => {
  const r = run(`Cast on 8 sts.
Join in the round.
Rnd 1: k.`, { inRound: false });
  assert.equal(r.inRound, false);
  assert.ok(r.messages.some((m) => m.severity === 'warning'));
});

test('cables cross stitches and set layers', () => {
  const r = run(`Cast on 8 sts.
Row 1: k2, c4f, k2.
Row 2: p.
Row 3: k2, 2/2 RC, k2.
Row 4: p2, 2/1 LPC, p3.`);
  assert.deepEqual(errors(r), []);
  assert.deepEqual(counts(r), [8, 8, 8, 8, 8]);
  const row1 = r.rows[1].nodes.map((id) => r.nodes[id]);
  const co = r.rows[0].nodes;
  // Row 1 is worked from the last cast-on stitch backwards. The cable takes co[5..2];
  // c4f holds the first two (co[5], co[4]) in front and knits co[3], co[2] first.
  assert.deepEqual(row1.slice(2, 6).map((n) => n.parents[0]), [co[3], co[2], co[5], co[4]]);
  assert.deepEqual(row1.slice(2, 6).map((n) => n.layer), [-1, -1, 1, 1]);
  const row3 = r.rows[3].nodes.map((id) => r.nodes[id]);
  assert.deepEqual(row3.slice(2, 6).map((n) => n.layer), [1, 1, -1, -1]);
  // 2/2 RC: the first two loops are held in back and worked second.
  const row2 = r.rows[2].nodes;
  assert.deepEqual(row3.slice(2, 6).map((n) => n.parents[0]), [row2[3], row2[2], row2[5], row2[4]]);
  assert.deepEqual(row3.slice(2, 6).map((n) => n.cableShift), [-2, -2, 2, 2]);
  const row4 = r.rows[4].nodes.map((id) => r.nodes[id]);
  assert.deepEqual(row4.slice(2, 5).map((n) => [n.kind, n.layer]), [['p', -1], ['k', 1], ['k', 1]]);
});

test('sock construction: flat heel flap on held stitches, heel turn with gaps, pick-ups, wrapped round, graft', () => {
  const r = run(`Sizes: S (M)
Cuff:
With CC, cast on 24 (30) sts.
Join in the round.
Rnd 1: *k2, p1; rep from * to end.
Rnd 2: as rnd 1.
Leg:
Change to MC.
Knit 4 rounds.
Heel flap:
Next rnd: k12 (15).
Work the next 12 (15) sts back and forth.
Row 1 (RS): k2, [sl1, k1] to end. Turn.
Row 2: sl1 wyif, p to end. Turn.
Row 3: [sl1, k1] to end. Turn.
Repeat rows 2-3 until heel flap measures 4 cm, ending after a purl row.
Heel turn:
Row 1: sl1, k6 (8), ssk, k1, turn.
Row 2: sl1, p3, p2tog, p1, turn.
Row 3: sl1, k to 1 st before gap, ssk, k1, turn.
Row 4: sl1, p to 1 st before gap, p2tog, p1, turn.
Repeat rows 3-4 until there are 8 (11) sts.
Next row: sl1, p to end.
Gusset:
Change to MC.
Next rnd: pick up and knit 5 (6) sts along the edge of the heel flap, k12 (15), pm, pick up and knit 5 (6) sts along the other edge of the heel flap, k8 (11), k5 (6). 30 (38) sts
Rnd 1: k to marker, sm, k1, ssk, k to 3 sts before end, k2tog, k1.
Rnd 2: k.
Repeat rnds 1-2 until there are 24 (30) sts.
Toe:
Rnd 1: k1, ssk, k to 3 sts before marker, k2tog, k1, sm, k1, ssk, k to 3 sts before end, k2tog, k1.
Rnd 2: k.
Repeat rnds 1-2 until there are 12 (14) sts.
Graft the remaining sts together.`, { rowHeight: 4 });
  assert.deepEqual(errors(r), []);
  assert.equal(r.finished, true);
  const sections = [...new Set(r.rows.map((x) => x.section))];
  assert.deepEqual(sections, ['Cuff', 'Leg', 'Heel flap', 'Heel turn', 'Gusset', 'Toe']);
  // The flap is flat with 12 sts while the 12 instep stitches are held.
  const flap = r.rows.filter((x) => x.section === 'Heel flap' && !x.isRound);
  assert.ok(flap.length >= 5);
  assert.ok(flap.every((x) => x.stitchesBefore === 12 && !x.short));
  // Heel turn short rows decrease by one each row down to 8.
  const turn = r.rows.filter((x) => x.section === 'Heel turn');
  assert.equal(turn[turn.length - 1].stitchesAfter, 8);
  assert.ok(turn.filter((x) => x.short).length >= 2);
  assert.deepEqual(r.messages.filter((m) => m.severity === 'warning').map((m) => m.message.replace(/^.*?: /, '')), ['works past the end of the round, so the beginning of the round moves']);
  // Pick-ups attach to slipped selvedge stitches of the flap; the gusset round wraps.
  const pickups = r.nodes.filter((n) => n.op === 'pick up');
  assert.equal(pickups.length, 10);
  assert.ok(pickups.every((n) => r.nodes[n.parents[0]].kind === 'sl'));
  const gusset = r.rows.find((x) => x.section === 'Gusset');
  assert.equal(gusset.wrapped, true);
  assert.equal(gusset.stitchesAfter, 30);
  // The next round starts at the instep: its first stitch is knit into an instep stitch of
  // the pick-up round, which was itself knit into a leg stitch.
  const next = r.rows[gusset.index + 1];
  const instep = r.nodes[r.nodes[next.nodes[0]].parents[0]];
  assert.equal(instep.op, 'k');
  const before = r.rows[r.nodes[instep.parents[0]].row]; // the partial round worked before the flap
  assert.equal(before.isRound, true);
  assert.equal(before.section, 'Heel flap');
  // Graft closes the toe: 6 graft loops joining pairs.
  const grafts = r.nodes.filter((n) => n.graft);
  assert.equal(grafts.length, 6);
  assert.ok(grafts.every((n) => n.parents.length === 2));
});
