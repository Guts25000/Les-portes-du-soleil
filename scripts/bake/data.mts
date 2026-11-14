/**
 * Étape 2 : assemblage des données du secteur.
 * Relief IGN 2,5 m -> grille 5 m ; couvert arboré (orthophoto) ; pistes, routes, bâtiments (OSM) ;
 * terrassement sous les bâtiments et les lacs ; placement des sapins. Résultats intermédiaires dans le cache.
 */
import fs from 'node:fs';
import { BBOX, CACHE, CELL, HALF_D, HALF_W, NX, NZ, TILE, proj } from './def.mts';
import { loadSharp } from './def.mts';
import { boxBlur, fillRings, mulberry, px, pz, rast, stampDisc, strokeLine, vnoise } from './raster.mts';
import { transformOverpass } from '../../lib/osm';
import { distToPolygonEdge, modelBuilding, parseVillage, pointInPolygon, roadWidth, type BuildingModel } from '../../game/buildings';
import { resample } from '../../lib/geo';
import type { Difficulty, LngLat } from '../../lib/types';

const sharp = await loadSharp();
const ST = `${CACHE}/stage`;
fs.mkdirSync(ST, { recursive: true });
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const save = (name: string, a: ArrayBufferView) => fs.writeFileSync(`${ST}/${name}.bin`, Buffer.from(a.buffer, a.byteOffset, a.byteLength));

const TCOLS = (2 * HALF_W) / TILE, TROWS = (2 * HALF_D) / TILE;

// ------------------------------------------------------------------ relief 2,5 m
const R25 = rast(2.5);
const dem = new Float32Array(R25.w * R25.h).fill(NaN);
for (let j = 0; j < TROWS; j++)
  for (let i = 0; i < TCOLS; i++) {
    const b = fs.readFileSync(`${CACHE}/dem/${i}_${j}.bil`);
    const f = new Float32Array(b.buffer, b.byteOffset, 512 * 512);
    for (let r = 0; r < 512; r++)
      for (let c = 0; c < 512; c++) {
        const v = f[r * 512 + c];
        if (v > -500 && v < 5000) dem[(j * 512 + r) * R25.w + i * 512 + c] = v;
      }
  }
let holes = 0;
for (let pass = 0; pass < 50; pass++) {
  let n = 0;
  for (let k = 0; k < dem.length; k++) {
    if (!Number.isNaN(dem[k])) continue;
    const i = k % R25.w, j = (k / R25.w) | 0;
    let s = 0, c = 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= R25.w || jj >= R25.h) continue;
      const v = dem[jj * R25.w + ii];
      if (!Number.isNaN(v)) (s += v), c++;
    }
    if (c) dem[k] = s / c;
    else n++;
    if (pass === 0) holes++;
  }
  if (!n) break;
}
// le service renvoie des marches (données ~5 m rééchantillonnées au plus proche) : lissage en tente
boxBlur(dem, R25.w, R25.h, 1);
boxBlur(dem, R25.w, R25.h, 1);
log('relief IGN 2,5 m', R25.w, 'x', R25.h, 'trous comblés', holes);

// grille 5 m aux nœuds
const GW = NX + 1, GH = NZ + 1;
const H = new Float32Array(GW * GH);
for (let b = 0; b < GH; b++)
  for (let a = 0; a < GW; a++) {
    const i0 = Math.max(0, 2 * a - 1), i1 = Math.min(R25.w - 1, 2 * a), j0 = Math.max(0, 2 * b - 1), j1 = Math.min(R25.h - 1, 2 * b);
    H[b * GW + a] = (dem[j0 * R25.w + i0] + dem[j0 * R25.w + i1] + dem[j1 * R25.w + i0] + dem[j1 * R25.w + i1]) / 4;
  }
const heightAt = (x: number, z: number) => {
  const fx = Math.min(NX - 1e-6, Math.max(0, (x + HALF_W) / CELL)), fz = Math.min(NZ - 1e-6, Math.max(0, (z + HALF_D) / CELL));
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * GW + i;
  return H[k] * (1 - tx) * (1 - tz) + H[k + 1] * tx * (1 - tz) + H[k + GW] * (1 - tx) * tz + H[k + GW + 1] * tx * tz;
};

// ------------------------------------------------------------------ couvert arboré 1,25 m
const R1 = rast(1.25);
const canopy = new Uint8Array(R1.w * R1.h);
for (let j = 0; j < TROWS; j++)
  for (let i = 0; i < TCOLS; i++) {
    const { data } = await sharp(`${CACHE}/ortho/${i}_${j}.jpg`).raw().toBuffer({ resolveWithObject: true });
    for (let r = 0; r < 1024; r++)
      for (let c = 0; c < 1024; c++) {
        const q = (r * 1024 + c) * 3;
        const R = data[q], G = data[q + 1], B = data[q + 2];
        const lum = (R + G + B) / 3;
        canopy[(j * 1024 + r) * R1.w + i * 1024 + c] = R > 245 && G > 245 && B > 245 ? 255 : lum < 68 && R < 95 && Math.abs(R - G) < 25 ? 1 : 0;
      }
  }
