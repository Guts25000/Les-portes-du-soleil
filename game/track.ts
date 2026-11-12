/** Outils purs (sans Three.js) : tracé de piste local, index spatial, aléa déterministe. */

export interface Pt {
  x: number;
  z: number;
}

export class Track {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly s: Float64Array; // abscisse curviligne cumulée
  readonly total: number;
  readonly n: number;

  constructor(points: Pt[]) {
    this.n = points.length;
    this.xs = new Float64Array(points.map((p) => p.x));
    this.zs = new Float64Array(points.map((p) => p.z));
    this.s = new Float64Array(this.n);
    for (let i = 1; i < this.n; i++) this.s[i] = this.s[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.zs[i] - this.zs[i - 1]);
    this.total = this.s[this.n - 1];
  }

  /** Point et tangente unitaire à l'abscisse s. */
  at(s: number): { x: number; z: number; tx: number; tz: number; i: number } {
    const S = Math.max(0, Math.min(this.total, s));
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.s[m] <= S) lo = m;
      else hi = m;
    }
    const seg = this.s[hi] - this.s[lo] || 1;
    const t = (S - this.s[lo]) / seg;
    const dx = this.xs[hi] - this.xs[lo], dz = this.zs[hi] - this.zs[lo];
    const len = Math.hypot(dx, dz) || 1;
    return { x: this.xs[lo] + dx * t, z: this.zs[lo] + dz * t, tx: dx / len, tz: dz / len, i: lo };
  }

  /**
   * Projection d'un point sur le tracé, recherche locale autour de `hint` (index de segment).
   * lateral > 0 : à gauche du sens de descente.
   */
  nearest(x: number, z: number, hint: number, back = 40, ahead = 80): { i: number; s: number; dist: number; lateral: number } {
    let best = { i: hint, s: this.s[Math.max(0, Math.min(this.n - 1, hint))], dist: Infinity, lateral: 0 };
    const i0 = Math.max(0, hint - back), i1 = Math.min(this.n - 2, hint + ahead);
    for (let i = i0; i <= i1; i++) {
      const ax = this.xs[i], az = this.zs[i];
      const dx = this.xs[i + 1] - ax, dz = this.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best.dist) {
        const l = Math.sqrt(l2);
        // gauche du sens (dx,dz) dans le repère x-est / z-sud, vu d'en haut avec y vers le haut : (dz, -dx)
        const cross = ((x - px) * dz - (z - pz) * dx) / l;
        best = { i, s: this.s[i] + t * l, dist: d, lateral: cross };
      }
    }
    return best;
  }

  /** Recherche globale (utilisée pour initialiser / après une perte du tracé). */
  nearestGlobal(x: number, z: number) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return this.nearest(x, z, bi, 3, 3);
  }

  /** Variation de cap (rad) entre s-w et s+w : mesure de la courbure. */
  turnAngle(s: number, w = 25): number {
    const a = this.at(s - w), b = this.at(s + w);
    return Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz);
  }
}

export class SpatialHash {
  private cells = new Map<number, number[]>();
  readonly xs: number[] = [];
  readonly zs: number[] = [];
  readonly rs: number[] = [];
  constructor(private cell: number) {}
  private key(ix: number, iz: number) {
    return ix * 73856093 ^ iz * 19349663;
  }
  insert(x: number, z: number, r = 0): number {
    const id = this.xs.length;
    this.xs.push(x);
    this.zs.push(z);
    this.rs.push(r);
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let arr = this.cells.get(k);
    if (!arr) this.cells.set(k, (arr = []));
    arr.push(id);
    return id;
  }
  /** Identifiants des points à moins de `radius` (+ leur rayon propre). */
  query(x: number, z: number, radius: number, out: number[] = []): number[] {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const arr = this.cells.get(this.key(cx + dx, cz + dz));
        if (!arr) continue;
        for (const id of arr) {
          const d = Math.hypot(this.xs[id] - x, this.zs[id] - z);
          if (d <= radius + this.rs[id]) out.push(id);
        }
      }
    return out;
  }
  minDist(x: number, z: number, radius: number): number {
    let best = Infinity;
    for (const id of this.query(x, z, radius)) best = Math.min(best, Math.hypot(this.xs[id] - x, this.zs[id] - z));
    return best;
  }
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Bruit de valeur 2D lissé, [0,1]. */
export function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, z: number): number {
  return 0.55 * valueNoise(x, z) + 0.3 * valueNoise(x * 2.1 + 5.3, z * 2.1 - 1.7) + 0.15 * valueNoise(x * 4.3 - 9.1, z * 4.3 + 2.2);
}
