// Turns a polyline into a smooth tube mesh with per-vertex colours.

import * as THREE from 'three';
import { buildCapsuleMesh } from './capsules.js';

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
 * Round off tight corners in a sampled polyline with a few passes of [1,2,1]/4
 * filtering (end points fixed), so bends stay wider than the tube radius and the
 * tube's cross-sections do not fold through each other.
 */
export function smoothPolyline(pts, attr, passes) {
  const n = pts.length / 3;
  if (n < 3) return { pts, attr };
  let a = Float32Array.from(pts), b = new Float32Array(pts.length);
  for (let p = 0; p < passes; p++) {
    b.set(a);
    for (let i = 1; i < n - 1; i++) {
      for (let k = 0; k < 3; k++) b[3 * i + k] = 0.25 * a[3 * i - 3 + k] + 0.5 * a[3 * i + k] + 0.25 * a[3 * i + 3 + k];
    }
    [a, b] = [b, a];
  }
  return { pts: a, attr };
}

/**
 * Build a tube geometry along a polyline.
 * @param {number[]} pts xyz triples (already smoothed)
 * @param {number} radius
 * @param {number} radial radial segments
 * @param {(i:number)=>[number,number,number]} colorAt colour for sample i
 * @param {boolean} closed
 */
export function tubeGeometry(pts, radius, radial, colorAt, closed = false, twist = null) {
  const n = pts.length / 3;
  const radiusAt = typeof radius === 'function' ? radius : () => radius;
  // Arc length per sample, for the ply twist.
  let arc = null;
  if (twist) {
    arc = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      arc[i] = arc[i - 1] + Math.hypot(pts[3 * i] - pts[3 * i - 3], pts[3 * i + 1] - pts[3 * i - 2], pts[3 * i + 2] - pts[3 * i - 1]);
    }
  }
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
      let r = rad;
      let mx = ox, my = oy, mz = oz;
      if (twist) {
        // Plies: the radius bulges `plies` times around the circumference, spiralling along the strand.
        const phase = twist.plies * th - (2 * Math.PI * arc[i]) / twist.pitch;
        const bump = twist.amount * Math.cos(phase);
        r = rad * (1 + bump);
        // Tilt the normal toward the bulges: tangential component from d(radius)/d(theta).
        const tx = -s * nx + c * bx, ty = -s * ny + c * by, tz = -s * nz + c * bz;
        const g = twist.amount * twist.plies * Math.sin(phase);
        mx = ox + g * tx; my = oy + g * ty; mz = oz + g * tz;
        const ml = Math.hypot(mx, my, mz) || 1;
        mx /= ml; my /= ml; mz /= ml;
      }
      positions[k] = px + ox * r; positions[k + 1] = py + oy * r; positions[k + 2] = pz + oz * r;
      normals[k] = mx; normals[k + 1] = my; normals[k + 2] = mz;
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

/**
 * Build the yarn for a yarn path as ray-cast capsules (see capsules.js).
 * @param {object} path result of YarnPathBuilder.build()
 * @param {object} opts {radius, subdivisions, colorAt(len, nodeId) -> [r,g,b]}
 */
export function buildYarnMesh(path, opts) {
  const strands = [];
  for (const strand of path.strands) {
    const sub = subdivide(path.points, strand.start, strand.end, opts.subdivisions, path.yarn);
    const { pts, attr } = smoothPolyline(sub.pts, sub.attr, opts.subdivisions);
    const n = pts.length / 3;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const nodeId = path.node[Math.min(strand.end - 1, strand.start + Math.floor(i / opts.subdivisions))];
      const c = opts.colorAt(attr[i], nodeId);
      colors[3 * i] = c[0]; colors[3 * i + 1] = c[1]; colors[3 * i + 2] = c[2];
    }
    strands.push({ pts, colors });
  }
  const group = new THREE.Group();
  const mesh = buildCapsuleMesh(strands, { radius: opts.radius, plies: 3, plyAmount: 0.12, plyPitch: opts.radius * 7 });
  group.add(mesh);
  group.userData.yarnMaterial = mesh.material;
  return group;
}

export { subdivide };
