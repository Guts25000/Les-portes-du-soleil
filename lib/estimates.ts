/**
 * Estimations calculées (et affichées comme telles) quand aucune donnée officielle n'existe.
 */
import type { Difficulty, Lift, LiftKind } from './types';

/** Vitesse moyenne d'un skieur de niveau intermédiaire selon la difficulté (km/h, pauses non comprises). */
const AVG_SKI_KMH: Record<Difficulty, number> = {
  verte: 18,
  bleue: 25,
  rouge: 30,
  noire: 28,
  freeride: 20,
  inconnue: 25,
};

export function descentMinutes(lengthM: number, d: Difficulty): number {
  return lengthM / 1000 / AVG_SKI_KMH[d] * 60;
}

/** Vitesses d'exploitation typiques (m/s) par type de remontée. */
const LIFT_SPEED: Record<LiftKind, number> = {
  telepherique: 10,
  telecabine: 5.5,
  telemix: 5,
  telesiege: 4.5,
  teleski: 3,
  'fil-neige': 1.5,
  tapis: 0.8,
  autre: 3,
};

/** Temps de montée : tag OSM aerialway:duration s'il existe, sinon estimation longueur / vitesse type. */
export function liftMinutes(l: Lift): { minutes: number; estimated: boolean } {
  if (l.durationMin && l.durationMin > 0) return { minutes: l.durationMin, estimated: false };
  return { minutes: l.lengthM / LIFT_SPEED[l.kind] / 60, estimated: true };
}

export const LIFT_LABEL: Record<LiftKind, string> = {
  telepherique: 'Téléphérique',
  telecabine: 'Télécabine',
  telemix: 'Télémix',
  telesiege: 'Télésiège',
  teleski: 'Téléski',
  'fil-neige': 'Fil neige',
  tapis: 'Tapis roulant',
  autre: 'Remontée',
};

export const DIFF_COLOR: Record<Difficulty, string> = {
  verte: '#22c55e',
  bleue: '#3b82f6',
  rouge: '#ef4444',
  noire: '#111827',
  freeride: '#f59e0b',
  inconnue: '#a1a1aa',
};

export const DIFF_LABEL: Record<Difficulty, string> = {
  verte: 'Verte',
  bleue: 'Bleue',
  rouge: 'Rouge',
  noire: 'Noire',
  freeride: 'Itinéraire / hors-piste',
  inconnue: 'Non renseignée',
};

export function fmtMin(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 60) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}`;
}
