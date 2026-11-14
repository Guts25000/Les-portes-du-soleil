/** Étape 1 : téléchargement des sources (relief IGN 2,5 m, orthophoto IGN 1,25 m, relief lointain AWS). */
import fs from 'node:fs';
import { BBOX, CACHE, HALF_D, HALF_W, TILE, llBox, pool } from './def.mts';

const WMS = 'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:4326';

async function get(url: string, file: string, check: (b: Buffer, ct: string) => boolean) {
  if (fs.existsSync(file)) return;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && check(b, r.headers.get('content-type') ?? '')) {
        fs.writeFileSync(file, b);
        return;
      }
      console.error('mauvaise réponse', r.status, file);
    } catch (e) {
      console.error('erreur', file, String(e));
    }
    await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
  }
  throw new Error('échec ' + url);
}

const jobs: (() => Promise<void>)[] = [];
fs.mkdirSync(`${CACHE}/dem`, { recursive: true });
fs.mkdirSync(`${CACHE}/ortho`, { recursive: true });
fs.mkdirSync(`${CACHE}/far`, { recursive: true });
const cols = (2 * HALF_W) / TILE, rows = (2 * HALF_D) / TILE;
for (let j = 0; j < rows; j++)
  for (let i = 0; i < cols; i++) {
    const x0 = -HALF_W + i * TILE, z0 = -HALF_D + j * TILE;
    const b = llBox(x0, z0, x0 + TILE, z0 + TILE);
    const bb = `${b.s.toFixed(7)},${b.w.toFixed(7)},${b.n.toFixed(7)},${b.e.toFixed(7)}`;
    jobs.push(() => get(`${WMS}&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&FORMAT=image/x-bil;bits=32&BBOX=${bb}&WIDTH=512&HEIGHT=512`, `${CACHE}/dem/${i}_${j}.bil`, (buf, ct) => ct.includes('bil') && buf.length === 512 * 512 * 4));
    jobs.push(() => get(`${WMS}&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&FORMAT=image/jpeg&BBOX=${bb}&WIDTH=1024&HEIGHT=1024`, `${CACHE}/ortho/${i}_${j}.jpg`, (buf, ct) => ct.includes('jpeg') && buf.length > 5000));
  }
// relief lointain : tuiles AWS terrarium z12 sur ~44 km autour
const z = 12;
const lon2x = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const m = 0.3;
for (let x = lon2x(BBOX.w - m); x <= lon2x(BBOX.e + m); x++)
  for (let y = lat2y(BBOX.n + m * 0.7); y <= lat2y(BBOX.s - m * 0.7); y++)
    jobs.push(() => get(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, `${CACHE}/far/${z}_${x}_${y}.png`, (buf) => buf.length > 60));
// photo aérienne lointaine (couleur des forêts au loin), 4 x 4 images
const fw = BBOX.w - m, fe = BBOX.e + m, fs_ = BBOX.s - m * 0.7, fn = BBOX.n + m * 0.7;
for (let j = 0; j < 4; j++)
  for (let i = 0; i < 4; i++) {
    const w = fw + ((fe - fw) * i) / 4, e = fw + ((fe - fw) * (i + 1)) / 4;
    const n = fn - ((fn - fs_) * j) / 4, s = fn - ((fn - fs_) * (j + 1)) / 4;
    jobs.push(() => get(`${WMS}&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&FORMAT=image/jpeg&BBOX=${s},${w},${n},${e}&WIDTH=1024&HEIGHT=1024`, `${CACHE}/far/ortho_${i}_${j}.jpg`, (buf, ct) => ct.includes('jpeg')));
  }
console.log('téléchargements', jobs.length, 'emprise', BBOX);
let done = 0;
await pool(jobs.map((f) => async () => { await f(); if (++done % 20 === 0) console.log(done, '/', jobs.length); }), 6);
console.log('terminé');
