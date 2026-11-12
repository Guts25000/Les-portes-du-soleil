/**
 * Fantôme du meilleur temps (rejoué pendant la descente) et retour en arrière (rewind).
 */
import type { Skier } from './physics';

const STEP = 0.1; // s entre deux échantillons

export class GhostRecorder {
  private data: number[] = [];
  private acc = 0;
  push(dt: number, x: number, y: number, z: number, heading: number) {
    this.acc += dt;
    if (this.data.length && this.acc < STEP) return;
    this.acc = 0;
    this.data.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10, Math.round(heading * 100) / 100);
  }
  reset() {
    this.data = [];
    this.acc = 0;
  }
  serialize(): string {
    return JSON.stringify({ v: 1, step: STEP, d: this.data });
  }
  get samples() {
    return this.data.length / 4;
  }
}

export class GhostPlayer {
  constructor(private d: number[], private step: number) {}
  static parse(s: string | null): GhostPlayer | null {
    if (!s) return null;
    try {
      const o = JSON.parse(s) as { v: number; step: number; d: number[] };
      if (o.v !== 1 || !Array.isArray(o.d) || o.d.length < 8) return null;
      return new GhostPlayer(o.d, o.step);
    } catch {
      return null;
    }
  }
  get duration() {
    return (this.d.length / 4 - 1) * this.step;
  }
  sample(t: number): { x: number; y: number; z: number; heading: number } | null {
    const n = this.d.length / 4;
    if (t < 0 || n < 2) return null;
    const f = t / this.step;
    const i = Math.min(n - 2, Math.floor(f));
    if (f > n - 1) return null;
    const a = f - i;
    const g = (k: number) => this.d[i * 4 + k] + (this.d[(i + 1) * 4 + k] - this.d[i * 4 + k]) * a;
    let h0 = this.d[i * 4 + 3], h1 = this.d[(i + 1) * 4 + 3];
    while (h1 - h0 > Math.PI) h1 -= 2 * Math.PI;
    while (h0 - h1 > Math.PI) h1 += 2 * Math.PI;
    return { x: g(0), y: g(1), z: g(2), heading: h0 + (h1 - h0) * a };
  }
}

export function ghostKey(pisteId: string) {
  return `pds3d.ghost.${pisteId}`;
}

/** Instantanés réguliers de l'état du skieur pour revenir quelques secondes en arrière. */
export class RewindBuffer<T extends object = { skier: Skier; score: number }> {
  private buf: { t: number; state: T }[] = [];
  private acc = 0;
  constructor(private seconds = 8, private every = 0.1) {}
  push(dt: number, state: () => T) {
    this.acc += dt;
    if (this.acc < this.every) return;
    this.acc = 0;
    const t = (this.buf.at(-1)?.t ?? 0) + this.every;
    this.buf.push({ t, state: state() });
    const max = Math.ceil(this.seconds / this.every);
    if (this.buf.length > max) this.buf.splice(0, this.buf.length - max);
  }
  /** Revient de `back` secondes ; retourne l'état ou null. */
  rewind(back = 3): T | null {
    if (!this.buf.length) return null;
    const target = this.buf[this.buf.length - 1].t - back;
    let i = this.buf.length - 1;
    while (i > 0 && this.buf[i].t > target) i--;
    const s = this.buf[i].state;
    this.buf.length = i + 1;
    return s;
  }
  clear() {
    this.buf = [];
    this.acc = 0;
  }
}
