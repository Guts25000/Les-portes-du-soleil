/* Simulation du skieur sans rendu : npm run test:libs le lance aussi */
import assert from 'node:assert/strict';
import { Track } from '../game/track';
import { createSkier, emptyInput, step, speedOf, type Env, type GameEvent } from '../game/physics';

const pts = Array.from({ length: 401 }, (_, i) => ({ x: 0, z: i * 5 }));
const track = new Track(pts);
const slope = 0.3; // 30 %
const env: Env = { height: (_x, z) => 2000 - slope * z, track, halfWidth: 20, collide: () => null };

function run(seconds: number, inputFn: (t: number) => Partial<ReturnType<typeof emptyInput>>) {
  const k = createSkier(track, env.height);
  const ev: GameEvent[] = [];
  let vmax = 0;
  for (let t = 0; t < seconds; t += 1 / 120) {
    step(k, { ...emptyInput(), ...inputFn(t) }, env, 1 / 120, ev);
    vmax = Math.max(vmax, speedOf(k));
  }
  return { k, ev, vmax };
}

const free = run(25, () => ({}));
const tuck = run(25, () => ({ tuck: true }));
const brake = run(25, () => ({ down: true }));
console.log('libre', (free.vmax * 3.6).toFixed(0), 'km/h, s=', free.k.s.toFixed(0));
console.log('schuss', (tuck.vmax * 3.6).toFixed(0), 'km/h');
console.log('frein', (brake.vmax * 3.6).toFixed(0), 'km/h');
assert.ok(free.vmax * 3.6 > 45 && free.vmax * 3.6 < 100, 'vitesse plausible');
assert.ok(tuck.vmax > free.vmax, 'la position aéro accélère');
assert.ok(brake.vmax < free.vmax * 0.6, 'le chasse-neige freine');
assert.ok(Math.abs(free.k.lateral) < 1, 'reste dans l’axe sans commande');

// Virage : on tourne à gauche, le skieur doit partir vers +x (gauche quand on regarde +z)
const turn = run(3, (t) => ({ left: t > 1 }));
assert.ok(turn.k.x > 0.5, `virage gauche → x>0 (x=${turn.k.x.toFixed(2)})`);
assert.ok(turn.k.lateral > 0, 'latéral positif = gauche');

// Saut + 360 : appui espace, puis gauche maintenu le temps d'un tour
const jump = run(6, (t) => ({ jump: t > 3 && t < 3.05, left: t > 3.05 && t < 3.05 + (Math.PI * 2) / 7.5 }));
const tricks = jump.ev.filter((e) => e.type === 'trick');
console.log('évènements saut :', jump.ev.map((e) => e.type + ('name' in e ? ':' + e.name : '')).join(', '));
assert.ok(tricks.some((e) => e.type === 'trick' && e.name.startsWith('360')), 'figure 360 détectée');

// Collision
const envTree: Env = { ...env, collide: (_x, z) => (z > 200 && z < 202 ? 'Arbre' : null) };
const k = createSkier(track, env.height);
const ev: GameEvent[] = [];
for (let t = 0; t < 20; t += 1 / 120) step(k, emptyInput(), envTree, 1 / 120, ev);
assert.ok(ev.some((e) => e.type === 'crash'), 'chute détectée');
console.log('✓ physique OK');