const treePx = (x: number, z: number) => {
  const i = Math.round(px(R1, x)), j = Math.round(pz(R1, z));
  if (i < 1 || j < 1 || i >= R1.w - 1 || j >= R1.h - 1) return 0;
  let s = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += canopy[(j + dj) * R1.w + i + di] === 1 ? 1 : 0;
  return s / 9;
};
// fraction de couvert à 2,5 m
const canopy25 = new Float32Array(R25.w * R25.h);
for (let j = 0; j < R25.h; j++)
  for (let i = 0; i < R25.w; i++) {
    let s = 0;
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) s += canopy[(2 * j + dj) * R1.w + 2 * i + di] === 1 ? 1 : 0;
    canopy25[j * R25.w + i] = s / 4;
  }
log('couvert arboré (orthophoto IGN) ok, part boisée', (canopy25.reduce((a, b) => a + b, 0) / canopy25.length).toFixed(3));

// ------------------------------------------------------------------ OSM
const osm = JSON.parse(fs.readFileSync(`${CACHE}/osm.json`, 'utf8'));
const domain = transformOverpass(osm);
const inB = (p: LngLat, m = 0) => p[0] > BBOX.w + m && p[0] < BBOX.e - m && p[1] > BBOX.s + m * 0.7 && p[1] < BBOX.n - m * 0.7;
const pistes = domain.pistes.filter((p) => p.segments.some((s) => s.some((q) => inB(q))));
const lifts = domain.lifts.filter((l) => inB(l.line[0], 0.002) && inB(l.line[l.line.length - 1], 0.002));
const pois = domain.pois.filter((p) => inB(p.coord) && ['restaurant', 'bar', 'snowpark', 'hut'].includes(p.kind));
const village = parseVillage(osm.elements);
log('OSM : pistes', pistes.length, 'remontées', lifts.length, 'POI', pois.length, 'bâtiments (zone OSM)', village.buildings.length);
const L = (p: LngLat) => proj.toLocal(p);

// ------------------------------------------------------------------ pistes (largeur réelle d'après la forêt)
const NOMINAL: Record<Difficulty, number> = { verte: 30, bleue: 34, rouge: 30, noire: 26, freeride: 22, inconnue: 30 };
const pisteCov = new Float32Array(R25.w * R25.h);
const pisteEdge = new Float32Array(R25.w * R25.h);
const pisteC = new Float32Array(R25.w * R25.h);
const pisteS = new Float32Array(R25.w * R25.h);
const pisteHalf: Record<string, number> = {};
for (const p of pistes) {
  const nominal = (p.widthM ?? NOMINAL[p.difficulty]) / 2;
  const maxHalf = Math.min(28, nominal * 1.35);
  let sumHalf = 0, nHalf = 0;
  for (const seg of p.segments) {
    const pts = resample(seg.map(L), 2.5);
    if (pts.length < 2) continue;
    const n = pts.length;
    const lw = new Float32Array(n), rw = new Float32Array(n), nx = new Float32Array(n), nz = new Float32Array(n), ang = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 2)], b = pts[Math.min(n - 1, k + 2)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      nx[k] = dz / l;
      nz[k] = -dx / l;
      ang[k] = Math.atan2(dz, dx);
      for (const side of [1, -1]) {
        let d = 0;
        for (d = 2.5; d <= maxHalf; d += 1.25) if (treePx(pts[k].x + nx[k] * side * d, pts[k].z + nz[k] * side * d) > 0.55) break;
        const w = d > maxHalf ? nominal : Math.max(6, d - 1.5);
        (side > 0 ? lw : rw)[k] = w;
      }
    }
    // lissage le long de la piste (moyenne glissante ~25 m)
    const sm = (a: Float32Array) => {
      const o = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        let s = 0, c = 0;
        for (let q = Math.max(0, k - 5); q <= Math.min(n - 1, k + 5); q++) (s += a[q]), c++;
        o[k] = s / c;
      }
      return o;
    };
    const L2 = sm(lw), R2 = sm(rw);
    for (let k = 0; k < n; k++) {
      const off = (L2[k] - R2[k]) / 2, rad = (L2[k] + R2[k]) / 2;
      sumHalf += rad;
      nHalf++;
      const cx = pts[k].x + nx[k] * off, cz = pts[k].z + nz[k] * off;
      const c2 = Math.cos(2 * ang[k]), s2 = Math.sin(2 * ang[k]);
      stampDisc(R25, cx, cz, rad + 1, (i, d) => {
        const cov = Math.min(1, Math.max(0, (rad - d) / 1.5 + 0.5));
        if (cov > pisteCov[i]) {
          pisteCov[i] = cov;
          pisteC[i] = c2;
          pisteS[i] = s2;
        }
        const e = Math.min(1, Math.max(0, (d / rad - 0.78) / 0.22));
        if (cov > 0.5) pisteEdge[i] = pisteEdge[i] === 0 ? e : Math.min(pisteEdge[i], e);
      });
    }
  }
  pisteHalf[p.id] = nHalf ? sumHalf / nHalf : nominal;
}
// zones de piste et snowparks dessinés en surface dans OSM
for (const el of osm.elements) {
  const t = el.tags ?? {};
  if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
  if (!((t['piste:type'] === 'downhill' && t.area === 'yes') || t['piste:type'] === 'snow_park')) continue;
  const ring = el.geometry.map((g: { lon: number; lat: number }) => L([g.lon, g.lat]));
  fillRings(R25, [ring], (i) => (pisteCov[i] = 1));
}
log('pistes peintes, largeur moyenne', (Object.values(pisteHalf).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(pisteHalf).length) * 2).toFixed(1), 'm');

