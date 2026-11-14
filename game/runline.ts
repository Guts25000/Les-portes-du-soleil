/**
 * Tracé de course d'une piste : la plus longue descente continue à travers ses tronçons OSM.
 * Les tronçons sont orientés vers l'aval d'après le relief, puis enchaînés quand la fin de l'un
 * rejoint un point d'un autre (départ ou milieu, ≤ 25 m). Évite les allers-retours quand
 * une piste est dessinée en plusieurs morceaux dans des sens différents.
 */
import type { Pt } from './track';

const JOIN = 25;

export function buildRunLine(segments: Pt[][], height: (x: number, z: number) => number): Pt[] {
  const segs = segments
    .filter((s) => s.length >= 2)
    .map((s) => (height(s[0].x, s[0].z) >= height(s[s.length - 1].x, s[s.length - 1].z) ? s : s.slice().reverse()));
  if (!segs.length) return [];
  const cum = segs.map((s) => {
    const c = [0];
    for (let i = 1; i < s.length; i++) c.push(c[i - 1] + Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z));
    return c;
  });
  const len = (a: number, from: number) => cum[a][cum[a].length - 1] - cum[a][from];
  // successeurs : (segment, indice d'entrée)
  const next: [number, number][][] = segs.map((s, a) => {
    const end = s[s.length - 1], hEnd = height(end.x, end.z);
    const out: [number, number][] = [];
    segs.forEach((t, b) => {
      if (b === a) return;
      let best = -1, bd = JOIN;
      for (let k = 0; k < t.length - 1; k++) {
        const d = Math.hypot(t[k].x - end.x, t[k].z - end.z);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best >= 0 && height(t[best].x, t[best].z) <= hEnd + 6 && len(b, best) > 15) out.push([b, best]);
    });
    return out;
  });
  const memo = new Map<number, { gain: number; via: [number, number] | null }>();
  const visiting = new Set<number>();
  const bestEnd = (a: number): { gain: number; via: [number, number] | null } => {
    const m = memo.get(a);
    if (m) return m;
    if (visiting.has(a)) return { gain: 0, via: null };
    visiting.add(a);
    let r: { gain: number; via: [number, number] | null } = { gain: 0, via: null };
    for (const [b, k] of next[a]) {
      const g = len(b, k) + bestEnd(b).gain;
      if (g > r.gain) r = { gain: g, via: [b, k] };
    }
    visiting.delete(a);
    memo.set(a, r);
    return r;
  };
  let start = 0, bestTotal = -1;
  segs.forEach((_, a) => {
    const t = len(a, 0) + bestEnd(a).gain;
    if (t > bestTotal) {
      bestTotal = t;
      start = a;
    }
  });
  const out: Pt[] = [...segs[start]];
  const used = new Set([start]);
  let cur = start;
  for (;;) {
    const v = bestEnd(cur).via;
    if (!v || used.has(v[0])) break;
    const [b, k] = v;
    out.push(...segs[b].slice(k + 1));
    used.add(b);
    cur = b;
  }
  return out;
}
