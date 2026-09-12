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
  vec3 u = cross(dn, tc);
  float ul = length(u);
  if (ul < 1e-4) { u = cross(dn, abs(dn.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)); ul = length(u); }
  u /= ul;
  // A quad through the axis, pushed toward the camera by one radius so it
  // covers the near surface, and inflated to cover the perspective silhouette.
  float R = radius * (1.6 + 2.0 * radius / max(dist, radius));
  vec3 p = mid + dn * (position.x * (0.5 * len + R)) + u * (position.y * R) + tc * radius;
  vWorld = p;
  fA = a; fB = b; fCa = ca; fCb = cb; fS = sab;
  fN = normalize(mat3(modelMatrix) * na);
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
flat in vec3 fDa;
flat in vec3 fDb;

uniform mat4 projectionMatrix; // same program uniform as the vertex stage
uniform float radius;
uniform float viewportHeight;
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

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);
  vec3 ba = fB - fA;
  float len = length(ba);
  vec3 dn = ba / max(len, 1e-6);
  vec3 oa = ro - fA;
  // Closest approach between the view ray and the (infinite) axis line.
  float B = dot(rd, dn);
  float D = dot(rd, oa);
  float E = dot(dn, oa);
  float denom = 1.0 - B * B;
  float s = denom > 1e-8 ? (E - D * B) / denom : 0.0;   // along the axis, world units
  float t = s * B - D;                                   // along the ray
  vec3 axisPt = fA + s * dn;
  vec3 q = ro + t * rd;
  float dist = length(q - axisPt);
  // Pixel size at this depth, for an anti-aliased silhouette.
  float px = 2.0 * max(t, 1e-3) / (projectionMatrix[1][1] * viewportHeight);
  float edge = radius + px;
  if (dist > edge || t <= 0.0) discard;
  float alpha = 1.0 - smoothstep(radius - px, edge, dist);

  vec3 p;
  vec3 n;
  if (dist < radius) {
    // Hit on the cylinder: pull the closest-approach point back along the ray.
    float sinA = sqrt(max(denom, 1e-6));
    float back = sqrt(max(radius * radius - dist * dist, 0.0)) / sinA;
    p = q - rd * back;
  } else {
    p = q; // grazing silhouette, for the anti-aliasing rim
  }
  // Mitred joins: keep only the part of this cylinder between the bisector planes it
  // shares with its neighbours; they render the rest.
  if (dot(p - fA, fDa) < 0.0 || dot(p - fB, fDb) > 0.0) discard;
  float h = dot(p - fA, dn) / max(len, 1e-6);
  n = normalize(p - (fA + h * dn * len));
  s = clamp(h, 0.0, 1.0);

  // Ply twist: a helical bump in the normal and a shallow groove in the albedo.
  vec3 nb = normalize(cross(dn, fN));
  float theta = atan(dot(n, nb), dot(n, fN));
  float arc = mix(fS.x, fS.y, s);
  float phase = plies * theta - 6.2831853 * arc / plyPitch;
  vec3 tangential = normalize(cross(dn, n));
  n = normalize(n + plyAmount * plies * sin(phase) * tangential - plyAmount * 0.6 * sin(phase) * dn);
  float groove = 1.0 - 0.14 * (0.5 + 0.5 * cos(phase));
  // A little fibre noise so the surface is not perfectly smooth.
  float fibre = 0.94 + 0.12 * hash(vec2(floor(arc * 40.0), floor(theta * 6.0)));

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
