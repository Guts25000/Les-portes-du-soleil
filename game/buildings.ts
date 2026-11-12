/**
 * Bâtiments réels (empreintes OpenStreetMap) pour le Ski Simulator.
 * - Les emprises et le nombre d'étages viennent d'OSM.
 * - Les chalets (emprise quasi rectangulaire) reçoivent un toit à deux pans enneigé ;
 *   les grands bâtiments irréguliers sont extrudés avec un toit plat enneigé.
 * Aucune dépendance à Three.js : ce module produit des tableaux de sommets (testables).
 */
import type { LngLat } from '@/lib/types';
import type { Pt } from './track';

export interface OsmBuilding {
  id: number;
  ring: LngLat[];
  tags: Record<string, string>;
}

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export interface OsmRoad {
  id: number;
  line: LngLat[];
  kind: string;
}

export interface OsmForest {
  outer: LngLat[][];
  inner: LngLat[][];
}

export interface Village {
  buildings: OsmBuilding[];
  roads: OsmRoad[];
  forests: OsmForest[];
  pylons: LngLat[];
  lakes: OsmForest[];
  rivers: { line: LngLat[]; kind: string }[];
  rock: OsmForest[];
  cliffs: LngLat[][];
  parkings: LngLat[][];
}

/** Assemble des tronçons de ligne en anneaux fermés (multipolygones OSM). */
export function assembleRings(parts: LngLat[][]): LngLat[][] {
  const same = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  const rest = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  const rings: LngLat[][] = [];
  while (rest.length) {
    let ring = rest.shift()!;
    let grown = true;
    while (!same(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i];
        const tail = ring[ring.length - 1];
        if (same(tail, p[0])) ring = ring.concat(p.slice(1));
        else if (same(tail, p[p.length - 1])) ring = ring.concat(p.slice(0, -1).reverse());
        else continue;
        rest.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Bâtiments, routes, forêts et pylônes du secteur (une seule requête Overpass). */
export async function fetchVillage(bbox: [number, number, number, number]): Promise<Village> {
  const [w, s, e, n] = bbox;
  const b = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:90];(way["building"](${b});way["aerialway"="station"](${b});way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)$"](${b});way["landuse"="forest"](${b});way["natural"="wood"](${b});rel["landuse"="forest"](${b});rel["natural"="wood"](${b});node["aerialway"="pylon"](${b});way["natural"~"^(water|bare_rock|scree|cliff)$"](${b});rel["natural"~"^(water|bare_rock|scree)$"](${b});way["waterway"~"^(river|stream)$"](${b});way["amenity"="parking"](${b}););out geom;`;
  let lastErr: unknown = null;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      type G = { lat: number; lon: number }[];
      const j = (await r.json()) as {
        elements: { type: string; id: number; lat?: number; lon?: number; geometry?: G; tags?: Record<string, string>; members?: { type: string; role: string; geometry?: G }[] }[];
      };
      return parseVillage(j.elements);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('Overpass indisponible');
}

type RawEl = { type: string; id: number; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>; members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[] };

export function parseVillage(elements: RawEl[]): Village {
  const buildings: OsmBuilding[] = [];
  const roads: OsmRoad[] = [];
  const forests: OsmForest[] = [];
  const pylons: LngLat[] = [];
  const lakes: OsmForest[] = [], rock: OsmForest[] = [];
  const rivers: { line: LngLat[]; kind: string }[] = [];
  const cliffs: LngLat[][] = [], parkings: LngLat[][] = [];
  const toLine = (g: { lat: number; lon: number }[]) => g.map((p) => [p.lon, p.lat] as LngLat);
  for (const el of elements) {
    const t = el.tags ?? {};
    const isForest = t.landuse === 'forest' || t.natural === 'wood';
    if (el.type === 'node') {
      if (t.aerialway === 'pylon' && el.lat != null && el.lon != null) pylons.push([el.lon, el.lat]);
      continue;
    }
    const isLake = t.natural === 'water';
    const isRock = t.natural === 'bare_rock' || t.natural === 'scree';
    if (el.type === 'relation') {
      if (!(isForest || isLake || isRock) || !el.members) continue;
      const outer = assembleRings(el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => toLine(m.geometry!)));
      const inner = assembleRings(el.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => toLine(m.geometry!)));
      if (outer.length) (isForest ? forests : isLake ? lakes : rock).push({ outer, inner });
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const line = toLine(el.geometry);
    if (isForest || isLake || isRock) {
      if (line.length >= 4) (isForest ? forests : isLake ? lakes : rock).push({ outer: [line], inner: [] });
    } else if (t.natural === 'cliff') cliffs.push(line);
    else if (t.waterway) rivers.push({ line, kind: t.waterway });
    else if (t.amenity === 'parking') {
      if (line.length >= 4) parkings.push(line);
    } else if (t.highway) roads.push({ id: el.id, line, kind: t.highway });
    else if (t.building || t.aerialway === 'station') {
      if (line.length >= 4) buildings.push({ id: el.id, ring: line, tags: t });
    }
  }
  return { buildings, roads, forests, pylons, lakes, rivers, rock, cliffs, parkings };
}

/** Largeur (m) d'une route selon son type OSM. */
export function roadWidth(kind: string): number {
  return ({ trunk: 9, primary: 8, secondary: 7, tertiary: 6, unclassified: 5, residential: 5, living_street: 4, service: 3.5 } as Record<string, number>)[kind] ?? 4;
}

// ------------------------------------------------------------------ géométrie plane

export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i].x * p[j].z - p[j].x * p[i].z;
  }
  return a / 2;
}

