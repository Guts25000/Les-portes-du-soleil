/** Vérifie que les sapins ne bloquent pas les pistes : pour chaque piste du monde, on parcourt le tracé de course. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { LocalProjection } from '../../lib/geo';
import { TreeField } from '../../game/trees';
import { buildRunLine } from '../../game/runline';
import { gridHeight, maskAt, type World } from '../../game/world';
const dir = new URL('../../public/world/', import.meta.url).pathname;
const meta = JSON.parse(fs.readFileSync(dir + 'meta.json', 'utf8'));
const gun = (f: string) => zlib.gunzipSync(fs.readFileSync(dir + f));
const GW = meta.nx + 1, GH = meta.nz + 1;
const hq = new Int16Array(gun('height.dat').buffer.slice(0));
const h = new Float32Array(GW * GH);
for (let j = 0; j < GH; j++) { let v = 0; for (let i = 0; i < GW; i++) { v += hq[j * GW + i]; h[j * GW + i] = meta.hmin + v / 10; } }
const tb = gun('trees.dat');
const n = meta.trees.cols * meta.trees.rows;
const tbuf = tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength);
const osm = JSON.parse(gun('osm.dat').toString());
const world = { meta, proj: new LocalProjection(meta.center), grid: { minX: -meta.halfW, minZ: -meta.halfD, nx: GW, nz: GH, cx: meta.cell, cz: meta.cell, h }, mask: new Uint8Array(gun('mask.dat')), treeOffsets: new Uint32Array(tbuf, 0, n + 1), treeData: new Uint8Array(tbuf, (n + 1) * 4), pistes: osm.pistes } as unknown as World;
const tf = Object.create(TreeField.prototype) as TreeField;
Object.assign(tf, { world, cache: new Map(), CH: meta.trees.chunk, cols: meta.trees.cols, rows: meta.trees.rows });
const H = (x: number, z: number) => gridHeight(world.grid, x, z) ?? 0;
const rows: string[] = [];
let bad = 0;
for (const p of world.pistes) {
  const run = buildRunLine(p.segments.map((s) => s.map((q) => world.proj.toLocal(q))), H);
  if (run.length < 2) continue;
  let len = 0, hits = 0, off = 0, samples = 0;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1], b = run[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (let t = 0; t < L; t += 3) {
      const x = a.x + ((b.x - a.x) * t) / L, z = a.z + ((b.z - a.z) * t) / L;
      samples++;
      if (tf.hit(x, z, 0.45)) hits++;
      if (!(maskAt(world, x, z) & 1)) off++;
    }
    len += L;
  }
  const pct = (hits / Math.max(1, samples)) * 100;
  if (pct > 1) bad++;
  rows.push(`${p.name || '(sans nom)'} [${p.difficulty}] ${Math.round(len)} m : arbres sur l'axe ${pct.toFixed(1)} %, hors masque piste ${((off / samples) * 100).toFixed(1)} %`);
}
console.log(rows.sort().join('\n'));
console.log('pistes avec > 1 % d\'arbres sur l\'axe :', bad, '/', rows.length);
