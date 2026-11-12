/* Géométrie des bâtiments (sans réseau ni rendu) */
import assert from 'node:assert/strict';
import { minAreaRect, earClip, pointInPolygon, polygonArea, modelBuilding, buildBuildingMesh, distToPolygonEdge, wallHeight } from '../game/buildings';

// Rectangle 20 x 10 tourné de 30°
const a = Math.PI / 6;
const rect = [[-10, -5], [10, -5], [10, 5], [-10, 5]].map(([u, v]) => ({ x: 100 + u * Math.cos(a) - v * Math.sin(a), z: 50 + u * Math.sin(a) + v * Math.cos(a) }));
const r = minAreaRect(rect);
assert.ok(Math.abs(r.area - 200) < 1e-6, 'aire du rectangle minimal');
assert.ok(Math.abs(Math.max(r.w, r.d) - 20) < 1e-6 && Math.abs(Math.min(r.w, r.d) - 10) < 1e-6);
assert.ok(Math.abs(r.cx - 100) < 1e-6 && Math.abs(r.cz - 50) < 1e-6, 'centre');

// Polygone en L
const L = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 10 }, { x: 10, z: 10 }, { x: 10, z: 20 }, { x: 0, z: 20 }];
const tris = earClip(L);
assert.equal(tris.length, 4 * 3, 'L : 4 triangles');
let sum = 0;
for (let i = 0; i < tris.length; i += 3) sum += Math.abs(polygonArea([L[tris[i]], L[tris[i + 1]], L[tris[i + 2]]]));
assert.ok(Math.abs(sum - 300) < 1e-6, 'aire triangulée = aire du L');
assert.equal(earClip(L.slice().reverse()).length, 12, 'orientation inverse');
assert.ok(pointInPolygon(5, 15, L) && !pointInPolygon(15, 15, L));
assert.ok(Math.abs(distToPolygonEdge(15, 12, L) - 2) < 1e-9);
assert.ok(Math.abs(wallHeight({ 'building:levels': '3' }, 100) - 8.4) < 1e-9);

const flat = () => 1000;
const chalet = modelBuilding(1, rect, { building: 'house' }, flat)!;
assert.equal(chalet.kind, 'chalet');
assert.ok(chalet.ridge > chalet.eaves);
const bloc = modelBuilding(2, L, { building: 'apartments' }, flat)!;
assert.equal(bloc.kind, 'bloc');
const mesh = buildBuildingMesh([chalet, bloc]);
assert.equal(mesh.positions.length % 9, 0);
assert.equal(mesh.positions.length, mesh.normals.length);
for (let i = 0; i < mesh.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]) - 1) < 1e-6, 'normales unitaires');
// Les faces doivent être orientées selon leur normale (face avant)
for (let i = 0; i < mesh.positions.length; i += 9) {
  const p = mesh.positions;
  const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
  const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
  const c = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const n = mesh.normals.slice(i, i + 3);
  assert.ok(c[0] * n[0] + c[1] * n[1] + c[2] * n[2] >= -1e-9, 'enroulement cohérent');
}
// Toit enneigé au-dessus des murs
let maxY = -Infinity;
for (let i = 1; i < mesh.positions.length; i += 3) maxY = Math.max(maxY, mesh.positions[i]);
assert.ok(maxY > 1000 + chalet.eaves);
assert.equal(modelBuilding(3, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], {}, flat), null, 'trop petit');
console.log(`✓ bâtiments OK — ${mesh.positions.length / 9} triangles pour 2 bâtiments`);
