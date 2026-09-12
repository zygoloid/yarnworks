// three.js scene: yarn, needles, markers, lifelines, camera and controls.

import * as THREE from 'three';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { tubeGeometry, subdivide, buildYarnMesh } from './tube.js';

export class KnitScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f2ef);
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.position.set(0, 0, 300);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.7;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x9d948c, 1.5);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff6ea, 2.3);
    key.position.set(100, 220, 180);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8eef8, 0.9);
    fill.position.set(-160, -60, 140);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.2);
    rim.position.set(20, 80, -220);
    this.scene.add(rim);
    const under = new THREE.DirectionalLight(0xffffff, 0.5);
    under.position.set(-40, -200, -60);
    this.scene.add(under);

    this.yarnGroup = new THREE.Group();
    this.needleGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.lifelineGroup = new THREE.Group();
    this.scene.add(this.yarnGroup, this.needleGroup, this.markerGroup, this.lifelineGroup);

    this.needleMaterial = new THREE.MeshStandardMaterial({ color: 0xb9b3aa, roughness: 0.35, metalness: 0.6 });
    this.markerMaterial = new THREE.MeshStandardMaterial({ color: 0xd9533a, roughness: 0.5 });
    this.lifelineMaterial = new THREE.MeshStandardMaterial({ color: 0x3f8fd6, roughness: 0.7 });

    this.needsRender = true;
    this.controls.addEventListener('change', () => { this.needsRender = true; });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (this.needsRender || moved) { this.renderer.render(this.scene, this.camera); this.needsRender = false; }
    };
    loop();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth || 300, h = parent.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  static dispose(group) {
    for (const child of group.children) {
      if (child.geometry) child.geometry.dispose();
      if (child.children) KnitScene.dispose(child);
    }
    group.clear();
  }

  clear() {
    KnitScene.dispose(this.yarnGroup);
    KnitScene.dispose(this.needleGroup);
    KnitScene.dispose(this.markerGroup);
    KnitScene.dispose(this.lifelineGroup);
    this.needsRender = true;
  }

  setYarn(path, opts) {
    KnitScene.dispose(this.yarnGroup);
    this.yarnGroup.add(buildYarnMesh(path, opts));
    this.needsRender = true;
  }

  /**
   * Add a needle. `points` are the loop head centres in order from the tip outwards;
   * for a circular needle they run all the way round.
   */
  addNeedle(points, opts) {
    const radius = opts.radius;
    let geo;
    if (opts.circular) {
      if (points.length < 3) return;
      const flat = new Float32Array(points.length * 3 + 6);
      // Close the loop by repeating the first two points.
      const all = points.concat([points[0], points[1]]);
      all.forEach((p, i) => { flat[3 * i] = p[0]; flat[3 * i + 1] = p[1]; flat[3 * i + 2] = p[2]; });
      const { pts } = subdivide(flat, 0, all.length, 4, new Float32Array(all.length));
      geo = tubeGeometry(pts, radius * 0.8, 10, () => [1, 1, 1]);
    } else {
      // Straight needle: least-squares line through the points, extended at both ends.
      const n = points.length;
      const c = [0, 0, 0];
      for (const p of points) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
      let d;
      if (n >= 2) {
        // Principal direction via power iteration on the covariance.
        let m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (const p of points) {
          const q = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += q[i] * q[j];
        }
        d = [points[n - 1][0] - points[0][0], points[n - 1][1] - points[0][1], points[n - 1][2] - points[0][2]];
        for (let it = 0; it < 8; it++) {
          const v = [0, 0, 0];
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v[i] += m[i][j] * d[j];
          const l = Math.hypot(...v) || 1;
          if (l < 1e-9) break;
          const nd = v.map((x) => x / l);
          if (nd[0] * d[0] + nd[1] * d[1] + nd[2] * d[2] < 0) d = nd.map((x) => -x); else d = nd;
        }
        const l = Math.hypot(...d) || 1; d = d.map((x) => x / l);
      } else {
        d = opts.direction || [1, 0, 0];
      }
      // Projections along d.
      let lo = Infinity, hi = -Infinity;
      for (const p of points) { const t = (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1] + (p[2] - c[2]) * d[2]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
      const tipLen = radius * 5;
      const tipStart = lo - opts.gap;
      const tipEnd = tipStart - tipLen;
      const tail = hi + opts.tail;
      const samples = [];
      const N = 24;
      for (let i = 0; i <= N; i++) {
        const t = tipEnd + (tail - tipEnd) * (i / N);
        samples.push(c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t);
      }
      geo = tubeGeometry(samples, (i) => {
        const t = tipEnd + (tail - tipEnd) * (i / N);
        if (t < tipStart) { const f = (t - tipEnd) / tipLen; return radius * Math.max(0.08, Math.pow(f, 0.7)); }
        return radius;
      }, 12, () => [1, 1, 1]);
      // Knob at the far end.
      const knob = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.6, 12, 10), this.needleMaterial);
      knob.position.set(c[0] + d[0] * tail, c[1] + d[1] * tail, c[2] + d[2] * tail);
      this.needleGroup.add(knob);
    }
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, this.needleMaterial);
    this.needleGroup.add(mesh);
    this.needsRender = true;
  }

  addMarker(position, axis, radius) {
    const geo = new THREE.TorusGeometry(radius, radius * 0.18, 8, 20);
    const mesh = new THREE.Mesh(geo, this.markerMaterial);
    mesh.position.set(position[0], position[1], position[2]);
    const a = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), a);
    this.markerGroup.add(mesh);
    this.needsRender = true;
  }

  addLifeline(points, radius) {
    if (points.length < 2) return;
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => { flat[3 * i] = p[0]; flat[3 * i + 1] = p[1]; flat[3 * i + 2] = p[2]; });
    const { pts } = subdivide(flat, 0, points.length, 3, new Float32Array(points.length));
    const geo = tubeGeometry(pts, radius, 6, () => [1, 1, 1]);
    this.lifelineGroup.add(new THREE.Mesh(geo, this.lifelineMaterial));
    this.needsRender = true;
  }

  setNeedlesVisible(v) { this.needleGroup.visible = v; this.markerGroup.visible = v; this.needsRender = true; }

  /** Frame the camera on the yarn. */
  fit(fromFront = true) {
    const box = new THREE.Box3().setFromObject(this.yarnGroup);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3(); box.getSize(size);
    const centre = new THREE.Vector3(); box.getCenter(centre);
    const radius = Math.max(size.x, size.y, size.z) * 0.55 + 5;
    const dist = radius / Math.sin((this.camera.fov * Math.PI / 180) / 2);
    this.controls.target.copy(centre);
    this.camera.position.set(centre.x, centre.y + dist * 0.15, centre.z + (fromFront ? dist : -dist));
    this.camera.near = Math.max(0.5, dist / 100);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.needsRender = true;
  }

  flip() {
    const t = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(t);
    offset.x = -offset.x; offset.z = -offset.z;
    this.camera.position.copy(t).add(offset);
    this.controls.update();
    this.needsRender = true;
  }
}
