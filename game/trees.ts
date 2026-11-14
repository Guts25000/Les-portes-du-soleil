/**
 * Forêt réelle du secteur : ~1 million de sapins placés d'après l'orthophoto IGN (pré-calcul).
 * Rendu : deux maillages instanciés seulement (épicéa détaillé près de la caméra, silhouette plus loin),
 * remplis à la volée avec les arbres des carrés visibles. Au-delà, le sol pré-calculé prend le relais.
 * La neige sur les branches est calculée dans le shader (faces tournées vers le ciel).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gridHeight, type World } from './world';

const TREE_H = 15.5; // hauteur d'un sapin d'échelle 1 (même valeur que le pré-calcul)

function tint(geo: THREE.BufferGeometry, r: number, g: number, b: number) {
  const n = geo.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) (c[i * 3] = r), (c[i * 3 + 1] = g), (c[i * 3 + 2] = b);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Étage de branches : jupe tombante au bord dentelé + dessous sombre. Hauteur totale de l'arbre = 1.
 *  Attribut aRim : 0 près du tronc (la neige s'y accumule), 1 au bout des branches (vert sombre). */
function tier(rTop: number, yTop: number, rBot: number, yBot: number, segs: number, rot: number, under: boolean, seed: number): THREE.BufferGeometry[] {
  const pos: number[] = [];
  const rim: number[] = [];
  const idx: number[] = [];
  let h = seed * 9301 + 49297;
  const rnd = () => ((h = (h * 9301 + 49297) % 233280) / 233280);
  const jag: number[] = [];
  for (let i = 0; i <= segs; i++) jag.push(i === segs ? jag[0] : (i % 2 ? 0.78 : 1.06) * (0.9 + rnd() * 0.22));
  const mid = 0.55;
  const R = under ? 3 : 2; // anneaux : tronc, (milieu), bout des branches
  for (let i = 0; i <= segs; i++) {
    const a = rot + (i / segs) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rr = rBot * jag[i];
    pos.push(ca * rTop, yTop, sa * rTop);
    if (R === 3) pos.push(ca * (rTop + (rr - rTop) * mid), yTop - (yTop - yBot) * 0.42, sa * (rTop + (rr - rTop) * mid));
    pos.push(ca * rr, yBot - (i % 2 ? 0.014 : 0) - rnd() * 0.01, sa * rr);
    if (R === 3) rim.push(0, 0.5, 1);
    else rim.push(0, 1);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * R;
    for (let r = 0; r < R - 1; r++) idx.push(a + r, a + R + r, a + r + 1, a + r + 1, a + R + r, a + R + r + 1);
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  top.setAttribute('aRim', new THREE.Float32BufferAttribute(rim, 1));
  top.setIndex(idx);
  top.computeVertexNormals();
  const out = [tint(top.toNonIndexed(), 0.03, 0.058, 0.04)];
  if (under) {
    const up: number[] = [];
    const ur: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a0 = rot + (i / segs) * Math.PI * 2, a1 = rot + ((i + 1) / segs) * Math.PI * 2;
      up.push(0, yBot + (yTop - yBot) * 0.45, 0, Math.cos(a1) * rBot * jag[i + 1], yBot, Math.sin(a1) * rBot * jag[i + 1], Math.cos(a0) * rBot * jag[i], yBot, Math.sin(a0) * rBot * jag[i]);
      ur.push(1, 1, 1);
    }
    const u = new THREE.BufferGeometry();
    u.setAttribute('position', new THREE.Float32BufferAttribute(up, 3));
    u.setAttribute('aRim', new THREE.Float32BufferAttribute(ur, 1));
    u.computeVertexNormals();
    out.push(tint(u, 0.012, 0.022, 0.016));
  }
  return out;
}

function withRim(g: THREE.BufferGeometry, v: number) {
  g.setAttribute('aRim', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(v), 1));
  return g;
}

