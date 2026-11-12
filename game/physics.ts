/**
 * Physique du skieur (pure, testable sans rendu).
 * Repère : x vers l'est, z vers le sud, y vers le haut. Cap h : direction (sin h, cos h).
 * Tourner à gauche = h augmente.
 */
import type { Track } from './track';

export const G = 9.81;

export interface Input {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  tuck: boolean;
}

export const emptyInput = (): Input => ({ left: false, right: false, up: false, down: false, jump: false, tuck: false });

export interface Env {
  height: (x: number, z: number) => number;
  track: Track;
  halfWidth: number;
  /** Retourne true si un obstacle (arbre, filet, skieur) est touché à cette position. */
  collide: (x: number, z: number, yAboveGround: number) => string | null;
  /** Mode libre : pas de progression ni de retour automatique sur le tracé. */
  freeRoam?: boolean;
  /** Vrai si la position est sur une piste damée (n'importe laquelle). */
  onPiste?: (x: number, z: number) => boolean;
  /** Limites du monde chargé. */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface Skier {
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  vy: number;
  heading: number;
  grounded: boolean;
  airTime: number;
  spin: number; // rotation visuelle accumulée en l'air
  grabTime: number;
  crashTimer: number;
  jumpHeld: boolean;
  trackIdx: number;
  s: number; // progression sur le tracé
  lateral: number;
  offPiste: boolean;
  turn: number; // -1..1, pour l'animation
  edgeLoss: number; // intensité du dérapage (particules)
}

export type GameEvent =
  | { type: 'trick'; name: string; points: number }
  | { type: 'crash'; reason: string }
  | { type: 'respawn' }
  | { type: 'land'; air: number }
  | { type: 'bounds' };

export function createSkier(track: Track, height: Env['height']): Skier {
  const a = track.at(2);
  return {
    x: a.x,
    z: a.z,
    y: height(a.x, a.z),
    vx: a.tx * 2,
    vz: a.tz * 2,
    vy: 0,
    heading: Math.atan2(a.tx, a.tz),
    grounded: true,
    airTime: 0,
    spin: 0,
    grabTime: 0,
    crashTimer: 0,
    jumpHeld: false,
    trackIdx: a.i,
    s: 2,
    lateral: 0,
    offPiste: false,
    turn: 0,
    edgeLoss: 0,
  };
}

export const speedOf = (k: Skier) => Math.hypot(k.vx, k.vz, k.grounded ? 0 : k.vy);

export function respawnOnTrack(k: Skier, env: Env, s: number) {
  const a = env.track.at(Math.max(2, s));
  k.x = a.x;
  k.z = a.z;
  k.y = env.height(a.x, a.z);
  k.vx = a.tx * 3;
  k.vz = a.tz * 3;
  k.vy = 0;
  k.heading = Math.atan2(a.tx, a.tz);
  k.grounded = true;
  k.spin = 0;
  k.airTime = 0;
  k.crashTimer = 0;
  k.trackIdx = a.i;
}

/** Avance la simulation de dt secondes (appeler avec dt ≤ 1/60). */
export function step(k: Skier, input: Input, env: Env, dt: number, events: GameEvent[]) {
  const crashed = k.crashTimer > 0;
  if (crashed) k.crashTimer = Math.max(0, k.crashTimer - dt);
  const inp = crashed ? emptyInput() : input;

  // --- Pente locale
  const e = 1.0;
  const gx = (env.height(k.x + e, k.z) - env.height(k.x - e, k.z)) / (2 * e);
  const gz = (env.height(k.x, k.z + e) - env.height(k.x, k.z - e)) / (2 * e);
  const g2 = gx * gx + gz * gz;

  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
  const lx = fz, lz = -fx; // gauche
  let speed = Math.hypot(k.vx, k.vz);

  // --- Direction
  const steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
  const maxTurn = (k.grounded ? 1.9 : 0) * (1 / (1 + speed / 22)) * (inp.tuck ? 0.55 : 1) + (k.grounded ? 0.35 : 0);
  k.heading += steer * maxTurn * dt;
  k.turn += (steer - k.turn) * Math.min(1, dt * 8);

  if (k.grounded) {
    // gravité projetée sur la pente
    const denom = 1 + g2;
    const ax = (-G * gx) / denom;
    const az = (-G * gz) / denom;

    // décomposition avant / latéral par rapport aux skis
    const nfx = Math.sin(k.heading), nfz = Math.cos(k.heading);
    const nlx = nfz, nlz = -nfx;
    let vf = k.vx * nfx + k.vz * nfz;
    let vl = k.vx * nlx + k.vz * nlz;

    // accroche des carres : la vitesse latérale est amortie ; une part est restituée vers l'avant (carving)
    const grip = inp.down ? 3.5 : 7.5;
    const vlNew = vl * Math.exp(-grip * dt);
    const lost = Math.abs(vl) - Math.abs(vlNew);
    k.edgeLoss = Math.min(1, lost / Math.max(0.001, dt) / 25);
    vf += Math.sign(vf || 1) * lost * (inp.down ? 0.1 : 0.55);
    vl = vlNew;

    // propulsion (pas de patineur) / freinage (chasse-neige)
    if (inp.up) vf += (speed < 8 ? 2.2 : 0.5) * dt;
    if (inp.down) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 6.5 * dt);

    k.vx = vf * nfx + vl * nlx;
    k.vz = vf * nfz + vl * nlz;

    // frottements : neige + air
    const mu = k.offPiste ? 0.22 : 0.055;
    const kAir = inp.tuck ? 0.0028 : 0.0058;
    speed = Math.hypot(k.vx, k.vz);
    if (speed > 0.01) {
      const dec = mu * G / Math.sqrt(denom) + kAir * speed * speed + (k.offPiste ? 0.012 * speed * speed : 0);
      const ns = Math.max(0, speed - dec * dt);
      k.vx *= ns / speed;
      k.vz *= ns / speed;
    }
    k.vx += ax * dt;
    k.vz += az * dt;

    // saut
    if (inp.jump && !k.jumpHeld) {
      k.grounded = false;
      // vitesse verticale = composante liée à la pente + impulsion
      const slopeVy = gx * k.vx + gz * k.vz;
      k.vy = slopeVy + 5.2 + Math.min(3, speed * 0.06);
      k.airTime = 0;
      k.spin = 0;
      k.grabTime = 0;
    }

    const nx = k.x + k.vx * dt, nz = k.z + k.vz * dt;
    const hNext = env.height(nx, nz);
    // décollage naturel sur une rupture de pente (bosse, mur)
    const vySlope = (hNext - k.y) / dt;
    const prevVy = gx * k.vx + gz * k.vz;
    if (k.grounded && prevVy - vySlope > 7 && speed > 10) {
      k.grounded = false;
      k.vy = prevVy;
      k.airTime = 0;
      k.spin = 0;
      k.grabTime = 0;
    }
    k.x = nx;
    k.z = nz;
    if (k.grounded) k.y = hNext;
  } else {
    // --- En l'air
    k.airTime += dt;
    k.vy -= G * dt;
    const kAir = 0.003;
    const sp = Math.hypot(k.vx, k.vz);
    if (sp > 0) {
      const ns = Math.max(0, sp - kAir * sp * sp * dt);
      k.vx *= ns / sp;
      k.vz *= ns / sp;
    }
    if (steer) k.spin += steer * 7.5 * dt;
    if (inp.tuck) k.grabTime += dt;
    k.x += k.vx * dt;
    k.z += k.vz * dt;
    k.y += k.vy * dt;
    const h = env.height(k.x, k.z);
    if (k.y <= h) {
      k.y = h;
      k.grounded = true;
      k.vy = 0;
      land(k, events);
    }
  }
  k.jumpHeld = inp.jump;

