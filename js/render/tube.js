// Turns a polyline into a smooth tube mesh with per-vertex colours.

import * as THREE from 'three';

/**
 * Catmull-Rom subdivision of a polyline.
 * @param {Float32Array} pts xyz triples
 * @param {number} start index of first point
 * @param {number} end index one past the last point
 * @param {number} sub subdivisions per segment
 * @param {Float32Array} attr per-point scalar to interpolate (e.g. yarn length)
 */
function subdivide(pts, start, end, sub, attr) {
  const n = end - start;
  const out = [];
  const outAttr = [];
  const get = (i) => { const k = Math.max(start, Math.min(end - 1, i)); return [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]]; };
  const getA = (i) => attr[Math.max(start, Math.min(end - 1, i))];
  for (let i = start; i < end - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const a1 = getA(i), a2 = getA(i + 1);
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      const z = 0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3);
      out.push(x, y, z);
      outAttr.push(a1 + (a2 - a1) * t);
    }
  }
  const last = get(end - 1);
  out.push(last[0], last[1], last[2]);
  outAttr.push(getA(end - 1));
  return { pts: out, attr: outAttr };
}

/**
 * Build a tube geometry along a polyline.
 * @param {number[]} pts xyz triples (already smoothed)
 * @param {number} radius
 * @param {number} radial radial segments
 * @param {(i:number)=>[number,number,number]} colorAt colour for sample i
 * @param {boolean} closed
 */
export function tubeGeometry(pts, radius, radial, colorAt, closed = false) {
  const n = pts.length / 3;
  const radiusAt = typeof radius === 'function' ? radius : () => radius;
  if (n < 2) return null;
  const positions = new Float32Array(n * radial * 3);
  const normals = new Float32Array(n * radial * 3);
  const colors = new Float32Array(n * radial * 3);
  const index = [];
  // Parallel-transport frames.
  let prevNormal = null;
  let tangents = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let tx = pts[3 * i1] - pts[3 * i0], ty = pts[3 * i1 + 1] - pts[3 * i0 + 1], tz = pts[3 * i1 + 2] - pts[3 * i0 + 2];
    const l = Math.hypot(tx, ty, tz) || 1;
    tangents[3 * i] = tx / l; tangents[3 * i + 1] = ty / l; tangents[3 * i + 2] = tz / l;
  }
  let nx, ny, nz;
  for (let i = 0; i < n; i++) {
    const tx = tangents[3 * i], ty = tangents[3 * i + 1], tz = tangents[3 * i + 2];
    if (prevNormal === null) {
      // Pick any vector not parallel to the tangent.
      let ax = 0, ay = 0, az = 1;
      if (Math.abs(tz) > 0.9) { ax = 1; az = 0; }
      // n = a - (a.t) t
      const d = ax * tx + ay * ty + az * tz;
      nx = ax - d * tx; ny = ay - d * ty; nz = az - d * tz;
    } else {
      const d = prevNormal[0] * tx + prevNormal[1] * ty + prevNormal[2] * tz;
      nx = prevNormal[0] - d * tx; ny = prevNormal[1] - d * ty; nz = prevNormal[2] - d * tz;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    prevNormal = [nx, ny, nz];
    // binormal = t x n
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const [cr, cg, cb] = colorAt(i);
    const rad = radiusAt(i);
    const px = pts[3 * i], py = pts[3 * i + 1], pz = pts[3 * i + 2];
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const ox = c * nx + s * bx, oy = c * ny + s * by, oz = c * nz + s * bz;
      const k = (i * radial + j) * 3;
      positions[k] = px + ox * rad; positions[k + 1] = py + oy * rad; positions[k + 2] = pz + oz * rad;
      normals[k] = ox; normals[k + 1] = oy; normals[k + 2] = oz;
      colors[k] = cr; colors[k + 1] = cg; colors[k + 2] = cb;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + (j + 1) % radial;
      const c = (i + 1) * radial + j, d = (i + 1) * radial + (j + 1) % radial;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(index);
  return geo;
}

/** End caps: small spheres at the start and end of a strand look better than open tubes. */
export function capGeometry(p, radius) {
  const g = new THREE.SphereGeometry(radius, 8, 6);
  g.translate(p[0], p[1], p[2]);
  return g;
}

/**
 * Build the yarn mesh for a yarn path.
 * @param {object} path result of YarnPathBuilder.build()
 * @param {object} opts {radius, subdivisions, radial, colorForYarn(len, nodeId) -> [r,g,b]}
 */
export function buildYarnMesh(path, opts) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  for (const strand of path.strands) {
    const { pts, attr } = subdivide(path.points, strand.start, strand.end, opts.subdivisions, path.yarn);
    // Node ids per sample: nearest control point.
    const nodeOf = (i) => path.node[Math.min(strand.end - 1, strand.start + Math.floor(i / opts.subdivisions))];
    const geo = tubeGeometry(pts, opts.radius, opts.radial, (i) => opts.colorAt(attr[i], nodeOf(i)));
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, material);
    group.add(mesh);
  }
  return group;
}

export { subdivide };
