// Ray-cast yarn: each short segment of the yarn path is drawn as a single
// camera-facing quad, and the fragment shader intersects the view ray with
// the exact capsule (a cylinder with spherical ends) for that segment. The
// shader writes the true depth and normal, so the yarn is perfectly round
// at any zoom, joins between segments are seamless, and the ply twist is a
// per-pixel surface detail rather than geometry.

import * as THREE from 'three';

const VERT = /* glsl */`
in vec3 pa;      // segment start (object space)
in vec3 pb;      // segment end
in vec3 ca;      // colour at start (linear)
in vec3 cb;      // colour at end
in vec2 sab;     // arc length along the strand at start / end
in vec3 na;      // reference normal at the start (parallel transported), for the ply phase
in vec3 nb;      // reference normal at the end
in vec3 da;      // bisector plane normal at the start (average direction with the previous segment)
in vec3 db;      // bisector plane normal at the end

uniform float radius;

out vec3 vWorld;
flat out vec3 fA;
flat out vec3 fB;
flat out vec3 fCa;
flat out vec3 fCb;
flat out vec2 fS;
flat out vec3 fN;
flat out vec3 fNb;
flat out vec3 fDa;
flat out vec3 fDb;

void main() {
  vec3 a = (modelMatrix * vec4(pa, 1.0)).xyz;
  vec3 b = (modelMatrix * vec4(pb, 1.0)).xyz;
  vec3 d = b - a;
  float len = length(d);
  vec3 dn = len > 1e-6 ? d / len : vec3(0.0, 1.0, 0.0);
  vec3 mid = 0.5 * (a + b);
  vec3 toCam = cameraPosition - mid;
  float dist = length(toCam);
  vec3 tc = toCam / max(dist, 1e-6);
  // Billboard axes in the screen plane: u across the segment, v along its projection.
  vec3 u = cross(dn, tc);
  float ul = length(u);
  if (ul < 1e-4) { u = cross(tc, abs(tc.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)); ul = length(u); }
  u /= ul;
  vec3 v = normalize(cross(tc, u));
  float along = abs(dot(dn, tc));           // how much the segment points at the camera
  float halfProj = 0.5 * len * sqrt(max(0.0, 1.0 - along * along));
  // Margin for the mitred ends and the perspective silhouette.
  float R = radius * (1.7 + 2.0 * radius / max(dist, radius));
  // Place the quad at the depth of the nearest point of the cylinder, so that its
  // projection covers everything behind it.
  vec3 centre = mid + tc * (radius * 1.1 + 0.5 * len * along);
  vec3 p = centre + v * (position.x * (halfProj + R)) + u * (position.y * R);
  vWorld = p;
  fA = a; fB = b; fCa = ca; fCb = cb; fS = sab;
  fN = normalize(mat3(modelMatrix) * na);
  fNb = normalize(mat3(modelMatrix) * nb);
  fDa = normalize(mat3(modelMatrix) * da);
  fDb = normalize(mat3(modelMatrix) * db);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

in vec3 vWorld;
flat in vec3 fA;
flat in vec3 fB;
flat in vec3 fCa;
flat in vec3 fCb;
flat in vec2 fS;
flat in vec3 fN;
flat in vec3 fNb;
flat in vec3 fDa;
flat in vec3 fDb;

uniform mat4 projectionMatrix; // same program uniform as the vertex stage
uniform float radius;          // outer radius of the yarn
uniform float viewportHeight;
uniform float aaRim;           // 1 when the framebuffer is multisampled (alpha-to-coverage works), else 0
uniform float plies;
uniform float plyPitch;        // arc length of one full twist
uniform float fibreBump;
uniform vec3 hemiSky;
uniform vec3 hemiGround;
uniform vec3 lightDir[4];
uniform vec3 lightColor[4];

out vec4 outColor;

vec3 toSRGB(vec3 c) {
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Hash and value noise that stay well behaved for large coordinates.
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Two octaves of value noise, the second rotated so the grid does not show.
float fibreNoise(vec2 p) {
  vec2 q = vec2(p.x * 0.83 - p.y * 0.55, p.x * 0.55 + p.y * 0.83) * 2.3 + 17.0;
  return vnoise(p) * 0.6 + vnoise(q) * 0.4;
}

// Segment geometry, set up once in main.
vec3 gA, gDn;
float gLen, gPlyR, gRho;

// Reference frame (N, B) around the axis at axial position z, blended between the
// transported frames at the two ends so it turns continuously along the curve.
void frameAt(float z, out vec3 N, out vec3 B) {
  float s = clamp(z / max(gLen, 1e-6), 0.0, 1.0);
  vec3 n = mix(fN, fNb, s);
  n -= gDn * dot(n, gDn);
  if (dot(n, n) < 1e-8) n = cross(gDn, abs(gDn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  N = normalize(n);
  B = cross(gDn, N);
}

// Is a point on this segment's stretch of the yarn? Each segment owns the slab between
// the planes perpendicular to its axis at its ends. On the outer side of a bend those
// slabs leave a wedge that belongs to no segment, so a point just past an end plane is
// also accepted when it lies beyond the neighbouring segment's own end plane.
bool inSlab(vec3 p) {
  float z = dot(p - gA, gDn);
  if (z >= 0.0 && z <= gLen) return true;
  if (z < 0.0) {
    if (z < -radius) return false;
    vec3 dPrev = 2.0 * dot(fDa, gDn) * fDa - gDn;   // previous segment's direction
    return dot(p - gA, dPrev) > 0.0;
  }
  if (z > gLen + radius) return false;
  vec3 dNext = 2.0 * dot(fDb, gDn) * fDb - gDn;     // next segment's direction
  return dot(p - fB, dNext) < 0.0;
}

// Signed distance from the point at ray parameter t to the true (helical) surface of
// ply k, measured in the cross-section plane. Used to refine straight-cylinder hits.
float nPliesG;
float helixField(vec3 ro, vec3 rd, float t, float k) {
  vec3 p = ro + t * rd;
  float z = dot(p - gA, gDn);
  vec3 N, B;
  frameAt(z, N, B);
  float phi = 6.2831853 * (k / nPliesG + (fS.x + z) / plyPitch);
  vec3 c = gA + z * gDn + gRho * (cos(phi) * N + sin(phi) * B);
  return length(p - c) - gPlyR;
}

// Ray against an infinite cylinder (axis point c, unit direction e, radius r).
// Returns the near root, or -1.
float rayCylinder(vec3 ro, vec3 rd, vec3 c, vec3 e, float r) {
  vec3 oc = ro - c;
  vec3 dd = rd - e * dot(rd, e);
  vec3 oo = oc - e * dot(oc, e);
  float a = dot(dd, dd);
  if (a < 1e-9) return -1.0;
  float b = dot(dd, oo), cc = dot(oo, oo) - r * r;
  float disc = b * b - a * cc;
  if (disc < 0.0) return -1.0;
  return (-b - sqrt(disc)) / a;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 ba = fB - fA;
  gA = fA;
  gLen = length(ba);
  gDn = ba / max(gLen, 1e-6);
  // Ply layout: circles of radius gPlyR touching each other, centres at radius gRho.
  gPlyR = plies > 1.5 ? radius / (1.0 + 1.0 / sin(3.14159265 / plies)) : radius;
  gRho = radius - gPlyR;

  // Bounding capsule: closest approach of the ray to the segment.
  vec3 oa = ro - fA;
  float Bd = dot(rd, gDn);
  float D = dot(rd, oa);
  float E = dot(gDn, oa);
  float denom = 1.0 - Bd * Bd;
  float sc = denom > 1e-8 ? clamp((E - D * Bd) / denom, 0.0, gLen) : 0.0;
  float tc = sc * Bd - D;
  vec3 q = ro + tc * rd;
  float dist = length(q - (fA + sc * gDn));
  if (dist > radius || tc <= 0.0) discard;
  float px = 2.0 * max(tc, 1e-3) / (projectionMatrix[1][1] * viewportHeight);

  // Level of detail: once the yarn is only a few pixels wide the plies cannot be
  // resolved, so render the plain capsule instead (with the ply shading painted on).
  float lodPlain = step(0.22, px / radius);
  float nPlies = plies;
  if (lodPlain > 0.5) { gPlyR = radius; gRho = 0.0; nPlies = 1.0; }
  nPliesG = nPlies;

  // Each ply is a helix around the axis; over one short segment it is a straight
  // cylinder to well under a micron, tilted by the helix angle at the segment's middle.
  float zMid = 0.5 * gLen;
  vec3 N, B;
  frameAt(zMid, N, B);
  float omega = 6.2831853 / plyPitch;          // twist per unit length
  float best = 1e9;
  vec3 bestC = gA, bestE = gDn;
  float bestK = 0.0;
  float dmin = 1e9;
  vec3 dminC = gA, dminE = gDn;
  float dminK = 0.0;
  for (float k = 0.0; k < nPlies; k += 1.0) {
    float phi = 6.2831853 * (k / nPlies + (fS.x + zMid) / plyPitch);
    vec3 radial = cos(phi) * N + sin(phi) * B;
    vec3 tangent = -sin(phi) * N + cos(phi) * B;
    vec3 c = gA + zMid * gDn + gRho * radial;
    vec3 e = normalize(gDn + gRho * omega * tangent);
    float t = rayCylinder(ro, rd, c, e, gPlyR);
    if (t > 0.0) {
      vec3 p = ro + t * rd;
      if (inSlab(p) && t < best) { best = t; bestC = c; bestE = e; bestK = k; }
    }
    // Miss distance for the anti-aliased silhouette.
    vec3 oc = ro - c;
    vec3 dd = rd - e * dot(rd, e);
    vec3 oo = oc - e * dot(oc, e);
    float a2 = dot(dd, dd);
    if (a2 > 1e-9) {
      float tca = -dot(dd, oo) / a2;
      float miss = length(oo + tca * dd) - gPlyR;
      if (miss < dmin && tca > 0.0 && inSlab(ro + tca * rd)) { dmin = miss; dminC = c; dminE = e; dminK = k; }
    }
  }
  float alpha = 1.0;
  float t = best;
  vec3 plyC = bestC, plyE = bestE;
  float plyK = bestK;
  bool grazing = false;
  if (best > 1e8) {
    float rim = aaRim * px;
    if (dmin > rim || dmin < 0.0) discard;
    alpha = 1.0 - dmin / max(rim, 1e-6);
    // Shade the rim at the closest approach to that ply.
    plyC = dminC; plyE = dminE; plyK = dminK;
    vec3 oc = ro - plyC;
    vec3 dd = rd - plyE * dot(rd, plyE);
    vec3 oo = oc - plyE * dot(oc, plyE);
    t = -dot(dd, oo) / max(dot(dd, dd), 1e-9);
    if (t <= 0.0) discard;
    grazing = true;
  } else if (gRho > 1e-6) {
    // Refine the straight-cylinder hit onto the true helical ply with Newton steps, so
    // the surface and its silhouette are smooth across segment joints.
    float h = 0.01 * radius;
    for (int i = 0; i < 3; i++) {
      float g = helixField(ro, rd, t, plyK);
      float slope = (helixField(ro, rd, t + h, plyK) - g) / h;
      if (abs(slope) < 0.05) break;
      t -= clamp(g / slope, -0.15 * radius, 0.15 * radius);
    }
  }
  vec3 p = ro + t * rd;
  float z = dot(p - gA, gDn);
  float s = clamp(z / max(gLen, 1e-6), 0.0, 1.0);
  float arc = fS.x + z;

  // Ply surface normal. The intersection used a straight ply for this segment; for
  // shading, use the true helix at this point along the curve (yarn axis blended between
  // the bisectors at the two ends), so joints between segments do not facet.
  vec3 dSmooth = normalize(mix(fDa, fDb, s));
  vec3 Nz, Bz;
  frameAt(z, Nz, Bz);
  float phiZ = 6.2831853 * (plyK / nPlies + arc / plyPitch);
  vec3 radialZ = cos(phiZ) * Nz + sin(phiZ) * Bz;
  vec3 tangentZ = -sin(phiZ) * Nz + cos(phiZ) * Bz;
  vec3 axisPt = gA + z * gDn;
  vec3 helixC = axisPt + gRho * radialZ;
  vec3 eSmooth = normalize(dSmooth + gRho * omega * tangentZ);
  vec3 pc = p - helixC;
  pc -= eSmooth * dot(pc, eSmooth);
  vec3 n = normalize(pc);
  if (lodPlain > 0.5) { vec3 q0 = p - axisPt; n = normalize(q0 - dSmooth * dot(q0, dSmooth)); }
  float detail = 1.0 - smoothstep(0.06, 0.3, px / radius);
  // Fibres: streaks along the ply, bump-mapped from anisotropic noise.
  vec3 u1 = gRho > 1e-6 ? radialZ : Nz;
  vec3 u2 = cross(eSmooth, u1);
  float psi = atan(dot(pc, u2), dot(pc, u1));
  float wa = mod(arc, 512.0);
  float along = wa * 0.8;
  float across = psi * 1.6;
  float f0 = fibreNoise(vec2(along, across));
  float f1 = fibreNoise(vec2(along, across + 0.5));
  float f2 = fibreNoise(vec2(along + 0.5, across));
  vec3 tPsi = normalize(cross(eSmooth, n));
  n = normalize(n + detail * fibreBump * ((f1 - f0) * tPsi + 0.3 * (f2 - f0) * eSmooth));
  // Crevices between plies are darker: occlusion by the neighbouring plies.
  float depthIn = length(p - axisPt) / radius;   // 1 at the outside, less in a crevice
  float ao = mix(0.45, 1.0, smoothstep(0.55, 1.0, depthIn));
  if (lodPlain > 0.5 && plies > 1.5) {
    // Painted plies for the distant view.
    float theta = atan(dot(p - axisPt, B), dot(p - axisPt, N));
    float u = fract(plies * theta / 6.2831853 + arc / plyPitch);
    ao = 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.2, min(u, 1.0 - u)));
  }
  float shade = ao * (0.85 + 0.3 * mix(0.5, f0, detail));

  vec3 albedo = mix(fCa, fCb, s) * shade;
  vec3 col = albedo * mix(hemiGround, hemiSky, 0.5 + 0.5 * n.y);
  vec3 spec = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 l = normalize(lightDir[i]);
    float nl = max(dot(n, l), 0.0);
    col += albedo * lightColor[i] * nl;
    vec3 hv = normalize(l - rd);
    spec += lightColor[i] * 0.06 * pow(max(dot(n, hv), 0.0), 12.0) * nl;
  }
  col += spec * ao;

  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  outColor = vec4(toSRGB(clamp(col, 0.0, 1.0)), alpha);
}
`;

