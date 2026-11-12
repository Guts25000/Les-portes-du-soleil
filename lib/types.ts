export type LngLat = [number, number];

/** Couleur française / suisse dérivée de piste:difficulty (OSM). */
export type Difficulty = 'verte' | 'bleue' | 'rouge' | 'noire' | 'freeride' | 'inconnue';

export type LiftKind =
  | 'telepherique'
  | 'telecabine'
  | 'telemix'
  | 'telesiege'
  | 'teleski'
  | 'fil-neige'
  | 'tapis'
  | 'autre';

export interface Piste {
  id: string; // "piste:<osm ids>"
  name: string;
  named: boolean;
  difficulty: Difficulty;
  osmDifficulty?: string;
  sector: string; // station la plus proche du départ
  /** Segments OSM bruts (pour l'affichage). */
  segments: LngLat[][];
  /** Tracé chaîné en une seule ligne (pour le simulateur et l'itinéraire). */
  line: LngLat[];
  lengthM: number;
  grooming?: string;
  widthM?: number;
  osmIds: number[];
  snowpark: boolean;
  /** Altitudes : remplies côté client par échantillonnage du MNT. */
  topAlt?: number;
  bottomAlt?: number;
}

export interface Lift {
  id: string;
  osmId: number;
  name: string;
  kind: LiftKind;
  osmKind: string;
  sector: string;
  line: LngLat[]; // convention OSM : de l'aval vers l'amont
  lengthM: number;
  capacity?: number; // personnes / heure
  occupancy?: number;
  durationMin?: number; // tag aerialway:duration si présent
  openingHours?: string;
  bottomAlt?: number;
  topAlt?: number;
}

export type PoiKind = 'restaurant' | 'bar' | 'snowpark' | 'viewpoint' | 'hut' | 'webcam' | 'debutant' | 'freeride' | 'repos';

export interface Poi {
  id: string;
  name: string;
  kind: PoiKind;
  coord: LngLat;
  sector: string;
  tags: Record<string, string>;
  ele?: number;
}

export interface Station {
  id: string;
  name: string;
  country: 'FR' | 'CH';
  coord: LngLat;
  /** Altitude du village (m), valeur de référence. */
  alt: number;
}

export interface DomainData {
  generatedAt: string;
  source: string;
  bbox: [number, number, number, number];
  pistes: Piste[];
  lifts: Lift[];
  pois: Poi[];
}

export interface Webcam {
  id: string;
  name: string;
  coord: LngLat;
  alt?: number;
  /** Page officielle (lien sortant, toujours affiché). */
  pageUrl: string;
  /** Image JPEG rafraîchie par l'exploitant (si autorisé à l'affichage). */
  imageUrl?: string;
  /** URL d'intégration iframe fournie par l'exploitant (si autorisée). */
  embedUrl?: string;
  provider?: string;
}

export type Selection =
  | { type: 'piste'; item: Piste }
  | { type: 'lift'; item: Lift }
  | { type: 'poi'; item: Poi }
  | { type: 'webcam'; item: Webcam }
  | { type: 'station'; item: Station };
