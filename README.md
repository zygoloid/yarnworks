# Yarnworks

A virtual knitter that runs in the browser. Write a knitting pattern in the
usual semi-formal notation, and Yarnworks knits it: it checks the pattern
makes sense, simulates the shape of the fabric, and shows a rotatable 3D
model of the work, yarn strand by yarn strand, on the needles.

Everything runs client-side; there is no server component and no build step.

## Running it

The app uses ES modules, so it has to be served over HTTP rather than opened
as a file. Any static server will do:

```
python3 -m http.server 8000
```

then open <http://localhost:8000/>.

Tests (parser, knitter, simulation) run under Node:

```
npm test
```

## Using it

- **Pattern**: type or paste a pattern. It is re-knit as you type, and any
  problems are listed under the editor with the line they come from (click a
  message to jump to it). Errors say whether the knitter could not understand
  an instruction or the pattern itself does not work (not enough stitches, a
  repeat that does not fit, a stitch count that does not match).
- **Position**: knit along with the virtual knitter. Step by row or by stitch
  (or use the arrow keys when the editor is not focused); the readout shows
  the row, the stitch count, the next instruction, and yarn used so far.
- **Yarn & gauge**: pick a yarn weight (which fills in a typical gauge and
  needle size), or set your own gauge. Choose the size for multi-size
  patterns. Yarns can be solid or self-striping, with colours that change by
  length along the yarn; patterns that say `Change to B` get extra yarns.
- **Markers & lifelines**: add a lifeline at the current row or a stitch
  marker at the current stitch, so the model matches what is on your needles.
- **View**: drag to rotate, scroll to zoom, right-drag to pan. Needles can
  be hidden; *Flip* looks at the other side of the work.

## Notation

Structure:

```
Sizes: S (M, L)
Cast on 40 (44, 48) sts.
Join in the round.
Row 1 (RS): *k2, p2; rep from * to end.
Row 2 and all WS rows: purl.
Rows 3-10: repeat rows 1-2.
Repeat rows 1-2 until piece measures 10 cm, ending with a WS row.
Rnd 7: *k4, k2tog; rep from * to end. 50 (60, 60) sts
Knit 4 rows.
Work 6 rows in stockinette.
Change to B.
Bind off.
```

Stitches: `k`, `p`, `k2tog`, `p2tog`, `ssk`, `k3tog`, `sk2p`, `s2kp`/`cdd`,
`yo`, `kfb`, `pfb`, `m1`, `m1l`, `m1r`, `sl1` (`wyif`/`wyib`), `psso`, `tbl`,
`pm`, `sm`, `rm`, `w&t`, `turn`, `bo N`, `co N`, and multi-word forms such as
`place marker`, `yarn over`, `knit into front and back`.

Repeats: `*…; rep from * to end`, `rep from * to last 3 sts`,
`(k1, yo) 3 times`, `[k2tog] twice`, `k to end`, `p to last 2 sts`,
`k to marker`, `k to 2 sts before marker`.

Sizes: numbers can be given per size as `12 (14, 16)`, `12 [14, 16]` or
`12/14/16`.

Checks: a stitch count at the end of a row, such as `(18 sts)` or `— 18 sts`,
is verified. Lines starting with `#` or `//` are comments.

## How it works

- `js/pattern/` tokenizes and parses the pattern into an AST.
- `js/knit/` is the virtual knitter: it executes the AST, keeping track of
  the loops on each needle, and produces a stitch graph in which every loop
  knows which loops it was pulled through.
- `js/sim/` relaxes that graph with position-based constraints (course,
  wale, shear and bending terms, plus a gentle pressure for tubes) to find
  the shape of the fabric.
- `js/render/` builds the yarn path, one continuous loop shape per stitch
  in a local frame, and renders it as a tube with three.js, along with
  needles, markers and lifelines.
