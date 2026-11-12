import type { DomainData, Difficulty, Lift, LiftKind, LngLat, Piste, Poi, PoiKind } from './types';
import { chainSegments, distanceToLine, lineLength } from './geo';
import { DOMAIN_BBOX, nearestStation } from './stations';

/** Requête Overpass : pistes de ski alpin, remontées, restaurants, points de vue, snowparks, webcams OSM. */
export function buildOverpassQuery(bbox = DOMAIN_BBOX): string {
  const [w, s, e, n] = bbox;
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:120];
(
  way["piste:type"="downhill"](${b});
  relation["piste:type"="downhill"](${b});
  way["piste:type"="snow_park"](${b});
  node["piste:type"="snow_park"](${b});
  way["aerialway"](${b});
  node["amenity"~"^(restaurant|bar|cafe|fast_food|pub)$"](${b});
  way["amenity"~"^(restaurant|bar|cafe)$"](${b});
  node["tourism"~"^(viewpoint|alpine_hut)$"](${b});
  node["amenity"~"^(shelter|bench)$"]["shelter_type"!="public_transport"](${b});
  node["contact:webcam"](${b});
  node["surveillance:type"="webcam"](${b});
);
out geom;`;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

const LIFT_KINDS: Record<string, LiftKind> = {
  cable_car: 'telepherique',
  gondola: 'telecabine',
  mixed_lift: 'telemix',
  chair_lift: 'telesiege',
  drag_lift: 'teleski',
  't-bar': 'teleski',
  'j-bar': 'teleski',
  platter: 'teleski',
  rope_tow: 'fil-neige',
  magic_carpet: 'tapis',
};

const EXCLUDED_AERIALWAY = new Set(['station', 'pylon', 'zip_line', 'goods', 'canopy', 'yes']);

export function difficultyFromOsm(d?: string): Difficulty {
  switch (d) {
    case 'novice':
      return 'verte';
    case 'easy':
      return 'bleue';
    case 'intermediate':
      return 'rouge';
    case 'advanced':
    case 'expert':
      return 'noire';
    case 'freeride':
    case 'extreme':
      return 'freeride';
    default:
      return 'inconnue';
  }
}

const geomToLine = (g?: { lat: number; lon: number }[]): LngLat[] =>
  (g ?? []).map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6] as LngLat);

export function transformOverpass(json: { elements: OsmElement[] }): DomainData {
  const elements = json.elements ?? [];
  const wayById = new Map<number, OsmElement>();
  for (const el of elements) if (el.type === 'way') wayById.set(el.id, el);

  // --- Pistes : regroupement par (nom, difficulté), les relations "route=piste" apportant le nom.
  type Group = { name: string; named: boolean; osmDiff?: string; segs: LngLat[][]; ids: number[]; grooming?: string; width?: number; snowpark: boolean };
  const groups = new Map<string, Group>();
  const wayInRelation = new Set<number>();

  const addToGroup = (key: string, init: Omit<Group, 'segs' | 'ids'>, seg: LngLat[], id: number) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...init, segs: [], ids: [] };
      groups.set(key, g);
    }
    if (seg.length >= 2) g.segs.push(seg);
    g.ids.push(id);
  };

  for (const el of elements) {
    if (el.type !== 'relation' || el.tags?.['piste:type'] !== 'downhill') continue;
    const t = el.tags;
    const name = t['piste:name'] || t.name || t.ref;
    const diff = t['piste:difficulty'];
    for (const m of el.members ?? []) {
      if (m.type !== 'way') continue;
      const geom = m.geometry ?? wayById.get(m.ref)?.geometry;
      const seg = geomToLine(geom);
      wayInRelation.add(m.ref);
      const key = name ? `n:${name}|${diff}` : `r:${el.id}`;
      addToGroup(key, { name: name ?? '', named: !!name, osmDiff: diff, grooming: t['piste:grooming'], snowpark: false }, seg, el.id);
    }
  }

  const pois: Poi[] = [];

  for (const el of elements) {
    if (el.type !== 'way') continue;
    const t = el.tags ?? {};
    const pt = t['piste:type'];
    if (pt !== 'downhill' && pt !== 'snow_park') continue;
    const seg = geomToLine(el.geometry);
    // Polygones (zones de piste, snowparks) : on garde le contour mais on ne les chaîne pas.
    const closed = seg.length > 3 && seg[0][0] === seg[seg.length - 1][0] && seg[0][1] === seg[seg.length - 1][1];
    if (pt === 'snow_park' || t.leisure === 'snow_park') {
      const c = seg[Math.floor(seg.length / 2)];
      if (c) pois.push(makePoi(`w${el.id}`, t.name || 'Snowpark', 'snowpark', centroid(seg), t));
      continue;
    }
    if (closed || t.area === 'yes') continue;
    if (wayInRelation.has(el.id) && !(t['piste:name'] || t.name)) continue;
    const name = t['piste:name'] || t.name || t.ref;
    const diff = t['piste:difficulty'];
    const key = name ? `n:${name}|${diff}` : `w:${el.id}`;
    const width = t.width ? parseFloat(t.width) : undefined;
    addToGroup(key, { name: name ?? '', named: !!name, osmDiff: diff, grooming: t['piste:grooming'], width: isFinite(width ?? NaN) ? width : undefined, snowpark: false }, seg, el.id);
  }

  const pistes: Piste[] = [];
  // Un même nom peut exister dans deux stations : on sépare par secteur.
  for (const g of groups.values()) {
    if (!g.segs.length) continue;
    const bySector = new Map<string, LngLat[][]>();
    for (const s of g.segs) {
      const sec = nearestStation(s[0]).name;
      if (!bySector.has(sec)) bySector.set(sec, []);
      bySector.get(sec)!.push(s);
    }
    for (const [sector, segs] of bySector) {
      const line = chainSegments(segs);
      if (line.length < 2) continue;
      const lengthM = Math.round(lineLength(line));
      if (lengthM < 40) continue;
      const ids = Array.from(new Set(g.ids));
      const difficulty = difficultyFromOsm(g.osmDiff);
      pistes.push({
        id: `piste:${sector}:${g.named ? g.name : ids[0]}:${g.osmDiff ?? 'x'}`.replace(/\s+/g, '_'),
        name: g.named ? g.name : `Piste sans nom (OSM ${ids[0]})`,
        named: g.named,
        difficulty,
        osmDifficulty: g.osmDiff,
        sector,
        segments: segs,
        line,
        lengthM,
        grooming: g.grooming,
        widthM: g.width,
        osmIds: ids,
        snowpark: false,
      });
    }
  }

  // --- Remontées mécaniques
  const lifts: Lift[] = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const t = el.tags ?? {};
    const a = t.aerialway;
    if (!a || EXCLUDED_AERIALWAY.has(a)) continue;
    const line = geomToLine(el.geometry);
    if (line.length < 2) continue;
    const kind = LIFT_KINDS[a] ?? 'autre';
    const dur = t['aerialway:duration'];
    lifts.push({
      id: `lift:${el.id}`,
      osmId: el.id,
      name: t.name || t.ref || `Remontée sans nom (OSM ${el.id})`,
      kind,
      osmKind: a,
      sector: nearestStation(line[0]).name,
      line,
      lengthM: Math.round(lineLength(line)),
      capacity: num(t['aerialway:capacity']),
      occupancy: num(t['aerialway:occupancy']),
      durationMin: dur ? parseDuration(dur) : undefined,
      openingHours: t.opening_hours,
    });
  }

  // --- Points d'intérêt (restaurants « d'altitude » = à moins de 200 m d'une piste ou d'une remontée)
  const allLines: LngLat[][] = [...pistes.map((p) => p.line), ...lifts.map((l) => l.line)];
  const nearSlopes = (c: LngLat) => {
    for (const l of allLines) {
      // pré-filtre grossier
      const [x0, y0] = l[0];
      if (Math.abs(x0 - c[0]) > 0.05 || Math.abs(y0 - c[1]) > 0.04) {
        const [x1, y1] = l[l.length - 1];
        if (Math.abs(x1 - c[0]) > 0.05 || Math.abs(y1 - c[1]) > 0.04) continue;
      }
      if (distanceToLine(c, l) < 200) return true;
    }
    return false;
  };

  for (const el of elements) {
    const t = el.tags ?? {};
    let coord: LngLat | null = null;
    if (el.type === 'node' && el.lat != null && el.lon != null) coord = [el.lon, el.lat];
    else if (el.type === 'way' && el.geometry) coord = centroid(geomToLine(el.geometry));
    if (!coord) continue;
    const id = `${el.type[0]}${el.id}`;
    if (el.type === 'node' && t['piste:type'] === 'snow_park') {
      pois.push(makePoi(id, t.name || 'Snowpark', 'snowpark', coord, t));
    } else if (t['contact:webcam'] || t['surveillance:type'] === 'webcam') {
      pois.push(makePoi(id, t.name || 'Webcam', 'webcam', coord, t));
    } else if (t.tourism === 'viewpoint') {
      pois.push(makePoi(id, t.name || 'Point panoramique', 'viewpoint', coord, t));
    } else if (t.tourism === 'alpine_hut') {
      pois.push(makePoi(id, t.name || 'Refuge', 'hut', coord, t));
    } else if (t.amenity === 'shelter' || t.amenity === 'bench') {
      if (nearSlopes(coord)) pois.push(makePoi(id, t.name || (t.amenity === 'shelter' ? 'Abri' : 'Espace de repos'), 'repos', coord, t));
    } else if (t.amenity && /^(restaurant|bar|cafe|fast_food|pub)$/.test(t.amenity)) {
      if (!t.name) continue;
      if (!nearSlopes(coord)) continue;
      const kind: PoiKind = t.amenity === 'bar' || t.amenity === 'pub' ? 'bar' : 'restaurant';
      pois.push(makePoi(id, t.name, kind, coord, t));
    }
  }

  // Zones débutants (pistes vertes / novice) et hors-piste balisé (freeride) en tant que points d'info
  for (const p of pistes) {
    if (p.difficulty === 'verte' && p.named) pois.push(makePoi(`deb:${p.id}`, `Zone débutants — ${p.name}`, 'debutant', p.line[0], {}));
    if (p.difficulty === 'freeride') pois.push(makePoi(`fr:${p.id}`, `Itinéraire hors-piste — ${p.name}`, 'freeride', p.line[0], {}));
  }

  return {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap contributors (ODbL) via Overpass API',
    bbox: DOMAIN_BBOX,
    pistes,
    lifts,
    pois,
  };
}

function makePoi(id: string, name: string, kind: PoiKind, coord: LngLat, tags: Record<string, string>): Poi {
  return { id: `poi:${id}`, name, kind, coord, sector: nearestStation(coord).name, tags, ele: num(tags.ele) };
}

function centroid(line: LngLat[]): LngLat {
  let x = 0, y = 0;
  for (const p of line) {
    x += p[0];
    y += p[1];
  }
  return [x / line.length, y / line.length];
}

function num(v?: string): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v.replace(',', '.'));
  return isFinite(n) ? n : undefined;
}

/** aerialway:duration : "7", "07:30", "PT7M"… → minutes */
export function parseDuration(v: string): number | undefined {
  const iso = /^PT(?:(\d+)M)?(?:(\d+)S)?$/i.exec(v);
  if (iso) return (parseInt(iso[1] || '0') * 60 + parseInt(iso[2] || '0')) / 60;
  const mmss = /^(\d+):(\d{2})$/.exec(v);
  if (mmss) return parseInt(mmss[1]) + parseInt(mmss[2]) / 60;
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}