export function pointInPolygon(x: number, z: number, p: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i].x, zi = p[i].z, xj = p[j].x, zj = p[j].z;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToPolygonEdge(x: number, z: number, p: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)));
  }
  return best;
}

function convexHull(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Rectangle d'aire minimale (calipers tournants sur l'enveloppe convexe). */
export function minAreaRect(pts: Pt[]): { cx: number; cz: number; w: number; d: number; angle: number; area: number } {
  const h = convexHull(pts);
  let best = { cx: 0, cz: 0, w: 0, d: 0, angle: 0, area: Infinity };
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ang = Math.atan2(b.z - a.z, b.x - a.x);
    const c = Math.cos(ang), s = Math.sin(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const q of h) {
      const u = q.x * c + q.z * s, v = -q.x * s + q.z * c;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { cx: cu * c - cv * s, cz: cu * s + cv * c, w: maxU - minU, d: maxV - minV, angle: ang, area };
    }
  }
  return best;
}

/** Triangulation par oreilles (polygone simple). Retourne des triplets d'indices. */
export function earClip(poly: Pt[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = polygonArea(poly) > 0;
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const isConvex = (a: Pt, b: Pt, c: Pt) => {
    const cr = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    return ccw ? cr > 0 : cr < 0;
  };
  const inTri = (p: Pt, a: Pt, b: Pt, c: Pt) => {
    const d1 = (p.x - b.x) * (a.z - b.z) - (a.x - b.x) * (p.z - b.z);
    const d2 = (p.x - c.x) * (b.z - c.z) - (b.x - c.x) * (p.z - c.z);
    const d3 = (p.x - a.x) * (c.z - a.z) - (c.x - a.x) * (p.z - a.z);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (!isConvex(a, b, c)) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(poly[j], a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // polygone dégénéré : on s'arrête proprement
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

// ------------------------------------------------------------------ modèle

export interface BuildingModel {
  id: number;
  footprint: Pt[];
  cx: number;
  cz: number;
  radius: number;
  base: number; // niveau du rez-de-chaussée
  foot: number; // bas des murs (sous le point le plus bas du terrain)
  eaves: number; // hauteur des murs (au-dessus de base)
  ridge: number; // hauteur du faîtage
  kind: 'chalet' | 'bloc';
}

function num(v?: string) {
  const n = v ? parseFloat(v.replace(',', '.')) : NaN;
  return isFinite(n) ? n : undefined;
}

export function wallHeight(tags: Record<string, string>, area: number): number {
  const h = num(tags.height);
  if (h) return Math.max(2.5, h * 0.75); // la hauteur OSM inclut le toit
  const lv = num(tags['building:levels']);
  if (lv) return Math.max(2.6, lv * 2.8);
  const b = tags.building;
  if (b === 'garage' || b === 'shed' || b === 'hut' || b === 'cabin' || area < 40) return 2.8;
  if (b === 'apartments' || b === 'hotel') return 11;
  if (b === 'church' || b === 'chapel') return 9;
  if (area > 600) return 9;
  return 6;
}

export function modelBuilding(id: number, footprint: Pt[], tags: Record<string, string>, height: (x: number, z: number) => number): BuildingModel | null {
  let poly = footprint.slice();
  if (poly.length > 3 && poly[0].x === poly[poly.length - 1].x && poly[0].z === poly[poly.length - 1].z) poly.pop();
  if (poly.length < 3) return null;
  const area = Math.abs(polygonArea(poly));
  if (area < 8 || area > 25000) return null;
  const r = minAreaRect(poly);
  const fill = area / r.area;
  const chalet = fill > 0.85 && area < 3000 && tags.roof_shape !== 'flat';
  let lo = Infinity, sum = 0;
  for (const p of poly) {
    const h = height(p.x, p.z);
    lo = Math.min(lo, h);
    sum += h;
  }
  const hc = height(r.cx, r.cz);
  lo = Math.min(lo, hc);
  const base = (sum + hc) / (poly.length + 1);
  const foot = lo - 1;
  const eaves = wallHeight(tags, area);
  const span = Math.min(r.w, r.d);
  const ridge = chalet ? eaves + Math.min(7, span * 0.25) : eaves;
  let radius = 0;
  for (const p of poly) radius = Math.max(radius, Math.hypot(p.x - r.cx, p.z - r.cz));
  return { id, footprint: poly, cx: r.cx, cz: r.cz, radius, base, foot, eaves, ridge, kind: chalet ? 'chalet' : 'bloc' };
}

// ------------------------------------------------------------------ maillage

export interface MeshArrays {
  positions: number[];
  normals: number[];
  colors: number[];
}

type V3 = [number, number, number];
type C3 = [number, number, number];

const WOOD: C3 = [0.42, 0.27, 0.16];
const WOOD_DARK: C3 = [0.33, 0.2, 0.12];
const STONE: C3 = [0.72, 0.71, 0.68];
const SNOW: C3 = [0.95, 0.97, 1.0];
const ROOF_EDGE: C3 = [0.25, 0.2, 0.18];
const WINDOW: C3 = [0.12, 0.16, 0.22];
const RENDER: C3 = [0.86, 0.83, 0.76];

function pushTri(m: MeshArrays, a: V3, b: V3, c: V3, n: V3, col: C3) {
  // ordre des sommets cohérent avec la normale (face avant)
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * n[0] + cy * n[1] + cz * n[2] < 0) [b, c] = [c, b];
  for (const v of [a, b, c]) {
    m.positions.push(v[0], v[1], v[2]);
    m.normals.push(n[0], n[1], n[2]);
    m.colors.push(col[0], col[1], col[2]);
  }
}

function pushQuad(m: MeshArrays, a: V3, b: V3, c: V3, d: V3, n: V3, col: C3) {
  pushTri(m, a, b, c, n, col);
  pushTri(m, a, c, d, n, col);
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function addChalet(m: MeshArrays, b: BuildingModel, rect: ReturnType<typeof minAreaRect>) {
  // axes : u le long du faîtage (côté long), v en travers
  let ang = rect.angle, W = rect.w, D = rect.d;
  if (D > W) {
    ang += Math.PI / 2;
    [W, D] = [D, W];
  }
  const cu = Math.cos(ang), su = Math.sin(ang);
  const P = (u: number, v: number, y: number): V3 => [b.cx + u * cu - v * su, y, b.cz + u * su + v * cu];
  const y0 = b.foot, yS = b.base + 1.4, yE = b.base + b.eaves, yR = b.base + b.ridge;
  const hw = W / 2, hd = D / 2;
  const nU: V3 = [cu, 0, su], nV: V3 = [-su, 0, cu];
  const neg = (n: V3): V3 => [-n[0], -n[1], -n[2]];
  // murs : soubassement en pierre puis bois
  const walls: [number, number, number, number, V3][] = [
    [-hw, -hd, hw, -hd, neg(nV)],
    [hw, -hd, hw, hd, nU],
    [hw, hd, -hw, hd, nV],
    [-hw, hd, -hw, -hd, neg(nU)],
  ];
  for (const [u1, v1, u2, v2, n] of walls) {
    pushQuad(m, P(u1, v1, y0), P(u2, v2, y0), P(u2, v2, yS), P(u1, v1, yS), n, STONE);
    pushQuad(m, P(u1, v1, yS), P(u2, v2, yS), P(u2, v2, yE), P(u1, v1, yE), n, WOOD);
    // fenêtres (légèrement en saillie)
    const len = Math.hypot(u2 - u1, v2 - v1);
    const floors = Math.max(1, Math.round((b.eaves - 1.4) / 2.8));
    const per = Math.max(1, Math.floor(len / 3.2));
    for (let f = 0; f < floors; f++) {
      const ya = yS + 0.9 + f * 2.8, yb = ya + 1.2;
      if (yb > yE - 0.3) break;
      for (let k = 0; k < per; k++) {
        const t0 = (k + 0.3) / per, t1 = (k + 0.7) / per;
        const off = 0.06;
        const a = P(u1 + (u2 - u1) * t0 + n[0] * 0, v1 + (v2 - v1) * t0, ya);
        const bb = P(u1 + (u2 - u1) * t1, v1 + (v2 - v1) * t1, ya);
        const sh: V3 = [n[0] * off, 0, n[2] * off];
        const add = (p: V3, y: number): V3 => [p[0] + sh[0], y, p[2] + sh[2]];
        pushQuad(m, add(a, ya), add(bb, ya), add(bb, yb), add(a, yb), n, WINDOW);
      }
    }
  }
  // pignons (triangles bois sombre)
  for (const [u, n] of [[-hw, neg(nU)], [hw, nU]] as [number, V3][]) {
    pushTri(m, P(u, -hd, yE), P(u, hd, yE), P(u, 0, yR), n, WOOD_DARK);
  }
  // toit à deux pans avec débord, enneigé (+ face inférieure)
  const ov = 0.9;
  const drop = ((yR - yE) / hd) * ov;
  for (const side of [-1, 1]) {
    const a = P(-hw - ov, side * (hd + ov), yE - drop), bq = P(hw + ov, side * (hd + ov), yE - drop);
    const c = P(hw + ov, 0, yR), d = P(-hw - ov, 0, yR);
    const slopeN = norm([nV[0] * side * (yR - yE), hd, nV[2] * side * (yR - yE)]);
    pushQuad(m, a, bq, c, d, slopeN, SNOW);
    const lift = (p: V3): V3 => [p[0], p[1] - 0.25, p[2]];
    pushQuad(m, lift(a), lift(bq), lift(c), lift(d), neg(slopeN), ROOF_EDGE);
    // tranche du toit
    pushQuad(m, a, bq, lift(bq), lift(a), norm([nV[0] * side, 0, nV[2] * side]), ROOF_EDGE);
  }
}

function addBloc(m: MeshArrays, b: BuildingModel) {
  const poly = b.footprint;
  const ccw = polygonArea(poly) > 0;
  const y0 = b.foot, yE = b.base + b.eaves;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dx = q.x - p.x, dz = q.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    const n: V3 = ccw ? [dz / l, 0, -dx / l] : [-dz / l, 0, dx / l];
    pushQuad(m, [p.x, y0, p.z], [q.x, y0, q.z], [q.x, yE, q.z], [p.x, yE, p.z], n, RENDER);
    // bandeau de fenêtres par étage
    const floors = Math.max(1, Math.floor(b.eaves / 2.9));
    for (let f = 0; f < floors; f++) {
      const ya = b.base + 1 + f * 2.9, yb = ya + 1.1;
      if (yb > yE - 0.3 || l < 3) continue;
      const o = 0.05;
      pushQuad(m, [p.x + n[0] * o + dx * 0.1, ya, p.z + n[2] * o + dz * 0.1], [q.x + n[0] * o - dx * 0.1, ya, q.z + n[2] * o - dz * 0.1], [q.x + n[0] * o - dx * 0.1, yb, q.z + n[2] * o - dz * 0.1], [p.x + n[0] * o + dx * 0.1, yb, p.z + n[2] * o + dz * 0.1], n, WINDOW);
    }
  }
  const tris = earClip(poly);
  for (let i = 0; i < tris.length; i += 3) {
    const a = poly[tris[i]], bb = poly[tris[i + 1]], c = poly[tris[i + 2]];
    pushTri(m, [a.x, yE, a.z], [bb.x, yE, bb.z], [c.x, yE, c.z], [0, 1, 0], SNOW);
  }
}

export function buildBuildingMesh(models: BuildingModel[]): MeshArrays {
  const m: MeshArrays = { positions: [], normals: [], colors: [] };
  for (const b of models) {
    if (b.kind === 'chalet') addChalet(m, b, minAreaRect(b.footprint));
    else addBloc(m, b);
  }
  return m;
}
