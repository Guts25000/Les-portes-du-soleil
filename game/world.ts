/**
 * Monde pré-calculé du secteur Pléney – Nyon – Les Gets (dossier public/world, produit par scripts/bake).
 * Chargé une seule fois par visite : les descentes suivantes démarrent instantanément.
 */
import { LocalProjection } from '@/lib/geo';
import type { Lift, LngLat, Piste, Poi } from '@/lib/types';
import type { OsmBuilding } from './buildings';

export interface Grid {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  cx: number;
  cz: number;
  h: Float32Array;
}

export interface WorldMeta {
  center: LngLat;
  bbox: [number, number, number, number];
  cell: number;
  nx: number;
  nz: number;
  halfW: number;
  halfD: number;
  hmin: number;
  far: { halfX: number; halfZ: number; cell: number; nx: number; nz: number; hmin: number };
  sun: { x: number; y: number; z: number };
  texM: number;
  tiles: { i: number; j: number; w: number; h: number }[];
  tileSize: number;
  trees: { count: number; chunk: number; cols: number; rows: number; step: number };
  sources: Record<string, string>;
  files: Record<string, number>;
  generated: string;
}

export interface WorldImages {
  albedo: Map<string, ImageBitmap>;
  light: Map<string, ImageBitmap>;
  aux: ImageBitmap;
  dir: ImageBitmap;
  farAlbedo: ImageBitmap;
  farLight: ImageBitmap;
}

export interface World {
  meta: WorldMeta;
  proj: LocalProjection;
  grid: Grid;
  far: Grid;
  /** Masque aux nœuds 5 m : 1 piste, 2 route, 4 eau, 8 bâtiment. */
  mask: Uint8Array;
  treeOffsets: Uint32Array;
  treeData: Uint8Array;
  pistes: Piste[];
  lifts: Lift[];
  pois: Poi[];
  buildings: OsmBuilding[];
  pylons: LngLat[];
  images: WorldImages;
  /** Ensoleillement (ombres du relief × ombres des arbres), 5 m, ligne 0 = nord. */
  sunVis: Uint8Array;
  sunW: number;
  sunH: number;
}

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH || '') + '/world/';

