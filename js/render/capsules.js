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
uniform float radius;
uniform float viewportHeight;
uniform float aaRim;      // 1 when the framebuffer is multisampled (alpha-to-coverage works), else 0
uniform float plies;
uniform float plyAmount;
uniform float plyPitch;
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

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 ba = fB - fA;
  float len = length(ba);
  vec3 dn = ba / max(len, 1e-6);
  vec3 oa = ro - fA;
  // Closest approach between the view ray and the segment (clamped), for the
  // anti-aliased silhouette and the behind-camera test.
  float B = dot(rd, dn);
  float D = dot(rd, oa);
  float E = dot(dn, oa);
  float denom = 1.0 - B * B;
  float sc = denom > 1e-8 ? clamp((E - D * B) / denom, 0.0, len) : 0.0;
  float tc = sc * B - D;
  vec3 axisPt = fA + sc * dn;
  vec3 q = ro + tc * rd;
  float dist = length(q - axisPt);
  float px = aaRim * 2.0 * max(tc, 1e-3) / (projectionMatrix[1][1] * viewportHeight);
  if (dist > radius || tc <= 0.0) discard;
  // Anti-aliased silhouette: fade out over the last pixel inside the true edge.
  float alpha = 1.0 - smoothstep(radius - px, radius, dist);

  // Capsule intersection: cylinder body, else a sphere at the nearer end. Capsules
  // overlap at the joints, so the union has no gaps however short the segments are.
  vec3 p;
  vec3 n;
  float h;
  if (dist < radius - 1e-5) {
    float t = -1.0;
    if (denom > 1e-6) {
      vec3 dd = rd - dn * B;
      vec3 oo = oa - dn * E;
      float a = dot(dd, dd), b = dot(dd, oo), c = dot(oo, oo) - radius * radius;
      float disc = b * b - a * c;
      if (disc >= 0.0) {
        float tb = (-b - sqrt(disc)) / a;
        float y = E + tb * B;
        if (tb > 0.0 && y >= 0.0 && y <= len) t = tb;
      }
    }
    if (t < 0.0) {
      // Sphere at whichever end the ray passes.
      vec3 centre = (E + tc * B) < 0.5 * len ? fA : fB;
      vec3 oc = ro - centre;
      float b = dot(rd, oc), c = dot(oc, oc) - radius * radius;
      float disc = b * b - c;
      if (disc < 0.0) discard;
      t = -b - sqrt(disc);
      if (t < 0.0) discard;
    }
    p = ro + t * rd;
    h = dot(p - fA, dn) / max(len, 1e-6);
  } else {
    p = q; // grazing silhouette, for the anti-aliasing rim
    h = sc / max(len, 1e-6);
  }
  float s = clamp(h, 0.0, 1.0);
  // Smooth shading across joints: the normal is taken about the axis direction
  // interpolated between the bisectors at the two ends, so it turns continuously along
  // the curve, and the spherical ends shade like the neighbouring cylinder.
  vec3 dMix = mix(fDa, fDb, s);
  vec3 dSmooth = length(dMix) > 1e-4 ? normalize(dMix) : dn;
  vec3 q0 = p - (fA + s * ba);
  vec3 nProj = q0 - dSmooth * dot(q0, dSmooth);
  float nl = length(nProj);
  // On a spherical end seen along the axis the projection degenerates; blend back to
  // the true normal there instead of dividing by zero.
  vec3 nTrue = normalize(q0);
  n = normalize(mix(nTrue, nProj / max(nl, 1e-6), smoothstep(0.0, 0.5 * radius, nl)));
  vec3 fMix = mix(fN, fNb, s);
  vec3 frameN = fMix - dSmooth * dot(fMix, dSmooth);
  if (length(frameN) < 1e-4) frameN = cross(dSmooth, abs(dSmooth.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  frameN = normalize(frameN);

  vec3 frameB = normalize(cross(dSmooth, frameN));
  float theta = atan(dot(n, frameB), dot(n, frameN));
  float arc = mix(fS.x, fS.y, s);
  float phase = plies * theta - 6.2831853 * arc / plyPitch;
  vec3 tangential = normalize(cross(dSmooth, n));
  n = normalize(n + plyAmount * plies * sin(phase) * tangential - plyAmount * 0.6 * sin(phase) * dSmooth);
  float groove = 1.0 - 0.14 * (0.5 + 0.5 * cos(phase));
  // Fibre texture: soft streaks running along the plies (wrapped so precision holds
  // for long strands).
  float wa = mod(arc, 512.0);
  float alongPly = wa * 1.2;
  float acrossPly = (theta * plies / 6.2831853 - wa / plyPitch) * 5.0;
  float fibre = 0.92 + 0.10 * vnoise(vec2(alongPly, acrossPly)) + 0.06 * vnoise(vec2(alongPly * 2.7, acrossPly * 2.1));

  vec3 albedo = mix(fCa, fCb, s) * groove * fibre;
  vec3 col = albedo * mix(hemiGround, hemiSky, 0.5 + 0.5 * n.y);
  vec3 spec = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 l = normalize(lightDir[i]);
    float nl = max(dot(n, l), 0.0);
    col += albedo * lightColor[i] * nl;
    vec3 hv = normalize(l - rd);
    spec += lightColor[i] * 0.04 * pow(max(dot(n, hv), 0.0), 24.0) * nl;
  }
  col += spec;

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
export function buildCapsuleMesh(strands, opts) {
  let total = 0;
  for (const s of strands) total += Math.max(0, s.pts.length / 3 - 1);
  const pa = new Float32Array(total * 3), pb = new Float32Array(total * 3);
  const ca = new Float32Array(total * 3), cb = new Float32Array(total * 3);
  const sab = new Float32Array(total * 2), na = new Float32Array(total * 3);
  const da = new Float32Array(total * 3), db = new Float32Array(total * 3);
  const nbArr = new Float32Array(total * 3);
  let k = 0;
  const box = new THREE.Box3();
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
        ca[3 * k + c] = cols[3 * i + c]; cb[3 * k + c] = cols[3 * i + 3 + c];
        na[3 * k + c] = normals[3 * i + c];
        nbArr[3 * k + c] = normals[3 * i + 3 + c];
        da[3 * k + c] = ba[c]; db[3 * k + c] = bb[c];
      }
      sab[2 * k] = arc; sab[2 * k + 1] = arc + len;
      arc += len;
      box.expandByPoint(new THREE.Vector3(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]));
      k++;
    }
    if (n) box.expandByPoint(new THREE.Vector3(pts[3 * n - 3], pts[3 * n - 2], pts[3 * n - 1]));
  }
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
      plyAmount: { value: opts.plyAmount ?? 0.10 },
      plyPitch: { value: opts.plyPitch ?? opts.radius * 7 },
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
  return mesh;
}
