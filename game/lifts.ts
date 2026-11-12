/**
 * Remontées mécaniques jouables : géométrie du câble, embarquement, trajet, débarquement.
 * Pur (sans Three.js) pour être testable.
 */
import type { LiftKind } from '@/lib/types';
import type { Pt } from './track';
import { resample } from '@/lib/geo';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface LiftPath {
  id: string;
  name: string;
  kind: LiftKind;
  /** Points du trajet du passager, de la gare aval à la gare amont. */
  pts: V3[];
  cum: number[];
  total: number;
  /** Vitesse réelle d'exploitation (m/s). */
  speed: number;
  towerH: number;
  /** Pylônes (pieds au sol). */
  towers: V3[];
  bottom: V3;
  top: V3;
  /** Direction horizontale unitaire de la montée. */
  dir: { x: number; z: number };
  /** Le passager reste au sol (téléski, tapis). */
  ground: boolean;
}

const SPEED: Record<LiftKind, number> = {
  telepherique: 10,
  telecabine: 5.5,
  telemix: 5,
  telesiege: 4.5,
  teleski: 3,
  'fil-neige': 1.5,
  tapis: 0.8,
  autre: 3,
};

const TOWER_H: Record<LiftKind, number> = {
  telepherique: 22,
  telecabine: 15,
  telemix: 14,
  telesiege: 11,
  teleski: 6,
  'fil-neige': 1.2,
  tapis: 0,
  autre: 9,
};

/** Hauteur du passager sous le câble. */
const HANG: Record<LiftKind, number> = {
  telepherique: 5,
  telecabine: 3.2,
  telemix: 3,
  telesiege: 2.6,
  teleski: 0,
  'fil-neige': 0,
  tapis: 0,
  autre: 2.6,
};

export function buildLiftPath(id: string, name: string, kind: LiftKind, line: Pt[], height: (x: number, z: number) => number, realPylons: Pt[] = []): LiftPath | null {
  if (line.length < 2) return null;
  let pts2 = line.slice();
  // sens de montée : du point le plus bas au plus haut
  if (height(pts2[0].x, pts2[0].z) > height(pts2[pts2.length - 1].x, pts2[pts2.length - 1].z)) pts2.reverse();
  const ground = kind === 'teleski' || kind === 'fil-neige' || kind === 'tapis';
  const towerH = TOWER_H[kind];
  const a = pts2[0], b = pts2[pts2.length - 1];
  const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const dir = { x: (b.x - a.x) / dl, z: (b.z - a.z) / dl };

  let pts: V3[];
  let towers: V3[] = [];
  if (ground) {
    pts = resample(pts2, 6).map((p) => ({ x: p.x, y: height(p.x, p.z), z: p.z }));
    towers = resample(pts2, 60).map((p) => ({ x: p.x, y: height(p.x, p.z), z: p.z }));
  } else {
    // pylônes réels (OSM) s'ils existent le long de la ligne, sinon un tous les ~110 m
    const near = matchPylons(pts2, realPylons);
    const t = near.length ? [pts2[0], ...near, pts2[pts2.length - 1]] : resample(pts2, 110);
    towers = t.map((p) => ({ x: p.x, y: height(p.x, p.z), z: p.z }));
    const cable = towers.map((p, i) => ({ x: p.x, y: p.y + (i === 0 || i === towers.length - 1 ? 5 : towerH), z: p.z }));
    pts = [];
    for (let i = 0; i < cable.length - 1; i++) {
      const p = cable[i], q = cable[i + 1];
      const L = Math.hypot(q.x - p.x, q.z - p.z);
      const n = Math.max(1, Math.ceil(L / 8));
      for (let k = 0; k < n; k++) {
        const s = k / n;
        // légère flèche du câble entre deux pylônes
        const sag = Math.sin(s * Math.PI) * Math.min(4, L * 0.015);
        pts.push({ x: p.x + (q.x - p.x) * s, y: p.y + (q.y - p.y) * s - sag - HANG[kind], z: p.z + (q.z - p.z) * s });
      }
    }
    const last = cable[cable.length - 1];
    pts.push({ x: last.x, y: last.y - HANG[kind], z: last.z });
    // le passager ne doit jamais passer sous la neige
    for (const p of pts) p.y = Math.max(p.y, height(p.x, p.z) + 0.6);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  return {
    id,
    name,
    kind,
    pts,
    cum,
    total: cum[cum.length - 1],
    speed: SPEED[kind],
    towerH,
    towers,
    bottom: { x: pts2[0].x, y: height(pts2[0].x, pts2[0].z), z: pts2[0].z },
    top: { x: b.x, y: height(b.x, b.z), z: b.z },
    dir,
    ground,
  };
}

/** Pylônes situés à moins de 15 m de la ligne, triés de l'aval vers l'amont. */
export function matchPylons(line: Pt[], pylons: Pt[]): Pt[] {
  const a = line[0], b = line[line.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  const out: { p: Pt; t: number }[] = [];
  for (const p of pylons) {
    const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (L * L);
    if (t <= 0.02 || t >= 0.98) continue;
    const d = Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / L;
    if (d < 15) out.push({ p, t });
  }
  return out.sort((u, v) => u.t - v.t).map((o) => o.p);
}

export function pointAt(p: LiftPath, d: number): V3 & { hx: number; hz: number } {
  const D = Math.max(0, Math.min(p.total, d));
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (p.cum[m] <= D) lo = m;
    else hi = m;
  }
  const a = p.pts[lo], b = p.pts[hi];
  const t = (D - p.cum[lo]) / Math.max(1e-6, p.cum[hi] - p.cum[lo]);
  const hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz) || 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, hx: hx / hl, hz: hz / hl };
}

/** Remontée dont la gare aval est à moins de `maxDist` mètres. */
export function boardable(paths: LiftPath[], x: number, z: number, maxDist = 18): LiftPath | null {
  let best: LiftPath | null = null, bd = maxDist;
  for (const p of paths) {
    const d = Math.hypot(p.bottom.x - x, p.bottom.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

export class LiftRide {
  d = 0;
  constructor(public path: LiftPath) {}
  /** Avance ; `boost` accélère le temps (x1 à x12). Retourne true à l'arrivée. */
  update(dt: number, boost: number): boolean {
    this.d += this.path.speed * dt * boost;
    return this.d >= this.path.total;
  }
  get progress() {
    return Math.min(1, this.d / Math.max(1, this.path.total));
  }
  remainingS(boost = 1) {
    return Math.max(0, (this.path.total - this.d) / (this.path.speed * boost));
  }
  position() {
    return pointAt(this.path, this.d);
  }
  /** Point de débarquement : quelques mètres après la gare amont. */
  exit(height: (x: number, z: number) => number) {
    const x = this.path.top.x + this.path.dir.x * 8, z = this.path.top.z + this.path.dir.z * 8;
    return { x, z, y: height(x, z), heading: Math.atan2(this.path.dir.x, this.path.dir.z) };
  }
}
