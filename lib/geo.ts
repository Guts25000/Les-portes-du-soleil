import type { LngLat } from './types';

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLength(line: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]);
  return d;
}

/** Point situé à la moitié de la longueur d'une ligne. */
export function midpoint(line: LngLat[]): LngLat {
  const total = lineLength(line);
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = haversine(line[i - 1], line[i]);
    if (acc + seg >= total / 2) {
      const t = seg === 0 ? 0 : (total / 2 - acc) / seg;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    acc += seg;
  }
  return line[Math.floor(line.length / 2)];
}

export function bboxOf(points: LngLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Projection locale équirectangulaire en mètres (x vers l'est, z vers le sud — repère Three.js). */
export class LocalProjection {
  readonly lon0: number;
  readonly lat0: number;
  private kx: number;
  private kz: number;
  constructor(center: LngLat) {
    this.lon0 = center[0];
    this.lat0 = center[1];
    this.kx = (Math.PI / 180) * R * Math.cos(toRad(center[1]));
    this.kz = (Math.PI / 180) * R;
  }
  toLocal(p: LngLat): { x: number; z: number } {
    return { x: (p[0] - this.lon0) * this.kx, z: -(p[1] - this.lat0) * this.kz };
  }
  toLngLat(x: number, z: number): LngLat {
    return [this.lon0 + x / this.kx, this.lat0 - z / this.kz];
  }
}

/** Distance (m) d'un point à une polyligne, approximation plane locale. */
export function distanceToLine(p: LngLat, line: LngLat[]): number {
  const proj = new LocalProjection(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = proj.toLocal(line[i - 1]);
    const b = proj.toLocal(line[i]);
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 === 0 ? 0 : -(a.x * dx + a.z * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx, z = a.z + t * dz;
    const d = Math.hypot(x, z);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Chaîne des segments OSM d'une même piste en une ligne continue.
 * Joint les extrémités distantes de moins de `tol` mètres. Si certains segments
 * ne se raccordent pas, la plus longue chaîne obtenue est retournée.
 */
export function chainSegments(segments: LngLat[][], tol = 40): LngLat[] {
  const remaining = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  if (remaining.length === 0) return [];
  remaining.sort((a, b) => lineLength(b) - lineLength(a));
  const chains: LngLat[][] = [];
  while (remaining.length) {
    let chain = remaining.shift()!;
    let grown = true;
    while (grown) {
      grown = false;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        const head = chain[0], tail = chain[chain.length - 1];
        const sHead = s[0], sTail = s[s.length - 1];
        let joined: LngLat[] | null = null;
        if (haversine(tail, sHead) < tol) joined = chain.concat(s.slice(1));
        else if (haversine(tail, sTail) < tol) joined = chain.concat(s.slice(0, -1).reverse());
        else if (haversine(sTail, head) < tol) joined = s.concat(chain.slice(1));
        else if (haversine(sHead, head) < tol) joined = s.slice().reverse().concat(chain.slice(1));
        if (joined) {
          chain = joined;
          remaining.splice(i, 1);
          grown = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  chains.sort((a, b) => lineLength(b) - lineLength(a));
  return chains[0];
}

/** Rééchantillonne une ligne locale (x,z) tous les `step` mètres. */
export function resample(points: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  if (points.length < 2) return points.slice();
  const out = [{ ...points[0] }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = points[points.length - 1];
  const l = out[out.length - 1];
  if (Math.hypot(last.x - l.x, last.z - l.z) > step * 0.3) out.push({ ...last });
  return out;
}

/** Lissage par moyenne glissante (préserve les extrémités). */
export function smooth(points: { x: number; z: number }[], radius: number): { x: number; z: number }[] {
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return { ...p };
    let sx = 0, sz = 0, n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(points.length - 1, i + radius); k++) {
      sx += points[k].x;
      sz += points[k].z;
      n++;
    }
    return { x: sx / n, z: sz / n };
  });
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
