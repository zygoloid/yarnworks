// Built-in example patterns.

export const EXAMPLES = [
  {
    name: 'Stockinette swatch',
    text: `# A plain swatch. Try changing the row count or the gauge.
Cast on 20 sts.
Row 1 (RS): knit.
Row 2: purl.
Repeat rows 1-2 until piece measures 5 cm, ending with a WS row.
Bind off.`,
  },
  {
    name: '2x2 rib with decreases',
    text: `Cast on 24 sts.
Row 1 (RS): *k2, p2; rep from * to end.
Row 2: *k2, p2; rep from * to end.
Rows 3-8: repeat rows 1-2.
Row 9: k2tog, k to last 2 sts, ssk. (22 sts)
Row 10: purl.
Rows 11-16: repeat rows 9-10. (16 sts)
Bind off.`,
  },
  {
    name: 'k2 p1 rib',
    text: `Cast on 27 sts.
Row 1 (RS): *k2, p1; rep from * to end.
Row 2: *k1, p2; rep from * to end.
Repeat rows 1-2 until piece measures 6 cm.
Bind off in pattern.`,
  },
  {
    name: 'Seed stitch',
    text: `Cast on 21 sts.
Row 1: *k1, p1; rep from * to last st, k1.
Repeat row 1 until piece measures 5 cm.
Bind off.`,
  },
  {
    name: 'Eyelet lace',
    text: `Cast on 23 sts.
Row 1 (RS): k1, *yo, k2tog; rep from * to end.
Row 2: purl.
Row 3: k2, *yo, k2tog; rep from * to last st, k1.
Row 4: purl.
Rows 5-16: repeat rows 1-4.
Knit 2 rows.
Bind off.`,
  },
  {
    name: 'Hat in the round (3 sizes)',
    text: `Sizes: S (M, L)
Cast on 60 (66, 72) sts.
Join in the round, being careful not to twist.
Rnd 1: *k1, p1; rep from * to end.
Rnds 2-5: as rnd 1.
Rnd 6: knit.
Repeat rnd 6 until piece measures 5 cm.
# Crown
Rnd 7: *k4 (9, 4), k2tog; rep from * to end. 50 (60, 60) sts
Rnd 8: knit.
Rnd 9: *k3, k2tog; rep from * to end. 40 (48, 48) sts
Rnd 10: knit.
Rnd 11: *k2, k2tog; rep from * to end. 30 (36, 36) sts
Rnd 12: *k1, k2tog; rep from * to end. 20 (24, 24) sts
Rnd 13: *k2tog; rep from * to end. 10 (12, 12) sts
Bind off.`,
  },
  {
    name: 'Plain sock (3 sizes)',
    text: `# A plain cuff-down sock of our own: a k2p1 cuff, a slipped-stitch heel flap worked flat
# over half the stitches, a turned heel, gusset decreases, and a grafted toe, with a
# contrast colour at the cuff, heel and toe. The leg and foot are short so it knits
# quickly; lengthen them to taste.
Sizes: S (M, L)
Gauge: 32 sts and 44 rows = 10 cm

Cuff:
With CC, cast on 45 (51, 60) sts.
Join in the round, being careful not to twist.
Rnd 1: *k2, p1; rep from * to end.
Repeat rnd 1 until cuff measures 3 cm.

Leg:
Change to MC.
Next rnd: k1, [k2tog] 1 (0, 0) times, [m1] 0 (1, 0) times, k to end. 44 (52, 60) sts
Continue in stockinette until leg measures 8 cm.

Heel flap:
Next rnd: k22 (26, 30).
Change to CC.
Work the next 22 (26, 30) sts back and forth.
Row 1 (RS): k2, [sl1, k1] to end. Turn.
Row 2: sl1 wyif, p to end. Turn.
Row 3: [sl1, k1] to end. Turn.
Repeat rows 2-3 until heel flap measures 5 (6, 7) cm, ending after a purl row.

Heel turn:
Row 1: sl1, k12 (14, 16), ssk, k1, turn.
Row 2: sl1, p5, p2tog, p1, turn.
Row 3: sl1, k to 1 st before gap, ssk, k1, turn.
Row 4: sl1, p to 1 st before gap, p2tog, p1, turn.
Repeat rows 3-4 until there are 14 (16, 18) sts.

Gusset:
Change to MC.
Next rnd: k14 (16, 18), pick up and knit 11 (13, 15) sts along the edge of the heel flap, k22 (26, 30), pm, pick up and knit 11 (13, 15) sts along the other edge of the heel flap, k25 (29, 33). 58 (68, 78) sts
Rnd 1: k to marker, sm, k1, ssk, k to 3 sts before end, k2tog, k1.
Rnd 2: k.
Repeat rnds 1-2 until there are 44 (52, 60) sts.

Foot:
Continue in stockinette until foot measures 8 (9, 10) cm.

Toe:
Change to CC.
Knit 1 round.
Rnd 1: k1, ssk, k to 3 sts before marker, k2tog, k1, sm, k1, ssk, k to 3 sts before end, k2tog, k1.
Rnd 2: k.
Repeat rnds 1-2 until there are 20 (24, 28) sts.
Graft the remaining sts together.`,
  },
  {
    name: 'Cable panel',
    text: `Cast on 22 sts.
Row 1 (RS): p3, k4, p2, k8, p2, k3.
Row 2 and all WS rows: k3, p8, k2, p4, k2, p3.
Row 3: p3, c4f, p2, k8, p2, k3.
Row 5: p3, k4, p2, c8b, p2, k3.
Row 7: p3, c4f, p2, k8, p2, k3.
Rows 9-24: repeat rows 1-8 twice.
Bind off in pattern.`,
  },
  {
    name: 'Short-row wedge',
    text: `Cast on 16 sts.
Row 1 (RS): k14, w&t.
Row 2: p12, w&t.
Row 3: k10, w&t.
Row 4: p8, w&t.
Row 5: k6, w&t.
Row 6: p to end.
Row 7: knit.
Row 8: purl.
Bind off.`,
  },
  {
    name: 'Garter stripes with markers',
    text: `# Set the main yarn to self-striping in "Yarn & gauge" to see the colours change along the yarn.
Cast on 18 sts.
Row 1: k6, pm, k6, pm, k6.
Row 2: k to marker, sm, k to marker, sm, k to end.
Rows 3-20: repeat row 2.
Row 21: k to marker, m1, sm, k to marker, sm, m1, k to end. (20 sts)
Rows 22-24: k.
Bind off.`,
  },
];