// ------------------------------------------------------------------ routes, eau, rochers
const DRIVE = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
// routes déneigées : grands axes partout, dessertes seulement près des bâtiments
const bHash = new Set<string>();
for (const b of village.buildings) for (const p of b.ring) { const l = L(p); bHash.add(`${Math.floor(l.x / 80)}:${Math.floor(l.z / 80)}`); }
const nearB = (x: number, z: number) => { const i = Math.floor(x / 80), j = Math.floor(z / 80); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (bHash.has(`${i + a}:${j + b}`)) return true; return false; };
const roads = village.roads.filter((r) => DRIVE.has(r.kind) && (r.kind !== 'service' && r.kind !== 'unclassified' ? true : r.line.every((p) => { const l = L(p); return nearB(l.x, l.z); })));
const roadCov = new Float32Array(R25.w * R25.h);
const bank = new Float32Array(R25.w * R25.h);
for (const r of roads) {
  const w = roadWidth(r.kind) / 2;
  strokeLine(R25, r.line.map(L), w + 2.5, (i, d) => {
    roadCov[i] = Math.max(roadCov[i], Math.min(1, Math.max(0, (w - d) / 1.2 + 0.5)));
    bank[i] = Math.max(bank[i], d > w - 0.5 ? 1 - Math.abs(d - w - 1) / 1.5 : 0);
  });
}
const water = new Float32Array(R25.w * R25.h); // 1 = lac gelé, 2 = rivière
for (const lk of village.lakes) fillRings(R25, [...lk.outer, ...lk.inner].map((r) => r.map(L)), (i) => (water[i] = 1));
for (const rv of village.rivers) if (rv.kind === 'river') strokeLine(R25, rv.line.map(L), 3.5, (i) => (water[i] = 2));
const rock = new Float32Array(R25.w * R25.h);
for (const r of village.rock) fillRings(R25, [...r.outer, ...r.inner].map((q) => q.map(L)), (i) => (rock[i] = 0.5));
for (const c of village.cliffs) strokeLine(R25, c.map(L), 3, (i) => (rock[i] = 1));
const parking = new Float32Array(R25.w * R25.h);
for (const pk of village.parkings) fillRings(R25, [pk.map(L)], (i) => (parking[i] = 1));

