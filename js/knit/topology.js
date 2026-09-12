// Checks that the knitted surface is orientable: that it has a consistent right side.
//
// The stitch graph is turned into small faces (each pair of consecutive stitches in a
// row together with the stitches below them), and an orientation is propagated from
// face to face across shared edges. A Möbius strip or Klein bottle (for example a tube
// rejoined with a half twist after a flap) has no consistent orientation, and the
// propagation reaches some face with two contradictory orientations.

/**
 * @param {object} knit result of the knitter (nodes, rows)
 * @returns {{ok: boolean, faces: number, conflict: {node: number, row: number}|null}}
 */
export function checkOrientable(knit) {
  const { nodes, rows } = knit;
  const n = nodes.length;
  // Neighbour lookup for short paths in the row below: course neighbours and wale links.
  const rowOf = (id) => rows[nodes[id].row];
  const courseNeighbours = (id) => {
    const node = nodes[id], row = rowOf(id), out = [];
    if (node.pos > 0) out.push(row.nodes[node.pos - 1]);
    if (node.pos + 1 < row.nodes.length) out.push(row.nodes[node.pos + 1]);
    if (row.isRound && row.nodes.length > 2) {
      if (node.pos === 0) out.push(row.nodes[row.nodes.length - 1]);
      if (node.pos === row.nodes.length - 1) out.push(row.nodes[0]);
    }
    return out;
  };
  const links = (id) => {
    const node = nodes[id];
    return courseNeighbours(id).concat(node.parents, node.children.filter((c) => c < n));
  };
  // Shortest path from a to b through at most `max` links (excluding the endpoints).
  const shortPath = (a, b, max) => {
    if (a === b) return [];
    const prev = new Map([[a, -1]]);
    let frontier = [a];
    for (let depth = 0; depth < max && frontier.length; depth++) {
      const next = [];
      for (const u of frontier) {
        for (const v of links(u)) {
          if (prev.has(v)) continue;
          prev.set(v, u);
          if (v === b) {
            const path = [];
            let x = prev.get(b);
            while (x !== -1 && x !== a) { path.push(x); x = prev.get(x); }
            return path.reverse();
          }
          next.push(v);
        }
      }
      frontier = next;
    }
    return null;
  };

  const faces = [];
  for (const row of rows) {
    const ids = row.nodes;
    const pairs = ids.length;
    for (let k = 0; k < pairs; k++) {
      const a = ids[k];
      const b = k + 1 < ids.length ? ids[k + 1] : (row.isRound && ids.length > 2 ? ids[0] : null);
      if (b === null) continue;
      const pa = nodes[a].parents, pb = nodes[b].parents;
      if (pa.length === 0 || pb.length === 0) continue;
      // Grafted stitches join two edges at once (parents on both): one face per side.
      const sides = pa.length > 1 && pa.length === pb.length ? pa.map((_, t) => [pa[t], pb[t]]) : [[pa[pa.length - 1], pb[0]]];
      for (const [x, y] of sides) {
        if (x === y) { faces.push([a, b, x]); continue; }
        const path = shortPath(y, x, 3);
        if (path === null) continue;
        const cycle = [a, b, y, ...path, x];
        if (new Set(cycle).size !== cycle.length) continue; // degenerate
        faces.push(cycle);
      }
    }
  }

  // Edge -> faces that use it, with the direction each traverses it.
  const edgeKey = (u, v) => (u < v ? u * n + v : v * n + u);
  const byEdge = new Map();
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const u = f[i], v = f[(i + 1) % f.length];
      const key = edgeKey(u, v);
      let list = byEdge.get(key);
      if (!list) { list = []; byEdge.set(key, list); }
      list.push({ face: fi, forward: u < v });
    }
  });

  // Propagate orientations. Edges shared by more than two faces are not manifold
  // (cables, increases) and are skipped rather than trusted.
  const orient = new Int8Array(faces.length);
  let conflict = null;
  for (let start = 0; start < faces.length && !conflict; start++) {
    if (orient[start]) continue;
    orient[start] = 1;
    const queue = [start];
    while (queue.length && !conflict) {
      const fi = queue.shift();
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) {
        const u = f[i], v = f[(i + 1) % f.length];
        const list = byEdge.get(edgeKey(u, v));
        if (list.length !== 2 || list[0].face === list[1].face) continue;
        const me = list.find((e) => e.face === fi), other = list.find((e) => e.face !== fi);
        // A consistently oriented pair traverses the shared edge in opposite directions.
        const want = (me.forward === other.forward) ? -orient[fi] : orient[fi];
        if (!orient[other.face]) { orient[other.face] = want; queue.push(other.face); }
        else if (orient[other.face] !== want) { conflict = { node: u, row: nodes[u].row }; break; }
      }
    }
  }
  return { ok: !conflict, faces: faces.length, conflict };
}
