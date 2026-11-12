import assert from 'node:assert/strict';
import { Features, kickerProfile, placeAlongTrack, placePark } from '../game/features';
import { Track, rng } from '../game/track';
import { createSkier, emptyInput, step, type Env, type GameEvent } from '../game/physics';

const k = { x: 0, z: 0, dx: 0, dz: 1, L: 8, H: 2, W: 4.5 };
assert.equal(kickerProfile(k, -1, 0), 0);
assert.ok(Math.abs(kickerProfile(k, 8, 0) - 2) < 1e-9, 'lèvre à H');
assert.ok(kickerProfile(k, 4, 0) < 1, 'courbe de transition');
assert.equal(kickerProfile(k, 4, 10), 0, 'hors largeur');
assert.equal(kickerProfile(k, 9.4, 0), 0, 'après la face arrière');

const f = new Features();
f.addKicker(k);
assert.ok(Math.abs(f.offset(0, 8) - 2) < 1e-9);
f.addRail({ ax: 50, az: 0, bx: 50, bz: 10, ya: 1, yb: 0, kind: 'rail' });
const r = f.railNear(50.2, 5)!;
assert.ok(r && Math.abs(r.t - 0.5) < 1e-9 && Math.abs(r.d - 0.2) < 1e-9 && Math.abs(r.y - 0.5) < 1e-9);
assert.equal(f.railNear(50, 30), null);

// Physique : un skieur lancé sur un tremplin décolle
const pts = Array.from({ length: 201 }, (_, i) => ({ x: 0, z: i * 5 }));
const track = new Track(pts);
const g = new Features();
g.addKicker({ x: 0, z: 200, dx: 0, dz: 1, L: 8, H: 2.2, W: 4.5 });
const env: Env = { height: (x, z) => 2000 - 0.25 * z + g.offset(x, z), track, halfWidth: 15, collide: () => null };
const sk = createSkier(track, env.height);
const ev: GameEvent[] = [];
let maxAir = 0, maxAbove = 0;
for (let t = 0; t < 30; t += 1 / 120) {
  step(sk, { ...emptyInput(), tuck: sk.grounded }, env, 1 / 120, ev);
  if (!sk.grounded) maxAbove = Math.max(maxAbove, sk.y - env.height(sk.x, sk.z));
  maxAir = Math.max(maxAir, sk.airTime);
}
console.log(`tremplin : ${maxAir.toFixed(2)} s en l'air, ${maxAbove.toFixed(1)} m au-dessus du sol`);
assert.ok(maxAir > 0.8, 'vrai saut sur le tremplin');

// Placement
const f2 = new Features();
const n = placeAlongTrack(f2, track, (_x, z) => 2000 - 0.25 * z, 15, 'rouge', rng(1));
assert.ok(n >= 2 && f2.kickers.length >= 1, `modules placés (${n})`);
const f3 = new Features();
placePark(f3, 0, 0, (_x, z) => 2000 - 0.25 * z, rng(2));
assert.ok(f3.kickers.length === 3 && f3.rails.length === 6, 'ligne de snowpark');
assert.ok(f3.kickers[1].z > f3.kickers[0].z, 'dans le sens de la pente');
console.log('✓ modules freestyle OK');
