import type { Station } from './types';

export interface SectorWeather {
  stationId: string;
  name: string;
  alt: number; // altitude du point de calcul
  time: string;
  temperature: number;
  apparent: number;
  weatherCode: number;
  windSpeed: number; // km/h
  windGusts: number; // km/h
  windDir: number;
  cloudCover: number;
  visibilityM: number | null;
  snowDepthCm: number | null; // modèle
  snowfall24hCm: number;
  snowfall72hCm: number;
  freezingLevelM: number | null;
}

export interface WeatherPayload {
  source: string;
  fetchedAt: string;
  sectors: SectorWeather[];
}

/** Libellés WMO (codes Open-Meteo). */
export function weatherLabel(code: number): { label: string; icon: string } {
  if (code === 0) return { label: 'Ciel dégagé', icon: '☀️' };
  if (code <= 2) return { label: 'Peu nuageux', icon: '🌤️' };
  if (code === 3) return { label: 'Couvert', icon: '☁️' };
  if (code === 45 || code === 48) return { label: 'Brouillard', icon: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Bruine', icon: '🌦️' };
  if (code >= 61 && code <= 67) return { label: 'Pluie', icon: '🌧️' };
  if (code >= 71 && code <= 77) return { label: 'Neige', icon: '🌨️' };
  if (code >= 80 && code <= 82) return { label: 'Averses', icon: '🌦️' };
  if (code === 85 || code === 86) return { label: 'Averses de neige', icon: '🌨️' };
  if (code >= 95) return { label: 'Orage', icon: '⛈️' };
  return { label: '—', icon: '·' };
}

export function buildOpenMeteoUrl(stations: Station[]): string {
  const p = new URLSearchParams({
    latitude: stations.map((s) => s.coord[1].toFixed(4)).join(','),
    longitude: stations.map((s) => s.coord[0].toFixed(4)).join(','),
    elevation: stations.map((s) => String(s.alt)).join(','),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover',
    hourly: 'snow_depth,snowfall,visibility,freezing_level_height',
    past_days: '3',
    forecast_days: '1',
    timezone: 'Europe/Paris',
    wind_speed_unit: 'kmh',
  });
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

interface OMResult {
  current: Record<string, number | string>;
  hourly: { time: string[]; snow_depth: (number | null)[]; snowfall: (number | null)[]; visibility: (number | null)[]; freezing_level_height: (number | null)[] };
}

export function parseOpenMeteo(stations: Station[], raw: OMResult | OMResult[]): SectorWeather[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((r, i) => {
    const s = stations[i];
    const cur = r.current;
    const curTime = String(cur.time);
    const h = r.hourly;
    // index de l'heure courante dans la série horaire
    let idx = h.time.findIndex((t) => t >= curTime.slice(0, 13));
    if (idx < 0) idx = h.time.length - 1;
    const sumBack = (hours: number) => {
      let sum = 0;
      for (let k = Math.max(0, idx - hours + 1); k <= idx; k++) sum += h.snowfall[k] ?? 0;
      return Math.round(sum * 10) / 10;
    };
    const sd = h.snow_depth[idx];
    return {
      stationId: s.id,
      name: s.name,
      alt: s.alt,
      time: curTime,
      temperature: Number(cur.temperature_2m),
      apparent: Number(cur.apparent_temperature),
      weatherCode: Number(cur.weather_code),
      windSpeed: Number(cur.wind_speed_10m),
      windGusts: Number(cur.wind_gusts_10m),
      windDir: Number(cur.wind_direction_10m),
      cloudCover: Number(cur.cloud_cover),
      visibilityM: h.visibility[idx] ?? null,
      snowDepthCm: sd == null ? null : Math.round(sd * 100),
      snowfall24hCm: sumBack(24),
      snowfall72hCm: sumBack(72),
      freezingLevelM: h.freezing_level_height[idx] ?? null,
    };
  });
}
