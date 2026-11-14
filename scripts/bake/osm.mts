/** Étape 1 bis : extrait OpenStreetMap du secteur (API 0.6 au format JSON, par carrés de 0,02°),
 *  converti au format Overpass « out geom » attendu par lib/osm.ts et game/buildings.ts. */
import fs from 'node:fs';
import { BBOX, CACHE } from './def.mts';

const UA = { 'User-Agent': 'pds3d-bake/1.0 (projet perso, carte 3D Les Gets)' };
const step = 0.02;
const W = Math.floor((BBOX.w - 0.01) / step) * step, E = BBOX.e + 0.01, S = Math.floor((BBOX.s - 0.01) / step) * step, N = BBOX.n + 0.01;
type El = { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string>; nodes?: number[]; members?: { type: string; ref: number; role: string }[] };
const nodes = new Map<number, El>(), ways = new Map<number, El>(), rels = new Map<number, El>();
fs.mkdirSync(`${CACHE}/osm`, { recursive: true });
const get = async (url: string, file: string) => {
  if (!fs.existsSync(file)) {
    for (let a = 0; a < 4; a++) {
      const r = await fetch(url, { headers: UA });
      if (r.ok) {
        fs.writeFileSync(file, await r.text());
        break;
      }
      console.error('HTTP', r.status, url);
      await new Promise((res) => setTimeout(res, 3000 * (a + 1)));
    }
  }
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).elements as El[]) : [];
};
const add = (els: El[]) => {
  for (const e of els) (e.type === 'node' ? nodes : e.type === 'way' ? ways : rels).set(e.id, e);
};
for (let x = W; x < E - 1e-9; x += step)
  for (let y = S; y < N - 1e-9; y += step) {
    const bb = `${x.toFixed(3)},${y.toFixed(3)},${(x + step).toFixed(3)},${(y + step).toFixed(3)}`;
    add(await get(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${bb}`, `${CACHE}/osm/${bb}.json`));
  }
// membres de relations (forêts, lacs, pistes) absents des carrés : géométrie complète du chemin
for (const r of rels.values())
  for (const m of r.members ?? [])
    if (m.type === 'way' && !ways.has(m.ref) && (r.tags?.landuse === 'forest' || r.tags?.natural || r.tags?.['piste:type'])) add(await get(`https://api.openstreetmap.org/api/0.6/way/${m.ref}/full.json`, `${CACHE}/osm/way-${m.ref}.json`));
const geom = (w: El) => (w.nodes ?? []).map((id) => nodes.get(id)).filter(Boolean).map((n) => ({ lat: n!.lat!, lon: n!.lon! }));
const elements: unknown[] = [];
for (const n of nodes.values()) if (n.tags) elements.push({ type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: n.tags });
for (const w of ways.values()) elements.push({ type: 'way', id: w.id, tags: w.tags ?? {}, geometry: geom(w) });
for (const r of rels.values())
  elements.push({ type: 'relation', id: r.id, tags: r.tags ?? {}, members: (r.members ?? []).map((m) => ({ type: m.type, ref: m.ref, role: m.role, geometry: m.type === 'way' && ways.has(m.ref) ? geom(ways.get(m.ref)!) : undefined })) });
fs.writeFileSync(`${CACHE}/osm.json`, JSON.stringify({ elements }));
console.log('OSM : nœuds', nodes.size, 'chemins', ways.size, 'relations', rels.size);