/**
 * Parallel-transport reference normals along a polyline.
 * @returns {Float32Array} one normal per point
 */
function transportNormals(pts) {
  const n = pts.length / 3;
  const out = new Float32Array(n * 3);
  let prev = null;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let tx = pts[3 * i1] - pts[3 * i0], ty = pts[3 * i1 + 1] - pts[3 * i0 + 1], tz = pts[3 * i1 + 2] - pts[3 * i0 + 2];
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l; ty /= l; tz /= l;
    let nx, ny, nz;
    if (prev === null) {
      let ax = 0, ay = 0, az = 1;
      if (Math.abs(tz) > 0.9) { ax = 1; az = 0; }
      const d = ax * tx + ay * ty + az * tz;
      nx = ax - d * tx; ny = ay - d * ty; nz = az - d * tz;
    } else {
      const d = prev[0] * tx + prev[1] * ty + prev[2] * tz;
      nx = prev[0] - d * tx; ny = prev[1] - d * ty; nz = prev[2] - d * tz;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    prev = [nx, ny, nz];
    out[3 * i] = nx; out[3 * i + 1] = ny; out[3 * i + 2] = nz;
  }
  return out;
}

/**
 * Build an instanced mesh of capsule impostors for a set of polylines.
 * @param {Array<{pts: Float32Array|number[], colors: Float32Array|number[], arc?: Float32Array}>} strands
 *   pts: xyz per point; colors: linear rgb per point.
 * @param {object} opts {radius, plies, plyAmount, plyPitch}
 */
