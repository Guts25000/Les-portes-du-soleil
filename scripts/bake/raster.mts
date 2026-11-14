/** Outils de rastérisation sur grilles régulières alignées sur le monde (x est, z sud). */
import { HALF_D, HALF_W } from './def.mts';

export interface Raster {
  w: number;
  h: number;
  m: number; // mètres par pixel
}

export const rast = (m: number): Raster => ({ w: Math.round((2 * HALF_W) / m), h: Math.round((2 * HALF_D) / m), m });
/** Coordonnées pixel (centre du pixel 0 = 0). */
export const px = (r: Raster, x: number) => (x + HALF_W) / r.m - 0.5;
export const pz = (r: Raster, z: number) => (z + HALF_D) / r.m - 0.5;
export const wx = (r: Raster, i: number) => -HALF_W + (i + 0.5) * r.m;
export const wz = (r: Raster, j: number) => -HALF_D + (j + 0.5) * r.m;

/** Remplissage pair-impair d'anneaux (en mètres) : appelle cb(index) pour chaque pixel intérieur. */
export function fillRings(r: Raster, rings: { x: number; z: number }[][], cb: (i: number) => void) {
  let zmin = Infinity, zmax = -Infinity;
  for (const ring of rings) for (const p of ring) (zmin = Math.min(zmin, p.z)), (zmax = Math.max(zmax, p.z));
  const j0 = Math.max(0, Math.ceil(pz(r, zmin))), j1 = Math.min(r.h - 1, Math.floor(pz(r, zmax)));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = wz(r, j);
    xs.length = 0;
    for (const ring of rings)
      for (let k = 0, n = ring.length; k < n; k++) {
        const a = ring[k], b = ring[(k + 1) % n];
        if (a.z <= z !== b.z <= z) xs.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(px(r, xs[k]))), i1 = Math.min(r.w - 1, Math.floor(px(r, xs[k + 1])));
      for (let i = i0; i <= i1; i++) cb(j * r.w + i);
    }
  }
}

/** Trait épais : cb(index, distanceAuSegment) pour les pixels à moins de `half` m de la polyligne. */
export function strokeLine(r: Raster, pts: { x: number; z: number }[], half: number, cb: (i: number, d: number) => void) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    const i0 = Math.max(0, Math.floor(px(r, Math.min(a.x, b.x) - half))), i1 = Math.min(r.w - 1, Math.ceil(px(r, Math.max(a.x, b.x) + half)));
    const j0 = Math.max(0, Math.floor(pz(r, Math.min(a.z, b.z) - half))), j1 = Math.min(r.h - 1, Math.ceil(pz(r, Math.max(a.z, b.z) + half)));
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const z = wz(r, j);
      for (let i = i0; i <= i1; i++) {
        const x = wx(r, i);
        let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
        if (d <= half) cb(j * r.w + i, d);
      }
    }
  }
}

/** Disque : cb(index, distance au centre). */
export function stampDisc(r: Raster, x: number, z: number, rad: number, cb: (i: number, d: number) => void) {
  const i0 = Math.max(0, Math.floor(px(r, x - rad))), i1 = Math.min(r.w - 1, Math.ceil(px(r, x + rad)));
  const j0 = Math.max(0, Math.floor(pz(r, z - rad))), j1 = Math.min(r.h - 1, Math.ceil(pz(r, z + rad)));
  for (let j = j0; j <= j1; j++) {
    const dz = wz(r, j) - z;
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(wx(r, i) - x, dz);
      if (d <= rad) cb(j * r.w + i, d);
    }
  }
}

/** Flou boîte séparable (rayon en pixels), sur place. */
export function boxBlur(a: Float32Array, w: number, h: number, rad: number) {
  const tmp = new Float32Array(a.length);
  const n = 2 * rad + 1;
  for (let j = 0; j < h; j++) {
    let s = 0;
    for (let i = -rad; i <= rad; i++) s += a[j * w + Math.min(w - 1, Math.max(0, i))];
    for (let i = 0; i < w; i++) {
      tmp[j * w + i] = s / n;
      s += a[j * w + Math.min(w - 1, i + rad + 1)] - a[j * w + Math.max(0, i - rad)];
    }
  }
  for (let i = 0; i < w; i++) {
    let s = 0;
    for (let j = -rad; j <= rad; j++) s += tmp[Math.min(h - 1, Math.max(0, j)) * w + i];
    for (let j = 0; j < h; j++) {
      a[j * w + i] = s / n;
      s += tmp[Math.min(h - 1, j + rad + 1) * w + i] - tmp[Math.max(0, j - rad) * w + i];
    }
  }
}

/** Bruit de valeur 2D déterministe (0..1). */
function hash(i: number, j: number) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x: number, y: number) {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, oct = 4) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise(x * f, y * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}
export function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
