import type { Station } from './types';
import { haversine } from './geo';
import type { LngLat } from './types';

/**
 * Les 12 stations des Portes du Soleil.
 * Coordonnées = centre approximatif du village / front de neige (à affiner si besoin),
 * altitudes = altitude de référence du village. Elles servent aux étiquettes,
 * à la météo par secteur et à l'attribution d'un secteur aux pistes.
 * La géographie (relief, pistes, remontées) vient, elle, des données réelles.
 */
export const STATIONS: Station[] = [
  { id: 'avoriaz', name: 'Avoriaz', country: 'FR', coord: [6.7739, 46.1906], alt: 1800 },
  { id: 'morzine', name: 'Morzine', country: 'FR', coord: [6.7089, 46.1792], alt: 1000 },
  { id: 'les-gets', name: 'Les Gets', country: 'FR', coord: [6.6697, 46.1586], alt: 1172 },
  { id: 'chatel', name: 'Châtel', country: 'FR', coord: [6.8406, 46.27], alt: 1200 },
  { id: 'montriond', name: 'Montriond', country: 'FR', coord: [6.6956, 46.2047], alt: 950 },
  { id: 'abondance', name: 'Abondance', country: 'FR', coord: [6.7214, 46.2794], alt: 930 },
  { id: 'la-chapelle', name: "La Chapelle-d'Abondance", country: 'FR', coord: [6.7883, 46.2953], alt: 1020 },
  { id: 'champery', name: 'Champéry', country: 'CH', coord: [6.8697, 46.1772], alt: 1050 },
  { id: 'les-crosets', name: 'Les Crosets', country: 'CH', coord: [6.8336, 46.1853], alt: 1660 },
  { id: 'morgins', name: 'Morgins', country: 'CH', coord: [6.8578, 46.2386], alt: 1350 },
  { id: 'champoussin', name: 'Champoussin', country: 'CH', coord: [6.855, 46.205], alt: 1580 },
  { id: 'torgon', name: 'Torgon', country: 'CH', coord: [6.8778, 46.3217], alt: 1150 },
];

/** Emprise de chargement des données (ouest, sud, est, nord). */
export const DOMAIN_BBOX: [number, number, number, number] = [6.6, 46.13, 6.93, 46.345];

export const DOMAIN_CENTER: LngLat = [6.78, 46.225];

export function nearestStation(p: LngLat): Station {
  let best = STATIONS[0];
  let bd = Infinity;
  for (const s of STATIONS) {
    const d = haversine(p, s.coord);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}