// ------------------------------------------------------------------ bâtiments + terrassement
const bld = new Float32Array(R25.w * R25.h); // hauteur des bâtiments au-dessus du sol
const apron = new Float32Array(R25.w * R25.h);
const kept: typeof village.buildings = [];
const models: BuildingModel[] = [];
const covAt = (x: number, z: number) => {
  const i = Math.round(px(R25, x)), j = Math.round(pz(R25, z));
  return i < 0 || j < 0 || i >= R25.w || j >= R25.h ? 0 : pisteCov[j * R25.w + i];
};
for (const b of village.buildings) {
  const fp = b.ring.map(L);
  if (!fp.some((p) => Math.abs(p.x) < HALF_W - 20 && Math.abs(p.z) < HALF_D - 20)) continue;
  if (fp.some((p) => covAt(p.x, p.z) > 0.6) && b.tags.aerialway !== 'station') continue;
  const m = modelBuilding(b.id, fp, b.tags, heightAt);
  if (!m) continue;
  kept.push(b);
  models.push(m);
}
const flatten = (fp: { x: number; z: number }[], base: number, R = 5) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of fp) (minX = Math.min(minX, p.x)), (maxX = Math.max(maxX, p.x)), (minZ = Math.min(minZ, p.z)), (maxZ = Math.max(maxZ, p.z));
  const i0 = Math.max(0, Math.floor((minX - R + HALF_W) / CELL)), i1 = Math.min(NX, Math.ceil((maxX + R + HALF_W) / CELL));
  const j0 = Math.max(0, Math.floor((minZ - R + HALF_D) / CELL)), j1 = Math.min(NZ, Math.ceil((maxZ + R + HALF_D) / CELL));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const x = -HALF_W + i * CELL, z = -HALF_D + j * CELL, k = j * GW + i;
      if (pointInPolygon(x, z, fp)) H[k] = base;
      else {
        const d = distToPolygonEdge(x, z, fp);
        if (d < R) {
          const t = Math.max(0, (d - 1) / (R - 1)), w = t * t * (3 - 2 * t);
          H[k] = base * (1 - w) + H[k] * w;
        }
      }
    }
};
for (const m of models) flatten(m.footprint, m.base - 0.05);
for (const lk of village.lakes) {
  const ring = lk.outer[0].map(L);
  if (!ring.some((p) => Math.abs(p.x) < HALF_W && Math.abs(p.z) < HALF_D)) continue;
  let lo = Infinity;
  for (const p of ring) lo = Math.min(lo, heightAt(p.x, p.z));
  flatten(ring, lo + 0.05, 8);
}
for (const m of models) {
  const roof = m.eaves + (m.ridge - m.eaves) * 0.6 + (m.base - m.foot) * 0;
  fillRings(R25, [m.footprint], (i) => (bld[i] = Math.max(bld[i], roof)));
  const ring = m.footprint;
  strokeLine(R25, [...ring, ring[0]], 4, (i, d) => (apron[i] = Math.max(apron[i], 1 - d / 4)));
}
log('bâtiments conservés', kept.length, '(hors pistes)');

// ------------------------------------------------------------------ remontées : couloirs déboisés
const liftCor = new Float32Array(R25.w * R25.h);
for (const l of lifts) strokeLine(R25, l.line.map(L), l.kind === 'teleski' || l.osmKind === 'drag_lift' || l.osmKind === 't-bar' || l.osmKind === 'platter' ? 4 : 8, (i) => (liftCor[i] = 1));

// ------------------------------------------------------------------ sapins
const rnd = mulberry(20260301);
const SP = 6;
const trees: number[] = []; // x, z, s, rot, density
for (let z = -HALF_D + 3; z < HALF_D - 3; z += SP)
  for (let x = -HALF_W + 3; x < HALF_W - 3; x += SP) {
    const tx = x + (rnd() - 0.5) * SP * 0.9, tz = z + (rnd() - 0.5) * SP * 0.9;
    const d = treePx(tx, tz);
    const p = d > 0.55 ? 1 : d > 0.3 ? 0.55 : d > 0.12 ? 0.12 : 0;
    if (!p || rnd() > p) continue;
    const i = Math.round(px(R25, tx)), j = Math.round(pz(R25, tz));
    if (i < 1 || j < 1 || i >= R25.w - 1 || j >= R25.h - 1) continue;
    const k = j * R25.w + i;
    let blocked = false;
    for (const q of [k, k - 1, k + 1, k - R25.w, k + R25.w]) if (pisteCov[q] > 0.15 || roadCov[q] > 0.05 || bank[q] > 0.3 || bld[q] > 0 || apron[q] > 0.3 || liftCor[q] > 0 || water[q] > 0 || parking[q] > 0) blocked = true;
    if (blocked) continue;
    const h = heightAt(tx, tz);
    const alt = Math.min(1, Math.max(0, (h - 1550) / 400));
    const s = (1.15 + rnd() * 0.65) * (1 - alt * 0.45) * (d > 0.3 ? 1 : 0.8);
    trees.push(tx, tz, s, rnd() * Math.PI * 2, d);
  }
log('sapins placés', trees.length / 5);

// ------------------------------------------------------------------ sauvegarde
save('H', H);
save('dem25', dem);
save('canopy25', canopy25);
save('pisteCov', pisteCov);
save('pisteEdge', pisteEdge);
save('pisteC', pisteC);
save('pisteS', pisteS);
save('roadCov', roadCov);
save('bank', bank);
save('water', water);
save('rock', rock);
save('parking', parking);
save('bld', bld);
save('apron', apron);
save('liftCor', liftCor);
save('trees', new Float32Array(trees));
fs.writeFileSync(
  `${ST}/osm.json`,
  JSON.stringify({
    pistes: pistes.map((p) => ({ ...p, widthM: p.widthM ?? Math.round(pisteHalf[p.id] * 2) })),
    lifts,
    pois,
    village: { buildings: kept, pylons: village.pylons.filter((p) => inB(p)) },
  }),
);
log('terminé');
void boxBlur;
void vnoise;