  // --- Collisions
  if (k.crashTimer <= 0) {
    const hit = env.collide(k.x, k.z, k.y - env.height(k.x, k.z));
    if (hit) {
      crash(k, events, hit);
      // recul pour sortir de l'obstacle
      const sp = Math.hypot(k.vx, k.vz) || 1;
      k.x -= (k.vx / sp) * 1.6;
      k.z -= (k.vz / sp) * 1.6;
      k.vx *= -0.1;
      k.vz *= -0.1;
      k.y = env.height(k.x, k.z);
    }
  }

  // --- Limites du monde
  if (env.bounds) {
    const b = env.bounds, m = 30;
    let hit = false;
    if (k.x < b.minX + m) { k.x = b.minX + m; k.vx = Math.abs(k.vx) * 0.2; hit = true; }
    if (k.x > b.maxX - m) { k.x = b.maxX - m; k.vx = -Math.abs(k.vx) * 0.2; hit = true; }
    if (k.z < b.minZ + m) { k.z = b.minZ + m; k.vz = Math.abs(k.vz) * 0.2; hit = true; }
    if (k.z > b.maxZ - m) { k.z = b.maxZ - m; k.vz = -Math.abs(k.vz) * 0.2; hit = true; }
    if (hit) {
      k.y = Math.max(k.y, env.height(k.x, k.z));
      events.push({ type: 'bounds' });
    }
  }

  // --- Progression sur le tracé
  if (env.freeRoam) {
    k.offPiste = env.onPiste ? !env.onPiste(k.x, k.z) : false;
    return;
  }
  const pr = env.track.nearest(k.x, k.z, k.trackIdx);
  k.trackIdx = pr.i;
  k.lateral = pr.lateral;
  k.offPiste = env.onPiste ? !env.onPiste(k.x, k.z) && pr.dist > env.halfWidth : pr.dist > env.halfWidth;
  if (pr.s > k.s) k.s = pr.s;
  if (pr.dist > env.halfWidth + 140) {
    respawnOnTrack(k, env, pr.s);
    events.push({ type: 'respawn' });
  }
}

function crash(k: Skier, events: GameEvent[], reason: string) {
  k.crashTimer = 1.3;
  k.vx *= 0.15;
  k.vz *= 0.15;
  k.spin = 0;
  events.push({ type: 'crash', reason });
}

function land(k: Skier, events: GameEvent[]) {
  const air = k.airTime;
  events.push({ type: 'land', air });
  const turns = Math.abs(k.spin) / (Math.PI * 2);
  const rot = Math.round(turns);
  const err = Math.abs(turns - rot) * 360; // degrés d'écart à la réception
  if (rot >= 1 && err < 40) {
    const name = `${rot * 360}${k.grabTime > 0.25 ? ' grab' : ''}`;
    events.push({ type: 'trick', name, points: 450 * rot + (k.grabTime > 0.25 ? 200 : 0) + Math.round(air * 80) });
  } else if (err >= 60 && Math.abs(k.spin) > 0.6) {
    crash(k, events, 'Réception ratée');
  } else if (k.grabTime > 0.3) {
    events.push({ type: 'trick', name: 'Grab', points: 180 + Math.round(air * 60) });
  } else if (air > 1.1) {
    events.push({ type: 'trick', name: 'Big air', points: Math.round(air * 120) });
  }
  k.spin = 0;
  k.grabTime = 0;
  k.airTime = 0;
}
