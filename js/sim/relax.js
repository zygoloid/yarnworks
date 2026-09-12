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
    this.anyRound = knit.rows.some((r) => r.isRound);
    // Pieces (a sweater's back, front and sleeves) are laid out separately and sewn together.
    this.pieces = knit.pieces && knit.pieces.length ? knit.pieces : [{ index: 0, startNode: 0, inRound: knit.inRound, role: null, startRow: 0, endRow: knit.rows.length, edgeMarkers: [] }];
    // Stitch size relative to the main needle, per loop, from the needle it was worked on.
    this.sc = new Float32Array(this.n).fill(1);
    if (opts.needleScale) for (let i = 0; i < this.n; i++) this.sc[i] = opts.needleScale(this.nodes[i].needle) || 1;
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
    if (d === 0) return this.w * this.scaleAt(i, j);
    const a = this.nodes[i], b = this.nodes[j];
    // A link with a neutral loop (cast on, bind off) follows the real link beside it.
    if ((!this.faceSign(a) || !this.faceSign(b)) && depth < 2) {
      const ca = a.children[0], cb = b.children[0];
      if (ca !== undefined && cb !== undefined && ca < this.n && cb < this.n && this.nodes[ca].row === this.nodes[cb].row) return this.coursePlane(ca, cb, depth + 1);
      const pa = a.parents[0], pb = b.parents[0];
      if (pa !== undefined && pb !== undefined && this.nodes[pa].row === this.nodes[pb].row) return this.coursePlane(pa, pb, depth + 1);
      return this.w * this.scaleAt(i, j);
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
    return this.w * this.scaleAt(i, j) * (1 - (1 - this.pullCourse) * consistency);
  }

  /** Mean needle scale of two loops. */
  scaleAt(i, j) { return 0.5 * (this.sc[i] + this.sc[j]); }

  /** In-plane length of a wale link; the fold runs along the course (garter ridges). */
  walePlane(i, p) {
    const d = this.pull[i] - this.pull[p];
    // A cast-on loop or a bound-off chain adds about half a row, not a whole one.
    const edge = this.nodes[i].kind === 'co' || this.nodes[p].kind === 'co' || this.nodes[i].op === 'bo' || this.nodes[p].op === 'bo' ? 0.6 : 1;
    if (d === 0) return this.h * edge * this.scaleAt(i, p);
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
    return this.h * edge * this.scaleAt(i, p) * (1 - (1 - this.pullWale) * consistency);
  }

  get(i) { return [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]]; }
  set(i, x, y, z) { this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z; }

  rowOf(node) { return this.knit.rows[node.row]; }

  pieceOf(node) { return this.pieces[Math.min(node.piece || 0, this.pieces.length - 1)]; }

  buildInitial(prev) {
    const { nodes, w, h } = this;
    const rows = this.knit.rows;
    // Radius for work in the round, from each piece's cast-on count.
    const castOnOf = (pc) => (rows[pc.startRow] ? rows[pc.startRow].nodes.length : 1);
    const fresh = this.pieces.map(() => true);
    let rnd = 1234567;
    const jitter = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return (rnd / 0x7fffffff - 0.5) * 0.05 * w; };

    for (let i = 0; i < this.n; i++) {
      const node = nodes[i];
      if (prev && prev.has(i)) { const p = prev.get(i); this.set(i, p[0], p[1], p[2]); fresh[this.pieceOf(node).index] = false; continue; }
      const row = rows[node.row];
      const pc = this.pieceOf(node);
      const castOnCount = castOnOf(pc);
      const R0 = Math.max(w, castOnCount * w / (2 * Math.PI));
      let x, y, z;
      if (node.pickedUp) {
        // Picked up along a selvedge: start one row height outward from the edge loop.
        const e = this.get(node.pickedUp.edge), q = this.get(node.pickedUp.inward);
        let dx = e[0] - q[0], dy = e[1] - q[1], dz = e[2] - q[2];
        const l = Math.hypot(dx, dy, dz) || 1;
        x = e[0] + dx / l * h; y = e[1] + dy / l * h; z = e[2] + dz / l * h;
      } else if (node.parents.length > 0) {
        x = 0; y = 0; z = 0;
        for (const p of node.parents) { x += this.pos[3 * p]; y += this.pos[3 * p + 1]; z += this.pos[3 * p + 2]; }
        x /= node.parents.length; y /= node.parents.length; z /= node.parents.length;
        // One row height along the direction the work is growing: for rounds, the normal
        // of the previous round's loop, so a tube can bend (a sock's heel); otherwise up.
        const up = this.growthDir(row);
        x += up[0] * h; y += up[1] * h; z += up[2] * h;
      } else if (node.bar && (node.bar[0] !== null || node.bar[1] !== null)) {
        const ids = node.bar.filter((b) => b !== null);
        x = 0; y = 0; z = 0;
        for (const p of ids) { x += this.pos[3 * p]; y += this.pos[3 * p + 1]; z += this.pos[3 * p + 2]; }
        x /= ids.length; y /= ids.length; z /= ids.length;
        y += h;
      } else if (row.castOn || node.pos === 0 && row.index === pc.startRow) {
        // Cast-on edge.
        if (pc.inRound) {
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
    if (this.pieces.length > 1) this.placePieces(fresh);
    else if (!prev && this.knit.closedLoop) this.bendIntoLoop();
  }

  /**
   * Put each freshly laid-out piece where it goes in the finished garment, so the seams
   * only have to pull the edges together: the front and back face each other, and the
   * sleeves stick out from the armholes like a sweater laid flat.
   */
  placePieces(fresh) {
    const pos = this.pos, rows = this.knit.rows, h = this.h;
    const ranges = this.pieces.map((pc, k) => [pc.startNode, k + 1 < this.pieces.length ? this.pieces[k + 1].startNode : this.n]);
    const bbox = (k) => {
      const [s, e] = ranges[k];
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[3 * i + a]); max[a] = Math.max(max[a], pos[3 * i + a]); }
      return { min, max };
    };
    const boxes = this.pieces.map((_, k) => bbox(k));
    const apply = (k, f) => { const [s, e] = ranges[k]; for (let i = s; i < e; i++) { const r = f(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); pos[3 * i] = r[0]; pos[3 * i + 1] = r[1]; pos[3 * i + 2] = r[2]; } };
    const front = this.pieces.find((p) => p.role === 'front'), back = this.pieces.find((p) => p.role === 'back');
    const panels = this.pieces.filter((p) => p.role === 'front' || p.role === 'back');
    let W = 0, yTop = 0;
    for (const p of panels) { const b = boxes[p.index]; W = Math.max(W, b.max[0] - b.min[0]); yTop = Math.max(yTop, b.max[1]); }
    const D = W / Math.PI; // half the body's depth: front and back a body's thickness apart
    const ref = front || back;
    let armDepth = 0;
    if (ref && ref.edgeMarkers.length) armDepth = (ref.endRow - ref.edgeMarkers[ref.edgeMarkers.length - 1].row) * h;
    let sleeves = 0, others = 0;
    for (const pc of this.pieces) {
      const k = pc.index;
      if (!fresh[k] || pc.attached) continue;
      const b = boxes[k];
      const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      if (pc.role === 'front' || pc.role === 'back') {
        const sign = pc.role === 'front' ? 1 : -1;
        apply(k, (x, y, z) => [sign * (x - cx), y, sign * z + sign * D]);
      } else if (pc.role === 'sleeve' && sleeves < 2) {
        const L = b.max[1] - b.min[1], r = (b.max[2] - b.min[2]) / 2;
        const yc = yTop - (armDepth ? armDepth / 2 : r);
        const gap = 0.5 * h;
        if (sleeves === 0) apply(k, (x, y, z) => [y - b.min[1] - L - W / 2 - gap, -(x - cx) + yc, z - cz]);
        else apply(k, (x, y, z) => [-(y - b.min[1]) + L + W / 2 + gap, (x - cx) + yc, z - cz]);
        sleeves++;
      } else {
        // Anything else goes in a row to the right of the body.
        const dx = W / 2 + 3 * this.w + others;
        apply(k, (x, y, z) => [x - b.min[0] + dx, y, z]);
        others += b.max[0] - b.min[0] + 3 * this.w;
      }
    }
  }

  /**
   * A piece whose end is grafted to its cast-on edge starts out bent into a ring, with
   * its cross-section turned through a half turn along the way for a twisted join, so
   * the relaxation only has to tidy the join rather than fold the piece from straight.
   */
  bendIntoLoop() {
    const pos = this.pos, nodes = this.nodes;
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < this.n; i++) { if (nodes[i].graft) continue; yMin = Math.min(yMin, pos[3 * i + 1]); yMax = Math.max(yMax, pos[3 * i + 1]); }
    const C = yMax - yMin + this.h;
    const R = C / (2 * Math.PI);
    const twist = this.knit.closedLoop.twist;
    for (let i = 0; i < this.n; i++) {
      if (nodes[i].graft) continue;
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      const th = 2 * Math.PI * (y - yMin) / C;
      let cx = x, cz = z;
      if (twist) { const a = th / 2; cx = x * Math.cos(a) - z * Math.sin(a); cz = x * Math.sin(a) + z * Math.cos(a); }
      pos[3 * i] = cx; pos[3 * i + 1] = (R + cz) * Math.sin(th); pos[3 * i + 2] = (R + cz) * Math.cos(th);
    }
    // Graft stitches sit between their (now adjacent) parents.
    for (let i = 0; i < this.n; i++) {
      const node = nodes[i];
      if (!node.graft || !node.parents.length) continue;
      let x = 0, y = 0, z = 0;
      for (const p of node.parents) { x += pos[3 * p]; y += pos[3 * p + 1]; z += pos[3 * p + 2]; }
      const m = node.parents.length;
      pos[3 * i] = x / m; pos[3 * i + 1] = y / m; pos[3 * i + 2] = z / m;
    }
  }

  /** Outward normal of the fabric at a point (the right side faces +z when flat, outward when round). */
  normalAt(x, y, z, node) {
    if (this.pieceOf(node).inRound) { const r = Math.hypot(x, z) || 1; return [x / r, 0, z / r]; }
    return [0, 0, 1];
  }

  /**
   * Direction in which row `row` grows away from the row before it. For a round this is
   * the normal of the previous round's loop (its area vector), oriented away from the
   * round before that; for flat rows the direction between the previous rows' centres.
   */
  growthDir(row) {
    if (!this.growth) this.growth = new Map();
    if (this.growth.has(row.index)) return this.growth.get(row.index);
    const rows = this.knit.rows;
    let dir = [0, 1, 0];
    const prev = row.index > 0 ? rows[row.index - 1] : null;
    const centre = (r) => {
      let x = 0, y = 0, z = 0;
      for (const id of r.nodes) { x += this.pos[3 * id]; y += this.pos[3 * id + 1]; z += this.pos[3 * id + 2]; }
      const n = r.nodes.length || 1;
      return [x / n, y / n, z / n];
    };
    if (prev && prev.nodes.length >= 3) {
      const c = centre(prev);
      let nx = 0, ny = 0, nz = 0;
      if (prev.pickUp && prev.closed) {
        // A band picked up around an opening grows out of the opening: along the ring's
        // normal, away from the rest of the work.
        const ids = prev.nodes;
        for (let k = 0; k < ids.length; k++) {
          const a = this.get(ids[k]), b = this.get(ids[(k + 1) % ids.length]);
          const ax = a[0] - c[0], ay = a[1] - c[1], az = a[2] - c[2];
          const bx = b[0] - c[0], by = b[1] - c[1], bz = b[2] - c[2];
          nx += ay * bz - az * by; ny += az * bx - ax * bz; nz += ax * by - ay * bx;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        let gx = 0, gy = 0, gz = 0, gn = 0;
        for (let i = 0; i < prev.nodes[0]; i++) { gx += this.pos[3 * i]; gy += this.pos[3 * i + 1]; gz += this.pos[3 * i + 2]; gn++; }
        if (gn) { gx /= gn; gy /= gn; gz /= gn; }
        const away = (c[0] - gx) * nx + (c[1] - gy) * ny + (c[2] - gz) * nz;
        const sgn = away < 0 ? -1 : 1;
        dir = [sgn * nx / nl, sgn * ny / nl, sgn * nz / nl];
        this.growth.set(row.index, dir);
        return dir;
      }
      if (prev.isRound) {
        const ids = prev.nodes;
        for (let k = 0; k < ids.length; k++) {
          const a = this.get(ids[k]), b = this.get(ids[(k + 1) % ids.length]);
          const ax = a[0] - c[0], ay = a[1] - c[1], az = a[2] - c[2];
          const bx = b[0] - c[0], by = b[1] - c[1], bz = b[2] - c[2];
          nx += ay * bz - az * by; ny += az * bx - ax * bz; nz += ax * by - ay * bx;
        }
      }
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-6) {
        let area = [nx / nl, ny / nl, nz / nl];
        const prevDir = this.growthDir(prev);
        // Just after a flat section (a heel flap), the work turns a corner: grow toward
        // the stitches that were held while the flap was worked (the instep), so the foot
        // folds the right way and the fabric keeps its right side out.
        if (prev.resume) {
          const toward = this.resumeDirection(prev.resume, prevDir);
          if (toward) { this.growth.set(row.index, toward); return toward; }
        }
        const pp = row.index > 1 ? rows[row.index - 2] : null;
        const justResumed = pp && !pp.isRound;
        const agree = area[0] * prevDir[0] + area[1] * prevDir[1] + area[2] * prevDir[2];
        if (!justResumed && Math.abs(agree) > 0.3) {
          if (agree < 0) area = [-area[0], -area[1], -area[2]];
        } else {
          const pp = row.index > 1 ? rows[row.index - 2] : null;
          if (pp && pp.nodes.length) {
            const c2 = centre(pp);
            const d = (c[0] - c2[0]) * area[0] + (c[1] - c2[1]) * area[1] + (c[2] - c2[2]) * area[2];
            if (d < 0) area = [-area[0], -area[1], -area[2]];
          } else if (area[1] < 0) area = [-area[0], -area[1], -area[2]];
        }
        // Blend with the previous direction so per-round estimation errors do not compound.
        const wPrev = justResumed ? 0 : 0.5;
        const bx = wPrev * prevDir[0] + (1 - wPrev) * area[0], by = wPrev * prevDir[1] + (1 - wPrev) * area[1], bz = wPrev * prevDir[2] + (1 - wPrev) * area[2];
        const bl = Math.hypot(bx, by, bz) || 1;
        dir = [bx / bl, by / bl, bz / bl];
      } else {
        // Flat rows keep growing the way the previous row did (straight up for a flat
        // piece; along the last round's normal for a flap worked on part of a tube).
        dir = this.growthDir(prev);
      }
    }
    this.growth.set(row.index, dir);
    return dir;
  }

  /**
   * Direction from a flap to the stitches held while it was worked, with the flap's own
   * growth direction removed: where the work goes after rejoining in the round.
   */
  resumeDirection(resume, along) {
    const rows = this.knit.rows;
    let fx = 0, fy = 0, fz = 0, fn = 0;
    for (let r = resume.flapStart; r < resume.flapEnd; r++) for (const id of rows[r].nodes) { fx += this.pos[3 * id]; fy += this.pos[3 * id + 1]; fz += this.pos[3 * id + 2]; fn++; }
    let hx = 0, hy = 0, hz = 0, hn = 0;
    for (const id of resume.held) { hx += this.pos[3 * id]; hy += this.pos[3 * id + 1]; hz += this.pos[3 * id + 2]; hn++; }
    if (!fn || !hn) return null;
    let dx = hx / hn - fx / fn, dy = hy / hn - fy / fn, dz = hz / hn - fz / fn;
    const d = dx * along[0] + dy * along[1] + dz * along[2];
    dx -= along[0] * d; dy -= along[1] * d; dz -= along[2] * d;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return null;
    return [dx / l, dy / l, dz / l];
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
    if (this.pieceOf(node).inRound) {
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
          const dx = shift * w * this.sc[id];
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
    // Seams: sewn stitches sit a stitch apart, like course neighbours, with diagonals to
    // the next pair along the seam so the two edges cannot slide past each other.
    for (const seam of this.knit.seams || []) {
      const pairs = seam.pairs;
      for (let k = 0; k < pairs.length; k++) {
        const [a, b] = pairs[k];
        this.addC(a, b, w * this.scaleAt(a, b), 1.0);
        if (k + 1 < pairs.length) {
          const [a2, b2] = pairs[k + 1];
          this.addC(a, b2, diag, 0.4);
          this.addC(a2, b, diag, 0.4);
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
      if (!r.isRound || r.nodes.length < 4) return 0;
      let circ = 0;
      for (let k = 0; k < r.nodes.length; k++) circ += this.coursePlane(r.nodes[k], r.nodes[(k + 1) % r.nodes.length]);
      return Math.max(w * 0.8, circ / (2 * Math.PI));
    });
  }

  /**
   * Hold the centre of mass at `p` during global steps, or release it with null. With the
   * centre held, dragging one stitch deforms the piece instead of carrying it along: the
   * pull is balanced by an equal and opposite force shared by every stitch.
   */
  anchorCentre(p) { this.anchor = p ? p.slice() : null; }

  /** Pin a node at a position (it is put back there after every iteration), or unpin with null. */
  pin(id, p) {
    if (!this.pins) this.pins = new Map();
    if (p) this.pins.set(id, p); else this.pins.delete(id);
  }

  /**
   * Run `iters` relaxation steps. Each step freezes every constraint's current direction
   * and solves, globally, for the positions that best satisfy all of them at once (the
   * weighted connection graph as a sparse linear system, solved by preconditioned
   * conjugate gradients). A pull on one stitch is felt across the whole piece in a single
   * step, instead of creeping one stitch per iteration as Gauss-Seidel does.
   */
  relax(iters) {
    for (let it = 0; it < iters; it++) {
      this.iteration = (this.iteration || 0) + 1;
      this.globalStep();
      if (it % 2 === 0) this.smooth(0.45);
      if (this.pins) for (const [id, p] of this.pins) { this.pos[3 * id] = p[0]; this.pos[3 * id + 1] = p[1]; this.pos[3 * id + 2] = p[2]; }
    }
  }

  /**
   * Build the direct solver: the system matrix (anchor + weighted graph Laplacian of the
   * constraints) is constant, so it is reordered to a narrow band (reverse Cuthill-McKee)
   * and Cholesky-factorised once. Every step then solves it exactly, so a pull anywhere
   * is felt everywhere at once.
   */
  buildDirect() {
    const n = this.n, c = this.c, nc = c.length / 4;
    const lambda = this.lambda;
    // Adjacency with summed weights.
    const adj = Array.from({ length: n }, () => new Map());
    for (let k = 0; k < nc; k++) {
      const i = c[4 * k], j = c[4 * k + 1], w = c[4 * k + 3];
      adj[i].set(j, (adj[i].get(j) || 0) + w);
      adj[j].set(i, (adj[j].get(i) || 0) + w);
    }
    // Reverse Cuthill-McKee ordering from a peripheral node (two BFS passes).
    const bfsOrder = (start) => {
      const seen = new Uint8Array(n), order = [];
      const push = (s) => { seen[s] = 1; order.push(s); };
      push(start);
      for (let h = 0; h < order.length; h++) {
        const u = order[h];
        const nb = [...adj[u].keys()].filter((v) => !seen[v]).sort((a, b) => adj[a].size - adj[b].size);
        for (const v of nb) push(v);
      }
      for (let s = 0; s < n; s++) if (!seen[s]) { // disconnected pieces
        push(s);
        for (let h = order.length - 1; h < order.length; h++) {
          const u = order[h];
          for (const v of adj[u].keys()) if (!seen[v]) push(v);
        }
      }
      return order;
    };
    let order = bfsOrder(0);
    order = bfsOrder(order[order.length - 1]).reverse();
    const inv = new Int32Array(n);
    order.forEach((old, i) => { inv[old] = i; });
    let bw = 0;
    for (let k = 0; k < nc; k++) bw = Math.max(bw, Math.abs(inv[c[4 * k]] - inv[c[4 * k + 1]]));
    if (n * (bw + 1) > 4e7) { this.direct = null; return false; }
    const W = bw + 1;
    const L = new Float64Array(n * W); // L[r*W + (r-c)] for c in [r-bw, r]
    // Fill the permuted matrix into L, then factorise in place.
    for (let r = 0; r < n; r++) {
      const old = order[r];
      let d = lambda;
      for (const [v, w] of adj[old]) {
        d += w;
        const cIdx = inv[v];
        if (cIdx < r) L[r * W + (r - cIdx)] -= w;
      }
      L[r * W] += d;
    }
    for (let r = 0; r < n; r++) {
      const c0 = Math.max(0, r - bw);
      for (let cc = c0; cc <= r; cc++) {
        let sum = L[r * W + (r - cc)];
        const t0 = Math.max(c0, cc - bw);
        for (let t = t0; t < cc; t++) sum -= L[r * W + (r - t)] * L[cc * W + (cc - t)];
        if (cc === r) {
          if (sum <= 1e-12) { this.direct = null; return false; }
          L[r * W] = Math.sqrt(sum);
        } else {
          L[r * W + (r - cc)] = sum / L[cc * W];
        }
      }
    }
    this.direct = { L, W, bw, order, inv, y: new Float64Array(n), bp: new Float64Array(n), xp: new Float64Array(n), pinCache: new Map() };
    return true;
  }

  /** Solve A x = b (both in original node order, one component). */
  solveDirect(b, x) {
    const { L, W, bw, order, inv, y, bp } = this.direct;
    const n = this.n;
    for (let r = 0; r < n; r++) bp[r] = b[order[r]];
    for (let r = 0; r < n; r++) {
      let sum = bp[r];
      const t0 = Math.max(0, r - bw);
      for (let t = t0; t < r; t++) sum -= L[r * W + (r - t)] * y[t];
      y[r] = sum / L[r * W];
    }
    for (let r = n - 1; r >= 0; r--) {
      let sum = y[r];
      const t1 = Math.min(n - 1, r + bw);
      for (let t = r + 1; t <= t1; t++) sum -= L[t * W + (t - r)] * bp[t];
      bp[r] = sum / L[r * W];
    }
    for (let r = 0; r < n; r++) x[order[r]] = bp[r];
  }

  /** One projective-dynamics step: local projection of each constraint, then the global solve. */
  globalStep() {
    const pos = this.pos, n = this.n;
    const c = this.c, nc = c.length / 4;
    if (this.direct === undefined) { this.lambda = 0.002; this.buildDirect(); }
    if (!this.direct) return this.globalStepCG();
    if (!this.pdb) this.pdb = { bx: new Float64Array(n), by: new Float64Array(n), bz: new Float64Array(n), x: new Float64Array(n) };
    const { bx, by, bz, x } = this.pdb;
    const lambda = this.lambda;
    for (let i = 0; i < n; i++) { bx[i] = lambda * pos[3 * i]; by[i] = lambda * pos[3 * i + 1]; bz[i] = lambda * pos[3 * i + 2]; }
    for (let k = 0; k < nc; k++) {
      const i = c[4 * k], j = c[4 * k + 1], rest = c[4 * k + 2], w = c[4 * k + 3];
      let dx = pos[3 * i] - pos[3 * j], dy = pos[3 * i + 1] - pos[3 * j + 1], dz = pos[3 * i + 2] - pos[3 * j + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const t = w * rest / d; dx *= t; dy *= t; dz *= t;
      bx[i] += dx; by[i] += dy; bz[i] += dz;
      bx[j] -= dx; by[j] -= dy; bz[j] -= dz;
    }
    // Pins and the centre-of-mass anchor are rank-one (Woodbury) corrections to the fixed
    // factorisation. The anchor term is kC (u u^T) with u = (1/n, ..., 1/n): first fold it
    // into the solution and into each pin's response vector, then apply the pins.
    const kPin = 40, kC = kPin * n;
    const anchor = this.anchor;
    let wu = null, denomU = 1;
    if (anchor) {
      wu = this.direct.anchorW;
      if (!wu) { const u = new Float64Array(n).fill(1 / n); wu = new Float64Array(n); this.solveDirect(u, wu); this.direct.anchorW = wu; }
      let m = 0; for (let i = 0; i < n; i++) m += wu[i]; denomU = 1 + kC * m / n;
    }
    const foldAnchor = (v) => { let m = 0; for (let i = 0; i < n; i++) m += v[i]; const f = kC * (m / n) / denomU; for (let i = 0; i < n; i++) v[i] -= f * wu[i]; };
    const pins = this.pins ? [...this.pins.entries()] : [];
    const pinW = pins.map(([id]) => {
      let w = this.direct.pinCache.get(id);
      if (!w) { const e = new Float64Array(n); e[id] = 1; w = new Float64Array(n); this.solveDirect(e, w); this.direct.pinCache.set(id, w); }
      if (anchor) { w = Float64Array.from(w); foldAnchor(w); }
      return w;
    });
    const comps = [bx, by, bz];
    for (let comp = 0; comp < 3; comp++) {
      const b = comps[comp];
      pins.forEach(([id, p]) => { b[id] += kPin * p[comp]; });
      if (anchor) { const g = kC * anchor[comp] / n; for (let i = 0; i < n; i++) b[i] += g; }
      this.solveDirect(b, x);
      if (anchor) foldAnchor(x);
      pins.forEach(([id], pi) => {
        const w = pinW[pi];
        const f = kPin * x[id] / (1 + kPin * w[id]);
        for (let i = 0; i < n; i++) x[i] -= f * w[i];
      });
      for (let i = 0; i < n; i++) pos[3 * i + comp] = x[i];
    }
    // Collisions are handled as position corrections after the solve.
    this.collide();
  }

  /** Fallback when the band is too wide: a few conjugate-gradient sweeps (propagates slowly). */
  globalStepCG() {
    const pos = this.pos, n = this.n, N = 3 * n;
    const c = this.c, nc = c.length / 4;
    const lambda = this.lambda, kPin = 40, kC = kPin * n, anchor = this.anchor;
    if (!this.pd) this.pd = { b: new Float32Array(N), diag: new Float32Array(n), r: new Float32Array(N), z: new Float32Array(N), q: new Float32Array(N), Aq: new Float32Array(N) };
    const { b, diag, r, z, q, Aq } = this.pd;
    for (let i = 0; i < n; i++) { diag[i] = lambda; b[3 * i] = lambda * pos[3 * i]; b[3 * i + 1] = lambda * pos[3 * i + 1]; b[3 * i + 2] = lambda * pos[3 * i + 2]; }
    if (this.pins) for (const [id, p] of this.pins) { diag[id] += kPin; b[3 * id] += kPin * p[0]; b[3 * id + 1] += kPin * p[1]; b[3 * id + 2] += kPin * p[2]; }
    if (anchor) for (let i = 0; i < n; i++) { diag[i] += kC / (n * n); b[3 * i] += kC * anchor[0] / n; b[3 * i + 1] += kC * anchor[1] / n; b[3 * i + 2] += kC * anchor[2] / n; }
    for (let k = 0; k < nc; k++) {
      const i = c[4 * k], j = c[4 * k + 1], rest = c[4 * k + 2], w = c[4 * k + 3];
      let dx = pos[3 * i] - pos[3 * j], dy = pos[3 * i + 1] - pos[3 * j + 1], dz = pos[3 * i + 2] - pos[3 * j + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const t = w * rest / d; dx *= t; dy *= t; dz *= t;
      b[3 * i] += dx; b[3 * i + 1] += dy; b[3 * i + 2] += dz;
      b[3 * j] -= dx; b[3 * j + 1] -= dy; b[3 * j + 2] -= dz;
      diag[i] += w; diag[j] += w;
    }
    const pinIds = this.pins ? [...this.pins.keys()] : [];
    const applyA = (v, out) => {
      for (let i = 0; i < n; i++) { out[3 * i] = lambda * v[3 * i]; out[3 * i + 1] = lambda * v[3 * i + 1]; out[3 * i + 2] = lambda * v[3 * i + 2]; }
      for (const id of pinIds) { out[3 * id] += kPin * v[3 * id]; out[3 * id + 1] += kPin * v[3 * id + 1]; out[3 * id + 2] += kPin * v[3 * id + 2]; }
      if (anchor) {
        let mx = 0, my = 0, mz = 0;
        for (let i = 0; i < n; i++) { mx += v[3 * i]; my += v[3 * i + 1]; mz += v[3 * i + 2]; }
        const g = kC / (n * n);
        for (let i = 0; i < n; i++) { out[3 * i] += g * mx; out[3 * i + 1] += g * my; out[3 * i + 2] += g * mz; }
      }
      for (let k = 0; k < nc; k++) {
        const i = c[4 * k], j = c[4 * k + 1], w = c[4 * k + 3];
        const dx = v[3 * i] - v[3 * j], dy = v[3 * i + 1] - v[3 * j + 1], dz = v[3 * i + 2] - v[3 * j + 2];
        out[3 * i] += w * dx; out[3 * i + 1] += w * dy; out[3 * i + 2] += w * dz;
        out[3 * j] -= w * dx; out[3 * j + 1] -= w * dy; out[3 * j + 2] -= w * dz;
      }
    };
    applyA(pos, Aq);
    let rz = 0;
    for (let i = 0; i < N; i++) { r[i] = b[i] - Aq[i]; z[i] = r[i] / diag[(i / 3) | 0]; q[i] = z[i]; rz += r[i] * z[i]; }
    for (let it = 0; it < 40 && rz > 1e-12; it++) {
      applyA(q, Aq);
      let qAq = 0;
      for (let i = 0; i < N; i++) qAq += q[i] * Aq[i];
      if (qAq <= 0) break;
      const alpha = rz / qAq;
      let rzNew = 0;
      for (let i = 0; i < N; i++) { pos[i] += alpha * q[i]; r[i] -= alpha * Aq[i]; z[i] = r[i] / diag[(i / 3) | 0]; rzNew += r[i] * z[i]; }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < N; i++) q[i] = z[i] + beta * q[i];
    }
    this.collide();
  }

  /** The previous solver: Gauss-Seidel projection of one constraint at a time. Kept for comparison. */
  relaxGaussSeidel(iters) {
    const pos = this.pos;
    const c = this.c;
    const nc = c.length / 4;
    for (let it = 0; it < iters; it++) {
      this.iteration = (this.iteration || 0) + 1;
      for (let k = 0; k < nc; k++) {
        const i = c[4 * k] * 3, j = c[4 * k + 1] * 3, rest = c[4 * k + 2], stiff = c[4 * k + 3];
        const dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const f = (d - rest) / d * stiff * 0.5;
        pos[i] += dx * f; pos[i + 1] += dy * f; pos[i + 2] += dz * f;
        pos[j] -= dx * f; pos[j + 1] -= dy * f; pos[j + 2] -= dz * f;
      }
      // No inflation term: a push that keeps acting at equilibrium never lets the piece
      // settle (measured: residual motion stayed 10x higher and the sock writhed). Tubes are
      // kept open by the bending terms and the collision pass instead.
      if (it % 3 === 0) this.smooth(0.45);
      if (this.iteration % 2 === 0) this.collide();
      if (this.pins) for (const [id, p] of this.pins) { pos[3 * id] = p[0]; pos[3 * id + 1] = p[1]; pos[3 * id + 2] = p[2]; }
    }
  }

  /**
   * Keep the fabric from passing through itself: loops that are not near each other in
   * the stitch graph must stay at least most of a stitch width apart in space.
   */
  collide() {
    const pos = this.pos;
    const minD = 1.0 * this.w;
    this.forEachCollision((i, j, d) => {
      const ex = pos[3 * j] - pos[3 * i], ey = pos[3 * j + 1] - pos[3 * i + 1], ez = pos[3 * j + 2] - pos[3 * i + 2];
      const push = (minD - d) / d * 0.4;
      pos[3 * i] -= ex * push; pos[3 * i + 1] -= ey * push; pos[3 * i + 2] -= ez * push;
      pos[3 * j] += ex * push; pos[3 * j + 1] += ey * push; pos[3 * j + 2] += ez * push;
    });
  }

  /** Call cb(i, j, distance) for every pair of loops closer than a stitch width that are not fabric neighbours. */
  forEachCollision(cb) {
    const pos = this.pos, n = this.n;
    const cell = this.w;
    const minD = 1.0 * this.w;
    const minD2 = minD * minD;
    const nodes = this.nodes, rows = this.knit.rows;
    if (!this.adjacent) {
      // Pairs linked by a constraint are neighbours in the fabric and may be close:
      // a compact per-node list (up to 24 entries) of constrained partners.
      const A = 24;
      const adjList = new Int32Array(n * A).fill(-1);
      const cnt = new Uint8Array(n);
      const add = (i, j) => { if (cnt[i] < A) adjList[i * A + cnt[i]++] = j; };
      const c = this.c;
      for (let k = 0; k < c.length; k += 4) { add(c[k], c[k + 1]); add(c[k + 1], c[k]); }
      this.adjacent = adjList; this.adjA = A;
      // Open-addressing hash table from packed cell coordinates to a linked list of nodes.
      let size = 1; while (size < 2 * n) size <<= 1;
      this.hKeys = new Int32Array(size); this.hHead = new Int32Array(size); this.hNext = new Int32Array(n);
      this.hCell = new Int32Array(n);
      this.hMask = size - 1;
    }
    const adj = this.adjacent, A = this.adjA;
    const keys = this.hKeys, head = this.hHead, next = this.hNext, cellOf = this.hCell, mask = this.hMask;
    keys.fill(0); head.fill(-1);
    const pack = (x, y, z) => (((x + 512) & 1023) << 20) | (((y + 512) & 1023) << 10) | ((z + 512) & 1023);
    const hash = (k) => (Math.imul(k, 2654435761) >>> 0) & mask;
    const inv = 1 / cell;
    for (let i = 0; i < n; i++) {
      const k = pack(Math.floor(pos[3 * i] * inv), Math.floor(pos[3 * i + 1] * inv), Math.floor(pos[3 * i + 2] * inv)) | 0x40000000;
      cellOf[i] = k;
      let slot = hash(k);
      while (keys[slot] !== 0 && keys[slot] !== k) slot = (slot + 1) & mask;
      keys[slot] = k;
      next[i] = head[slot];
      head[slot] = i;
    }
    for (let i = 0; i < n; i++) {
      const k0 = cellOf[i];
      const x0 = (k0 >> 20) & 1023, y0 = (k0 >> 10) & 1023, z0 = k0 & 1023;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = ((((x0 + dx) & 1023) << 20) | (((y0 + dy) & 1023) << 10) | ((z0 + dz) & 1023)) | 0x40000000;
        let slot = hash(k);
        while (keys[slot] !== 0 && keys[slot] !== k) slot = (slot + 1) & mask;
        if (keys[slot] !== k) continue;
        for (let j = head[slot]; j >= 0; j = next[j]) {
          if (j <= i) continue;
          let linked = false;
          for (let a = i * A, e = a + A; a < e; a++) { const q = adj[a]; if (q < 0) break; if (q === j) { linked = true; break; } }
          if (linked) continue;
          // Near neighbours in the fabric grid (a few stitches or rows apart) are allowed close.
          const ni = nodes[i], nj = nodes[j];
          const dr = Math.abs(ni.row - nj.row);
          if (dr <= 2) {
            const len = rows[ni.row].nodes.length;
            let dp = Math.abs(ni.pos - nj.pos);
            if (rows[ni.row].isRound && rows[nj.row].isRound) dp = Math.min(dp, Math.abs(len - dp));
            if (dp <= 3) continue;
          }
          const ex = pos[3 * j] - pos[3 * i], ey = pos[3 * j + 1] - pos[3 * i + 1], ez = pos[3 * j + 2] - pos[3 * i + 2];
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= minD2 || d2 < 1e-12) continue;
          cb(i, j, Math.sqrt(d2));
        }
      }
    }
  }

  /**
   * Pull each node toward the average of its neighbours' mid-surface positions, but only
   * along the local normal, so the sheet resists buckling while folds are kept.
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

  /** Precompute the wide stencil (course ±3, wale ±2) used for the smoothing normal. */
  buildStencils() {
    const rows = this.knit.rows;
    const n = this.n;
    // Flat arrays: for each node, up to 3 back, 3 forward, 2 down, 2 up (-1 = none).
    this.stBack = new Int32Array(n * 3).fill(-1);
    this.stFwd = new Int32Array(n * 3).fill(-1);
    this.stDown = new Int32Array(n * 2).fill(-1);
    this.stUp = new Int32Array(n * 2).fill(-1);
    this.stRs = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      const row = rows[node.row];
      for (let k = 1; k <= 3; k++) {
        if (node.pos - k >= 0) this.stBack[3 * i + k - 1] = row.nodes[node.pos - k];
        if (node.pos + k < row.nodes.length) this.stFwd[3 * i + k - 1] = row.nodes[node.pos + k];
      }
      let cur = node;
      for (let k = 0; k < 2 && cur.parents.length; k++) { cur = this.nodes[cur.parents[0]]; this.stDown[2 * i + k] = cur.id; }
      cur = node;
      for (let k = 0; k < 2 && cur.children.length && cur.children[0] < n; k++) { cur = this.nodes[cur.children[0]]; this.stUp[2 * i + k] = cur.id; }
      this.stRs[i] = row.side === 'rs' || row.isRound ? 1 : 0;
    }
    this.nrm = new Float32Array(3);
  }

  /** Mean of the mid-surface positions (offsets removed along the current normal estimate) of a stencil group. */
  stencilMean(arr, base, count, self, nx, ny, nz, out) {
    let x = 0, y = 0, z = 0, m = 0;
    const pos = this.pos;
    for (let k = 0; k < count; k++) {
      const j = arr[base + k];
      if (j < 0) continue;
      const o = this.off[j];
      x += pos[3 * j] - nx * o; y += pos[3 * j + 1] - ny * o; z += pos[3 * j + 2] - nz * o; m++;
    }
    if (m === 0) { const o = this.off[self]; x = pos[3 * self] - nx * o; y = pos[3 * self + 1] - ny * o; z = pos[3 * self + 2] - nz * o; m = 1; }
    out[0] = x / m; out[1] = y / m; out[2] = z / m;
  }

  /** Unit normal at node i pointing toward the right side of the fabric, or null. */
  rsNormal(i) {
    if (!this.stBack) this.buildStencils();
    if ((this.stBack[3 * i] < 0 && this.stFwd[3 * i] < 0) || (this.stDown[2 * i] < 0 && this.stUp[2 * i] < 0)) return null;
    const a = this.tA || (this.tA = [0, 0, 0]), b = this.tB || (this.tB = [0, 0, 0]);
    const c = this.tC || (this.tC = [0, 0, 0]), d = this.tD || (this.tD = [0, 0, 0]);
    const rs = this.stRs[i];
    let nx = 0, ny = 0, nz = 0;
    // Two passes: the first with no normal estimate, so neighbours' offsets do not tilt the result.
    for (let pass = 0; pass < 2; pass++) {
      this.stencilMean(this.stBack, 3 * i, 3, i, nx, ny, nz, a);
      this.stencilMean(this.stFwd, 3 * i, 3, i, nx, ny, nz, b);
      this.stencilMean(this.stDown, 2 * i, 2, i, nx, ny, nz, c);
      this.stencilMean(this.stUp, 2 * i, 2, i, nx, ny, nz, d);
      const cx = b[0] - a[0], cy = b[1] - a[1], cz = b[2] - a[2];
      const wx = d[0] - c[0], wy = d[1] - c[1], wz = d[2] - c[2];
      let x, y, z;
      if (rs) { x = wy * cz - wz * cy; y = wz * cx - wx * cz; z = wx * cy - wy * cx; }
      else { x = cy * wz - cz * wy; y = cz * wx - cx * wz; z = cx * wy - cy * wx; }
      const l = Math.hypot(x, y, z);
      if (l < 1e-9) return null;
      nx = x / l; ny = y / l; nz = z / l;
    }
    const out = this.nrm;
    out[0] = nx; out[1] = ny; out[2] = nz;
    return out;
  }

  /**
   * Where the fabric of a round has turned inside out (its right side faces the round's
   * centre), push those nodes through to the outside. Zero elsewhere.
   */
  uninvert(k) {
    const pos = this.pos;
    const rows = this.knit.rows;
    const c = this.rowCentre;
    if (!c) return;
    for (const r of rows) {
      if (!r.isRound || r.nodes.length < 8) continue;
      const cx = c[3 * r.index], cy = c[3 * r.index + 1], cz = c[3 * r.index + 2];
      for (const i of r.nodes) {
        const n = this.rsNormal(i);
        if (!n) continue;
        const d = (pos[3 * i] - cx) * n[0] + (pos[3 * i + 1] - cy) * n[1] + (pos[3 * i + 2] - cz) * n[2];
        if (d >= 0) continue;
        const step = k * this.w;
        pos[3 * i] -= n[0] * step; pos[3 * i + 1] -= n[1] * step; pos[3 * i + 2] -= n[2] * step;
      }
    }
  }

  /**
   * Nudge each node of a round toward its round's target radius, measured from that
   * round's own centre and about the local tube axis, so bent tubes (a sock's heel)
   * stay open without being pulled onto a single straight axis.
   */
  inflate(k) {
    const pos = this.pos;
    const rows = this.knit.rows;
    if (!this.rowCentre) this.rowCentre = new Float32Array(rows.length * 3);
    const c = this.rowCentre;
    for (const r of rows) {
      let x = 0, y = 0, z = 0;
      for (const id of r.nodes) { x += pos[3 * id]; y += pos[3 * id + 1]; z += pos[3 * id + 2]; }
      const n = r.nodes.length || 1;
      c[3 * r.index] = x / n; c[3 * r.index + 1] = y / n; c[3 * r.index + 2] = z / n;
    }
    for (const r of rows) {
      const R = this.rowRadius[r.index];
      if (!R) continue;
      // Local axis from the neighbouring rounds' centres.
      const a = Math.max(0, r.index - 1), b = Math.min(rows.length - 1, r.index + 1);
      let ax = c[3 * b] - c[3 * a], ay = c[3 * b + 1] - c[3 * a + 1], az = c[3 * b + 2] - c[3 * a + 2];
      const al = Math.hypot(ax, ay, az);
      if (al < 1e-6) { ax = 0; ay = 1; az = 0; } else { ax /= al; ay /= al; az /= al; }
      const cx = c[3 * r.index], cy = c[3 * r.index + 1], cz = c[3 * r.index + 2];
      for (const i of r.nodes) {
        let x = pos[3 * i] - cx, y = pos[3 * i + 1] - cy, z = pos[3 * i + 2] - cz;
        const d = x * ax + y * ay + z * az;
        x -= ax * d; y -= ay * d; z -= az * d;
        const rad = Math.hypot(x, y, z) || 1e-6;
        // Pressure is one-sided: it only props a round open when it has collapsed well
        // inside its rest radius, and does nothing once the round is open. A term that
        // kept pushing rounds toward a circle never settled where rounds are not circular.
        const target = 0.8 * (R + this.off[i]);
        if (rad >= target) continue;
        const f = (target - rad) / rad * k;
        pos[3 * i] += x * f; pos[3 * i + 1] += y * f; pos[3 * i + 2] += z * f;
      }
    }
  }

  /** Recentre the piece on the origin (cheap; safe to call every frame). */
  centre() { return this.finish(); }

  /** The mean position of all stitches. */
  centroid() {
    const pos = this.pos;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.n; i++) { cx += pos[3 * i]; cy += pos[3 * i + 1]; cz += pos[3 * i + 2]; }
    const n = this.n || 1;
    return [cx / n, cy / n, cz / n];
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
  const iters = opts.iterations || Math.min(120, 30 + Math.round(Math.sqrt(knit.nodes.length)));
  r.relax(iters);
  return r.finish();
}
