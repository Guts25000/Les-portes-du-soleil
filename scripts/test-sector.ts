/* Rapprochement liste officielle ↔ OSM + médailles */
import assert from 'node:assert/strict';
import { matchSector, nameKey } from '../lib/sectorMatch';
import { medalTargets, medalFor, recordRun, totals, isUnlocked } from '../lib/championship';
import type { DomainData, Piste, LngLat } from '../lib/types';
import { OFFICIAL_PISTES } from '../data/morzineLesGets';

const mk = (name: string, diff: Piste['difficulty'], line: LngLat[], sector = 'Morzine'): Piste => ({
  id: 'p:' + name + line[0][0], name, named: true, difficulty: diff, sector, segments: [line], line, lengthM: 1000, osmIds: [1], snowpark: false,
});

const data: DomainData = {
  generatedAt: '', source: '', bbox: [0, 0, 0, 0], lifts: [], pois: [],
  pistes: [
    mk('Le Chamois', 'rouge', [[6.735, 46.162], [6.72, 46.17]]),            // Nyon
    mk('Chamois', 'rouge', [[6.632, 46.15], [6.64, 46.155]], 'Les Gets'),    // Mont-Chéry
    mk('Chamois', 'bleue', [[6.84, 46.27], [6.85, 46.28]], 'Châtel'),        // homonyme lointain
    mk("L'Aigle Rouge", 'rouge', [[6.74, 46.152], [6.735, 46.158]]),
    mk('Aigle Rouge partie basse', 'rouge', [[6.735, 46.158], [6.73, 46.163]]),
    mk('Pâquérages', 'bleue', [[6.725, 46.16], [6.72, 46.163]]),
    mk('Piste B', 'bleue', [[6.70, 46.166], [6.705, 46.175]]),
    mk('Tulipe', 'bleue', [[6.678, 46.182], [6.672, 46.175]], 'Les Gets'),
    mk('Renard', 'rouge', [[6.70, 46.167], [6.704, 46.172]]),
  ],
};

assert.equal(nameKey("L'Aigle Rouge"), 'aigle rouge');
assert.equal(nameKey('Les Paquerages'), nameKey('Pâquérages'));
assert.equal(nameKey('Piste 64'), '64');

const s = matchSector(data);
const get = (n: string, z?: string) => s.find((e) => e.official.name === n && (!z || e.zone === z))!;
assert.equal(get('Le Chamois').osm.length, 1, 'Chamois de Nyon : un seul tronçon');
assert.equal(get('Le Chamois').osm[0].line[0][0], 6.735);
assert.equal(get('Chamois', 'Mont-Chéry').osm.length, 1, 'Chamois du Mont-Chéry séparé');
assert.equal(get('Chamois', 'Mont-Chéry').osm[0].line[0][0], 6.632);
assert.equal(get("L'Aigle Rouge").osm.length, 2, 'parties haute et basse fusionnées');
assert.equal(get("L'Aigle Rouge").piste!.line.length, 3, 'tracé chaîné');
assert.ok(get('Les Paquerages').piste, 'accents/pluriels tolérés');
assert.ok(get('Piste B').piste);
assert.equal(get('Tulipe').difficulty, 'bleue', 'couleur OSM si pas de couleur officielle');
assert.equal(get('Tulipe').colorSource, 'OSM');
assert.equal(get('Le Chamois').colorSource, 'officielle');
assert.equal(get('Gazelle').piste, null, 'piste absente d’OSM → manquante');
assert.equal(get('Renard').difficulty, 'rouge');
assert.equal(s.length, OFFICIAL_PISTES.length);
const ids = new Set(s.filter((e) => e.piste).map((e) => e.piste!.id));
assert.equal(ids.size, s.filter((e) => e.piste).length, 'identifiants uniques');

// Médailles : 1000 m en rouge → or ≤ 75 s (48 km/h)
const t = medalTargets(1000, 'rouge');
assert.equal(t.or, 75);
assert.equal(medalFor(70, t), 'or');
assert.equal(medalFor(90, t), 'argent');
assert.equal(medalFor(130, t), 'bronze');
assert.equal(medalFor(200, t), null);
let st = recordRun({}, 'a', 90, 1000, t).state;
st = recordRun(st, 'a', 200, 500, t).state; // moins bien : on garde l'argent
assert.equal(st.a.medal, 'argent');
assert.equal(st.a.bestTime, 90);
assert.equal(st.a.runs, 2);
const r = recordRun(st, 'a', 60, 2000, t);
assert.equal(r.medal, 'or');
assert.ok(r.improved);
assert.equal(totals(r.state, ['a', 'b']).points, 3);
assert.ok(!isUnlocked('noire', 3) && isUnlocked('rouge', 4));
console.log(`✓ secteur & championnat OK — ${OFFICIAL_PISTES.length} pistes officielles`);
