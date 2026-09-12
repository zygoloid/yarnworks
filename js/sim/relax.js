// Position-based relaxation of the stitch graph.
//
// Each node (loop) is a point. Constraints pull course neighbours to the
// stitch width, parents/children to the row height, and add diagonal and
// bending terms so the fabric behaves like a sheet rather than a net of
// hinges. Knit and purl faces sit on opposite sides of the fabric's
// mid-surface, and where a face change runs along a line the fabric folds
// there and contracts (rib across the course, garter along the wale).
// Work in the round starts on a cylinder and gets a gentle outward pressure
// so tubes stay open.

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
    // Knit and purl faces sit on opposite sides of the fabric's mid-surface. Each loop
    // gets a preferred offset along the surface normal (toward the right side for a
    // knit face, away for a purl face); links that cross a face change fold the fabric
    // there and pull the columns or rows together, which is what makes rib and garter
    // corrugate and contract.
    const r = opts.yarnRadius || 0.21 * this.w;
    this.offsetAmp = 1.4 * r;
    this.pullCourse = 0.6;  // in-plane rest length of a course link across a face change (rib)
    this.pullWale = 0.72;   // the same along the wale (garter)
    this.off = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) this.off[i] = this.faceSign(this.nodes[i]) * this.offsetAmp;
    // Neutral loops (cast on, bind off, yarn overs) follow the face structure of the
    // loops they connect to, so edges contract with the fabric.
    this.pull = new Int8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const node = this.nodes[i];
      let f = this.faceSign(node);
      if (!f) for (const c of node.children) { if (c < this.n && (f = this.faceSign(this.nodes[c]))) break; }
      if (!f) for (const p of node.parents) { if ((f = this.faceSign(this.nodes[p]))) break; }
      this.pull[i] = f;
    }
    this.buildInitial(opts.prev || null);
    this.buildConstraints();
  }

  /** +1 for a knit face (as seen from the right side), -1 for purl, 0 for neutral loops. */
  faceSign(node) {
    if (node.kind !== 'k' && node.kind !== 'p') return 0;
    if (node.op === 'bo' || node.chain) return 0;
    return node.face === 'p' ? -1 : 1;
  }

  /** Rest length of a link with in-plane length `plane` between nodes i and j, including their offsets. */
  restWith(i, j, plane) {
    const d = this.off[i] - this.off[j];
    return Math.hypot(plane, d);
  }

  /** In-plane length of a course link: shorter across a face change. */
  /**
   * In-plane length of a course link. A face change pulls the columns together only
   * when the same change runs up the wale (a fold line, as in rib); where faces also
   * alternate between rows (seed stitch) there is nothing to fold along.
   */
  coursePlane(i, j, depth = 0) {
    const d = this.pull[i] - this.pull[j];
    if (d === 0) return this.w;
    const a = this.nodes[i], b = this.nodes[j];
    // A link with a neutral loop (cast on, bind off) follows the real link beside it.
    if ((!this.faceSign(a) || !this.faceSign(b)) && depth < 2) {
      const ca = a.children[0], cb = b.children[0];
      if (ca !== undefined && cb !== undefined && ca < this.n && cb < this.n && this.nodes[ca].row === this.nodes[cb].row) return this.coursePlane(ca, cb, depth + 1);
      const pa = a.parents[0], pb = b.parents[0];
      if (pa !== undefined && pb !== undefined && this.nodes[pa].row === this.nodes[pb].row) return this.coursePlane(pa, pb, depth + 1);
      return this.w;
    }
    let same = 0, total = 0;
    const check = (x, y) => {
      if (x === undefined || y === undefined || x === null || y === null) return;
      const fx = this.faceSign(this.nodes[x]), fy = this.faceSign(this.nodes[y]);
      if (!fx || !fy) return;
      total++;
      if (Math.sign(fx - fy) === Math.sign(d)) same++;
    };
    check(a.parents[0], b.parents[0]);
    check(a.children[0] < this.n ? a.children[0] : undefined, b.children[0] < this.n ? b.children[0] : undefined);
    const consistency = total ? same / total : 0.5;
    return this.w * (1 - (1 - this.pullCourse) * consistency);
  }

  /** In-plane length of a wale link; the fold runs along the course (garter ridges). */
  walePlane(i, p) {
    const d = this.pull[i] - this.pull[p];
    if (d === 0) return this.h;
    const a = this.nodes[i], b = this.nodes[p];
    const ra = this.knit.rows[a.row], rb = this.knit.rows[b.row];
    let same = 0, total = 0;
    const check = (x, y) => {
      if (x === undefined || y === undefined) return;
      const fx = this.faceSign(this.nodes[x]), fy = this.faceSign(this.nodes[y]);
      if (!fx || !fy) return;
      total++;
      if (Math.sign(fx - fy) === Math.sign(d)) same++;
    };
    // The neighbouring column: next stitch in this row against the parent's neighbour on the matching side.
    const sameDir = ra.isRound || ra.side === rb.side;
    check(ra.nodes[a.pos + 1], rb.nodes[b.pos + (sameDir ? 1 : -1)]);
    check(ra.nodes[a.pos - 1], rb.nodes[b.pos - (sameDir ? 1 : -1)]);
    const consistency = total ? same / total : 0.5;
    return this.h * (1 - (1 - this.pullWale) * consistency);
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
      if (node.cableShift) {
        const dir = this.courseDir(node.pos > 0 ? row.nodes[node.pos - 1] : i);
        x += dir[0] * node.cableShift * w; y += dir[1] * node.cableShift * w; z += dir[2] * node.cableShift * w;
      }
      // Offsets are relative to the fabric's mid-surface; the reference nodes already
      // carry their own offsets, so apply only the difference (plus any cable layer).
      let refOff = 0;
      if (node.parents.length) { for (const p of node.parents) refOff += this.off[p]; refOff /= node.parents.length; }
      else if (node.bar && node.bar.some((b) => b !== null)) { const ids = node.bar.filter((b) => b !== null); for (const p of ids) refOff += this.off[p]; refOff /= ids.length; }
      else if (!row.castOn && node.pos > 0) refOff = this.off[row.nodes[node.pos - 1]];
      const o = node.layer * this.h * 0.4 + (this.off[i] - refOff);
      if (o !== 0) {
        const nrm = this.normalAt(x, y, z, node);
        x += nrm[0] * o; y += nrm[1] * o; z += nrm[2] * o;
      }
      this.set(i, x + jitter(), y + jitter(), z + jitter());
    }
  }

  /** Outward normal of the fabric at a point (the right side faces +z when flat, outward when round). */
  normalAt(x, y, z, node) {
    if (this.inRound) { const r = Math.hypot(x, z) || 1; return [x / r, 0, z / r]; }
    return [0, 0, 1];
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
        if (k + 1 < ids.length) this.addC(id, ids[k + 1], this.restWith(id, ids[k + 1], this.coursePlane(id, ids[k + 1])), 1.0);
        if (k + 2 < ids.length) {
          const mid = ids[k + 1], far = ids[k + 2];
          this.addC(id, far, this.restWith(id, far, this.coursePlane(id, mid) + this.coursePlane(mid, far)), 0.25);
        }
        // Wale.
        const np = node.parents.length;
        for (let pi = 0; pi < np; pi++) {
          const p = node.parents[pi];
          const parent = nodes[p];
          const nc = parent.children.length;
          const ci = parent.children.indexOf(id);
          // Horizontal offset between this stitch and its parent, in stitch widths:
          // from increases/decreases, plus any cable crossing.
          const shift = (ci - (nc - 1) / 2) - (pi - (np - 1) / 2) + (node.cableShift || 0);
          const dx = shift * w;
          const hp = this.walePlane(id, p);
          this.addC(id, p, this.restWith(id, p, Math.hypot(hp, dx)), 1.0);
          // Diagonals to the parent's course neighbours (which are one column further along).
          const prow = rows[parent.row];
          const pk = parent.pos;
          const sameDir = row.isRound || prow.side === row.side ? 1 : -1; // parent row worked in the same direction?
          if (pk > 0) { const q = prow.nodes[pk - 1]; this.addC(id, q, this.restWith(id, q, Math.hypot(hp, dx + sameDir * this.coursePlane(p, q))), 0.4); }
          if (pk + 1 < prow.nodes.length) { const q = prow.nodes[pk + 1]; this.addC(id, q, this.restWith(id, q, Math.hypot(hp, dx - sameDir * this.coursePlane(p, q))), 0.4); }
          // Bending along the wale.
          if (parent.parents.length) { const g = parent.parents[0]; this.addC(id, g, this.restWith(id, g, Math.hypot(hp + this.walePlane(p, g), dx)), 0.3); }
        }
        if (node.bar) {
          for (const b of node.bar) if (b !== null) this.addC(id, b, Math.hypot(h, w / 2), 0.8);
        }
      }
      // Rounds: the course continues into the next round.
      if (row.isRound && row.index + 1 < rows.length && ids.length) {
        const next = rows[row.index + 1];
        if (next.isRound && next.nodes.length) {
          const a = ids[ids.length - 1], b = next.nodes[0];
          this.addC(a, b, this.restWith(a, b, this.coursePlane(a, b)), 1.0);
          if (ids.length > 1) { const a2 = ids[ids.length - 2]; this.addC(a2, b, this.restWith(a2, b, this.coursePlane(a2, a) + this.coursePlane(a, b)), 0.25); }
          if (next.nodes.length > 1) { const b2 = next.nodes[1]; this.addC(a, b2, this.restWith(a, b2, this.coursePlane(a, b) + this.coursePlane(b, b2)), 0.25); }
        }
      }
    }
    this.c = new Float32Array(this.constraints);
    this.constraints = null;
    // Neighbour lists for the smoothing term: course prev/next, parents, children.
    this.nbr = new Array(this.n);
    for (const row of rows) {
      for (let k = 0; k < row.nodes.length; k++) {
        const id = row.nodes[k];
        const node = nodes[id];
        const list = [];
        if (k > 0) list.push(row.nodes[k - 1]);
        if (k + 1 < row.nodes.length) list.push(row.nodes[k + 1]);
        for (const p of node.parents) list.push(p);
        for (const c of node.children) if (c < this.n) list.push(c);
        this.nbr[id] = list;
      }
    }
    // Target radius per row for work in the round, from the row's contracted circumference.
    this.rowRadius = rows.map((r) => {
      let circ = 0;
      for (let k = 0; k < r.nodes.length; k++) circ += this.coursePlane(r.nodes[k], r.nodes[(k + 1) % r.nodes.length]);
      return Math.max(w * 0.8, circ / (2 * Math.PI));
    });
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
      if (it % 2 === 0) this.smooth(0.35);
    }
  }

  /**
   * Pull each node toward the average of its neighbours, but only along the local
   * normal, so the sheet resists buckling while keeping its in-plane structure.
   */
  smooth(k) {
    const pos = this.pos;
    const out = this.scratch || (this.scratch = new Float32Array(this.n * 3));
    out.set(pos);
    for (let i = 0; i < this.n; i++) {
      const list = this.nbr[i];
      if (!list || list.length < 3) continue;
      if (this.nodes[i].layer) continue;
      const nrm = this.rsNormal(i);
      if (!nrm) continue;
      const [nx, ny, nz] = nrm;
      // Average of the neighbours' mid-surface positions (their positions minus their offsets).
      let ax = 0, ay = 0, az = 0;
      for (const j of list) {
        const oj = this.off[j];
        ax += pos[3 * j] - nx * oj; ay += pos[3 * j + 1] - ny * oj; az += pos[3 * j + 2] - nz * oj;
      }
      ax /= list.length; ay /= list.length; az /= list.length;
      const oi = this.off[i];
      const dx = ax + nx * oi - pos[3 * i], dy = ay + ny * oi - pos[3 * i + 1], dz = az + nz * oi - pos[3 * i + 2];
      const d = (dx * nx + dy * ny + dz * nz) * k;
      out[3 * i] += nx * d; out[3 * i + 1] += ny * d; out[3 * i + 2] += nz * d;
    }
    pos.set(out);
  }

  /** Unit normal at node i pointing toward the right side of the fabric, or null. */
  rsNormal(i) {
    const pos = this.pos;
    const node = this.nodes[i];
    const row = this.knit.rows[node.row];
    // A wide stencil (up to three stitches along the course, two rows along the wale)
    // so the zigzag of a rib or garter fold averages out of the estimate.
    const back = [], fwd = [], down = [], up = [];
    for (let k = 1; k <= 3; k++) {
      if (node.pos - k >= 0) back.push(row.nodes[node.pos - k]);
      if (node.pos + k < row.nodes.length) fwd.push(row.nodes[node.pos + k]);
    }
    let cur = node;
    for (let k = 0; k < 2 && cur.parents.length; k++) { cur = this.nodes[cur.parents[0]]; down.push(cur.id); }
    cur = node;
    for (let k = 0; k < 2 && cur.children.length && cur.children[0] < this.n; k++) { cur = this.nodes[cur.children[0]]; up.push(cur.id); }
    if ((back.length === 0 && fwd.length === 0) || (down.length === 0 && up.length === 0)) return null;
    if (back.length === 0) back.push(i);
    if (fwd.length === 0) fwd.push(i);
    if (down.length === 0) down.push(i);
    if (up.length === 0) up.push(i);
    const rs = row.side === 'rs' || row.isRound;
    // Positions with the face offsets removed along a normal estimate; two passes, the
    // first with no estimate, so neighbours' offsets do not tilt the result.
    let nx = 0, ny = 0, nz = 0;
    const mean = (list) => {
      let x = 0, y = 0, z = 0;
      for (const j of list) { const o = this.off[j]; x += pos[3 * j] - nx * o; y += pos[3 * j + 1] - ny * o; z += pos[3 * j + 2] - nz * o; }
      return [x / list.length, y / list.length, z / list.length];
    };
    for (let pass = 0; pass < 2; pass++) {
      const a = mean(back), b = mean(fwd), c = mean(down), d = mean(up);
      const cx = b[0] - a[0], cy = b[1] - a[1], cz = b[2] - a[2];
      const wx = d[0] - c[0], wy = d[1] - c[1], wz = d[2] - c[2];
      let x, y, z;
      if (rs) { x = wy * cz - wz * cy; y = wz * cx - wx * cz; z = wx * cy - wy * cx; }
      else { x = cy * wz - cz * wy; y = cz * wx - cx * wz; z = cx * wy - cy * wx; }
      const l = Math.hypot(x, y, z);
      if (l < 1e-9) return null;
      nx = x / l; ny = y / l; nz = z / l;
    }
    return [nx, ny, nz];
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
      const R = this.rowRadius[node.row] + this.off[i];
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
  const iters = opts.iterations || Math.min(500, 100 + Math.round(Math.sqrt(knit.nodes.length) * 5));
  r.relax(iters);
  return r.finish();
}
