/**
 * Rapprochement de la liste officielle des pistes (data/morzineLesGets.ts)
 * avec les tracés GPS d'OpenStreetMap, par le nom et la position.
 */
import type { Difficulty, DomainData, Piste } from './types';
import { OFFICIAL_PISTES, ZONES, type OfficialPiste, type Zone } from '@/data/morzineLesGets';
import { chainSegments, haversine, lineLength, midpoint, normalizeText } from './geo';

const STOP = new Set(['le', 'la', 'les', 'l', 'des', 'du', 'de', 'd', 'piste', 'pistes']);
/** Rayon maximal entre une piste OSM et le centre approximatif de son secteur. */
const MAX_DIST_M = 3500;

export function nameKey(s: string): string {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 ? t.replace(/[sx]$/, '') : t))
    .join(' ');
}

function nameMatches(official: string[], osmName: string): boolean {
  const k = nameKey(osmName);
  if (!k) return false;
  for (const o of official) {
    const ko = nameKey(o);
    if (!ko) continue;
    if (k === ko) return true;
    // « Le Lièvre partie haute » contient « lievre » (mot entier)
    if (ko.length >= 5 && (` ${k} `.includes(` ${ko} `) || (k.length >= 5 && ` ${ko} `.includes(` ${k} `)))) return true;
  }
  return false;
}

export interface SectorEntry {
  official: OfficialPiste;
  zone: Zone;
  resort: 'Morzine' | 'Les Gets';
  osm: Piste[];
  /** Piste fusionnée (tous les tronçons OSM), utilisée par la carte et le jeu. */
  piste: Piste | null;
  difficulty: Difficulty;
  osmDifficulty: Difficulty | null;
  colorSource: 'officielle' | 'recoupée' | 'OSM' | 'inconnue';
  colorMismatch: boolean;
}

function mostCommon(ds: Difficulty[]): Difficulty | null {
  const c = new Map<Difficulty, number>();
  for (const d of ds) if (d !== 'inconnue') c.set(d, (c.get(d) ?? 0) + 1);
  let best: Difficulty | null = null, n = 0;
  for (const [d, k] of c) if (k > n) {
    best = d;
    n = k;
  }
  return best;
}

const slug = (s: string) => normalizeText(s).replace(/\s+/g, '-');

export function matchSector(data: DomainData | null): SectorEntry[] {
  return OFFICIAL_PISTES.map((o) => {
    const z = ZONES.find((x) => x.zone === o.zone)!;
    const names = [o.name, ...(o.aliases ?? [])];
    const osm = (data?.pistes ?? []).filter(
      (p) => p.named && nameMatches(names, p.name) && Math.min(haversine(p.line[0], z.anchor), haversine(midpoint(p.line), z.anchor)) <= MAX_DIST_M,
    );
    const osmDifficulty = mostCommon(osm.map((p) => p.difficulty));
    const difficulty: Difficulty = o.color ?? osmDifficulty ?? 'inconnue';
    let piste: Piste | null = null;
    if (osm.length) {
      const segments = osm.flatMap((p) => p.segments);
      const line = chainSegments(segments);
      piste = {
        id: `pdl:${slug(o.zone)}:${slug(o.name)}`,
        name: o.name,
        named: true,
        difficulty,
        osmDifficulty: osm[0].osmDifficulty,
        sector: z.resort,
        segments,
        line,
        lengthM: Math.round(lineLength(line)),
        grooming: osm[0].grooming,
        widthM: osm.find((p) => p.widthM)?.widthM,
        osmIds: Array.from(new Set(osm.flatMap((p) => p.osmIds))),
        snowpark: false,
      };
    }
    return {
      official: o,
      zone: o.zone,
      resort: z.resort,
      osm,
      piste,
      difficulty,
      osmDifficulty,
      colorSource: o.color ? (o.src ? 'recoupée' : 'officielle') : osmDifficulty ? 'OSM' : 'inconnue',
      colorMismatch: !!(o.color && osmDifficulty && o.color !== osmDifficulty),
    };
  });
}
