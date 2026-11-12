/** Niveaux de qualité graphique du simulateur. */
export type QualityLevel = 'basse' | 'haute' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  pixelRatio: number;
  shadowMap: number;
  shadowRange: number;
  postfx: boolean;
  bloom: boolean;
  msaa: number;
  treeDensity: number; // arbres par km²
  treeShadows: boolean;
  terrainTex: number;
  nearCells: number;
  sparkles: number;
  buildingShadows: boolean;
}

const KEY = 'pds3d.quality';

export function loadQuality(): QualityLevel {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'basse' || v === 'haute' || v === 'ultra') return v;
  } catch {
    /* ignore */
  }
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const touch = 'ontouchstart' in window;
  if (small || touch) return 'basse';
  return window.innerWidth >= 1280 ? 'ultra' : 'haute';
}

export function saveQuality(q: QualityLevel) {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* ignore */
  }
}

export function qualitySettings(level: QualityLevel): QualitySettings {
  const dpr = window.devicePixelRatio || 1;
  switch (level) {
    case 'basse':
      return { level, pixelRatio: Math.min(dpr, 1), shadowMap: 1024, shadowRange: 60, postfx: false, bloom: false, msaa: 0, treeDensity: 600, treeShadows: false, terrainTex: 2048, nearCells: 380, sparkles: 0, buildingShadows: false };
    case 'haute':
      return { level, pixelRatio: Math.min(dpr, 1.25), shadowMap: 2048, shadowRange: 90, postfx: true, bloom: true, msaa: 4, treeDensity: 1100, treeShadows: true, terrainTex: 4096, nearCells: 520, sparkles: 1500, buildingShadows: true };
    case 'ultra':
      return { level, pixelRatio: Math.min(dpr, 1.75), shadowMap: 2048, shadowRange: 110, postfx: true, bloom: true, msaa: 4, treeDensity: 1500, treeShadows: true, terrainTex: 4096, nearCells: 640, sparkles: 2500, buildingShadows: true };
  }
}

export const QUALITY_LABEL: Record<QualityLevel, string> = { basse: 'Basse', haute: 'Haute', ultra: 'Ultra' };
