/**
 * Championnat Morzine – Les Gets : médailles par piste, progression et déblocages.
 * Les temps de référence sont calculés à partir de la longueur réelle du tracé
 * et d'une vitesse moyenne cible par couleur.
 */
import type { Difficulty } from './types';

export type Medal = 'or' | 'argent' | 'bronze';

/** Vitesses moyennes cibles (km/h) : or / argent / bronze. */
const TARGET_KMH: Record<Difficulty, [number, number, number]> = {
  verte: [30, 24, 16],
  bleue: [40, 32, 22],
  rouge: [48, 38, 27],
  noire: [52, 42, 30],
  freeride: [44, 35, 25],
  inconnue: [44, 35, 25],
};

export interface MedalTargets {
  or: number;
  argent: number;
  bronze: number;
}

export function medalTargets(lengthM: number, d: Difficulty): MedalTargets {
  const [g, s, b] = TARGET_KMH[d];
  const t = (kmh: number) => Math.round((lengthM / (kmh / 3.6)) * 10) / 10;
  return { or: t(g), argent: t(s), bronze: t(b) };
}

export function medalFor(timeS: number, t: MedalTargets): Medal | null {
  if (timeS <= t.or) return 'or';
  if (timeS <= t.argent) return 'argent';
  if (timeS <= t.bronze) return 'bronze';
  return null;
}

export const MEDAL_POINTS: Record<Medal, number> = { or: 3, argent: 2, bronze: 1 };
export const MEDAL_ICON: Record<Medal, string> = { or: '🥇', argent: '🥈', bronze: '🥉' };

/** Points nécessaires pour débloquer chaque couleur. */
export const UNLOCK: Record<Difficulty, number> = { verte: 0, bleue: 0, inconnue: 0, rouge: 4, freeride: 10, noire: 12 };

export interface ChampRecord {
  bestTime: number;
  medal: Medal | null;
  score: number;
  runs: number;
}

export type ChampState = Record<string, ChampRecord>;

const KEY = 'pds3d.championnat.morzine-lesgets.v1';

export function loadChamp(): ChampState {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as ChampState;
  } catch {
    return {};
  }
}

export function saveChamp(s: ChampState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible */
  }
}

const rank = (m: Medal | null) => (m ? MEDAL_POINTS[m] : 0);

/** Enregistre une descente ; retourne le nouvel état et la médaille obtenue. */
export function recordRun(state: ChampState, pisteId: string, timeS: number, score: number, targets: MedalTargets): { state: ChampState; medal: Medal | null; improved: boolean } {
  const medal = medalFor(timeS, targets);
  const prev = state[pisteId];
  const next: ChampRecord = prev
    ? {
        bestTime: Math.min(prev.bestTime, timeS),
        medal: rank(medal) > rank(prev.medal) ? medal : prev.medal,
        score: Math.max(prev.score, score),
        runs: prev.runs + 1,
      }
    : { bestTime: timeS, medal, score, runs: 1 };
  return { state: { ...state, [pisteId]: next }, medal, improved: !prev || rank(medal) > rank(prev.medal) };
}

export function totals(state: ChampState, ids: string[]) {
  let points = 0, or = 0, argent = 0, bronze = 0, done = 0, score = 0;
  for (const id of ids) {
    const r = state[id];
    if (!r) continue;
    done++;
    score += r.score;
    if (r.medal) {
      points += MEDAL_POINTS[r.medal];
      if (r.medal === 'or') or++;
      else if (r.medal === 'argent') argent++;
      else bronze++;
    }
  }
  return { points, or, argent, bronze, done, score, max: ids.length * 3 };
}

export function isUnlocked(d: Difficulty, points: number): boolean {
  return points >= UNLOCK[d];
}
