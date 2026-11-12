import type { Difficulty, LngLat } from '@/lib/types';

/**
 * Pistes du forfait Morzine – Les Gets (Pleney, Nyon, Chamossière, Les Gets).
 *
 * Liste établie à partir des pages officielles d'ouverture des pistes du domaine
 * (consultées le 12/11/2026) :
 *  - Morzine : https://en.portesdusoleil.com/in-winter/openings-slopes-and-lifts/morzine-ski-lifts/
 *    (noms, secteurs et couleurs)
 *  - Les Gets : https://en.portesdusoleil.com/in-winter/slopes-and-lifts-en/ski-lifts-les-gets
 *    (noms et secteurs, sans couleurs)
 * Couleurs des Gets : recoupées sur des guides de la station (voir `src`). Quand les sources
 * ne concordent pas ou qu'aucune ne précise la couleur, `color` vaut null et l'application
 * affiche la couleur renseignée dans OpenStreetMap.
 *
 * Les zones débutants, espaces luge, snowparks, boardercross et itinéraires de ski de fond
 * / de randonnée ne sont pas des descentes : ils sont exclus.
 * Les tracés GPS ne sont PAS ici : ils viennent d'OpenStreetMap (rapprochement par le nom).
 */

export type Zone = 'Pleney' | 'Nyon' | 'Chamossière' | 'Chavannes' | 'Ranfoilly-Nauchets' | 'Rosta-Perrières' | 'Mont-Chéry';

export interface OfficialPiste {
  name: string;
  zone: Zone;
  color: Difficulty | null;
  /** Autres graphies possibles dans OSM. */
  aliases?: string[];
  /** Source de la couleur quand elle ne vient pas de la page officielle. */
  src?: string;
  note?: string;
}

export const ZONES: { zone: Zone; resort: 'Morzine' | 'Les Gets'; anchor: LngLat }[] = [
  // Points d'ancrage approximatifs, utilisés uniquement pour départager les homonymes
  // (ex. « Chamois » existe à Nyon et au Mont-Chéry).
  { zone: 'Pleney', resort: 'Morzine', anchor: [6.7, 46.168] },
  { zone: 'Nyon', resort: 'Morzine', anchor: [6.73, 46.16] },
  { zone: 'Chamossière', resort: 'Morzine', anchor: [6.745, 46.15] },
  { zone: 'Chavannes', resort: 'Les Gets', anchor: [6.672, 46.168] },
  { zone: 'Ranfoilly-Nauchets', resort: 'Les Gets', anchor: [6.68, 46.18] },
  { zone: 'Rosta-Perrières', resort: 'Les Gets', anchor: [6.658, 46.172] },
  { zone: 'Mont-Chéry', resort: 'Les Gets', anchor: [6.636, 46.148] },
];

const CH1066 = 'chalets1066.com — « Skier aux Chavannes »';
const MOREMTN = 'moremountain.com — « Best ski runs in Morzine and Les Gets »';
const POPLI = 'poplidays.com — guide Les Gets';
const RMNET = 'remontees-mecaniques.net — TKD Tête des Crêts';

