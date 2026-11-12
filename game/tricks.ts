/**
 * Figures et combos, inspirés des jeux de glisse arcade (type Rider Republic) :
 * rotations par demi-tours (180, 360, 540…), flips avant/arrière, grabs, qualité de réception
 * (Perfect / Good / Sloppy), réception en switch, et combos avec multiplicateur.
 * Pur, sans rendu : testé dans scripts/test-tricks.ts.
 */

export type Quality = 'Perfect' | 'Good' | 'Sloppy';

export interface AirState {
  spin: number; // rad, signé
  flip: number; // rad, > 0 = avant
  grabTime: number; // s
  grabKind: string | null;
  air: number; // s
}

export interface LandingResult {
  crash: boolean;
  reason?: string;
  quality: Quality;
  name: string | null;
  points: number;
  /** Facteur appliqué à la vitesse (bonus de vitesse sur un Perfect). */
  speedFactor: number;
  /** Réception à l'envers (nombre impair de demi-tours). */
  switchFlip: boolean;
}

const DEG = 180 / Math.PI;
const MULT = ['', '', 'Double ', 'Triple ', 'Quad ', 'Quint '];

export function evaluateLanding(a: AirState): LandingResult {
  const halfSpins = Math.round(Math.abs(a.spin) / Math.PI);
  const spinErr = Math.abs(Math.abs(a.spin) - halfSpins * Math.PI) * DEG;
  const flips = Math.round(Math.abs(a.flip) / (2 * Math.PI));
  const flipErr = Math.abs(Math.abs(a.flip) - flips * 2 * Math.PI) * DEG;
  const worst = Math.max(spinErr, flipErr);
  if (flipErr > 70 || spinErr > 75) {
    return { crash: true, reason: flipErr > 70 ? 'Réception sur la tête !' : 'Réception de travers', quality: 'Sloppy', name: null, points: 0, speedFactor: 0.15, switchFlip: false };
  }
  const quality: Quality = worst < 18 ? 'Perfect' : worst < 40 ? 'Good' : 'Sloppy';
  const parts: string[] = [];
  if (flips > 0) parts.push(`${MULT[Math.min(flips, 5)]}${a.flip > 0 ? 'Frontflip' : 'Backflip'}`.replace(/^(Double|Triple|Quad|Quint) F/, '$1 f').replace(/^(Double|Triple|Quad|Quint) B/, '$1 b'));
  if (halfSpins > 0) parts.push(`${halfSpins * 180}`);
  const grabbed = a.grabTime > 0.25;
  if (grabbed) parts.push(a.grabKind ?? 'Grab');
  let points = 0;
  let name: string | null = null;
  if (parts.length) {
    points = a.air * 90 + halfSpins * 160 + flips * 550 + (grabbed ? 150 + a.grabTime * 120 : 0);
    name = parts.join(' ');
  } else if (a.air > 1.1) {
    points = a.air * 120;
    name = 'Big air';
  }
  const qm = quality === 'Perfect' ? 1.5 : quality === 'Good' ? 1 : 0.5;
  return {
    crash: false,
    quality,
    name,
    points: Math.round(points * qm),
    speedFactor: quality === 'Perfect' ? 1.06 : quality === 'Good' ? 1 : 0.75,
    switchFlip: halfSpins % 2 === 1,
  };
}

/** Nom du grab selon ce que fait le rider au moment où il attrape ses skis. */
export function grabName(spinning: boolean, flipDir: number): string {
  if (flipDir > 0) return 'Nose grab';
  if (flipDir < 0) return 'Tail grab';
  if (spinning) return 'Japan';
  return 'Mute';
}

/** Enchaînement de figures : multiplicateur croissant, perdu en cas de chute. */
export class Combo {
  names: string[] = [];
  base = 0;
  private timer = 0;
  static WINDOW = 2.5;

  get multiplier() {
    return Math.min(5, 1 + 0.5 * Math.max(0, this.names.length - 1));
  }
  get active() {
    return this.names.length > 0;
  }
  get total() {
    return Math.round(this.base * this.multiplier);
  }
  /** Fraction restante de la fenêtre d'enchaînement (0..1). */
  get window() {
    return this.active ? Math.max(0, 1 - this.timer / Combo.WINDOW) : 0;
  }

  add(name: string, points: number) {
    this.names.push(name);
    this.base += points;
    this.timer = 0;
  }

  /** Ajoute des points au dernier élément (grind en cours) sans relancer de figure. */
  extend(points: number) {
    this.base += points;
    this.timer = 0;
  }

  /** Retourne les points encaissés quand la fenêtre expire (au sol uniquement). */
  update(dt: number, grounded: boolean): number | null {
    if (!this.active || !grounded) return null;
    this.timer += dt;
    if (this.timer < Combo.WINDOW) return null;
    const pts = this.total;
    this.reset();
    return pts;
  }

  fail(): number {
    const lost = this.total;
    this.reset();
    return lost;
  }

  reset() {
    this.names = [];
    this.base = 0;
    this.timer = 0;
  }
}