export function gridHeight(g: Grid, x: number, z: number): number | null {
  const fx = (x - g.minX) / g.cx, fz = (z - g.minZ) / g.cz;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return null;
  const ix = Math.min(g.nx - 2, Math.floor(fx)), iz = Math.min(g.nz - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const i = iz * g.nx + ix;
  const a = g.h[i], b = g.h[i + 1], c = g.h[i + g.nx], d = g.h[i + g.nx + 1];
  return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
}

export function insideWorld(w: World, p: LngLat, margin = 0) {
  const [W, S, E, N] = w.meta.bbox;
  return p[0] > W + margin && p[0] < E - margin && p[1] > S + margin * 0.7 && p[1] < N - margin * 0.7;
}

let cached: Promise<World> | null = null;

/** Charge le monde (une seule fois). onProgress(fraction 0..1, libellé). */
export function loadWorld(onProgress: (f: number, label: string) => void): Promise<World> {
  if (!cached) {
    cached = doLoad(onProgress).catch((e) => {
      cached = null;
      throw e;
    });
  } else cached.then(() => onProgress(1, 'Monde prêt'));
  return cached;
}

async function doLoad(onProgress: (f: number, label: string) => void): Promise<World> {
  onProgress(0, 'Chargement de la carte du secteur…');
  const meta = (await (await fetch(BASE + 'meta.json')).json()) as WorldMeta;
  const total = Object.values(meta.files).reduce((a, b) => a + b, 0);
  let loaded = 0;
  const label = (f: string) =>
    f.startsWith('albedo') ? 'Textures du sol (neige, pistes, routes)…' : f.startsWith('light') ? 'Lumière et ombres pré-calculées…' : f.startsWith('trees') ? 'Forêt réelle (photo aérienne IGN)…' : f.startsWith('height') ? 'Relief IGN au pas de 5 m…' : f.startsWith('far') ? 'Montagnes à l’horizon…' : f.startsWith('osm') ? 'Pistes, remontées et chalets (OSM)…' : 'Carte du secteur…';
  const get = async (f: string): Promise<Blob> => {
    const r = await fetch(BASE + f);
    if (!r.ok || !r.body) throw new Error(`Monde : ${f} introuvable (${r.status})`);
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      onProgress(Math.min(0.97, (loaded / total) * 0.92), label(f));
    }
    return new Blob(parts as BlobPart[]);
  };
  const gunzip = async (b: Blob) => new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const bitmap = async (f: string) => createImageBitmap(await get(f), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

  const tileKeys = meta.tiles.map((t) => `${t.i}_${t.j}`);
  const [hBuf, fBuf, mBuf, tBuf, oBuf, aux, dir, farAlbedo, farLight, ...tiles] = await Promise.all([
    get('height.dat').then(gunzip),
    get('far.dat').then(gunzip),
    get('mask.dat').then(gunzip),
    get('trees.dat').then(gunzip),
    get('osm.dat').then(gunzip),
    bitmap('aux.jpg'),
    bitmap('dir.jpg'),
    bitmap('far_albedo.jpg'),
    bitmap('far_light.jpg'),
    ...tileKeys.flatMap((k) => [bitmap(`albedo_${k}.jpg`), bitmap(`light_${k}.jpg`)]),
  ]);
  onProgress(0.94, 'Assemblage du relief…');
  const GW = meta.nx + 1, GH = meta.nz + 1;
  const hq = new Int16Array(hBuf);
  const h = new Float32Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    let v = 0;
    for (let i = 0; i < GW; i++) {
      v += hq[j * GW + i];
      h[j * GW + i] = meta.hmin + v / 10;
    }
  }
  const grid: Grid = { minX: -meta.halfW, minZ: -meta.halfD, nx: GW, nz: GH, cx: meta.cell, cz: meta.cell, h };
  const fq = new Uint16Array(fBuf);
  const fh = new Float32Array(fq.length);
  for (let k = 0; k < fq.length; k++) fh[k] = meta.far.hmin + fq[k] / 4;
  const far: Grid = { minX: -meta.far.halfX, minZ: -meta.far.halfZ, nx: meta.far.nx, nz: meta.far.nz, cx: meta.far.cell, cz: meta.far.cell, h: fh };
  const nChunks = meta.trees.cols * meta.trees.rows;
  const treeOffsets = new Uint32Array(tBuf, 0, nChunks + 1);
  const treeData = new Uint8Array(tBuf, (nChunks + 1) * 4);
  const osm = JSON.parse(new TextDecoder().decode(oBuf));

  const albedo = new Map<string, ImageBitmap>(), light = new Map<string, ImageBitmap>();
  tileKeys.forEach((k, i) => {
    albedo.set(k, tiles[i * 2]);
    light.set(k, tiles[i * 2 + 1]);
  });

  // ensoleillement à 5 m pour éclairer les objets (chalets, skieurs, remontées) comme le sol
  onProgress(0.97, 'Calcul de l’ensoleillement…');
  const sunW = meta.nx, sunH = meta.nz;
  const sunVis = new Uint8Array(sunW * sunH);
  const cv = document.createElement('canvas');
  for (const t of meta.tiles) {
    const w = Math.ceil(t.w / 2), hh = Math.ceil(t.h / 2);
    cv.width = w;
    cv.height = hh;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(light.get(`${t.i}_${t.j}`)!, 0, 0, w, hh);
    const d = ctx.getImageData(0, 0, w, hh).data;
    const x0 = (t.i * meta.tileSize) / 2, y0 = (t.j * meta.tileSize) / 2;
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < w; x++) {
        const q = (y * w + x) * 4;
        const X = x0 + x, Y = y0 + y;
        if (X < sunW && Y < sunH) sunVis[Y * sunW + X] = Math.round((d[q] * (0.35 + (0.65 * d[q + 1]) / 255)));
      }
  }
  onProgress(1, 'Monde prêt');
  return {
    meta,
    proj: new LocalProjection(meta.center),
    grid,
    far,
    mask: new Uint8Array(mBuf),
    treeOffsets,
    treeData,
    pistes: osm.pistes,
    lifts: osm.lifts,
    pois: osm.pois,
    buildings: osm.village.buildings,
    pylons: osm.village.pylons,
    images: { albedo, light, aux, dir, farAlbedo, farLight },
    sunVis,
    sunW,
    sunH,
  };
}

/** Bits du masque au point (x, z) (nœud 5 m le plus proche). */
export function maskAt(w: World, x: number, z: number): number {
  const i = Math.round((x + w.meta.halfW) / w.meta.cell), j = Math.round((z + w.meta.halfD) / w.meta.cell);
  if (i < 0 || j < 0 || i > w.meta.nx || j > w.meta.nz) return 0;
  return w.mask[j * (w.meta.nx + 1) + i];
}

/** Ensoleillement 0..1 au point (x, z). */
export function sunAt(w: World, x: number, z: number): number {
  const i = Math.floor((x + w.meta.halfW) / 5), j = Math.floor((z + w.meta.halfD) / 5);
  if (i < 0 || j < 0 || i >= w.sunW || j >= w.sunH) return 1;
  return w.sunVis[j * w.sunW + i] / 255;
}
