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
python3 serve.py
```

then open <http://localhost:8000/>. (`serve.py` is a plain static server that
disables browser caching; with `python3 -m http.server` a browser may keep
old modules after a reload, so force-refresh if you use that instead.)

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
- **Yarn & gauge**: pick a yarn weight (which fills in a typical gauge,
  needle size and ply count), or set your own. Metric / US switches gauge
  labels, needle sizes, and lengths. Choose the size for multi-size
  patterns. Yarns can be solid or self-striping, with colours that change by
  length along the yarn; patterns that say `Change to B` get extra yarns.
- **Markers & lifelines**: add a lifeline at the current row or a stitch
  marker at the current stitch, so the model matches what is on your needles.
- **View**: drag to rotate, scroll to zoom, right-drag to pan. Needles can
  be hidden; *Flip* looks at the other side of the work, *Turn upside down*
  shows a cuff-down sock cuff-up. The shape relaxes in front of you; with
  *Move stitches* on, drag a stitch to pull the fabric into a different
  shape and it settles around your hand. *Reset shape* relaxes from scratch.

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

Cables: `c4f`, `c6b`, `cable 4 front`, `2/2 RC`, `2/2 LC`, `2/1 RPC`,
`2/1 LPC`, `LT`, `RT`.

Garment construction (see the sock example): section headings such as
`Heel flap:` with measurements relative to the section (`until heel flap
measures 5 cm`); `Work the next 28 sts back and forth` to work a flap on
part of the stitches while the rest are held; `k to 1 st before gap` when
turning a heel; `pick up and knit 14 sts along the edge of the heel flap`
(the knitter tracks which edge the yarn is at: after a wrong-side row, work
back across the flap's stitches before picking up);
a round that works past its end moves the beginning of the round; `Graft
the remaining sts together` for a Kitchener-stitched toe; `Graft the last
row to the cast-on edge` closes a strip into a ring or a tube into a torus,
and `... with a half twist` (or `inside out`) makes a Möbius strip or a
Klein bottle instead, which the knitter duly warns about. `Gauge: 40 sts
and 56 rows = 10 cm` in a pattern sets the gauge. Lines beginning with
`Note:` are ignored.

Repeats: `*…; rep from * to end`, `rep from * to last 3 sts`,
`(k1, yo) 3 times`, `[k2tog] twice`, `k to end`, `p to last 2 sts`,
`k to marker`, `k to 2 sts before marker`.

Sizes: numbers can be given per size as `12 (14, 16)`, `12 [14, 16]` or
`12/14/16`.

Checks: a stitch count at the end of a row, such as `(18 sts)` or `— 18 sts`,
is verified, and the knitter warns if the work twists on itself so that
the fabric has no consistent right side (a Möbius strip or Klein bottle,
which a wrongly joined flap or gusset can produce). Lines starting with `#` or `//` are comments.

## Development

`tools/shot.mjs` loads the app in headless Chrome over the DevTools
protocol, prints console output, optionally runs a script in the page, and
saves a screenshot. It is handy for checking rendering changes:

```
node tools/shot.mjs http://localhost:8000/ shot.png --eval "yarnworks.scene.fit(true)"
```

The page exposes `window.yarnworks` (scene, state, knit results, positions,
`setStop`) for this kind of scripting.

## How it works

- `js/pattern/` tokenizes and parses the pattern into an AST.
- `js/knit/` is the virtual knitter: it executes the AST, keeping track of
  the loops on each needle, and produces a stitch graph in which every loop
  knows which loops it was pulled through.
- `js/sim/` relaxes that graph with position-based constraints (course,
  wale, shear and bending terms, plus a gentle pressure for tubes) to find
  the shape of the fabric. Knit and purl faces sit on opposite sides of the
  fabric's mid-surface; where a face change runs along a line the fabric
  folds and contracts there, which is what makes rib corrugate and narrow,
  garter form ridges with compressed rows, and seed stitch stay flat. A
  collision pass keeps the fabric from passing through itself. The initial
  settle uses cheap Gauss-Seidel sweeps; dragging uses a global solve
  (projective dynamics with a banded Cholesky factorisation of the
  constraint graph, reordered to a narrow band), so a pull on one stitch is
  felt across the whole piece in a single step.
- `js/render/` builds the yarn path, one continuous loop shape per stitch
  in a local frame, and renders it with three.js along with needles,
  markers and lifelines. The yarn itself is not a polygon mesh: each short
  segment of the smoothed path is drawn as one camera-facing quad, and a
  fragment shader intersects the view ray with the exact cylinder for that
  segment (mitred against its neighbours), writing the true depth, normal,
  ply twist and fibre texture per pixel. That keeps the yarn perfectly round
  at any zoom with two triangles per segment.
