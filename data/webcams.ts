import type { Webcam } from '@/lib/types';

/**
 * Webcams du domaine.
 *
 * Volontairement vide : les flux webcam appartiennent aux offices de tourisme / exploitants
 * (souvent hébergés par des prestataires comme Skaping, Roundshot ou Panomax) et leurs URL
 * d'intégration doivent être récupérées depuis les pages officielles, avec autorisation.
 *
 * Ajoutez une entrée par webcam vérifiée, par exemple :
 * {
 *   id: 'avoriaz-pointe-de-mossette',
 *   name: 'Pointe de Mossette',
 *   coord: [6.8, 46.17],           // [longitude, latitude]
 *   alt: 2277,
 *   pageUrl: 'https://…',           // page officielle
 *   embedUrl: 'https://…',          // optionnel : iframe autorisée par le fournisseur
 *   imageUrl: 'https://…/last.jpg', // optionnel : dernière image
 *   provider: 'Skaping',
 * }
 *
 * Les webcams présentes dans OpenStreetMap (tag contact:webcam) sont ajoutées automatiquement.
 */
export const WEBCAMS: Webcam[] = [];
