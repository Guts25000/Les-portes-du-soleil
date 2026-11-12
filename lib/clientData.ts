/**
 * Chargement des données directement depuis le navigateur (site statique, compatible GitHub Pages).
 * - Pistes / remontées / POI : Overpass API (OpenStreetMap), mis en cache 24 h dans IndexedDB.
 * - Météo : Open-Meteo, rafraîchie toutes les 15 min.
 */
import type { DomainData } from './types';
import { buildOverpassQuery, transformOverpass } from './osm';
import { STATIONS } from './stations';
import { buildOpenMeteoUrl, parseOpenMeteo, type WeatherPayload } from './weather';

const OVERPASS = [
  process.env.NEXT_PUBLIC_OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
].filter(Boolean) as string[];

const CACHE_KEY = 'domain-v1';
const TTL = 24 * 3600 * 1000;

// --- Petit cache IndexedDB (les données font plusieurs Mo : trop pour localStorage)
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('pds3d', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('cache');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheGet<T>(key: string): Promise<{ at: number; value: T } | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction('cache').objectStore('cache').get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheSet<T>(key: string, value: T) {
  const db = await idb();
  if (!db) return;
  try {
    db.transaction('cache', 'readwrite').objectStore('cache').put({ at: Date.now(), value }, key);
  } catch {
    /* quota dépassé : tant pis, on rechargera */
  }
}

export async function loadDomain(onStatus?: (msg: string) => void): Promise<DomainData> {
  const cached = await cacheGet<DomainData>(CACHE_KEY);
  if (cached && Date.now() - cached.at < TTL) return cached.value;

  const query = buildOverpassQuery();
  let lastErr: unknown = null;
  for (const url of OVERPASS) {
    try {
      onStatus?.(`Téléchargement des pistes OpenStreetMap (${new URL(url).host})…`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      onStatus?.('Analyse des pistes et remontées…');
      const data = transformOverpass(json);
      if (!data.pistes.length) throw new Error('réponse vide');
      cacheSet(CACHE_KEY, data);
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  // Serveurs indisponibles : on ressert un cache périmé plutôt que rien
  if (cached) return cached.value;
  throw lastErr ?? new Error('Aucun serveur Overpass disponible');
}

export async function loadWeather(): Promise<WeatherPayload> {
  const res = await fetch(buildOpenMeteoUrl(STATIONS));
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return {
    source: 'Open-Meteo (modèles météo, CC BY 4.0) — valeurs modélisées, pas des relevés officiels des stations',
    fetchedAt: new Date().toISOString(),
    sectors: parseOpenMeteo(STATIONS, await res.json()),
  };
}
