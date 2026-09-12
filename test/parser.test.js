import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePattern } from '../js/pattern/parser.js';

function parseOne(line) {
  const r = parsePattern(line);
  assert.deepEqual(r.errors.map((e) => e.message), [], `errors parsing "${line}"`);
  assert.equal(r.statements.length, 1);
  return r.statements[0];
}

function strip(x) { return JSON.parse(JSON.stringify(x, (k, v) => (k === 'loc' ? undefined : v))); }

test('cast on with sizes', () => {
  const s = parseOne('Cast on 40 (44, 48) sts using long-tail cast on.');
  assert.equal(s.type, 'castOn');
  assert.deepEqual(s.count.sizes, [40, 44, 48]);
});

test('cast on plain', () => {
  assert.equal(parseOne('CO 12').count, 12);
  assert.equal(parseOne('Cast on twenty sts').count, 20);
});

test('row with star repeat to end', () => {
  const s = parseOne('Row 1 (RS): *k2, p2; rep from * to end.');
  assert.equal(s.type, 'row');
  assert.equal(s.side, 'rs');
  assert.deepEqual(s.labels, { list: [1] });
  assert.deepEqual(strip(s.instructions), [
    { type: 'star', body: [{ type: 'stitch', op: 'k', count: 2, mods: [] }, { type: 'stitch', op: 'p', count: 2, mods: [] }], times: { kind: 'toEnd', leave: 0 } },
  ]);
});

test('star repeat to last N sts, then continuation', () => {
  const s = parseOne('Row 2: k1, *p2, k2; rep from * to last st, k1.');
  assert.equal(s.instructions.length, 3);
  assert.deepEqual(s.instructions[1].times, { kind: 'toEnd', leave: 1 });
});

test('star with closing star form', () => {
  const s = parseOne('Row 2: *k1, p1* to end');
  assert.equal(s.instructions[0].type, 'star');
  assert.deepEqual(s.instructions[0].times, { kind: 'toEnd', leave: 0 });
});

test('groups with counts', () => {
  const s = parseOne('Row 3: (k2, p2) 3 times, [k1, yo] twice, (k1, p1) to last 2 sts, k2');
  const t = s.instructions.map((i) => i.type);
  assert.deepEqual(t, ['group', 'group', 'group', 'stitch']);
  assert.deepEqual(s.instructions[0].times, { kind: 'times', count: 3 });
  assert.deepEqual(s.instructions[1].times, { kind: 'times', count: 2 });
  assert.deepEqual(s.instructions[2].times, { kind: 'toEnd', leave: 2 });
});

test('sized stitch counts', () => {
  const s = parseOne('Row 6: k12 (14, 16), pm, k to end.');
  assert.deepEqual(s.instructions[0].count.sizes, [12, 14, 16]);
  assert.equal(s.instructions[1].op, 'pm');
  assert.deepEqual(s.instructions[2].target, { kind: 'toEnd', leave: 0 });
  const s2 = parseOne('Row 6: k 12 [14, 16]');
  assert.deepEqual(s2.instructions[0].count.sizes, [12, 14, 16]);
  const s3 = parseOne('Row 6: k12/14/16');
  assert.deepEqual(s3.instructions[0].count.sizes, [12, 14, 16]);
});

test('stitch count trailer forms', () => {
  assert.equal(parseOne('Row 7: k2tog, k to end. (18 sts)').expectedCount, 18);
  assert.equal(parseOne('Row 7: k2tog, k to end — 18 sts').expectedCount, 18);
  assert.equal(parseOne('Row 7: k2tog, k to end. 18 sts remain.').expectedCount, 18);
  assert.deepEqual(parseOne('Row 7: k2tog, k to end. 18 (20, 22) sts').expectedCount.sizes, [18, 20, 22]);
});

test('modifiers', () => {
  const s = parseOne('Row 1: sl1 wyif, k1 tbl, sl 1 st purlwise with yarn in back, p2tog tbl');
  assert.deepEqual(s.instructions.map((i) => [i.op, i.mods]), [
    ['sl', ['wyif']], ['k', ['tbl']], ['sl', ['pwise', 'wyib']], ['p2tog', ['tbl']],
  ]);
});

test('multi-word phrases', () => {
  const s = parseOne('Row 1: place marker, yarn over, knit into front and back, sl1, k1, psso, wrap and turn');
  assert.deepEqual(s.instructions.map((i) => i.op), ['pm', 'yo', 'kfb', 'sl', 'k', 'psso', 'wt']);
});

test('bare knit/purl rows', () => {
  assert.deepEqual(parseOne('Row 2: purl.').instructions[0].target, { kind: 'toEnd', leave: 0 });
  assert.deepEqual(parseOne('Row 2: k').instructions[0].target, { kind: 'toEnd', leave: 0 });
  assert.deepEqual(parseOne('Row 2: knit all sts').instructions[0].target, { kind: 'toEnd', leave: 0 });
  assert.deepEqual(parseOne('Row 2: k across').instructions[0].target, { kind: 'toEnd', leave: 0 });
});

test('to marker targets', () => {
  const s = parseOne('Row 2: k to marker, sm, k to 2 sts before marker, k2tog, sm, (k1, p1) to marker');
  assert.deepEqual(s.instructions[0].target, { kind: 'toMarker', before: 0 });
  assert.deepEqual(s.instructions[2].target, { kind: 'toMarker', before: 2 });
  assert.deepEqual(s.instructions[5].times, { kind: 'toMarker', before: 0 });
});

