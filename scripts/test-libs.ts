/* Tests rapides des bibliothèques pures (sans réseau) : npm run test:libs */
import assert from 'node:assert/strict';
import { transformOverpass, buildOverpassQuery, parseDuration } from '../lib/osm';
import { chainSegments, lineLength, haversine, resample } from '../lib/geo';
import { SkiGraph } from '../lib/routing';
import { parseOpenMeteo } from '../lib/weather';
import { STATIONS } from '../lib/stations';
import type { LngLat } from '../lib/types';

const g = (pts: LngLat[]) => pts.map(([lon, lat]) => ({ lon, lat }));

// Domaine synthétique près d'Avoriaz : altitude = f(latitude) (le nord est plus haut)
const elev = (p: LngLat) => 1000 + (p[1] - 46.18) * 40000;

const liftLine: LngLat[] = [[6.77, 46.18], [6.77, 46.19]];
const pisteA1: LngLat[] = [[6.7701, 46.19], [6.772, 46.186]];
const pisteA2: LngLat[] = [[6.772, 46.186], [6.775, 46.181]]; // continue A1
const pisteB: LngLat[] = [[6.775, 46.1811], [6.79, 46.175]]; // part du bas de A

const json = {
  elements: [
    { type: 'way', id: 1, tags: { aerialway: 'chair_lift', name: 'TS Test', 'aerialway:duration': '07:30' }, geometry: g(liftLine) },
    { type: 'way', id: 2, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate', 'piste:name': 'La Rouge' }, geometry: g(pisteA2) },
    { type: 'way', id: 3, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate', 'piste:name': 'La Rouge' }, geometry: g(pisteA1) },
    { type: 'way', id: 4, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'easy' }, geometry: g(pisteB) },
    { type: 'node', id: 10, lat: 46.1895, lon: 6.7702, tags: { amenity: 'restaurant', name: 'Le Refuge Test' } },
    { type: 'node', id: 11, lat: 46.3, lon: 6.6, tags: { amenity: 'restaurant', name: 'Restaurant de vallée' } },
    { type: 'way', id: 5, tags: { aerialway: 'pylon' }, geometry: g(liftLine) },
  ],
};

const d = transformOverpass(json as never);
assert.equal(d.lifts.length, 1, 'une remontée (pylône exclu)');
assert.equal(d.lifts[0].durationMin, 7.5);
const rouge = d.pistes.find((p) => p.name === 'La Rouge')!;
assert.ok(rouge, 'piste nommée regroupée');
assert.equal(rouge.difficulty, 'rouge');
assert.equal(rouge.line.length, 3, 'segments chaînés');
assert.ok(Math.abs(rouge.lengthM - lineLength([...pisteA1, pisteA2[1]])) < 1);
assert.equal(d.pistes.find((p) => !p.named)?.difficulty, 'bleue');
assert.ok(d.pois.some((p) => p.name === 'Le Refuge Test'), 'restaurant d’altitude retenu');
assert.ok(!d.pois.some((p) => p.name === 'Restaurant de vallée'), 'restaurant loin des pistes exclu');
assert.equal(rouge.sector, 'Avoriaz');

assert.equal(parseDuration('PT7M30S'), 7.5);
assert.equal(parseDuration('6'), 6);
assert.ok(buildOverpassQuery().includes('piste:type'));

// chaînage avec segment inversé
const ch = chainSegments([pisteA2, pisteA1.slice().reverse()]);
assert.equal(ch.length, 3);

// rééchantillonnage
const rs = resample([{ x: 0, z: 0 }, { x: 100, z: 0 }], 10);
assert.equal(rs.length, 11);

// Itinéraire : du bas de la remontée jusqu'au bas de la piste B
const graph = new SkiGraph(d.pistes, d.lifts, elev);
const r = graph.route([6.77, 46.18], [6.79, 46.175], 200)!;
assert.ok(r, 'itinéraire trouvé');
const kinds = r.steps.map((s) => s.kind + ':' + s.label);
assert.equal(r.steps[0].kind, 'lift', kinds.join(' > '));
assert.ok(kinds.some((k) => k.includes('La Rouge')), kinds.join(' > '));
assert.ok(r.minutes > 7.5);
// Sens interdit : on ne remonte pas une piste à pied ni à ski
const back = graph.route([6.79, 46.175], [6.7701, 46.19], 150);
assert.equal(back, null, 'pas de montée par les pistes');

// Météo
const om = STATIONS.slice(0, 1).map(() => ({
  current: { time: '2026-01-10T10:00', temperature_2m: -4, apparent_temperature: -9, weather_code: 73, wind_speed_10m: 20, wind_gusts_10m: 45, wind_direction_10m: 270, cloud_cover: 90 },
  hourly: {
    time: Array.from({ length: 96 }, (_, i) => `2026-01-0${7 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`),
    snow_depth: Array(96).fill(1.2),
    snowfall: Array(96).fill(0.5),
    visibility: Array(96).fill(800),
    freezing_level_height: Array(96).fill(900),
  },
}));
const w = parseOpenMeteo(STATIONS.slice(0, 1), om as never);
assert.equal(w[0].snowDepthCm, 120);
assert.equal(w[0].snowfall24hCm, 12);
assert.ok(haversine([0, 0], [0, 1]) > 111000);

console.log('✓ toutes les vérifications passent —', kinds.join(' > '));