export function spruceGeometry(detail: 'high' | 'low'): THREE.BufferGeometry {
  const T = detail === 'high' ? 10 : 3;
  const segs = detail === 'high' ? 10 : 5;
  const parts: THREE.BufferGeometry[] = [];
  const y0 = 0.1, span = 0.88;
  for (let k = 0; k < T; k++) {
    const f = k / T;
    const rBot = 0.205 * Math.pow(1 - f, 0.92) + 0.014;
    const yBot = y0 + f * span - (detail === 'high' ? 0.03 : 0.05);
    const yTop = y0 + ((k + 1) / T) * span + 0.025;
    parts.push(...tier(rBot * 0.16, yTop, rBot, yBot, segs, k * 0.71, detail === 'high', k + 1));
  }
  const tip = new THREE.ConeGeometry(0.012, 0.07, 4);
  tip.translate(0, 1.0, 0);
  parts.push(withRim(tint(tip.toNonIndexed(), 0.03, 0.058, 0.04), 1));
  if (detail === 'high') {
    const trunk = new THREE.CylinderGeometry(0.012, 0.02, 0.3, 6, 1, true);
    trunk.translate(0, 0.15, 0);
    parts.push(withRim(tint(trunk.toNonIndexed(), 0.045, 0.028, 0.017), 1));
  }
  for (const p of parts) {
    if (p.getAttribute('uv')) p.deleteAttribute('uv');
  }
  return mergeGeometries(parts)!;
}

function treeMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader =
      'attribute vec4 iPos;\nattribute vec4 iDat;\nattribute float aRim;\nvarying float vRim;\nvarying float vShade;\nvarying float vTint;\nvarying float vH;\nvarying vec3 vWN;\nvarying vec3 vTW;\n' +
      sh.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          `float cr = cos(iDat.x), sr = sin(iDat.x);
vec3 objectNormal = vec3(cr * normal.x + sr * normal.z, normal.y, -sr * normal.x + cr * normal.z);`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 p0 = position * vec3(iPos.w, iPos.w * iDat.w, iPos.w);
vec3 transformed = vec3(cr * p0.x + sr * p0.z, p0.y, -sr * p0.x + cr * p0.z) + iPos.xyz;
vShade = iDat.y; vTint = iDat.z; vH = position.y; vWN = objectNormal; vTW = transformed; vRim = aRim;`,
        );
    sh.fragmentShader =
      `float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