test('row labels', () => {
  assert.deepEqual(parseOne('Rows 3-10: k').labels, { from: 3, to: 10 });
  assert.deepEqual(parseOne('Rows 1, 3 and 5: k').labels, { list: [1, 3, 5] });
  assert.deepEqual(parseOne('Rnd 4: k').isRound, true);
  const s = parseOne('Row 2 and all WS rows: p');
  assert.deepEqual(s.labels, { list: [2] });
  assert.equal(s.andAll, 'ws');
  assert.equal(parseOne('Next row (WS): p').labels, null);
});

test('repeat rows forms', () => {
  let s = parseOne('Repeat rows 1-2 three more times');
  assert.deepEqual(s.ref, { from: 1, to: 2 });
  assert.deepEqual(s.times, { kind: 'count', count: 3, endingWith: null });
  s = parseOne('Rows 3-10: repeat rows 1-2.');
  assert.deepEqual(s.times, { kind: 'derived' });
  assert.deepEqual(s.labels, { from: 3, to: 10 });
  s = parseOne('Rnds 2-5: as rnd 1');
  assert.deepEqual(s.ref, { list: [1] });
  s = parseOne('Rep the last 2 rows until piece measures 10 cm from cast-on edge, ending with a WS row.');
  assert.deepEqual(s.ref, { last: 2 });
  assert.deepEqual(s.times, { kind: 'measure', length: 10, unit: 'cm', endingWith: 'ws' });
  s = parseOne('Repeat rows 1 and 2 until there are 20 sts.');
  assert.deepEqual(s.times, { kind: 'stitches', count: 20 });
  s = parseOne('Work rows 1-4 twice.');
  assert.deepEqual(s.times, { kind: 'count', count: 2, endingWith: null });
  s = parseOne('Rep row 5 until piece measures 4.5"');
  assert.deepEqual(s.times, { kind: 'measure', length: 4.5, unit: 'in', endingWith: null });
});

test('plain rows', () => {
  let s = parseOne('Knit 4 rows.');
  assert.equal(s.type, 'plainRows');
  assert.equal(s.stitch, 'knit');
  assert.deepEqual(s.count, { kind: 'count', count: 4 });
  s = parseOne('Work 6 rows in stockinette stitch.');
  assert.equal(s.stitch, 'stockinette');
  s = parseOne('Work in garter st until piece measures 5 cm.');
  assert.equal(s.stitch, 'garter');
  assert.equal(s.count.kind, 'measure');
  s = parseOne('Continue in pattern until piece measures 20 cm, ending with a RS row');
  assert.equal(s.stitch, 'pattern');
  assert.equal(s.count.endingWith, 'rs');
});

test('bind off and join', () => {
  assert.equal(parseOne('Bind off loosely.').type, 'bindOff');
  assert.equal(parseOne('BO all sts in pattern').method, 'pattern');
  assert.equal(parseOne('Join in the round, being careful not to twist.').type, 'join');
  assert.equal(parseOne('Row 5: bo 3 sts, k to end').instructions[0].op, 'bo');
  assert.equal(parseOne('Row 5: bo 3 sts, k to end').instructions[0].count, 3);
});

test('sizes statement', () => {
  const r = parsePattern('Sizes: XS (S, M, L)\nCast on 10 (20, 30, 40) sts');
  assert.deepEqual(r.sizes.names, ['XS', 'S', 'M', 'L']);
  assert.equal(r.sizes.count, 4);
});

test('comments and blank lines', () => {
  const r = parsePattern('# a comment\n\nCast on 10 sts // ten\nRow 1: k\n');
  assert.equal(r.errors.length, 0);
  assert.equal(r.statements.length, 2);
});

test('errors carry locations and keep going', () => {
  const r = parsePattern('Cast on 10\nRow 1: k2, blah, k2\nRow 2: (k1\nRow 3: rep from * to end\nRow 4: k');
  assert.equal(r.errors.length, 3);
  assert.equal(r.errors[0].loc.line, 2);
  assert.match(r.errors[0].message, /don't understand the instruction "blah"/);
  assert.equal(r.errors[1].loc.line, 3);
  assert.match(r.errors[1].message, /Expected "\)"/);
  assert.equal(r.errors[2].loc.line, 4);
  assert.match(r.errors[2].message, /without a matching "\*"/);
  assert.equal(r.statements.length, 2);
});

test('unknown line', () => {
  const r = parsePattern('Make a cup of tea');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /don't understand this line/);
});

test('cable notation', () => {
  const s = parseOne('Row 3: p2, c4f, k1, cable 6 back, 2/2 RC, 2/1 LPC, LT, p2');
  const cables = s.instructions.filter((i) => i.type === 'cable');
  assert.deepEqual(cables.map((c) => [c.top, c.under, c.dir, c.purlUnder]), [
    [2, 2, 'left', false], [3, 3, 'right', false], [2, 2, 'right', false], [2, 1, 'left', true], [1, 1, 'left', false],
  ]);
  const r = parsePattern('Row 1: c3f');
  assert.match(r.errors[0].message, /even number/);
});
