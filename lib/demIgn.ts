/**
 * Relief haute précision de l'IGN (RGE ALTI®, ~1 à 5 m) via le service WMS-R de la Géoplateforme.
 * Format BIL float32, CORS ouvert. Couvre la France : côté suisse, les valeurs « sans donnée »
 * renvoient null et l'appelant utilise un autre relief (AWS Terrain Tiles).
 * Licence : Licence Ouverte Etalab 2.0 — « IGN – RGE ALTI® ».
 */
import type { LngLat } from './types';

const TILE_DEG = 0.01; // ~1,1 km en latitude
const PX = 256; // ~4,3 m par pixel
const URL =
  'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&CRS=EPSG:4326&FORMAT=image/x-bil;bits=32';

export class IgnDem {
  private tiles = new Map<string, Float32Array | null>();
  loaded = 0;
  failed = 0;

  private key(i: number, j: number) {
    return `${i}:${j}`;
  }

  private async load(i: number, j: number) {
    const k = this.key(i, j);
    if (this.tiles.has(k)) return;
    this.tiles.set(k, null);
    const s = j * TILE_DEG, w = i * TILE_DEG;
    const bbox = `${s.toFixed(5)},${w.toFixed(5)},${(s + TILE_DEG).toFixed(5)},${(w + TILE_DEG).toFixed(5)}`;
    try {
      const r = await fetch(`${URL}&BBOX=${bbox}&WIDTH=${PX}&HEIGHT=${PX}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('bil')) throw new Error(String(r.status));
      const buf = await r.arrayBuffer();
      if (buf.byteLength !== PX * PX * 4) throw new Error('taille');
      this.tiles.set(k, new Float32Array(buf));
      this.loaded++;
    } catch {
      this.failed++;
    }
  }

  /** Charge les tuiles de l'emprise (6 requêtes en parallèle). */
  async preload(bbox: [number, number, number, number], onProgress?: (done: number, total: number) => void): Promise<number> {
    const [w, s, e, n] = bbox;
    const jobs: [number, number][] = [];
    for (let i = Math.floor(w / TILE_DEG); i <= Math.floor(e / TILE_DEG); i++)
      for (let j = Math.floor(s / TILE_DEG); j <= Math.floor(n / TILE_DEG); j++) jobs.push([i, j]);
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        const [i, j] = jobs.shift()!;
        await this.load(i, j);
        onProgress?.(++done, done + jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return this.loaded;
  }

  private px(gx: number, gy: number): number | null {
    // gx, gy : coordonnées pixel globales (x vers l'est, y vers le nord)
    const i = Math.floor(gx / PX), j = Math.floor(gy / PX);
    const t = this.tiles.get(this.key(i, j));
    if (!t) return null;
    const lx = Math.min(PX - 1, Math.max(0, Math.floor(gx - i * PX)));
    const ly = Math.min(PX - 1, Math.max(0, Math.floor(gy - j * PX)));
    const v = t[(PX - 1 - ly) * PX + lx]; // la première ligne de l'image est au nord
    return v > -500 && v < 5000 ? v : null;
  }

  sample(p: LngLat): number | null {
    const gx = (p[0] / TILE_DEG) * PX - 0.5, gy = (p[1] / TILE_DEG) * PX - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const a = this.px(x0, y0), b = this.px(x0 + 1, y0), c = this.px(x0, y0 + 1), d = this.px(x0 + 1, y0 + 1);
    if (a == null || b == null || c == null || d == null) return a ?? b ?? c ?? d ?? null;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }
}
