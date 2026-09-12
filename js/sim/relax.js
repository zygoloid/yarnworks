// Position-based relaxation of the stitch graph.
//
// Each node (loop) is a point. Constraints pull course neighbours to the
// stitch width, parents/children to the row height, and add diagonal and
// bending terms so the fabric behaves like a sheet rather than a net of
// hinges. Work in the round starts on a cylinder and gets a gentle outward
// pressure so tubes stay open.

export class Relaxer {
  /**
   * @param {object} knit result of the knitter (nodes, rows, inRound)
   * @param {object} opts {stitchWidth, rowHeight, prev: Map<id, [x,y,z]>}
   */
  constructor(knit, opts) {
    this.knit = knit;
    this.w = opts.stitchWidth;
    this.h = opts.rowHeight;
    this.nodes = knit.nodes;
    this.n = this.nodes.length;
    this.pos = new Float32Array(this.n * 3);
    this.inRound = knit.inRound;
    this.constraints = []; // flat arrays below
    this.buildInitial(opts.prev || null);
    this.buildConstraints();
  }

  get(i) { return [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]]; }
  set(i, x, y, z) { this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z; }

  rowOf(node) { return this.knit.rows[node.row]; }

  buildInitial(prev) {
    const { nodes, w, h } = this;
    const rows = this.knit.rows;
    // Radius for work in the round, from the cast-on count.
    const castOnCount = rows.length ? rows[0].nodes.length : 1;
    const R0 = Math.max(w, castOnCount * w / (2 * Math.PI));
    let rnd = 1234567;
    const jitter = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return (rnd / 0x7fffffff - 0.5) * 0.05 * w; };

    for (let i = 0; i < this.n; i++) {
      const node = nodes[i];
      if (prev && prev.has(i)) { const p = prev.get(i); this.set(i, p[0], p[1], p[2]); continue; }
      const row = rows[node.row];
      let x, y, z;
      if (node.parents.length > 0) {
        x = 0; y = 0; z = 0;
        for (const p of node.parents) { x += this.pos[3 * p]; y += this.pos[3 * p + 1]; z += this.pos[3 * p + 2]; }
        x /= node.parents.length; y /= node.parents.length; z /= node.parents.length;
        if (this.inRound) {
          // Move up and keep the radius.
          y += h;
        } else {
          y += h;
        }
      } else if (node.bar && (node.bar[0] !== null || node.bar[1] !== null)) {
        const ids = node.bar.filter((b) => b !== null);
        x = 0; y = 0; z = 0;
        for (const p of ids) { x += this.pos[3 * p]; y += this.pos[3 * p + 1]; z += this.pos[3 * p + 2]; }
        x /= ids.length; y /= ids.length; z /= ids.length;
        y += h;
      } else if (row.castOn || node.pos === 0 && row.index === 0) {
        // Cast-on edge.
        if (this.inRound) {
          const th = -2 * Math.PI * node.pos / Math.max(1, castOnCount);
          x = R0 * Math.sin(th); z = R0 * Math.cos(th); y = 0;
        } else {
          x = node.pos * w; y = 0; z = 0;
        }
      } else {
        // Parentless loop mid-row (yarn over, cast on): next to the previous stitch in the row.
        const prevId = node.pos > 0 ? row.nodes[node.pos - 1] : null;
        if (prevId !== null) {
          const [px, py, pz] = this.get(prevId);
          const dir = this.courseDir(prevId);
          x = px + dir[0] * w; y = py + dir[1] * w; z = pz + dir[2] * w;
        } else {
          x = 0; y = node.row * h; z = 0;
        }
      }
      this.set(i, x + jitter(), y + jitter(), z + jitter());
    }
  }

  /** Approximate knitting direction at node `id` from its row's neighbours or side. */
  courseDir(id) {
    const node = this.nodes[id];
    const row = this.rowOf(node);
    if (node.pos > 0) {
      const a = this.get(row.nodes[node.pos - 1]);
      const b = this.get(id);
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len = Math.hypot(...d) || 1;
      return d.map((v) => v / len);
    }
    if (this.inRound) {
      const p = this.get(id);
      const r = Math.hypot(p[0], p[2]) || 1;
      // Tangent for decreasing angle: d/dθ (R sinθ, R cosθ) = (cosθ, -sinθ); decreasing θ flips it.
      return [-p[2] / r, 0, p[0] / r];
    }
    return row.side === 'rs' ? [-1, 0, 0] : [1, 0, 0];
  }

  addC(i, j, rest, k) {
    if (i === j || i === null || j === null || i === undefined || j === undefined) return;
    this.constraints.push(i, j, rest, k);
  }

  buildConstraints() {
    const { nodes, w, h } = this;
    const rows = this.knit.rows;
    const diag = Math.hypot(w, h);
    for (const row of rows) {
      const ids = row.nodes;
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k];
        const node = nodes[id];
        // Course neighbours.
        if (k + 1 < ids.length) this.addC(id, ids[k + 1], w, 1.0);
        if (k + 2 < ids.length) this.addC(id, ids[k + 2], 2 * w, 0.25);
        // Wale.
        const np = node.parents.length;
        for (let pi = 0; pi < np; pi++) {
          const p = node.parents[pi];
          const parent = nodes[p];
          const nc = parent.children.length;
          const ci = parent.children.indexOf(id);
          const dx = ((ci - (nc - 1) / 2) - (pi - (np - 1) / 2) * 1) * w;
          const rest = node.kind === 'sl' ? Math.hypot(h, dx) : Math.hypot(h, dx);
          this.addC(id, p, rest, 1.0);
          // Diagonals to the parent's course neighbours.
          const prow = rows[parent.row];
          const pk = parent.pos;
          if (pk > 0) this.addC(id, prow.nodes[pk - 1], diag, 0.4);
          if (pk + 1 < prow.nodes.length) this.addC(id, prow.nodes[pk + 1], diag, 0.4);
          // Bending along the wale.
          if (parent.parents.length) this.addC(id, parent.parents[0], 2 * h, 0.3);
        }
        if (node.bar) {
          for (const b of node.bar) if (b !== null) this.addC(id, b, Math.hypot(h, w / 2), 0.8);
        }
      }
      // Rounds: the course continues into the next round.
      if (row.isRound && row.index + 1 < rows.length && ids.length) {
        const next = rows[row.index + 1];
        if (next.isRound && next.nodes.length) {
          this.addC(ids[ids.length - 1], next.nodes[0], w, 1.0);
          if (ids.length > 1) this.addC(ids[ids.length - 2], next.nodes[0], 2 * w, 0.25);
          if (next.nodes.length > 1) this.addC(ids[ids.length - 1], next.nodes[1], 2 * w, 0.25);
        }
      }
    }
    this.c = new Float32Array(this.constraints);
    this.constraints = null;
    // Target radius per row for work in the round.
    this.rowRadius = rows.map((r) => Math.max(w * 0.8, r.nodes.length * w / (2 * Math.PI)));
  }

  /** Run `iters` Gauss-Seidel iterations. */
  relax(iters) {
    const pos = this.pos;
    const c = this.c;
    const nc = c.length / 4;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < nc; k++) {
        const i = c[4 * k] * 3, j = c[4 * k + 1] * 3, rest = c[4 * k + 2], stiff = c[4 * k + 3];
        const dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const f = (d - rest) / d * stiff * 0.5;
        pos[i] += dx * f; pos[i + 1] += dy * f; pos[i + 2] += dz * f;
        pos[j] -= dx * f; pos[j + 1] -= dy * f; pos[j + 2] -= dz * f;
      }
      if (this.inRound) this.inflate(0.2);
    }
  }

  /** Nudge each node toward its row's target radius about the y axis. */
  inflate(k) {
    const pos = this.pos;
    // Axis through the mean x,z of everything.
    let cx = 0, cz = 0;
    for (let i = 0; i < this.n; i++) { cx += pos[3 * i]; cz += pos[3 * i + 2]; }
    cx /= this.n; cz /= this.n;
    for (let i = 0; i < this.n; i++) {
      const node = this.nodes[i];
      const R = this.rowRadius[node.row];
      const x = pos[3 * i] - cx, z = pos[3 * i + 2] - cz;
      const r = Math.hypot(x, z) || 1e-6;
      const f = (R - r) / r * k;
      pos[3 * i] += x * f; pos[3 * i + 2] += z * f;
    }
  }

  /** Recentre the piece on the origin and return the positions. */
  finish() {
    const pos = this.pos;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.n; i++) { cx += pos[3 * i]; cy += pos[3 * i + 1]; cz += pos[3 * i + 2]; }
    if (this.n) { cx /= this.n; cy /= this.n; cz /= this.n; }
    for (let i = 0; i < this.n; i++) { pos[3 * i] -= cx; pos[3 * i + 1] -= cy; pos[3 * i + 2] -= cz; }
    return pos;
  }
}

/** Convenience: relax a knit result fully and return positions. */
export function relaxKnit(knit, opts) {
  const r = new Relaxer(knit, opts);
  const iters = opts.iterations || Math.min(400, 80 + Math.round(Math.sqrt(knit.nodes.length) * 4));
  r.relax(iters);
  return r.finish();
}
