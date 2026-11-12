/**
 * Calcul d'itinéraire skieur sur le graphe réel pistes + remontées.
 * - Les pistes sont parcourues vers l'aval (sens vérifié avec le MNT, sinon convention OSM).
 * - Les remontées vers l'amont.
 * - Des liaisons à pied courtes raccordent les extrémités proches (gares, croisements).
 */
import type { Difficulty, Lift, LngLat, Piste } from './types';
import { haversine } from './geo';
import { descentMinutes, liftMinutes } from './estimates';

export type ElevationFn = (p: LngLat) => number | null;

interface Edge {
  to: number;
  minutes: number;
  lengthM: number;
  kind: 'piste' | 'lift' | 'walk';
  ref: string; // id piste / remontée
  label: string;
  difficulty?: Difficulty;
  liftKind?: string;
  coords: LngLat[];
}

export interface RouteStep {
  kind: 'piste' | 'lift' | 'walk';
  ref: string;
  label: string;
  difficulty?: Difficulty;
  liftKind?: string;
  minutes: number;
  lengthM: number;
}

export interface RouteResult {
  minutes: number;
  lengthM: number;
  steps: RouteStep[];
  coords: LngLat[];
  /** Segments colorés pour l'affichage. */
  legs: { kind: RouteStep['kind']; difficulty?: Difficulty; coords: LngLat[] }[];
}

export interface RouteOptions {
  avoid?: Difficulty[];
  closedLifts?: Set<string>;
  closedPistes?: Set<string>;
  liftWaitMin?: number;
}

const SNAP_M = 25;
const WALK_M = 90;
const WALK_SPEED = 0.9; // m/s (chaussures de ski, terrain enneigé)

export class SkiGraph {
  nodes: LngLat[] = [];
  adj: Edge[][] = [];
  private grid = new Map<string, number[]>();
  private cell = 0.0006; // ~50-65 m

  constructor(pistes: Piste[], lifts: Lift[], elev: ElevationFn, opts: RouteOptions = {}) {
    const avoid = new Set(opts.avoid ?? []);
    const wait = opts.liftWaitMin ?? 3;

    for (const p of pistes) {
      if (avoid.has(p.difficulty)) continue;
      if (opts.closedPistes?.has(p.id)) continue;
      for (const seg0 of p.segments) {
        if (seg0.length < 2) continue;
        let seg = seg0;
        const a = elev(seg[0]), b = elev(seg[seg.length - 1]);
        if (a != null && b != null && b - a > 5) seg = seg.slice().reverse();
        this.addPolyline(seg, (len) => ({
          kind: 'piste',
          ref: p.id,
          label: p.name,
          difficulty: p.difficulty,
          minutes: descentMinutes(len, p.difficulty),
        }));
      }
    }
    for (const l of lifts) {
      if (opts.closedLifts?.has(l.id)) continue;
      let line = l.line;
      const a = elev(line[0]), b = elev(line[line.length - 1]);
      if (a != null && b != null && a - b > 20) line = line.slice().reverse();
      const { minutes } = liftMinutes(l);
      // Une remontée = une seule arête (pas d'arrêt intermédiaire), départ -> arrivée.
      const from = this.nodeFor(line[0]);
      const to = this.nodeFor(line[line.length - 1]);
      this.adj[from].push({
        to,
        minutes: minutes + wait,
        lengthM: l.lengthM,
        kind: 'lift',
        ref: l.id,
        label: l.name,
        liftKind: l.kind,
        coords: line,
      });
    }
    this.addWalkLinks();
  }

  private gkey(p: LngLat) {
    return `${Math.floor(p[0] / this.cell)}:${Math.floor(p[1] / this.cell)}`;
  }