/** Fill the per-segment geometry attributes (positions, frames, arc lengths) from strand polylines. */
function fillSegments(strands, buf, withColors) {
  const { pa, pb, ca, cb, sab, na, nb: nbArr, da, db } = buf;
  let k = 0;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const s of strands) {
    const pts = s.pts, cols = s.colors;
    const n = pts.length / 3;
    const normals = transportNormals(pts);
    // Unit direction of each segment, and the bisector direction at each point.
    const dir = new Float32Array(Math.max(0, n - 1) * 3);
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[3 * i + 3] - pts[3 * i], dy = pts[3 * i + 4] - pts[3 * i + 1], dz = pts[3 * i + 5] - pts[3 * i + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dir[3 * i] = dx / l; dir[3 * i + 1] = dy / l; dir[3 * i + 2] = dz / l;
    }
    const bis = (i) => {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 2, i);
      let x = dir[3 * i0] + dir[3 * i1], y = dir[3 * i0 + 1] + dir[3 * i1 + 1], z = dir[3 * i0 + 2] + dir[3 * i1 + 2];
      const l = Math.hypot(x, y, z);
      if (l < 1e-6) return [dir[3 * i1], dir[3 * i1 + 1], dir[3 * i1 + 2]];
      return [x / l, y / l, z / l];
    };
    let arc = 0;
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[3 * i + 3] - pts[3 * i], dy = pts[3 * i + 4] - pts[3 * i + 1], dz = pts[3 * i + 5] - pts[3 * i + 2];
      const len = Math.hypot(dx, dy, dz);
      const ba = bis(i), bb = bis(i + 1);
      for (let c = 0; c < 3; c++) {
        pa[3 * k + c] = pts[3 * i + c]; pb[3 * k + c] = pts[3 * i + 3 + c];
        if (withColors) { ca[3 * k + c] = cols[3 * i + c]; cb[3 * k + c] = cols[3 * i + 3 + c]; }
        na[3 * k + c] = normals[3 * i + c];
        nbArr[3 * k + c] = normals[3 * i + 3 + c];
        da[3 * k + c] = ba[c]; db[3 * k + c] = bb[c];
      }
      sab[2 * k] = arc; sab[2 * k + 1] = arc + len;
      arc += len;
      box.expandByPoint(v.set(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]));
      k++;
    }
    if (n) box.expandByPoint(v.set(pts[3 * n - 3], pts[3 * n - 2], pts[3 * n - 1]));
  }
  return { count: k, box };
}

