/**
 * Échantillonneur de Modèle Numérique de Terrain (navigateur).
 * Source : AWS Terrain Tiles (format Terrarium, agrégation SRTM / EU-DEM / données nationales),
 * domaine public / attributions listées sur https://github.com/tilezen/joerd/blob/master/docs/attribution.md
 */
import type { LngLat } from './types';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const TILE = 256;

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export class DemSampler {
  private tiles = new Map<string, Float32Array | null>();
  private pending = new Map<string, Promise<void>>();
  constructor(public readonly zoom = 13) {}

  private key(x: number, y: number) {
    return `${this.zoom}/${x}/${y}`;
  }

  private loadTile(x: number, y: number): Promise<void> {
    const k = this.key(x, y);
    if (this.tiles.has(k)) return Promise.resolve();
    const p = this.pending.get(k);
    if (p) return p;
    const url = TERRARIUM_URL.replace('{z}', String(this.zoom)).replace('{x}', String(x)).replace('{y}', String(y));
    const prom = new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = TILE;
          c.height = TILE;
          const ctx = c.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, TILE, TILE).data;
          const h = new Float32Array(TILE * TILE);
          for (let i = 0; i < TILE * TILE; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
          this.tiles.set(k, h);
        } catch {
          this.tiles.set(k, null);
        }
        resolve();
      };
      img.onerror = () => {
        this.tiles.set(k, null);
        resolve();
      };
      img.src = url;
    });
    this.pending.set(k, prom);
    return prom;
  }

  /** Précharge toutes les tuiles couvrant l'emprise. Retourne false si au moins une tuile manque. */
  async preload(bbox: [number, number, number, number]): Promise<boolean> {
    const [w, s, e, n] = bbox;
    const x0 = Math.floor(lonToTileX(w, this.zoom)), x1 = Math.floor(lonToTileX(e, this.zoom));
    const y0 = Math.floor(latToTileY(n, this.zoom)), y1 = Math.floor(latToTileY(s, this.zoom));
    const jobs: Promise<void>[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(this.loadTile(x, y));
    await Promise.all(jobs);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (!this.tiles.get(this.key(x, y))) return false;
    return true;
  }

  private pixel(px: number, py: number): number | null {
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) return null;
    const ix = Math.min(TILE - 1, Math.max(0, Math.floor(px - tx * TILE)));
    const iy = Math.min(TILE - 1, Math.max(0, Math.floor(py - ty * TILE)));
    return t[iy * TILE + ix];
  }

  /** Altitude (m) interpolée bilinéairement. null si la tuile n'est pas chargée. */
  sample(p: LngLat): number | null {
    const px = lonToTileX(p[0], this.zoom) * TILE - 0.5;
    const py = latToTileY(p[1], this.zoom) * TILE - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const a = this.pixel(x0, y0), b = this.pixel(x0 + 1, y0), c = this.pixel(x0, y0 + 1), d = this.pixel(x0 + 1, y0 + 1);
    if (a == null || b == null || c == null || d == null) return a ?? b ?? c ?? d ?? null;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  async sampleAsync(p: LngLat): Promise<number | null> {
    const x = Math.floor(lonToTileX(p[0], this.zoom)), y = Math.floor(latToTileY(p[1], this.zoom));
    await this.loadTile(x, y);
    return this.sample(p);
  }
}

/** Instance partagée pour les fiches (altitudes départ/arrivée). */
let shared: DemSampler | null = null;
export function sharedDem(): DemSampler {
  if (!shared) shared = new DemSampler(13);
  return shared;
}
