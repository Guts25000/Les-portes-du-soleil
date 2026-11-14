import assert from 'node:assert/strict';
import { buildRunLine } from '../game/runline';
// relief : pente vers +z (z grand = bas)
const h = (_x: number, z: number) => 2000 - z * 0.3;
// tronçon A du haut vers le milieu, tronçon B dessiné à l'envers (du bas vers le milieu)
const A = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 0, z: 200 }];
const B = [{ x: 5, z: 500 }, { x: 3, z: 350 }, { x: 2, z: 210 }];
const run = buildRunLine([B, A], h);
assert.equal(run[0].z, 0, 'départ en haut');
assert.equal(run[run.length - 1].z, 500, 'arrivée en bas');
for (let i = 1; i < run.length; i++) assert.ok(run[i].z >= run[i - 1].z, 'pas de remontée');
// branche latérale plus courte ignorée
const C = [{ x: 0, z: 100 }, { x: 60, z: 160 }];
const run2 = buildRunLine([A, B, C], h);
assert.equal(run2[run2.length - 1].z, 500);
console.log('✓ tracé de course OK —', run.length, 'points');