  private near(p: LngLat, radius: number): number[] {
    const r = Math.ceil(radius / 45);
    const gx = Math.floor(p[0] / this.cell), gy = Math.floor(p[1] / this.cell);
    const out: number[] = [];
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const ids = this.grid.get(`${gx + dx}:${gy + dy}`);
        if (ids) for (const id of ids) if (haversine(p, this.nodes[id]) <= radius) out.push(id);
      }
    return out;
  }

  private nodeFor(p: LngLat): number {
    let best = -1, bd = SNAP_M;
    for (const id of this.near(p, SNAP_M)) {
      const d = haversine(p, this.nodes[id]);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    if (best >= 0) return best;
    const id = this.nodes.length;
    this.nodes.push(p);
    this.adj.push([]);
    const k = this.gkey(p);
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k)!.push(id);
    return id;
  }

  private addPolyline(line: LngLat[], meta: (len: number) => Omit<Edge, 'to' | 'coords' | 'lengthM'>) {
    let prev = this.nodeFor(line[0]);
    let acc: LngLat[] = [line[0]];
    for (let i = 1; i < line.length; i++) {
      acc.push(line[i]);
      // On crée un nœud tous les sommets (permet les jonctions en milieu de piste).
      const id = this.nodeFor(line[i]);
      if (id === prev) continue;
      const len = haversine(line[i - 1], line[i]);
      this.adj[prev].push({ to: id, lengthM: len, coords: acc, ...meta(len) });
      prev = id;
      acc = [line[i]];
    }
  }

  private addWalkLinks() {
    const n = this.nodes.length;
    for (let i = 0; i < n; i++) {
      // On ne relie à pied que les nœuds « terminaux » (départ/arrivée) pour limiter le graphe.
      const degree = this.adj[i].length;
      if (degree > 1) continue;
      for (const j of this.near(this.nodes[i], WALK_M)) {
        if (j === i) continue;
        const d = haversine(this.nodes[i], this.nodes[j]);
        const e: Edge = { to: j, minutes: d / WALK_SPEED / 60, lengthM: d, kind: 'walk', ref: 'walk', label: 'Liaison à pied', coords: [this.nodes[i], this.nodes[j]] };
        this.adj[i].push(e);
        this.adj[j].push({ ...e, to: i, coords: [this.nodes[j], this.nodes[i]] });
      }
    }
  }

  /** Itinéraire le plus rapide entre deux points (gares / villages). */
  route(from: LngLat, to: LngLat, accessRadius = 900): RouteResult | null {
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevEdge: (Edge | null)[] = new Array(n).fill(null);
    const prevNode = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    for (const id of this.near(from, accessRadius)) {
      const m = haversine(from, this.nodes[id]) / WALK_SPEED / 60;
      if (m < dist[id]) {
        dist[id] = m;
        heap.push(id, m);
      }
    }
    const targets = new Map<number, number>();
    for (const id of this.near(to, accessRadius)) targets.set(id, haversine(to, this.nodes[id]) / WALK_SPEED / 60);
    if (!targets.size || !heap.size) return null;

    let bestT = -1, bestCost = Infinity;
    while (heap.size) {
      const [u, du] = heap.pop()!;
      if (du > dist[u]) continue;
      if (du >= bestCost) break;
      const tc = targets.get(u);
      if (tc != null && du + tc < bestCost) {
        bestCost = du + tc;
        bestT = u;
      }
      for (const e of this.adj[u]) {
        const nd = du + e.minutes;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prevEdge[e.to] = e;
          prevNode[e.to] = u;
          heap.push(e.to, nd);
        }
      }
    }
    if (bestT < 0) return null;

    const edges: Edge[] = [];
    for (let v = bestT; prevNode[v] >= 0; v = prevNode[v]) edges.push(prevEdge[v]!);
    edges.reverse();

    const steps: RouteStep[] = [];
    const legs: RouteResult['legs'] = [];
    const coords: LngLat[] = [];
    let lengthM = 0;
    for (const e of edges) {
      lengthM += e.lengthM;
      coords.push(...e.coords);
      const last = steps[steps.length - 1];
      if (last && last.ref === e.ref && last.kind === e.kind) {
        last.minutes += e.minutes;
        last.lengthM += e.lengthM;
        legs[legs.length - 1].coords.push(...e.coords.slice(1));
      } else {
        steps.push({ kind: e.kind, ref: e.ref, label: e.label, difficulty: e.difficulty, liftKind: e.liftKind, minutes: e.minutes, lengthM: e.lengthM });
        legs.push({ kind: e.kind, difficulty: e.difficulty, coords: e.coords.slice() });
      }
    }
    // On masque les micro-liaisons à pied (< 15 m) issues du raccordement des données.
    const visible = steps.filter((s) => !(s.kind === 'walk' && s.lengthM < 15));
    return { minutes: bestCost, lengthM, steps: visible, coords, legs };
  }
}

class MinHeap {
  private a: [number, number][] = [];
  get size() {
    return this.a.length;
  }
  push(id: number, k: number) {
    const a = this.a;
    a.push([id, k]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][1] <= a[i][1]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
