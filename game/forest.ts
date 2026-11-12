/**
 * Forêt à niveaux de détail : les sapins sont regroupés par carrés de 200 m.
 * - près de la caméra : épicéa détaillé (5 étages de branches enneigées), qui projette des ombres ;
 * - plus loin : silhouette simplifiée (20 triangles) ;
 * - au-delà de la portée : non dessinés (le sous-bois peint sur le terrain prend le relais).
 * Chaque carré est une InstancedMesh : peu d'appels de dessin, et le GPU ignore les carrés hors champ.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface TreeInstance {
  x: number;
  y: number;
  z: number;
  s: number;
  rot: number;
  tint: number; // 0.75 – 1.15
}

function painted(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Épicéa détaillé (origine au pied du tronc, ~11 m de haut à l'échelle 1). */
export function spruceHigh(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.18, 0.32, 3, 6);
  trunk.translate(0, 1.5, 0);
  parts.push(painted(trunk, 0x4a3426));
  const layers = [
    [2.5, 4.0, 2.8],
    [2.1, 3.7, 4.7],
    [1.65, 3.3, 6.5],
    [1.15, 2.9, 8.2],
    [0.6, 2.3, 9.8],
  ];
  layers.forEach(([r, h, y], i) => {
    const fol = new THREE.ConeGeometry(r, h, 7, 1, false);
    fol.rotateY(i * 0.45);
    fol.translate(0, y, 0);
    parts.push(painted(fol, i % 2 ? 0x2a4436 : 0x2f4b3b));
    const cap = new THREE.ConeGeometry(r * 0.82, h * 0.34, 7, 1, true);
    cap.rotateY(i * 0.45 + 0.2);
    cap.translate(0, y + h * 0.3, 0);
    parts.push(painted(cap, 0xeef3f7));
  });
  return mergeGeometries(parts)!;
}

/** Silhouette lointaine. */
export function spruceLow(): THREE.BufferGeometry {
  const body = new THREE.ConeGeometry(2.3, 9.5, 5, 1, false);
  body.translate(0, 5.6, 0);
  const snow = new THREE.ConeGeometry(1.4, 3.2, 5, 1, true);
  snow.translate(0, 8.4, 0);
  const trunk = new THREE.CylinderGeometry(0.2, 0.3, 1.2, 4);
  trunk.translate(0, 0.6, 0);
  return mergeGeometries([painted(body, 0x2c4738), painted(snow, 0xe6edf2), painted(trunk, 0x4a3426)])!;
}

interface Chunk {
  cx: number;
  cz: number;
  high: THREE.InstancedMesh;
  low: THREE.InstancedMesh;
}

export class Forest {
  readonly group = new THREE.Group();
  private chunks: Chunk[] = [];
  private timer = 0;

  constructor(
    trees: TreeInstance[],
    private opts: { chunk: number; highDist: number; maxDist: number; shadows: boolean },
  ) {
    const geoHigh = spruceHigh();
    const geoLow = spruceLow();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
    const buckets = new Map<string, TreeInstance[]>();
    for (const t of trees) {
      const k = `${Math.floor(t.x / opts.chunk)}:${Math.floor(t.z / opts.chunk)}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(t);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    for (const [k, list] of buckets) {
      const [i, j] = k.split(':').map(Number);
      const high = new THREE.InstancedMesh(geoHigh, mat, list.length);
      const low = new THREE.InstancedMesh(geoLow, mat, list.length);
      list.forEach((t, n) => {
        m.compose(p.set(t.x, t.y - 0.3, t.z), q.setFromAxisAngle(up, t.rot), s.set(t.s, t.s * (0.92 + (t.tint - 0.95) * 0.6), t.s));
        high.setMatrixAt(n, m);
        low.setMatrixAt(n, m);
        c.setScalar(t.tint);
        high.setColorAt(n, c);
        low.setColorAt(n, c);
      });
      high.computeBoundingSphere();
      low.computeBoundingSphere();
      high.castShadow = opts.shadows;
      high.receiveShadow = false;
      low.castShadow = false;
      high.visible = false;
      this.group.add(high, low);
      this.chunks.push({ cx: (i + 0.5) * opts.chunk, cz: (j + 0.5) * opts.chunk, high, low });
    }
  }

  get count() {
    return this.chunks.reduce((a, c) => a + c.high.count, 0);
  }

  /** Choisit le niveau de détail de chaque carré selon la distance à la caméra. */
  update(cam: THREE.Vector3, dt: number, force = false) {
    this.timer -= dt;
    if (this.timer > 0 && !force) return;
    this.timer = 0.25;
    const h2 = this.opts.highDist ** 2, m2 = this.opts.maxDist ** 2;
    for (const ch of this.chunks) {
      const d2 = (ch.cx - cam.x) ** 2 + (ch.cz - cam.z) ** 2;
      ch.high.visible = d2 < h2;
      ch.low.visible = d2 >= h2 && d2 < m2;
    }
  }
}