` + 'varying float vRim;\nvarying float vShade;\nvarying float vTint;\nvarying float vH;\nvarying vec3 vWN;\nvarying vec3 vTW;\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
if (vColor.g > vColor.r * 1.2) {
  float nn = vn3(vTW * 1.1) * 0.65 + vn3(vTW * 3.7) * 0.35;
  float up = smoothstep(0.05, 0.45, normalize(vWN).y);
  float snow = up * smoothstep(0.42, 0.62, nn * 0.85 + (1.0 - vRim) * 0.42);
  diffuseColor.rgb = mix(diffuseColor.rgb * vTint, vec3(0.82, 0.86, 0.92), clamp(snow * 1.1, 0.0, 0.95));
}`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
reflectedLight.directDiffuse *= vShade;
reflectedLight.indirectDiffuse *= 0.45 + 0.55 * clamp(vH * 1.2, 0.0, 1.0);`,
        );
  };
  mat.customProgramCacheKey = () => 'pds-tree';
  return mat;
}

class Layer {
  readonly mesh: THREE.Mesh;
  readonly pos: THREE.InstancedBufferAttribute;
  readonly dat: THREE.InstancedBufferAttribute;
  readonly geo: THREE.InstancedBufferGeometry;
  count = 0;
  constructor(base: THREE.BufferGeometry, mat: THREE.Material, readonly capacity: number) {
    const geo = new THREE.InstancedBufferGeometry();
    for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.getAttribute(k));
    if (base.index) geo.setIndex(base.index);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.dat = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.pos);
    geo.setAttribute('iDat', this.dat);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.userData.cat = 'sapins';
    this.mesh.matrixAutoUpdate = false;
  }
  push(t: Float32Array, o: number) {
    if (this.count >= this.capacity) return;
    const p = this.pos.array as Float32Array, d = this.dat.array as Float32Array, k = this.count * 4;
    p[k] = t[o];
    p[k + 1] = t[o + 1];
    p[k + 2] = t[o + 2];
    p[k + 3] = t[o + 3];
    d[k] = t[o + 4];
    d[k + 1] = t[o + 5];
    d[k + 2] = t[o + 6];
    d[k + 3] = t[o + 7];
    this.count++;
  }
  commit() {
    this.geo.instanceCount = this.count;
    this.pos.clearUpdateRanges();
    this.dat.clearUpdateRanges();
    this.pos.addUpdateRange(0, this.count * 4);
    this.dat.addUpdateRange(0, this.count * 4);
    this.pos.needsUpdate = true;
    this.dat.needsUpdate = true;
  }
}

export class TreeField {
  readonly group = new THREE.Group();
  private high: Layer;
  private low: Layer;
  private cache = new Map<number, Float32Array>();
  private bounds: { minY: number; maxY: number }[] = [];
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private timer = 0;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private box = new THREE.Box3();
  readonly CH: number;
  readonly cols: number;
  readonly rows: number;

  constructor(private world: World, private opts: { highDist: number; lowDist: number; highCap: number; lowCap: number }) {
    const t = world.meta.trees;
    this.CH = t.chunk;
    this.cols = t.cols;
    this.rows = t.rows;
    const mat = treeMaterial();
    this.high = new Layer(spruceGeometry('high'), mat, opts.highCap);
    this.low = new Layer(spruceGeometry('low'), mat, opts.lowCap);
    this.group.add(this.high.mesh, this.low.mesh);
    const g = world.grid;
    for (let cj = 0; cj < this.rows; cj++)
      for (let ci = 0; ci < this.cols; ci++) {
        let minY = Infinity, maxY = -Infinity;
        for (let z = 0; z <= this.CH; z += 40)
          for (let x = 0; x <= this.CH; x += 40) {
            const h = gridHeight(g, -world.meta.halfW + ci * this.CH + x, -world.meta.halfD + cj * this.CH + z) ?? 0;
            minY = Math.min(minY, h);
            maxY = Math.max(maxY, h);
          }
        this.bounds.push({ minY, maxY: maxY + 35 });
      }
  }

  /** Arbres d'un carré : x, y, z, hauteur, rotation, ensoleillement, teinte, étirement. */
  chunk(c: number): Float32Array {
    let a = this.cache.get(c);
    if (a) return a;
    const off = this.world.treeOffsets, d = this.world.treeData;
    const n = off[c + 1] - off[c];
    a = new Float32Array(n * 8);
    const x0 = -this.world.meta.halfW + (c % this.cols) * this.CH, z0 = -this.world.meta.halfD + Math.floor(c / this.cols) * this.CH;
    for (let k = 0; k < n; k++) {
      const q = (off[c] + k) * 4;
      let hsh = (c * 73856093) ^ (k * 19349663);
      const rnd = () => {
        hsh = Math.imul(hsh ^ (hsh >>> 15), 2246822507);
        hsh = Math.imul(hsh ^ (hsh >>> 13), 3266489909);
        return ((hsh ^= hsh >>> 16) >>> 0) / 4294967296;
      };
      const x = x0 + d[q] * 1.25 + (rnd() - 0.5) * 1.1, z = z0 + d[q + 1] * 1.25 + (rnd() - 0.5) * 1.1;
      const s = 0.6 + ((d[q + 2] >> 4) / 15) * 1.5;
      const o = k * 8;
      a[o] = x;
      a[o + 1] = (gridHeight(this.world.grid, x, z) ?? 0) - 0.4;
      a[o + 2] = z;
      a[o + 3] = s * TREE_H;
      a[o + 4] = rnd() * Math.PI * 2;
      a[o + 5] = 0.12 + 0.88 * (d[q + 3] / 255);
      a[o + 6] = 0.78 + ((d[q + 2] & 15) / 15) * 0.42;
      a[o + 7] = 0.9 + rnd() * 0.22;
    }
    this.cache.set(c, a);
    return a;
  }

  /** Remplit les maillages avec les arbres visibles (mis à jour quand la caméra bouge). */
  update(cam: THREE.PerspectiveCamera, dt: number, force = false) {
    this.timer -= dt;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const moved = cam.position.distanceToSquared(this.lastPos) > 12 * 12 || dir.dot(this.lastDir) < 0.985;
    if (!force && !moved && this.timer > 0) return;
    if (!force && this.timer > -0.1 && !moved) return;
    this.timer = 0.35;
    this.lastPos.copy(cam.position);
    this.lastDir.copy(dir);
    this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    const { highDist, lowDist } = this.opts;
    const h2 = highDist * highDist, l2 = lowDist * lowDist;
    this.high.count = 0;
    this.low.count = 0;
    const cx = cam.position.x, cz = cam.position.z;
    const W = this.world.meta.halfW, D = this.world.meta.halfD;
    const i0 = Math.max(0, Math.floor((cx - lowDist + W) / this.CH)), i1 = Math.min(this.cols - 1, Math.floor((cx + lowDist + W) / this.CH));
    const j0 = Math.max(0, Math.floor((cz - lowDist + D) / this.CH)), j1 = Math.min(this.rows - 1, Math.floor((cz + lowDist + D) / this.CH));
    // carrés triés du plus proche au plus lointain : le budget va d'abord aux arbres proches
    const list: [number, number][] = [];
    for (let cj = j0; cj <= j1; cj++)
      for (let ci = i0; ci <= i1; ci++) {
        const x0 = -W + ci * this.CH, z0 = -D + cj * this.CH;
        const dx = Math.max(x0 - cx, 0, cx - x0 - this.CH), dz = Math.max(z0 - cz, 0, cz - z0 - this.CH);
        const d2 = dx * dx + dz * dz;
        if (d2 > l2) continue;
        const b = this.bounds[cj * this.cols + ci];
        this.box.min.set(x0 - 6, b.minY - 2, z0 - 6);
        this.box.max.set(x0 + this.CH + 6, b.maxY, z0 + this.CH + 6);
        if (!this.frustum.intersectsBox(this.box)) continue;
        list.push([cj * this.cols + ci, d2]);
      }
    list.sort((a, b) => a[1] - b[1]);
    for (const [c, d2c] of list) {
      const t = this.chunk(c);
      const allLow = d2c > h2 * 1.2;
      for (let o = 0; o < t.length; o += 8) {
        const dx = t[o] - cx, dz = t[o + 2] - cz, d2 = dx * dx + dz * dz;
        if (d2 > l2) continue;
        if (!allLow && d2 < h2) this.high.push(t, o);
        else this.low.push(t, o);
      }
    }
    this.high.commit();
    this.low.commit();
  }

  /** Collision avec un tronc (rayon autour du pied). */
  hit(x: number, z: number, r: number): boolean {
    const W = this.world.meta.halfW, D = this.world.meta.halfD;
    const ci = Math.floor((x + W) / this.CH), cj = Math.floor((z + D) / this.CH);
    for (let b = cj - 1; b <= cj + 1; b++)
      for (let a = ci - 1; a <= ci + 1; a++) {
        if (a < 0 || b < 0 || a >= this.cols || b >= this.rows) continue;
        const x0 = -W + a * this.CH, z0 = -D + b * this.CH;
        if (x < x0 - 3 || x > x0 + this.CH + 3 || z < z0 - 3 || z > z0 + this.CH + 3) continue;
        const t = this.chunk(b * this.cols + a);
        for (let o = 0; o < t.length; o += 8) {
          const dx = t[o] - x, dz = t[o + 2] - z;
          const rr = r + 0.25 + t[o + 3] * 0.012;
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    return false;
  }

  /** Arbres proches d'un point (pour éviter d'en planter dans les modules, etc.). */
  stats() {
    return { high: this.high.count, low: this.low.count, cached: this.cache.size };
  }
}
