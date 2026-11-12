/**
 * Couvert arboré réel détecté sur l'orthophotographie IGN (BD ORTHO®, Licence Ouverte Etalab).
 * Les photos sont prises en été : les houppiers des résineux apparaissent en vert très sombre,
 * nettement plus foncés que les prairies. On en tire un masque « arbre / pas arbre » qui sert à
 * placer chaque sapin là où il est réellement (forêts, bosquets, arbres isolés, haies).
 * Hors de France, l'image est vide (blanche) : le masque indique alors « inconnu ».
 */

const TILE_DEG = 0.01;
const PX = 512; // ~1,5 à 2,2 m par pixel
const URL =
  'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:4326&FORMAT=image/jpeg';

/** 0 = pas d'arbre, 1 = arbre, 255 = pas de donnée. */
export function classifyPixel(r: number, g: number, b: number): number {
  if (r > 245 && g > 245 && b > 245) return 255;
  const lum = (r + g + b) / 3;
  return lum < 68 && r < 95 && Math.abs(r - g) < 25 ? 1 : 0;
}

export class CanopyMask {
  /** Masque global (lignes du nord vers le sud). */
  data: Uint8Array;
  width: number;
  height: number;
  loaded = 0;
  private w0: number;
  private n0: number;

  constructor(private bbox: [number, number, number, number]) {
    const [w, s, e, n] = bbox;
    this.w0 = Math.floor(w / TILE_DEG) * TILE_DEG;
    this.n0 = Math.ceil(n / TILE_DEG) * TILE_DEG;
    const cols = Math.round((Math.ceil(e / TILE_DEG) * TILE_DEG - this.w0) / TILE_DEG);
    const rows = Math.round((this.n0 - Math.floor(s / TILE_DEG) * TILE_DEG) / TILE_DEG);
    this.width = cols * PX;
    this.height = rows * PX;
    this.data = new Uint8Array(this.width * this.height).fill(255);
  }

  private loadTile(col: number, row: number): Promise<void> {
    const w = this.w0 + col * TILE_DEG, n = this.n0 - row * TILE_DEG;
    const bbox = `${(n - TILE_DEG).toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${(w + TILE_DEG).toFixed(5)}`;
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const done = () => resolve();
      const timer = setTimeout(done, 30_000);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas');
          c.width = c.height = PX;
          const ctx = c.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, PX, PX);
          const d = ctx.getImageData(0, 0, PX, PX).data;
          for (let y = 0; y < PX; y++)
            for (let x = 0; x < PX; x++) {
              const i = (y * PX + x) * 4;
              this.data[(row * PX + y) * this.width + col * PX + x] = classifyPixel(d[i], d[i + 1], d[i + 2]);
            }
          this.loaded++;
        } catch {
          /* tuile illisible : reste « inconnu » */
        }
        done();
      };
      img.onerror = () => {
        clearTimeout(timer);
        done();
      };
      img.src = `${URL}&BBOX=${bbox}&WIDTH=${PX}&HEIGHT=${PX}`;
    });
  }

  async load(onProgress?: (done: number, total: number) => void): Promise<number> {
    const jobs: [number, number][] = [];
    for (let r = 0; r < this.height / PX; r++) for (let c = 0; c < this.width / PX; c++) jobs.push([c, r]);
    const total = jobs.length;
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        const [c, r] = jobs.shift()!;
        await this.loadTile(c, r);
        onProgress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return this.loaded;
  }

  /** 0, 1, ou 255 (inconnu) au point lon/lat. */
  at(lon: number, lat: number): number {
    const x = Math.floor(((lon - this.w0) / TILE_DEG) * PX), y = Math.floor(((this.n0 - lat) / TILE_DEG) * PX);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 255;
    return this.data[y * this.width + x];
  }

  /** Proportion d'arbres dans un carré de (2r+1)² pixels autour du point (lissage du bruit). */
  density(lon: number, lat: number, r = 1): number {
    const x0 = Math.floor(((lon - this.w0) / TILE_DEG) * PX), y0 = Math.floor(((this.n0 - lat) / TILE_DEG) * PX);
    let t = 0, n = 0;
    for (let y = y0 - r; y <= y0 + r; y++)
      for (let x = x0 - r; x <= x0 + r; x++) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const v = this.data[y * this.width + x];
        if (v === 255) continue;
        n++;
        t += v;
      }
    return n ? t / n : -1;
  }
}
