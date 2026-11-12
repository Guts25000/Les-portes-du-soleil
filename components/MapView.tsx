'use client';
import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature, type StyleSpecification } from 'maplibre-gl';
import type { DomainData, LngLat, Selection, Webcam } from '@/lib/types';
import { STATIONS, DOMAIN_CENTER } from '@/lib/stations';
import { TERRARIUM_URL } from '@/lib/dem';
import { DIFF_COLOR } from '@/lib/estimates';
import { bboxOf, midpoint } from '@/lib/geo';
import type { RouteResult } from '@/lib/routing';

export interface Filters {
  verte: boolean;
  bleue: boolean;
  rouge: boolean;
  noire: boolean;
  freeride: boolean;
  lifts: boolean;
  webcams: boolean;
  restaurants: boolean;
  snowparks: boolean;
  pois: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  verte: true,
  bleue: true,
  rouge: true,
  noire: true,
  freeride: true,
  lifts: true,
  webcams: true,
  restaurants: true,
  snowparks: true,
  pois: true,
};

export type Basemap = 'satellite' | 'topo';

interface Props {
  data: DomainData | null;
  webcams: Webcam[];
  filters: Filters;
  mode3d: boolean;
  basemap: Basemap;
  selection: Selection | null;
  focus: { sel: Selection; nonce: number } | null;
  route: RouteResult | null;
  intro: boolean;
  onSelect: (s: Selection) => void;
  onReady?: () => void;
}

const POI_ICONS: Record<string, string> = {
  restaurant: '🍽️',
  bar: '🍺',
  snowpark: '🏂',
  webcam: '📷',
  viewpoint: '🔭',
  hut: '🛖',
  debutant: '🐣',
  freeride: '⚠️',
  repos: '🪑',
};

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 18,
        attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics',
      },
      topo: {
        type: 'raster',
        tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 17,
        attribution: '© OpenTopoMap (CC-BY-SA)',
      },
      terrain: {
        type: 'raster-dem',
        tiles: [TERRARIUM_URL],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
        attribution: 'Relief : AWS Terrain Tiles (Mapzen / SRTM / EU-DEM)',
      },
      hillshadeSrc: {
        type: 'raster-dem',
        tiles: [TERRARIUM_URL],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dfe7ee' } },
      { id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-saturation': -0.15, 'raster-contrast': 0.08 } },
      { id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshadeSrc',
        paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0d1b2a', 'hillshade-highlight-color': '#ffffff' },
      },
    ],
  };
}

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });

function emojiImage(emoji: string, ring: string): ImageData {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(19,22,26,0.85)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.font = '30px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, s / 2, s / 2 + 2);
  return ctx.getImageData(0, 0, s, s);
}

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const propsRef = useRef(p);
  propsRef.current = p;
  const spin = useRef<number | null>(null);

  // --- Initialisation
  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: baseStyle(),
      center: DOMAIN_CENTER,
      zoom: 9.6,
      pitch: 20,
      bearing: 0,
      maxPitch: 80,
      maxBounds: [
        [6.3, 45.95],
        [7.25, 46.55],
      ],
      attributionControl: { compact: true },
      antialias: true,
    } as maplibregl.MapOptions);
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      map.setTerrain({ source: 'terrain', exaggeration: 1.15 });
      const anyMap = map as unknown as { setSky?: (s: unknown) => void };
      try {
        anyMap.setSky?.({
          'sky-color': '#5d9fd6',
          'sky-horizon-blend': 0.6,
          'horizon-color': '#dcebf6',
          'horizon-fog-blend': 0.7,
          'fog-color': '#c9dbe8',
          'fog-ground-blend': 0.2,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0.6, 15, 0],
        });
      } catch {
        /* version sans ciel */
      }

      for (const [k, e] of Object.entries(POI_ICONS)) {
        const ring = k === 'freeride' ? '#f59e0b' : k === 'webcam' ? '#3d8bff' : k === 'snowpark' ? '#a855f7' : '#a9d6ea';
        map.addImage(`poi-${k}`, emojiImage(e, ring), { pixelRatio: 2 });
      }

      map.addSource('pistes', { type: 'geojson', data: fc([]) });
      map.addSource('piste-points', { type: 'geojson', data: fc([]) });
      map.addSource('lifts', { type: 'geojson', data: fc([]) });
      map.addSource('lift-ends', { type: 'geojson', data: fc([]) });
      map.addSource('pois', { type: 'geojson', data: fc([]) });
      map.addSource('route', { type: 'geojson', data: fc([]) });
      map.addSource('highlight', { type: 'geojson', data: fc([]) });

      map.addLayer({
        id: 'pistes-casing',
        type: 'line',
        source: 'pistes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': 'rgba(255,255,255,0.85)', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 5, 16, 9] },
      });
      map.addLayer({
        id: 'pistes-line',
        type: 'line',
        source: 'pistes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 3, 16, 6],
        },
      });
      // Itinéraires hors-piste : pointillés (line-dasharray n'accepte pas d'expression par entité)
      map.addLayer({
        id: 'pistes-freeride',
        type: 'line',
        source: 'pistes',
        filter: ['==', ['get', 'difficulty'], 'freeride'],
        paint: { 'line-color': '#f59e0b', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 3, 16, 5], 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'lifts-line',
        type: 'line',
        source: 'lifts',
        paint: {
          'line-color': ['case', ['in', ['get', 'kind'], ['literal', ['telecabine', 'telepherique', 'telemix']]], '#0b0d10', '#2a2f36'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 15, 3],
        },
      });
      map.addLayer({
        id: 'lifts-hit',
        type: 'line',
        source: 'lifts',
        paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 14 },
      });
      map.addLayer({
        id: 'lift-ends',
        type: 'circle',
        source: 'lift-ends',
        minzoom: 11.5,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 2, 15, 5], 'circle-color': '#0b0d10', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
      });
      map.addLayer({
        id: 'highlight',
        type: 'line',
        source: 'highlight',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#3d8bff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 12], 'line-opacity': 0.55, 'line-blur': 2 },
      });
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#1f6bff', 'line-width': 14, 'line-opacity': 0.35, 'line-blur': 6 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        filter: ['==', ['get', 'kind'], 'piste'],
        paint: { 'line-color': '#3d8bff', 'line-width': 4.5 },
      });
      map.addLayer({
        id: 'route-transport',
        type: 'line',
        source: 'route',
        filter: ['!=', ['get', 'kind'], 'piste'],
        paint: {
          'line-color': ['case', ['==', ['get', 'kind'], 'lift'], '#ffffff', '#a9d6ea'],
          'line-width': 4,
          'line-dasharray': [1.5, 1],
        },
      });
      map.addLayer({
        id: 'piste-points',
        type: 'circle',
        source: 'piste-points',
        minzoom: 12.3,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.3, 3.5, 15, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'pistes-label',
        type: 'symbol',
        source: 'pistes',
        minzoom: 13.3,
        filter: ['==', ['get', 'named'], true],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 12,
          'text-max-angle': 30,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': ['get', 'color'], 'text-halo-width': 1.6 },
      });
      map.addLayer({
        id: 'lifts-label',
        type: 'symbol',
        source: 'lifts',
        minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'], 'text-size': 11 },
        paint: { 'text-color': '#0b0d10', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      });
      map.addLayer({
        id: 'pois',
        type: 'symbol',
        source: 'pois',
        minzoom: 11.8,
        layout: {
          'icon-image': ['concat', 'poi-', ['get', 'kind']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11.8, 0.7, 15, 1],
          'icon-allow-overlap': true,
          'text-field': ['step', ['zoom'], '', 14.5, ['get', 'name']],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#13161a', 'text-halo-width': 1.4 },
      });

      const clickable = ['piste-points', 'pistes-line', 'pistes-freeride', 'lifts-hit', 'pois'];
      for (const id of clickable) {
        map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
      }
      map.on('click', (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: clickable.filter((l) => map.getLayer(l)) });
        if (!feats.length) return;
        // priorité : POI > point de piste > remontée > tracé de piste
        const order = ['pois', 'piste-points', 'lifts-hit', 'pistes-line', 'pistes-freeride'];
        feats.sort((a, b) => order.indexOf(a.layer.id) - order.indexOf(b.layer.id));
        const sel = featureToSelection(feats[0]);
        if (sel) propsRef.current.onSelect(sel);
      });

      // Stations : marqueurs HTML
      for (const s of STATIONS) {
        const node = document.createElement('div');
        node.className = 'station-marker';
        node.innerHTML = `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px 5px 6px;border-radius:999px;background:rgba(19,22,26,.72);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 18px rgba(0,0,0,.35);font:600 12px Inter,system-ui;color:#f5f8fb;white-space:nowrap">
          <span style="width:18px;height:18px;border-radius:50%;display:grid;place-items:center;background:${s.country === 'CH' ? '#d52b1e' : '#1f6bff'};font-size:9px;font-weight:800">${s.country}</span>${s.name}</div>`;
        node.addEventListener('click', (ev) => {
          ev.stopPropagation();
          propsRef.current.onSelect({ type: 'station', item: s });
        });
        new maplibregl.Marker({ element: node, anchor: 'bottom' }).setLngLat(s.coord).addTo(map);
      }

      loaded.current = true;
      syncData();
      syncFilters();
      syncRoute();
      syncHighlight();
      p.onReady?.();
    });

    return () => {
      if (spin.current) cancelAnimationFrame(spin.current);
      map.remove();
      mapRef.current = null;
      loaded.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function featureToSelection(f: MapGeoJSONFeature): Selection | null {
    const { data, webcams } = propsRef.current;
    if (!data) return null;
    const id = f.properties?.id as string;
    if (f.layer.id === 'piste-points' || f.layer.id === 'pistes-line' || f.layer.id === 'pistes-freeride') {
      const item = data.pistes.find((x) => x.id === id);
      return item ? { type: 'piste', item } : null;
    }
    if (f.layer.id === 'lifts-hit') {
      const item = data.lifts.find((x) => x.id === id);
      return item ? { type: 'lift', item } : null;
    }
    if (f.layer.id === 'pois') {
      const cam = webcams.find((w) => w.id === id);
      if (cam) return { type: 'webcam', item: cam };
      const item = data.pois.find((x) => x.id === id);
      return item ? { type: 'poi', item } : null;
    }
    return null;
  }

  // --- Synchronisation des données
  function syncData() {
    const map = mapRef.current;
    const { data, webcams } = propsRef.current;
    if (!map || !loaded.current || !data) return;
    (map.getSource('pistes') as GeoJSONSource).setData(
      fc(
        data.pistes.map((pi) => ({
          type: 'Feature',
          properties: { id: pi.id, name: pi.name, named: pi.named, difficulty: pi.difficulty, color: DIFF_COLOR[pi.difficulty] },
          geometry: { type: 'MultiLineString', coordinates: pi.segments },
        })),
      ),
    );
    (map.getSource('piste-points') as GeoJSONSource).setData(
      fc(
        data.pistes.map((pi) => ({
          type: 'Feature',
          properties: { id: pi.id, difficulty: pi.difficulty, color: DIFF_COLOR[pi.difficulty] },
          geometry: { type: 'Point', coordinates: midpoint(pi.line) },
        })),
      ),
    );
    (map.getSource('lifts') as GeoJSONSource).setData(
      fc(data.lifts.map((l) => ({ type: 'Feature', properties: { id: l.id, name: l.name, kind: l.kind }, geometry: { type: 'LineString', coordinates: l.line } }))),
    );
    (map.getSource('lift-ends') as GeoJSONSource).setData(
      fc(
        data.lifts.flatMap((l) => [l.line[0], l.line[l.line.length - 1]]).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })),
      ),
    );
    const poiFeatures: GeoJSON.Feature[] = data.pois.map((x) => ({
      type: 'Feature',
      properties: { id: x.id, name: x.name, kind: x.kind },
      geometry: { type: 'Point', coordinates: x.coord },
    }));
    for (const w of webcams) poiFeatures.push({ type: 'Feature', properties: { id: w.id, name: w.name, kind: 'webcam' }, geometry: { type: 'Point', coordinates: w.coord } });
    (map.getSource('pois') as GeoJSONSource).setData(fc(poiFeatures));
  }

  function syncFilters() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const f = propsRef.current.filters;
    const diffs = (['verte', 'bleue', 'rouge', 'noire', 'freeride'] as const).filter((d) => f[d]) as string[];
    diffs.push('inconnue');
    const df = ['in', ['get', 'difficulty'], ['literal', diffs]] as maplibregl.FilterSpecification;
    map.setFilter('pistes-line', ['all', df, ['!=', ['get', 'difficulty'], 'freeride']] as maplibregl.FilterSpecification);
    map.setLayoutProperty('pistes-freeride', 'visibility', f.freeride ? 'visible' : 'none');
    map.setFilter('pistes-casing', df);
    map.setFilter('piste-points', df);
    map.setFilter('pistes-label', ['all', ['==', ['get', 'named'], true], df] as maplibregl.FilterSpecification);
    const vis = (b: boolean) => (b ? 'visible' : 'none');
    for (const l of ['lifts-line', 'lifts-hit', 'lift-ends', 'lifts-label']) map.setLayoutProperty(l, 'visibility', vis(f.lifts));
    const kinds: string[] = [];
    if (f.restaurants) kinds.push('restaurant', 'bar');
    if (f.snowparks) kinds.push('snowpark');
    if (f.webcams) kinds.push('webcam');
    if (f.pois) kinds.push('viewpoint', 'hut', 'debutant', 'freeride', 'repos');
    map.setFilter('pois', ['in', ['get', 'kind'], ['literal', kinds]] as maplibregl.FilterSpecification);
  }

  function syncRoute() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const r = propsRef.current.route;
    (map.getSource('route') as GeoJSONSource).setData(
      fc((r?.legs ?? []).map((l) => ({ type: 'Feature', properties: { kind: l.kind }, geometry: { type: 'LineString', coordinates: l.coords } }))),
    );
    if (r && r.coords.length > 1) {
      const [w, s, e, n] = bboxOf(r.coords);
      map.fitBounds([[w, s], [e, n]], { padding: { top: 80, bottom: 80, left: 380, right: 80 }, pitch: 55, duration: 1800 });
    }
  }

  function syncHighlight() {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    const s = propsRef.current.selection;
    let coords: LngLat[][] = [];
    if (s?.type === 'piste') coords = s.item.segments;
    if (s?.type === 'lift') coords = [s.item.line];
    (map.getSource('highlight') as GeoJSONSource).setData(
      fc(coords.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: coords } }] : []),
    );
  }

  useEffect(syncData, [p.data, p.webcams]);
  useEffect(syncFilters, [p.filters]);
  useEffect(syncRoute, [p.route]);
  useEffect(syncHighlight, [p.selection]);

  // --- Fond de carte
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    map.setLayoutProperty('satellite', 'visibility', p.basemap === 'satellite' ? 'visible' : 'none');
    map.setLayoutProperty('topo', 'visibility', p.basemap === 'topo' ? 'visible' : 'none');
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', p.basemap === 'topo' ? 0.15 : 0.35);
  }, [p.basemap]);

  // --- 2D / 3D
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    if (p.mode3d) {
      map.setTerrain({ source: 'terrain', exaggeration: 1.15 });
      map.easeTo({ pitch: 62, duration: 900 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
    }
  }, [p.mode3d]);

  // --- Animation d'introduction : rotation lente autour du domaine
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (p.intro) {
      const start = () => {
        map.flyTo({ center: DOMAIN_CENTER, zoom: 11.3, pitch: 68, bearing: -25, duration: 4500, essential: true });
        const rotate = () => {
          if (!map.isMoving()) map.setBearing(map.getBearing() + 0.04);
          spin.current = requestAnimationFrame(rotate);
        };
        map.once('moveend', () => (spin.current = requestAnimationFrame(rotate)));
      };
      if (loaded.current) start();
      else map.once('load', start);
    } else if (spin.current) {
      cancelAnimationFrame(spin.current);
      spin.current = null;
      map.easeTo({ zoom: 11.8, pitch: p.mode3d ? 60 : 0, duration: 1400 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.intro]);

  // --- Déplacement de caméra vers une sélection
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.focus) return;
    const s = p.focus.sel;
    const pitch = p.mode3d ? 60 : 0;
    const pad = { top: 90, bottom: 120, left: window.innerWidth > 900 ? 400 : 40, right: window.innerWidth > 900 ? 420 : 40 };
    if (s.type === 'piste' || s.type === 'lift') {
      const pts = s.type === 'piste' ? s.item.segments.flat() : s.item.line;
      const [w, so, e, n] = bboxOf(pts);
      map.fitBounds([[w, so], [e, n]], { padding: pad, pitch, maxZoom: 15.5, duration: 2000 });
    } else {
      const c = s.type === 'station' ? s.item.coord : s.item.coord;
      map.flyTo({ center: c, zoom: s.type === 'station' ? 13.2 : 15.5, pitch, duration: 2200, essential: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus]);

  return <div ref={el} className="absolute inset-0" />;
}
