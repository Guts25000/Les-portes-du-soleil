/**
 * Adaptateurs pour les données « en direct » officielles.
 *
 * Aucune API publique et libre n'expose aujourd'hui l'état d'ouverture piste par piste
 * des Portes du Soleil ni le bulletin d'avalanche dans un format directement utilisable
 * sans clé. Ces fonctions renvoient donc `null` (=> l'interface affiche « non disponible »)
 * et constituent le point d'intégration prévu :
 *   - État pistes / remontées : flux de l'exploitant (ex. Lumiplan, SkiData, Infosnow pour la Suisse)
 *   - Avalanches FR : API Météo-France « Bulletins d'avalanche » (BRA) — clé gratuite sur portail-api.meteofrance.fr
 *   - Avalanches CH : SLF (WSL) — bulletin CAAML
 * Ne JAMAIS remplacer ces retours par des valeurs inventées.
 */

export type OpenState = 'ouvert' | 'ferme' | 'prevu' | 'inconnu';

export interface LiveStatus {
  source: string;
  updatedAt: string;
  pistes: Record<string, OpenState>; // clé : nom de piste normalisé + secteur
  lifts: Record<string, OpenState>;
  pistesOpen: number;
  pistesTotal: number;
  liftsOpen: number;
  liftsTotal: number;
  snowQuality?: Record<string, string>;
}

export interface AvalancheBulletin {
  source: string;
  massif: string;
  risk: 1 | 2 | 3 | 4 | 5;
  validUntil: string;
  url: string;
}

export async function fetchLiveStatus(): Promise<LiveStatus | null> {
  const url = process.env.NEXT_PUBLIC_LIVE_STATUS_URL;
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as LiveStatus;
  } catch {
    return null;
  }
}

export async function fetchAvalanche(): Promise<AvalancheBulletin[] | null> {
  const url = process.env.NEXT_PUBLIC_AVALANCHE_URL;
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as AvalancheBulletin[];
  } catch {
    return null;
  }
}

/** Liens officiels affichés tant que les flux ne sont pas branchés. */
export const OFFICIAL_LINKS = [
  { label: 'Portes du Soleil — site officiel', url: 'https://www.portesdusoleil.com' },
  { label: 'Météo-France — bulletins avalanche (Chablais)', url: 'https://meteofrance.com/meteo-montagne' },
  { label: 'SLF — bulletin avalanches Suisse', url: 'https://www.slf.ch' },
];