export const OFFICIAL_PISTES: OfficialPiste[] = [
  // ---------------- MORZINE — Pleney
  { name: 'Mas Verjus', zone: 'Pleney', color: 'verte' },
  { name: 'Corbeau', zone: 'Pleney', color: 'bleue' },
  { name: 'Daguet', zone: 'Pleney', color: 'bleue' },
  { name: 'Grizzli', zone: 'Pleney', color: 'bleue', aliases: ['Grizzly'] },
  { name: 'Le Bouchet', zone: 'Pleney', color: 'bleue' },
  { name: 'Nabor', zone: 'Pleney', color: 'bleue' },
  { name: 'Retour des Nants', zone: 'Pleney', color: 'bleue' },
  { name: 'Piste B', zone: 'Pleney', color: 'bleue' },
  { name: 'Renard', zone: 'Pleney', color: null, note: 'Bleue sur portesdusoleil.com, rouge sur pleney.com : couleur OSM affichée.' },
  { name: 'Daim', zone: 'Pleney', color: 'rouge' },
  { name: 'Abeille', zone: 'Pleney', color: 'rouge' },
  { name: 'Fouine', zone: 'Pleney', color: 'rouge' },
  { name: 'Hermine', zone: 'Pleney', color: 'rouge' },
  { name: 'Le Stade', zone: 'Pleney', color: 'rouge' },
  { name: 'Olympique', zone: 'Pleney', color: 'noire' },
  { name: 'Atray', zone: 'Pleney', color: null, note: 'Listée « hors période » sur la page officielle.' },
  // ---------------- MORZINE — Nyon
  { name: 'La Chouette', zone: 'Nyon', color: 'verte' },
  { name: 'Le Lièvre', zone: 'Nyon', color: 'bleue' },
  { name: 'Les Freux', zone: 'Nyon', color: 'bleue' },
  { name: 'Les Granges', zone: 'Nyon', color: 'bleue' },
  { name: 'Les Paquerages', zone: 'Nyon', color: 'bleue', aliases: ['Pâquérages'] },
  { name: 'Les Poireaux', zone: 'Nyon', color: 'bleue' },
  { name: 'Les Raverettes', zone: 'Nyon', color: 'bleue' },
  { name: "L'Aigle Rouge", zone: 'Nyon', color: 'rouge' },
  { name: 'La Combe', zone: 'Nyon', color: 'rouge' },
  { name: 'Le Chamois', zone: 'Nyon', color: 'rouge' },
  { name: 'Les Lanches', zone: 'Nyon', color: 'rouge' },
  { name: 'Les Coutalays', zone: 'Nyon', color: 'rouge', aliases: ["Courtalay's", 'Coutalay'], src: 'pleney.com — info pistes' },
  { name: "L'Aigle Noir", zone: 'Nyon', color: 'noire' },
  // ---------------- MORZINE — Chamossière
  { name: 'Le Tétras', zone: 'Chamossière', color: 'bleue' },
  { name: 'Les Choucas', zone: 'Chamossière', color: 'bleue' },
  { name: 'Bellemouille', zone: 'Chamossière', color: 'rouge', aliases: ['Belle Mouille'] },
  { name: "L'Eterlou", zone: 'Chamossière', color: 'rouge' },
  { name: 'Les Arbis', zone: 'Chamossière', color: 'rouge' },
  { name: 'Les Blanchots', zone: 'Chamossière', color: 'rouge' },
  { name: 'Les Chevrelles', zone: 'Chamossière', color: 'rouge' },
  { name: 'Les Creux', zone: 'Chamossière', color: 'noire' },
  // ---------------- LES GETS — Chavannes
  { name: 'Piste 64', zone: 'Chavannes', color: null },
  { name: 'Bleuet', zone: 'Chavannes', color: null },
  { name: 'Bruyère', zone: 'Chavannes', color: null },
  { name: 'Chardon Bleu', zone: 'Chavannes', color: null },
  { name: 'Crocus', zone: 'Chavannes', color: null },
  { name: 'Fougère', zone: 'Chavannes', color: null },
  { name: 'Gentiane', zone: 'Chavannes', color: 'bleue', src: RMNET },
  { name: 'Vieux Chêne', zone: 'Chavannes', color: null },
  { name: 'Perce-Neige', zone: 'Chavannes', color: null },
  { name: 'Orchis', zone: 'Chavannes', color: null },
  // ---------------- LES GETS — Ranfoilly-Nauchets
  { name: 'Cyclamen', zone: 'Ranfoilly-Nauchets', color: 'bleue', aliases: ['Cyclamens'], src: RMNET },
  { name: 'Tulipe', zone: 'Ranfoilly-Nauchets', color: null, note: 'Donnée bleue ou rouge selon les sources : couleur OSM affichée.' },
  { name: 'Violette', zone: 'Ranfoilly-Nauchets', color: 'bleue', src: CH1066 },
  { name: 'Ambresalles', zone: 'Ranfoilly-Nauchets', color: 'rouge', aliases: ['Ambresalle'], src: CH1066 },
  { name: 'Arnica', zone: 'Ranfoilly-Nauchets', color: 'rouge', src: CH1066 },
  { name: 'Fenerets', zone: 'Ranfoilly-Nauchets', color: 'rouge', src: CH1066 },
  { name: 'Rhodos', zone: 'Ranfoilly-Nauchets', color: 'rouge', src: CH1066 },
  { name: 'Sautenailles', zone: 'Ranfoilly-Nauchets', color: null },
  // ---------------- LES GETS — Rosta-Perrières
  { name: 'Campanule', zone: 'Rosta-Perrières', color: null },
  { name: 'Les Trembles', zone: 'Rosta-Perrières', color: null },
  { name: 'Reine des Prés', zone: 'Rosta-Perrières', color: 'bleue', src: CH1066 },
  { name: 'Renardière', zone: 'Rosta-Perrières', color: null },
  { name: 'Vorosses', zone: 'Rosta-Perrières', color: 'bleue', src: CH1066 },
  { name: 'Eglantine', zone: 'Rosta-Perrières', color: 'rouge', src: CH1066 },
  { name: 'Mélèzes', zone: 'Rosta-Perrières', color: 'rouge', src: CH1066 },
  { name: 'Myrtilles', zone: 'Rosta-Perrières', color: 'noire', src: POPLI },
  { name: 'Yéti', zone: 'Rosta-Perrières', color: 'noire', src: CH1066 },
  // ---------------- LES GETS — Mont-Chéry
  { name: 'Ourson', zone: 'Mont-Chéry', color: null },
  { name: 'Chamois', zone: 'Mont-Chéry', color: 'rouge', src: MOREMTN },
  { name: 'Epervier', zone: 'Mont-Chéry', color: 'rouge', src: MOREMTN },
  { name: 'Lièvre', zone: 'Mont-Chéry', color: null },
  { name: 'Marmotte', zone: 'Mont-Chéry', color: null },
  { name: 'Cabri', zone: 'Mont-Chéry', color: null },
  { name: 'Bouquetin', zone: 'Mont-Chéry', color: 'noire', src: MOREMTN },
  { name: 'Chevreuil', zone: 'Mont-Chéry', color: null },
  { name: 'Gazelle', zone: 'Mont-Chéry', color: 'noire', src: MOREMTN },
  { name: 'Mouflon', zone: 'Mont-Chéry', color: null },
];

export const SECTOR_SOURCES = [
  { label: 'Ouvertures Morzine — portesdusoleil.com', url: 'https://en.portesdusoleil.com/in-winter/openings-slopes-and-lifts/morzine-ski-lifts/' },
  { label: 'Ouvertures Les Gets — portesdusoleil.com', url: 'https://en.portesdusoleil.com/in-winter/slopes-and-lifts-en/ski-lifts-les-gets' },
  { label: 'Plan des pistes officiel Les Gets–Morzine (PDF)', url: 'https://www.portesdusoleil.com/app/uploads/lesportesdusoleil/2025/10/PDS_PLAN_HIVER_656x396_LES_GETS_MORZINE_WEB.pdf' },
];
