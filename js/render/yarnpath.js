// Builds the yarn path (a polyline with per-point yarn-length values) from
// relaxed node positions. Each stitch contributes a loop-shaped set of
// control points expressed in a local frame: W (wale, up), C (course, the
// knitting direction), N (normal, pointing to the right side of the fabric).

const tmp = { a: [0, 0, 0] };

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len(a) { return Math.hypot(a[0], a[1], a[2]); }
function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mean(list) { const m = [0, 0, 0]; for (const p of list) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; } return list.length ? scale(m, 1 / list.length) : m; }

export class YarnPathBuilder {
  /**
   * @param {object} knit knitter result
   * @param {Float32Array} pos relaxed positions
   * @param {object} opts {stitchWidth, rowHeight, yarnRadius}
   */
  constructor(knit, pos, opts) {
    this.knit = knit;
    this.nodes = knit.nodes;
    this.rows = knit.rows;
    this.pos = pos;
    this.w = opts.stitchWidth;
    this.h = opts.rowHeight;
    this.d = opts.yarnRadius * 1.1;
    this.frames = new Array(this.nodes.length);
    this.computeFrames();
  }

  P(id) { return [this.pos[3 * id], this.pos[3 * id + 1], this.pos[3 * id + 2]]; }

  /** Where this node's head should sit: the base of the loops knit into it. */
  headTarget(node, depth = 0) {
    const kids = node.children.filter((c) => c < this.nodes.length);
    if (node.passedOver !== null && node.passedOver < this.nodes.length) {
      // A loop passed over another sits around that loop's base, to the side.
      const onto = this.nodes[node.passedOver];
      const f = this.frames[onto.id] || this.frameFor(onto, depth + 1);
      return add(this.P(onto.id), scale(f.W, -0.1 * this.h));
    }
    if (kids.length === 0 || depth > 4) return add(this.P(node.id), scale(this.upFor(node), this.h));
    const targets = kids.map((c) => {
      const k = this.nodes[c];
      if (k.kind === 'sl') return this.headTarget(k, depth + 1);
      return this.P(c);
    });
    return mean(targets);
  }

  baseTarget(node) {
    if (node.parents.length) return mean(node.parents.map((p) => this.P(p)));
    if (node.bar) { const ids = node.bar.filter((b) => b !== null); if (ids.length) return mean(ids.map((p) => this.P(p))); }
    return add(this.P(node.id), scale(this.upFor(node), -this.h));
  }

  upFor(node) {
    if (node.parents.length) {
      const d = norm(sub(this.P(node.id), mean(node.parents.map((p) => this.P(p)))));
      if (len(d) > 0.5) return d;
    }
    return [0, 1, 0];
  }

  /** Course neighbours in knitting order: [prevId, nextId] (either may be null). */
  neighbours(node) {
    const row = this.rows[node.row];
    let prev = node.pos > 0 ? row.nodes[node.pos - 1] : null;
    let next = node.pos + 1 < row.nodes.length ? row.nodes[node.pos + 1] : null;
    if (row.isRound) {
      if (prev === null && node.row > 0) { const r = this.rows[node.row - 1]; if (r.isRound && r.nodes.length) prev = r.nodes[r.nodes.length - 1]; }
      if (next === null && node.row + 1 < this.rows.length) { const r = this.rows[node.row + 1]; if (r.isRound && r.nodes.length) next = r.nodes[0]; }
    }
    return [prev, next];
  }

  frameFor(node) {
    let P = this.P(node.id);
    const head = this.headTarget(node);
    const base = this.baseTarget(node);
    let W = norm(sub(head, base));
    if (!(len(W) > 0.5)) W = [0, 1, 0];
    const [prev, next] = this.neighbours(node);
    let C;
    if (prev !== null && next !== null) C = sub(this.P(next), this.P(prev));
    else if (next !== null) C = sub(this.P(next), P);
    else if (prev !== null) C = sub(P, this.P(prev));
    else C = this.rows[node.row].side === 'rs' ? [-1, 0, 0] : [1, 0, 0];
    // Remove the W component so the frame is orthogonal.
    C = sub(C, scale(W, dot(C, W)));
    if (len(C) < 1e-6) C = cross(W, [0, 0, 1]);
    C = norm(C);
    const rs = this.rows[node.row].side === 'rs';
    const N = norm(rs ? cross(W, C) : cross(C, W));
    if (node.layer) P = add(P, scale(N, node.layer * this.d * 1.2));
    return { P, W, C, N, head, base };
  }