/** Update an existing capsule mesh with new strand positions (same segment count). */
export function updateCapsuleMesh(mesh, strands) {
  const g = mesh.geometry;
  const buf = mesh.userData.buffers;
  const { box } = fillSegments(strands, buf, false);
  for (const name of ['pa', 'pb', 'na', 'nb', 'da', 'db', 'sab']) g.attributes[name].needsUpdate = true;
  box.expandByScalar(mesh.material.uniforms.radius.value * 2);
  g.boundingBox = box;
  g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
}

export function buildCapsuleMesh(strands, opts) {
  let total = 0;
  for (const s of strands) total += Math.max(0, s.pts.length / 3 - 1);
  const pa = new Float32Array(total * 3), pb = new Float32Array(total * 3);
  const ca = new Float32Array(total * 3), cb = new Float32Array(total * 3);
  const sab = new Float32Array(total * 2), na = new Float32Array(total * 3);
  const da = new Float32Array(total * 3), db = new Float32Array(total * 3);
  const nbArr = new Float32Array(total * 3);
  const buffers = { pa, pb, ca, cb, sab, na, nb: nbArr, da, db };
  const { box } = fillSegments(strands, buffers, true);
  const geo = new THREE.InstancedBufferGeometry();
  // A quad: corners in [-1, 1]^2.
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('pa', new THREE.InstancedBufferAttribute(pa, 3));
  geo.setAttribute('pb', new THREE.InstancedBufferAttribute(pb, 3));
  geo.setAttribute('ca', new THREE.InstancedBufferAttribute(ca, 3));
  geo.setAttribute('cb', new THREE.InstancedBufferAttribute(cb, 3));
  geo.setAttribute('sab', new THREE.InstancedBufferAttribute(sab, 2));
  geo.setAttribute('na', new THREE.InstancedBufferAttribute(na, 3));
  geo.setAttribute('nb', new THREE.InstancedBufferAttribute(nbArr, 3));
  geo.setAttribute('da', new THREE.InstancedBufferAttribute(da, 3));
  geo.setAttribute('db', new THREE.InstancedBufferAttribute(db, 3));
  geo.instanceCount = total;
  box.expandByScalar(opts.radius * 2);
  geo.boundingBox = box;
  geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      radius: { value: opts.radius },
      viewportHeight: { value: 900 },
      aaRim: { value: 1 },
      plies: { value: opts.plies ?? 3 },
      plyPitch: { value: opts.plyPitch ?? opts.radius * 7 },
      fibreBump: { value: opts.fibreBump ?? 0.9 },
      hemiSky: { value: new THREE.Color(0.62, 0.62, 0.62) },
      hemiGround: { value: new THREE.Color(0.30, 0.28, 0.27) },
      lightDir: { value: [new THREE.Vector3(100, 220, 180), new THREE.Vector3(-160, -60, 140), new THREE.Vector3(20, 80, -220), new THREE.Vector3(-40, -200, -60)] },
      lightColor: { value: [new THREE.Color(0.85, 0.80, 0.74), new THREE.Color(0.28, 0.30, 0.34), new THREE.Color(0.38, 0.38, 0.38), new THREE.Color(0.16, 0.16, 0.16)] },
    },
    alphaToCoverage: true,
    side: THREE.DoubleSide, // the impostor quad's winding depends on the view direction
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = true;
  mesh.userData.buffers = buffers;
  return mesh;
}
