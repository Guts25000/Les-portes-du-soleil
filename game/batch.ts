/**
 * Regroupement des décors immobiles : tous les maillages d'un même matériau situés dans le même
 * carré de 1 280 m sont fusionnés en un seul. Des milliers d'objets (pylônes, gares, panneaux…)
 * deviennent quelques dizaines d'appels de dessin, que le GPU peut encore écarter hors du champ.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const CELL = 2560;

function normalize(g: THREE.BufferGeometry, keepUv: boolean, keepColor: boolean): THREE.BufferGeometry {
  let geo = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(geo.attributes)) {
    if (k === 'position' || k === 'normal') continue;
    if (k === 'uv' && keepUv) continue;
    if (k === 'color' && keepColor) continue;
    geo.deleteAttribute(k);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (keepUv && !geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
  if (keepColor && !geo.getAttribute('color')) {
    const c = new Float32Array(geo.getAttribute('position').count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  geo.morphAttributes = {};
  return geo;
}

/** Signature d'un matériau : deux matériaux identiques (souvent recréés par objet) sont fusionnables. */
function matKey(m: THREE.Material): string {
  const a = m as THREE.MeshStandardMaterial;
  return [m.type, a.color?.getHexString(), a.emissive?.getHexString(), a.emissiveIntensity, a.roughness, a.metalness, a.vertexColors, m.transparent, m.opacity, m.side, a.flatShading, a.map?.uuid, a.normalMap?.uuid, a.alphaMap?.uuid, m.alphaTest, m.depthWrite].join('|');
}

/** Fusionne les maillages immobiles de `roots` (les objets fusionnés sont retirés de la scène). */
export function batchStatic(scene: THREE.Scene, roots: THREE.Object3D[]): { before: number; after: number } {
  scene.updateMatrixWorld(true);
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean; recv: boolean }>();
  // matériaux unis : la couleur passe dans les sommets, un seul matériau par famille (mat, métal)
  const shared = new Map<string, THREE.MeshStandardMaterial>();
  const plainKey = (m: THREE.Material) => {
    const a = m as THREE.MeshStandardMaterial;
    if (!(a instanceof THREE.MeshStandardMaterial) || a.map || a.normalMap || a.alphaMap || m.transparent || a.emissive.getHex() !== 0) return null;
    return `vc|${Math.round(a.roughness * 4)}|${Math.round(a.metalness * 2)}|${m.side}`;
  };
  const remove: THREE.Object3D[] = [];
  let before = 0;
  const v = new THREE.Vector3();
  for (const root of roots)
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (Array.isArray(m.material) || !m.visible || m.userData.dynamic) return;
      let mat = m.material as THREE.Material & { map?: THREE.Texture | null; vertexColors?: boolean };
      before++;
      m.getWorldPosition(v);
      const pk = plainKey(mat);
      const tint = pk ? (mat as THREE.MeshStandardMaterial).color : null;
      const hadColors = !!mat.vertexColors;
      if (pk) {
        let sm = shared.get(pk);
        if (!sm) {
          const a = mat as THREE.MeshStandardMaterial;
          sm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: Math.round(a.roughness * 4) / 4, metalness: Math.round(a.metalness * 2) / 2, side: a.side });
          shared.set(pk, sm);
        }
        mat = sm;
      }
      const key = `${matKey(mat)}|${Math.floor(v.x / CELL)}|${Math.floor(v.z / CELL)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { mat, geos: [], shadow: false, recv: true }));
      const g = normalize(m.geometry, !!mat.map || !!(mat as THREE.MeshStandardMaterial).normalMap || !!(mat as THREE.MeshStandardMaterial).alphaMap, !!mat.vertexColors);
      if (tint) {
        const col = g.getAttribute('color') as THREE.BufferAttribute;
        for (let i = 0; i < col.count; i++)
          col.setXYZ(i, (hadColors ? col.getX(i) : 1) * tint.r, (hadColors ? col.getY(i) : 1) * tint.g, (hadColors ? col.getZ(i) : 1) * tint.b);
      }
      g.applyMatrix4(m.matrixWorld);
      b.geos.push(g);
      remove.push(m);
    });
  for (const o of remove) o.removeFromParent();
  let after = 0;
  const byMat = new Map<string, number>();
  for (const [k, b] of buckets) {
    const name = k.split('|').slice(0, 3).join('|') + (k.split('|')[11] ? '|tex' : '');
    byMat.set(name, (byMat.get(name) ?? 0) + 1);
    void b;
  }
  console.info('[pds3d] lots de décor', JSON.stringify([...byMat].sort((a, b) => b[1] - a[1]).slice(0, 12)));
  for (const b of buckets.values()) {
    // homogénéise les attributs (uv/couleur) au sein d'un groupe
    const names = new Set<string>();
    for (const g of b.geos) for (const k of Object.keys(g.attributes)) names.add(k);
    const geos = b.geos.map((g) => {
      for (const k of names)
        if (!g.getAttribute(k)) {
          const n = g.getAttribute('position').count;
          const size = k === 'uv' ? 2 : 3;
          g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * size).fill(k === 'color' ? 1 : 0), size));
        }
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = b.recv;
    mesh.matrixAutoUpdate = false;
    mesh.userData.cat = 'décor';
    scene.add(mesh);
    after++;
  }
  return { before, after };
}