  computeFrames() {
    for (let i = 0; i < this.nodes.length; i++) this.frames[i] = this.frameFor(this.nodes[i]);
  }

  /**
   * Build the polyline. Returns {points: Float32Array (xyz), yarn: Float32Array (length along yarn),
   * node: Int32Array (node id per point), strands: [{start, end}] index ranges of continuous strands}.
   */
  build() {
    const pts = [];
    const yarnAt = [];
    const nodeAt = [];
    const strands = [];
    let strandStart = 0;
    const { w, h, d } = this;
    const push = (p, node, frac) => { pts.push(p[0], p[1], p[2]); yarnAt.push(node.yarnStart + node.yarnLength * frac); nodeAt.push(node.id); };

    let prevNode = null;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const f = this.frames[i];
      const { P, W, C, N } = f;
      const s = node.face === 'p' ? -1 : 1;
      const back = scale(N, -s * d);
      const front = scale(N, s * d);
      const row = this.rows[node.row];

      // Strand breaks: a change of yarn starts a new strand.
      if (prevNode && prevNode.yarn !== node.yarn) {
        strands.push({ start: strandStart, end: pts.length / 3 });
        strandStart = pts.length / 3;
        prevNode = null;
      }

      // Trough between the previous stitch and this one (course neighbours only).
      const [prevId] = this.neighbours(node);
      if (prevId !== null && prevNode && prevId === prevNode.id) {
        const pf = this.frames[prevId];
        const mid = lerp(pf.P, P, 0.5);
        const upAvg = norm(add(pf.W, W));
        const sPrev = this.nodes[prevId].face === 'p' ? -1 : 1;
        const nAvg = norm(add(pf.N, N));
        const zsum = (sPrev + s) / 2;
        const kindA = this.nodes[prevId].kind, kindB = node.kind;
        const level = (kindA === 'sl' || kindB === 'sl') ? -0.45 : -0.55;
        push(add(add(mid, scale(upAvg, level * h)), scale(nAvg, -zsum * d)), node, 0.0);
      } else if (prevNode && !row.castOn) {
        // Row turn. If the previous row ended with a wrap and turn, wrap the yarn around the
        // base of the stitch that was left unworked before climbing to this row.
        const wrappedId = this.wrapTargetAfter(prevNode);
        if (wrappedId !== null) {
          const wf = this.frames[wrappedId];
          const base = lerp(wf.P, wf.base, 0.3);
          const pf = this.frames[prevNode.id];
          const sideSign = this.nodes[wrappedId].face === 'p' ? -1 : 1;
          push(add(add(base, scale(wf.C, -0.35 * w)), scale(wf.N, -sideSign * 1.4 * d)), node, 0.0);
          push(add(add(base, scale(wf.C, 0.35 * w)), scale(wf.N, -sideSign * 1.4 * d)), node, 0.0);
          push(add(add(base, scale(wf.C, 0.35 * w)), scale(wf.N, sideSign * 1.4 * d)), node, 0.0);
          push(add(add(base, scale(wf.C, -0.35 * w)), scale(wf.N, sideSign * 1.4 * d)), node, 0.0);
          void pf;
        } else {
          // The yarn climbs the selvedge. Add a point just below this stitch's first leg.
          const pf = this.frames[prevNode.id];
          const mid = lerp(pf.P, P, 0.5);
          push(add(mid, scale(N, -s * d * 0.5)), node, 0.0);
        }
      }

      const headC = lerp(P, f.head, 0.55);
      const baseC = lerp(P, f.base, 0.4);
      switch (node.kind) {
        case 'yo': {
          push(add(add(baseC, scale(C, -0.35 * w)), back), node, 0.1);
          push(add(add(lerp(P, f.head, 0.2), scale(C, -0.25 * w)), back), node, 0.35);
          push(add(headC, back), node, 0.5);
          push(add(add(lerp(P, f.head, 0.2), scale(C, 0.25 * w)), back), node, 0.65);
          push(add(add(baseC, scale(C, 0.35 * w)), back), node, 0.9);
          break;
        }
        case 'sl': {
          // The float lies across the slipped loop; the parent's loop (drawn by the parent) is stretched.
          const lvl = add(P, scale(W, -0.45 * h));
          push(add(add(lvl, scale(C, -0.25 * w)), front), node, 0.3);
          push(add(add(lvl, scale(C, 0.25 * w)), front), node, 0.7);
          break;
        }
        case 'm1': {
          // A twisted loop: the legs cross.
          push(add(add(baseC, scale(C, 0.2 * w)), front), node, 0.1);
          push(add(add(lerp(P, f.head, -0.1), scale(C, -0.05 * w)), scale(N, s * d * 0.3)), node, 0.25);
          push(add(add(headC, scale(C, -0.3 * w)), back), node, 0.4);
          push(add(headC, back), node, 0.5);
          push(add(add(headC, scale(C, 0.3 * w)), back), node, 0.6);
          push(add(add(lerp(P, f.head, -0.1), scale(C, 0.05 * w)), scale(N, -s * d * 0.3)), node, 0.75);
          push(add(add(baseC, scale(C, -0.2 * w)), front), node, 0.9);
          break;
        }
        case 'co': {
          // Cast-on loop: a plain loop whose legs meet at the bottom edge.
          const bottom = add(P, scale(W, -0.55 * h));
          push(add(add(bottom, scale(C, -0.15 * w)), front), node, 0.1);
          push(add(add(lerp(P, f.head, 0.05), scale(C, -0.32 * w)), scale(N, s * d * 0.2)), node, 0.3);
          push(add(add(headC, scale(C, -0.25 * w)), back), node, 0.42);
          push(add(headC, back), node, 0.5);
          push(add(add(headC, scale(C, 0.25 * w)), back), node, 0.58);
          push(add(add(lerp(P, f.head, 0.05), scale(C, 0.32 * w)), scale(N, -s * d * 0.2)), node, 0.7);
          push(add(add(bottom, scale(C, 0.15 * w)), front), node, 0.9);
          break;
        }
        default: {
          // Knit or purl loop: legs converge at the base (where they emerge from the
          // parent loop) and spread towards the head, which sits behind the next row.
          const legSpread = node.parents.length > 1 ? 0.16 : 0.12;
          push(add(add(baseC, scale(C, -legSpread * w)), front), node, 0.1);
          push(add(add(lerp(P, f.head, 0.12), scale(C, -0.27 * w)), scale(N, s * d * 0.35)), node, 0.28);
          push(add(add(headC, scale(C, -0.34 * w)), back), node, 0.4);
          push(add(add(headC, scale(W, 0.1 * h)), back), node, 0.5);
          push(add(add(headC, scale(C, 0.34 * w)), back), node, 0.6);
          push(add(add(lerp(P, f.head, 0.12), scale(C, 0.27 * w)), scale(N, s * d * 0.35)), node, 0.72);
          push(add(add(baseC, scale(C, legSpread * w)), front), node, 0.9);
          break;
        }
      }
      prevNode = node;
    }
    strands.push({ start: strandStart, end: pts.length / 3 });
    return {
      points: new Float32Array(pts),
      yarn: new Float32Array(yarnAt),
      node: new Int32Array(nodeAt),
      strands: strands.filter((s) => s.end - s.start >= 2),
    };
  }

  /** If the row containing `node` ended with a wrap and turn right after it, the wrapped node's id. */
  wrapTargetAfter(node) {
    const row = this.rows[node.row];
    if (!row.short || node.pos !== row.nodes.length - 1) return null;
    // The wrapped stitch is the one that would have been worked next: find a wrapped node
    // adjacent in the row below (the parent's course neighbour beyond this stitch).
    const parent = node.parents.length ? this.nodes[node.parents[0]] : null;
    if (!parent) return null;
    const prow = this.rows[parent.row];
    const dir = prow.side === row.side ? 1 : -1; // same knitting direction as the parent row?
    const candidates = [prow.nodes[parent.pos + 1], prow.nodes[parent.pos - 1]].filter((x) => x !== undefined);
    for (const c of candidates) if (this.nodes[c].wrapped) return c;
    void dir;
    return null;
  }

  /** Centre of a node's head loop (where a needle or lifeline would pass). */
  headCentre(id) {
    const f = this.frames[id];
    return lerp(f.P, f.head, 0.55);
  }
}
