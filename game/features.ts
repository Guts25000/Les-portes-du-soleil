/**
 * Modules de freestyle : tremplins (kickers) et rails/boxes.
 * - Le long de la piste : quelques modules sur les sections régulières (générés, signalés comme tels).
 * - Aux emplacements réels des snowparks (OpenStreetMap) : une ligne de modules dans la pente.
 * Pur (sans Three.js) : les tremplins modifient le relief vu par la physique via `offset()`.
 */
import type { Difficulty } from '@/lib/types';
import { SpatialHash, type Track } from './track';

export interface Kicker {
  x: number; // début de la rampe
  z: number;
  dx: number; // direction de la rampe (vers l'aval), unitaire
  dz: number;
  L: number; // longueur de la rampe
  H: number; // hauteur de la lèvre
  W: number; // largeur
}

export interface Rail {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ya: number; // hauteur absolue du dessus en A
  yb: number;
  kind: 'rail' | 'box';
}

const SIZE: Record<Difficulty, [number, number]> = {
  verte: [1.0, 5],
  bleue: [1.5, 6.5],
  rouge: [2.1, 8],
  noire: [2.6, 9],
  freeride: [2.1, 8],
  inconnue: [1.5, 6.5],
};
const BACK = 1.3; // longueur de la face arrière (chute après la lèvre)
const SIDE = 1.6; // talus latéral

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function kickerProfile(k: Kicker, u: number, v: number): number {
  if (u < 0 || u > k.L + BACK) return 0;
  const av = Math.abs(v);
  if (av > k.W / 2 + SIDE) return 0;
  const along = u <= k.L ? k.H * Math.pow(u / k.L, 1.7) : k.H * (1 - (u - k.L) / BACK);
  const across = 1 - smoothstep(k.W / 2, k.W / 2 + SIDE, av);
  return Math.max(0, along * across);
}

export class Features {
  kickers: Kicker[] = [];
  rails: Rail[] = [];
  private kHash = new SpatialHash(20);
  private rHash = new SpatialHash(20);

  addKicker(k: Kicker) {
    const id = this.kickers.length;
    this.kickers.push(k);
    const cx = k.x + k.dx * (k.L / 2), cz = k.z + k.dz * (k.L / 2);
    this.kHash.insert(cx, cz, k.L / 2 + BACK + k.W / 2 + SIDE);
    return id;
  }

  addRail(r: Rail) {
    const id = this.rails.length;
    this.rails.push(r);
    this.rHash.insert((r.ax + r.bx) / 2, (r.az + r.bz) / 2, Math.hypot(r.bx - r.ax, r.bz - r.az) / 2 + 1);
    return id;
  }

  private tmp: number[] = [];

  /** Surélévation du sol due aux tremplins. */
  offset(x: number, z: number): number {
    let h = 0;
    for (const id of this.kHash.query(x, z, 0, this.tmp)) {
      const k = this.kickers[id];
      const rx = x - k.x, rz = z - k.z;
      const u = rx * k.dx + rz * k.dz;
      const v = -rx * k.dz + rz * k.dx;
      h = Math.max(h, kickerProfile(k, u, v));
    }
    return h;
  }

  /** Rail le plus proche sous le skieur : position t (0..1), écart latéral, hauteur du dessus. */
  railNear(x: number, z: number): { id: number; t: number; d: number; y: number; len: number; ux: number; uz: number } | null {
    let best: ReturnType<Features['railNear']> = null;
    for (const id of this.rHash.query(x, z, 0, this.tmp)) {
      const r = this.rails[id];
      const dx = r.bx - r.ax, dz = r.bz - r.az;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const t = ((x - r.ax) * ux + (z - r.az) * uz) / len;
      if (t < -0.02 || t > 1.02) continue;
      const d = Math.abs(-(x - r.ax) * uz + (z - r.az) * ux);
      if (!best || d < best.d) best = { id, t, d, y: r.ya + (r.yb - r.ya) * t, len, ux, uz };
    }
    return best;
  }
}

/** Place des modules le long du tracé principal sur les sections régulières. */
export function placeAlongTrack(
  f: Features,
  track: Track,
  height: (x: number, z: number) => number,
  half: number,
  d: Difficulty,
  rand: () => number,
) {
  const [H, L] = SIZE[d];
  let s = 90, n = 0;
  while (s < track.total - 140) {
    const a = track.at(s);
    const h1 = height(a.x, a.z), h2 = height(a.x + a.tx * 20, a.z + a.tz * 20);
    const slope = (h1 - h2) / 20;
    const straight = Math.abs(track.turnAngle(s, 30)) < 0.3;
    if (straight && slope > 0.06 && slope < 0.5) {
      const side = n % 2 === 0 ? 1 : -1;
      const off = side * half * 0.42;
      const x = a.x + a.tz * off, z = a.z - a.tx * off;
      if (n % 3 === 2) addRailAt(f, x, z, a.tx, a.tz, height, rand() > 0.5 ? 'rail' : 'box', 10 + rand() * 4);
      else f.addKicker({ x, z, dx: a.tx, dz: a.tz, L: L * (0.9 + rand() * 0.25), H: H * (0.85 + rand() * 0.3), W: 4.5 });
      n++;
      s += 230 + rand() * 120;
    } else s += 25;
  }
  return n;
}

function addRailAt(f: Features, x: number, z: number, dx: number, dz: number, height: (x: number, z: number) => number, kind: 'rail' | 'box', len: number) {
  const bx = x + dx * len, bz = z + dz * len;
  const top = kind === 'rail' ? 0.75 : 0.55;
  f.addRail({ ax: x, az: z, bx, bz, ya: height(x, z) + top, yb: height(bx, bz) + top, kind });
}

/** Ligne de snowpark à un emplacement réel (point OSM), dans le sens de la pente. */
export function placePark(
  f: Features,
  x0: number,
  z0: number,
  height: (x: number, z: number) => number,
  rand: () => number,
): { x: number; z: number; dx: number; dz: number } {
  // direction de la plus grande pente
  const e = 6;
  let gx = height(x0 + e, z0) - height(x0 - e, z0), gz = height(x0, z0 + e) - height(x0, z0 - e);
  const gl = Math.hypot(gx, gz) || 1;
  const dx = -gx / gl, dz = -gz / gl;
  gx = dx;
  gz = dz;
  let x = x0, z = z0;
  const lines: ('k' | 'r' | 'b')[] = ['k', 'r', 'k', 'b', 'k', 'r'];
  for (const m of lines) {
    if (m === 'k') {
      const L = 7 + rand() * 2;
      f.addKicker({ x, z, dx: gx, dz: gz, L, H: 1.8 + rand() * 0.8, W: 5 });
      x += gx * (L + 28);
      z += gz * (L + 28);
    } else {
      const len = 10 + rand() * 3;
      for (const side of [-1, 1]) addRailAt(f, x + gz * side * 3, z - gx * side * 3, gx, gz, height, m === 'r' ? 'rail' : 'box', len);
      x += gx * (len + 22);
      z += gz * (len + 22);
    }
  }
  return { x: x0, z: z0, dx: gx, dz: gz };
}
