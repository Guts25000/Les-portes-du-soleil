import assert from 'node:assert/strict';
import { buildLiftPath, boardable, LiftRide, pointAt } from '../game/lifts';

// pente : altitude augmente vers le nord (z négatif)
const h = (_x: number, z: number) => 1000 - z * 0.4;
// ligne tracée de haut en bas (sens OSM inversé) : doit être réorientée
const line = [{ x: 0, z: -800 }, { x: 0, z: 0 }];
const p = buildLiftPath('l1', 'TS Test', 'telesiege', line, h)!;
assert.ok(p.bottom.z === 0 && p.top.z === -800, 'orientation aval → amont');
assert.ok(p.dir.z < 0);
assert.ok(p.towers.length >= 8, 'pylônes ~110 m');
for (const q of p.pts) assert.ok(q.y >= h(q.x, q.z) + 0.6 - 1e-9, 'passager au-dessus de la neige');
assert.ok(p.pts.some((q) => q.y - h(q.x, q.z) > 5), 'siège en hauteur entre les pylônes');
const mid = pointAt(p, p.total / 2);
assert.ok(mid.z < -300 && mid.z > -500);
assert.equal(boardable([p], 3, 5)?.id, 'l1');
assert.equal(boardable([p], 0, -400), null, 'pas d’embarquement en milieu de ligne');

const ride = new LiftRide(p);
let t = 0, done = false;
while (!done && t < 1000) { done = ride.update(0.1, 1); t += 0.1; }
assert.ok(done);
assert.ok(Math.abs(t - p.total / 4.5) < 0.5, `durée réaliste (${t.toFixed(0)} s)`);
const ex = ride.exit(h);
assert.ok(ex.z < -800, 'débarquement après la gare amont');

const tk = buildLiftPath('l2', 'TK', 'teleski', [{ x: 0, z: 0 }, { x: 0, z: -300 }], h)!;
assert.ok(tk.ground);
for (const q of tk.pts) assert.ok(Math.abs(q.y - h(q.x, q.z)) < 1e-9, 'téléski : au sol');
console.log(`✓ remontées OK — TS de ${Math.round(p.total)} m en ${Math.round(t)} s`);

// Index spatial : un élément de rayon 15 m doit être trouvé depuis la cellule voisine
import { SpatialHash } from '../game/track';
const sh = new SpatialHash(25);
sh.insert(24, 0, 15);
assert.equal(sh.query(30, 0, 0).length, 1, 'élément à rayon détecté hors de sa cellule');
assert.equal(sh.query(60, 0, 0).length, 0);
console.log('✓ index spatial OK');
